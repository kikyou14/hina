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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    #[cfg(unix)]
    updater::maybe_rollback();

    let config = AgentConfig::parse();

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
