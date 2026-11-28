#![forbid(unsafe_code)]

//! The thread engine both native apps use, on the device database (`engine.rs`).

mod db;
mod engine;
mod rows;
pub use db::{ThreadIndex, Window};
pub use engine::{Engine, Images, Peek, Pending, Settings, peek};
