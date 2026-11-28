//! GitHub source control for the Conn Server, reached as the T3 server reaches it
//! (`packages/source-control-*`). See `README.md` for the map of the whole area and what is
//! served.

pub mod cache;
pub mod checkout;
pub mod cli;
pub mod close_commands;
pub mod detect;
pub mod discovery;
pub mod hosts;
pub mod http;
pub mod pull_requests;
pub mod repository;
pub mod secret;
pub mod settings;

pub use secret::Secret;

// The registry and the remote text live below the engine, which reads link keys through
// them. This crate's answers carry the registry's types, so it shows them as its own.
pub use conn_source_control_core::registry;
pub(crate) use conn_source_control_core::remote;
