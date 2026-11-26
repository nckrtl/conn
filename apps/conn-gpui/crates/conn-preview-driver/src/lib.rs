//! Runs agent preview requests on a desktop browser tab over the Chrome DevTools Protocol.
//!
//! This is the desktop half of T3 Conn's browser relay: [`DesktopTabRunner`] answers the
//! requests a server forwards (`status`, `snapshot`, `click`, `evaluate`, ...) against a page
//! that implements [`PageTarget`]. Page work uses the same injected engine and the same
//! operation scripts `conn-server` uses for its own browser, so agents see the same snapshots
//! and refs from every kind of tab.

mod cdp;
mod page;
mod runner;
mod spec;

pub use cdp::{Cdp, CdpFuture, EventListener, Subscription};
pub use runner::{DesktopTabRunner, DialogInfo, FileChooserInfo, OperationError, PageTarget};

/// A page operation failed.
#[derive(Clone, Debug, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PageError(pub String);
