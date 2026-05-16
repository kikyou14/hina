mod collector;
mod config;
mod ip_resolve;
mod net_filter;
mod probe;
mod protocol;
mod tls;
#[cfg(unix)]
mod updater;
mod ws_client;

use std::time::Duration;

use clap::Parser;
use tokio::sync::mpsc;

use crate::config::AgentConfig;

#[cfg(unix)]
const AUTO_UPDATE_INTERVAL: Duration = Duration::from_secs(12 * 60 * 60);

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = match AgentConfig::try_parse() {
        Ok(cfg) => cfg,
        Err(err) => {
            if !matches!(
                err.kind(),
                clap::error::ErrorKind::DisplayHelp
                    | clap::error::ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
                    | clap::error::ErrorKind::DisplayVersion
            ) {
                init_tracing();
                #[cfg(unix)]
                updater::maybe_rollback();
            }
            err.exit();
        }
    };

    init_tracing();
    tracing::info!(version = env!("CARGO_PKG_VERSION"), "hina-agent starting");

    #[cfg(unix)]
    updater::maybe_rollback();

    let (update_tx, mut update_rx) = mpsc::channel(1);

    #[cfg(unix)]
    if !config.no_auto_update && !config.once {
        updater::spawn(AUTO_UPDATE_INTERVAL, update_tx);
    } else {
        drop(update_tx);
    }

    #[cfg(not(unix))]
    drop(update_tx);

    match ws_client::run_agent(config, &mut update_rx).await? {
        #[cfg(unix)]
        Some(exe_path) => updater::exec_self(&exe_path)?,
        _ => {}
    }

    Ok(())
}
