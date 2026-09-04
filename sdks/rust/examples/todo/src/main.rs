#![allow(missing_docs)]

use tesseron::HostEvent;
use tesseron_todo_example::todo_application;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let (builder, _todos) = todo_application("rust_todo", "Rust Todo");
    let mut events = builder.subscribe();
    let host = builder.listen().await?;

    while let Ok(event) = events.recv().await {
        if let HostEvent::Welcome(welcome) = event {
            if let Some(claim_code) = welcome.claim_code {
                println!("Claim code: {claim_code}");
                break;
            }
        }
    }

    tokio::signal::ctrl_c().await?;
    host.shutdown().await?;
    Ok(())
}
