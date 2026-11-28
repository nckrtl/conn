//! macOS desktop host services for `conn-gpui`.
//!
//! Feature-specific backends (`conn-api-client`, `conn-database`, `conn-mcp-client`,
//! `conn-laravel-toolbar`, `conn-process`) live in their own crates so they can be reused across
//! apps or moved into standalone programs without pulling in desktop-only host services.
#![forbid(unsafe_code)]

pub mod control;
pub mod operator;
pub mod orbit;
pub mod server_store;
pub mod vault;
pub mod vaultwarden;
