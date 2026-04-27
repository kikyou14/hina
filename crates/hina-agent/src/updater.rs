use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{Context, bail};
use semver::Version;
use sha2::{Digest, Sha256};

const GITHUB_REPO: &str = "kikyou14/hina";
const TAG_PREFIX: &str = "agent-v";
const CHECKSUM_ASSET: &str = "checksums.txt";
const INITIAL_DELAY: Duration = Duration::from_secs(60);
const BACKUP_NAME: &str = ".hina-agent.backup";
const TEMP_NAME: &str = ".hina-agent.update.tmp";
const STATE_NAME: &str = ".hina-agent.update-state";
const SKIP_NAME: &str = ".hina-agent.skip-version";
const MAX_CRASH_COUNT: u32 = 3;

pub fn spawn(interval: Duration, update_tx: tokio::sync::mpsc::Sender<PathBuf>) {
    tokio::spawn(async move {
        let exe_path = match resolve_exe_path() {
            Ok(p) => p,
            Err(e) => {
                tracing::error!(error = %e, "cannot determine executable path, auto-update disabled");
                return;
            }
        };

        tokio::time::sleep(INITIAL_DELAY).await;

        loop {
            match check_and_update(&exe_path).await {
                Ok(Some(version)) => {
                    tracing::info!(%version, "update installed, signaling graceful restart");
                    let _ = update_tx.send(exe_path).await;
                    return;
                }
                Ok(None) => {
                    tracing::debug!("no update available");
                }
                Err(e) => {
                    tracing::warn!(error = %e, "update check failed");
                }
            }
            tokio::time::sleep(interval).await;
        }
    });
}

pub fn maybe_rollback() {
    let exe_path = match resolve_exe_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    let Some(parent) = exe_path.parent() else {
        return;
    };

    let backup = parent.join(BACKUP_NAME);
    let state = parent.join(STATE_NAME);

    if !backup.exists() {
        let _ = std::fs::remove_file(&state);
        return;
    }

    let count: u32 = std::fs::read_to_string(&state)
        .ok()
        .and_then(|s| s.trim().parse().ok())
        .unwrap_or(0);

    if count >= MAX_CRASH_COUNT {
        tracing::error!(count, "too many crashes after update, rolling back");
        let _ = std::fs::write(parent.join(SKIP_NAME), env!("CARGO_PKG_VERSION"));
        match std::fs::rename(&backup, &exe_path) {
            Ok(()) => {
                let _ = std::fs::remove_file(&state);
                if let Err(e) = exec_self(&exe_path) {
                    tracing::error!(error = %e, "exec into rolled-back binary failed, exiting");
                    std::process::exit(1);
                }
            }
            Err(e) => tracing::error!(error = %e, "rollback rename failed"),
        }
        return;
    }

    tracing::info!(
        attempt = count + 1,
        max = MAX_CRASH_COUNT,
        "post-update boot"
    );
    let _ = std::fs::write(&state, (count + 1).to_string());
}

pub fn confirm_update() {
    let Ok(exe_path) = resolve_exe_path() else {
        return;
    };
    let Some(parent) = exe_path.parent() else {
        return;
    };
    if parent.join(BACKUP_NAME).exists() {
        let _ = std::fs::remove_file(parent.join(BACKUP_NAME));
        let _ = std::fs::remove_file(parent.join(STATE_NAME));
        let _ = std::fs::remove_file(parent.join(SKIP_NAME));
        tracing::info!("update confirmed, backup cleaned up");
    }
}

fn resolve_exe_path() -> anyhow::Result<PathBuf> {
    let path = std::env::current_exe().context("failed to get current exe")?;
    Ok(path.canonicalize().unwrap_or(path))
}

async fn check_and_update(exe_path: &Path) -> anyhow::Result<Option<Version>> {
    let current =
        Version::parse(env!("CARGO_PKG_VERSION")).context("failed to parse current version")?;

    let client = reqwest::Client::builder()
        .user_agent(concat!("hina-agent/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()?;

    let release = fetch_latest_agent_release(&client).await?;

    let tag_version = release
        .tag_name
        .strip_prefix(TAG_PREFIX)
        .context("release tag missing expected prefix")?;
    let remote = Version::parse(tag_version)
        .with_context(|| format!("failed to parse release version: {tag_version}"))?;

    if remote <= current {
        return Ok(None);
    }

    if let Some(parent) = exe_path.parent()
        && let Ok(v) = std::fs::read_to_string(parent.join(SKIP_NAME))
        && v.trim() == remote.to_string()
    {
        tracing::debug!(version = %remote, "skipping previously failed version");
        return Ok(None);
    }

    tracing::info!(current = %current, available = %remote, "new version available");

    let asset_name = platform_asset_name().context("unsupported platform for auto-update")?;

    let binary_url = release
        .asset_url(asset_name)
        .with_context(|| format!("release missing asset: {asset_name}"))?;
    let checksum_url = release
        .asset_url(CHECKSUM_ASSET)
        .context("release missing checksums.txt")?;

    let checksums_text = client
        .get(checksum_url)
        .send()
        .await?
        .error_for_status()?
        .text()
        .await?;
    let expected_hash =
        parse_checksum(&checksums_text, asset_name).context("checksum entry not found")?;

    tracing::info!(asset = asset_name, "downloading update");
    let binary_bytes = client
        .get(binary_url)
        .timeout(Duration::from_secs(5 * 60))
        .send()
        .await?
        .error_for_status()?
        .bytes()
        .await?;

    let actual_hash = hex_sha256(&binary_bytes);
    if actual_hash != expected_hash {
        bail!("checksum mismatch: expected {expected_hash}, got {actual_hash}");
    }
    tracing::info!("checksum verified");

    replace_executable(exe_path, &binary_bytes)?;

    Ok(Some(remote))
}

async fn fetch_latest_agent_release(client: &reqwest::Client) -> anyhow::Result<Release> {
    let url = format!("https://api.github.com/repos/{GITHUB_REPO}/releases");
    let releases: Vec<Release> = client
        .get(&url)
        .query(&[("per_page", "100")])
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;

    releases
        .into_iter()
        .filter(|r| !r.draft && !r.prerelease)
        .filter_map(|r| {
            let v = Version::parse(r.tag_name.strip_prefix(TAG_PREFIX)?).ok()?;
            Some((v, r))
        })
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, r)| r)
        .context("no agent release found")
}

#[derive(serde::Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    prerelease: bool,
    #[serde(default)]
    draft: bool,
    assets: Vec<Asset>,
}

impl Release {
    fn asset_url(&self, name: &str) -> Option<&str> {
        self.assets
            .iter()
            .find(|a| a.name == name)
            .map(|a| a.browser_download_url.as_str())
    }
}

#[derive(serde::Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}

fn platform_asset_name() -> Option<&'static str> {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("linux", "x86_64") => Some("hina-agent-linux-x86_64"),
        ("linux", "aarch64") => Some("hina-agent-linux-aarch64"),
        ("macos", "x86_64") => Some("hina-agent-darwin-x86_64"),
        ("macos", "aarch64") => Some("hina-agent-darwin-aarch64"),
        _ => None,
    }
}

fn parse_checksum<'a>(checksums: &'a str, filename: &str) -> Option<&'a str> {
    checksums.lines().find_map(|line| {
        let (hash, name) = line.split_once(char::is_whitespace)?;
        let name = name.trim().trim_start_matches('*');
        (name == filename).then_some(hash)
    })
}

fn hex_sha256(data: &[u8]) -> String {
    let digest = Sha256::digest(data);
    let mut out = String::with_capacity(64);
    for b in digest {
        use std::fmt::Write;
        write!(out, "{b:02x}").unwrap();
    }
    out
}

fn replace_executable(exe_path: &Path, new_bytes: &[u8]) -> anyhow::Result<()> {
    let parent = exe_path.parent().context("exe has no parent directory")?;
    let backup_path = parent.join(BACKUP_NAME);
    let temp_path = parent.join(TEMP_NAME);

    if let Err(e) = write_and_replace(&temp_path, exe_path, new_bytes, &backup_path) {
        let _ = std::fs::remove_file(&temp_path);
        if !exe_path.exists() && backup_path.exists() {
            let _ = std::fs::rename(&backup_path, exe_path);
        }
        return Err(e);
    }
    Ok(())
}

fn write_and_replace(
    temp: &Path,
    target: &Path,
    bytes: &[u8],
    backup: &Path,
) -> anyhow::Result<()> {
    let mut file = std::fs::File::create(temp).context("failed to create temp file")?;
    file.write_all(bytes)
        .context("failed to write update binary")?;
    file.sync_all()?;
    drop(file);

    std::fs::set_permissions(temp, std::fs::Permissions::from_mode(0o755))?;
    if target.exists() {
        std::fs::rename(target, backup).context("failed to back up current binary")?;
    }
    std::fs::rename(temp, target).context("failed to replace executable")
}

pub fn exec_self(exe_path: &Path) -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    tracing::info!(path = %exe_path.display(), "exec into updated binary");

    use std::os::unix::process::CommandExt;
    let err = std::process::Command::new(exe_path).args(&args[1..]).exec();
    Err(err).context("exec failed")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_checksum() {
        let input = "\
abc123  hina-agent-linux-x86_64\n\
def456  hina-agent-linux-aarch64\n\
789abc  hina-agent-darwin-aarch64";
        assert_eq!(
            parse_checksum(input, "hina-agent-linux-x86_64"),
            Some("abc123")
        );
        assert_eq!(
            parse_checksum(input, "hina-agent-darwin-aarch64"),
            Some("789abc")
        );
        assert_eq!(parse_checksum(input, "nonexistent"), None);
    }

    #[test]
    fn test_parse_checksum_binary_mode() {
        let input = "abc123 *hina-agent-linux-x86_64";
        assert_eq!(
            parse_checksum(input, "hina-agent-linux-x86_64"),
            Some("abc123")
        );
    }

    #[test]
    fn test_platform_asset_name() {
        let name = platform_asset_name();
        assert!(name.is_some(), "should resolve on supported platforms");
        assert!(name.unwrap().starts_with("hina-agent-"));
    }
}
