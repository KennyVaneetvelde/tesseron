//! Host adapter for the `@tesseron/conformance` runner.
//!
//! The runner starts one of these per fixture with `TESSERON_CONFORMANCE_FIXTURE`
//! pointing at the fixture document, waits for a single readiness line on
//! stdout, then plays the gateway against the endpoint that line names. Every
//! diagnostic goes to stderr, because a second stdout line fails the fixture.

use std::env;
use std::error::Error;
use std::fs;
use std::io::Write as _;
use std::process::ExitCode;

use tesseron::{ApplicationDescriptor, ManifestPublication, Tesseron};
use tokio::io::AsyncReadExt as _;

mod fixture;
mod schema_subset;

/// The environment variable the runner sets to the fixture document's path.
const FIXTURE_PATH_VARIABLE: &str = "TESSERON_CONFORMANCE_FIXTURE";

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(problem) => {
            eprintln!("tesseron-conformance-host: {problem}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Box<dyn Error>> {
    let fixture_path = env::var(FIXTURE_PATH_VARIABLE)
        .map_err(|_| format!("{FIXTURE_PATH_VARIABLE} is required"))?;
    let document = fs::read_to_string(&fixture_path)
        .map_err(|problem| format!("could not read {fixture_path}: {problem}"))?;

    let builder = Tesseron::builder()
        .application_descriptor(ApplicationDescriptor {
            id: "conformance".to_owned(),
            name: "Tesseron Rust conformance host".to_owned(),
            description: None,
            origin: "tesseron-conformance://rust".to_owned(),
            version: None,
            icon_url: None,
        })
        // The runner dials the endpoint it is told about and never reads
        // discovery manifests, so publishing one would only litter the
        // developer's ~/.tesseron/instances.
        .manifest(ManifestPublication::Disabled);
    let host = fixture::register(builder, &document)?.listen().await?;

    announce(host.url())?;
    wait_for_shutdown().await;
    host.shutdown().await?;
    Ok(())
}

/// Writes the one readiness line the runner waits for, flushed so it cannot sit
/// in a buffer while the runner times out.
fn announce(url: &str) -> Result<(), Box<dyn Error>> {
    let mut stdout = std::io::stdout();
    writeln!(stdout, "tesseron-conformance-url={url}")?;
    stdout.flush()?;
    Ok(())
}

/// Waits for the runner to ask the process to end.
///
/// Closing stdin is the runner's normal signal; the interrupt and termination
/// signals cover the force-kill path and a developer running the binary by hand.
async fn wait_for_shutdown() {
    let mut discarded = Vec::new();
    let mut stdin = tokio::io::stdin();
    tokio::select! {
        _ = stdin.read_to_end(&mut discarded) => {}
        _ = tokio::signal::ctrl_c() => {}
        () = terminated() => {}
    }
}

#[cfg(unix)]
async fn terminated() {
    use tokio::signal::unix::{SignalKind, signal};

    match signal(SignalKind::terminate()) {
        Ok(mut terminate) => {
            terminate.recv().await;
        }
        Err(problem) => {
            eprintln!("tesseron-conformance-host: no SIGTERM handler: {problem}");
            std::future::pending().await
        }
    }
}

/// Windows has no SIGTERM; the runner's force-kill path ends the process
/// outright, so this branch simply never resolves.
#[cfg(not(unix))]
async fn terminated() {
    std::future::pending().await
}
