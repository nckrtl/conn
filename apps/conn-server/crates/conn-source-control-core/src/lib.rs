//! The source control rules that the engine needs too, so they sit below both it and
//! `conn-source-control`: text in, text out. No I/O, no async, no state. See `README.md`.

pub mod registry;
pub mod remote;
pub mod wake;
