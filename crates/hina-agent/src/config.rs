use std::path::PathBuf;

use clap::Parser;

#[derive(Debug, Clone, Parser)]
#[command(name = "hina-agent")]
pub struct AgentConfig {
    #[arg(long)]
    pub server_url: String,

    #[arg(long)]
    pub token: String,

    #[arg(long)]
    pub once: bool,

    #[arg(long)]
    pub insecure: bool,

    #[arg(long)]
    pub interface: Option<String>,

    #[arg(long)]
    pub mount_points: Option<String>,

    #[arg(long)]
    pub no_auto_update: bool,
}

pub fn parse_mount_points(raw: &str) -> Vec<PathBuf> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| PathBuf::from(s).components().collect::<PathBuf>())
        .collect()
}
