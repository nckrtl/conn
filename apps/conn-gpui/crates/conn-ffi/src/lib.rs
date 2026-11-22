//! UniFFI Swift/iOS bridge over the GPUI-free `conn-client` and `conn-state` core.
//!
//! Hand-written code in this crate stays free of `unsafe`; only the UniFFI proc-macro
//! scaffolding generates FFI boundary code.

mod coalesce;
mod core;
mod types;

uniffi::setup_scaffolding!();

pub use crate::core::{ConnCore, CoreListener};
pub use crate::types::{
    FfiConnectionStatus, FfiCredential, FfiError, FfiItemStatus, FfiProject, FfiShellSnapshot,
    FfiThreadActivity, FfiThreadSnapshot, FfiThreadSummary, FfiTimelineEntry,
};

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ConnCore>();
    assert_send_sync::<FfiCredential>();
    assert_send_sync::<FfiConnectionStatus>();
    assert_send_sync::<FfiThreadActivity>();
    assert_send_sync::<FfiProject>();
    assert_send_sync::<FfiThreadSummary>();
    assert_send_sync::<FfiShellSnapshot>();
    assert_send_sync::<FfiItemStatus>();
    assert_send_sync::<FfiTimelineEntry>();
    assert_send_sync::<FfiThreadSnapshot>();
    assert_send_sync::<FfiError>();
};
