# Contributing to Tesseron Rust

Run the gate from this repository root before opening a PR:

```sh
cargo fmt --all --check
cargo clippy --workspace --exclude tauri-todo --all-targets -- -D warnings
cargo test --workspace --exclude tauri-todo
cargo build --workspace --exclude tauri-todo
```

On Windows, also run `cargo check -p tauri-todo`.

Keep `Cargo.lock` committed. Do not use `unwrap()` outside tests. The library
uses `#![deny(missing_docs)]`. Spell names out instead of abbreviating them.

Sign every commit with DCO:

```sh
git commit -s
```

An SDK release PR is complete only after its required hub docs PR has merged.
Docs live in the [Tesseron hub](https://github.com/Eigenwise/tesseron/tree/main/docs/src/content/docs/sdk/rust).
