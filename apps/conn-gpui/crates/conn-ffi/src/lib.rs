//! UniFFI Swift/iOS bridge over the GPUI-free `conn-client`, `conn-state`, and `conn-theme` core.
//!
//! Hand-written code in this crate stays free of `unsafe`; only the UniFFI proc-macro
//! scaffolding generates FFI boundary code.

mod coalesce;
mod core;
mod theme;
mod types;

uniffi::setup_scaffolding!();

pub use crate::core::{ConnCore, CoreListener};
pub use crate::theme::{
    FfiAppearance, FfiColor, FfiShellGeometry, FfiThemeSummary, FfiThemeTokens, builtin_themes,
    custom_theme_tokens, theme_tokens,
};
pub use crate::types::{
    FfiApprovalDecision, FfiAttachment, FfiConnectionStatus, FfiCredential, FfiError,
    FfiItemStatus, FfiProject, FfiSecretRequestStatus, FfiSendMode, FfiShellSnapshot,
    FfiThreadActivity, FfiThreadSnapshot, FfiThreadSummary, FfiTimelineEntry,
    FfiTurnCheckpointFile, FfiTurnItemStatus, FfiUserInputAnswer, FfiUserInputAnswerValue,
    FfiUserInputOption, FfiUserInputQuestion, FfiUserInputSubmission, FfiWorkGroupTiming,
};

const _: () = {
    const fn assert_send_sync<T: Send + Sync>() {}
    assert_send_sync::<ConnCore>();
    assert_send_sync::<FfiAppearance>();
    assert_send_sync::<FfiColor>();
    assert_send_sync::<FfiShellGeometry>();
    assert_send_sync::<FfiThemeSummary>();
    assert_send_sync::<FfiThemeTokens>();
    assert_send_sync::<FfiCredential>();
    assert_send_sync::<FfiConnectionStatus>();
    assert_send_sync::<FfiSendMode>();
    assert_send_sync::<FfiApprovalDecision>();
    assert_send_sync::<FfiThreadActivity>();
    assert_send_sync::<FfiProject>();
    assert_send_sync::<FfiThreadSummary>();
    assert_send_sync::<FfiShellSnapshot>();
    assert_send_sync::<FfiItemStatus>();
    assert_send_sync::<FfiTurnItemStatus>();
    assert_send_sync::<FfiSecretRequestStatus>();
    assert_send_sync::<FfiAttachment>();
    assert_send_sync::<FfiUserInputOption>();
    assert_send_sync::<FfiUserInputQuestion>();
    assert_send_sync::<FfiUserInputAnswer>();
    assert_send_sync::<FfiUserInputAnswerValue>();
    assert_send_sync::<FfiUserInputSubmission>();
    assert_send_sync::<FfiTurnCheckpointFile>();
    assert_send_sync::<FfiWorkGroupTiming>();
    assert_send_sync::<FfiTimelineEntry>();
    assert_send_sync::<FfiThreadSnapshot>();
    assert_send_sync::<FfiError>();
};
