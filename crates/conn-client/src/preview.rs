//! Typed preview session and desktop tab relay RPCs (`preview.*`, `subscribePreviewEvents`).
//!
//! Mirrors T3 Conn's `apps/web/src/rpc/desktopTabRelay.ts` and
//! `packages/client-runtime/src/state/preview.ts` against `conn-server`'s typed contract in
//! `conn_contract::rpc::preview`.

use std::fmt;
use std::future::Future;
use std::pin::Pin;

use conn_contract::{
    DesktopTabBinding, DesktopTabConnection, PreviewAdjustInput, PreviewAutomationResponse,
    PreviewAutomationStreamEvent, PreviewCloseInput, PreviewEvent, PreviewListResult,
    PreviewOpenInput, PreviewReportStatusInput, PreviewResizeInput, PreviewSessionSnapshot,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;

use crate::{ClientError, Connection, StreamId};

mod host;

pub use host::{
    ApiFuture, DesktopRequests, DesktopTabExecutor, DesktopTabHost, HostOptions, HostedTabState,
    HostedTarget, PreviewApi, UNAVAILABLE_MESSAGE,
};

/// RPC tag for creating a preview tab record (`preview.open`).
pub const TAG_PREVIEW_OPEN: &str = "preview.open";
/// RPC tag for listing a thread's preview tab records (`preview.list`).
pub const TAG_PREVIEW_LIST: &str = "preview.list";
/// RPC tag for reporting a desktop tab's navigation status (`preview.reportStatus`).
pub const TAG_PREVIEW_REPORT_STATUS: &str = "preview.reportStatus";
/// RPC tag for updating a preview tab's viewport setting (`preview.resize`).
pub const TAG_PREVIEW_RESIZE: &str = "preview.resize";
/// RPC tag for updating a preview tab's appearance/zoom (`preview.adjust`).
pub const TAG_PREVIEW_ADJUST: &str = "preview.adjust";
/// RPC tag for closing a preview tab record (`preview.close`).
pub const TAG_PREVIEW_CLOSE: &str = "preview.close";
/// RPC tag for registering a desktop-hosted browser tab (`preview.desktopRegister`).
pub const TAG_PREVIEW_DESKTOP_REGISTER: &str = "preview.desktopRegister";
/// RPC tag for streaming agent automation requests to a desktop host (`preview.desktopRequests`).
pub const TAG_PREVIEW_DESKTOP_REQUESTS: &str = "preview.desktopRequests";
/// RPC tag for answering an agent automation request (`preview.desktopRespond`).
pub const TAG_PREVIEW_DESKTOP_RESPOND: &str = "preview.desktopRespond";
/// RPC tag for subscribing to server preview lifecycle events (`subscribePreviewEvents`).
pub const TAG_SUBSCRIBE_PREVIEW_EVENTS: &str = "subscribePreviewEvents";

/// Active `preview.desktopRequests` stream for one desktop tab registration.
///
/// Dropping this handle cancels the stream (`FromClient::Interrupt`), which causes the server to
/// drop its `DesktopFeed` and immediately release the tab registration.
pub struct DesktopRequestStream {
    connection: Connection,
    stream_id: StreamId,
    rx: mpsc::Receiver<Value>,
}

impl fmt::Debug for DesktopRequestStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DesktopRequestStream")
            .field("stream_id", &self.stream_id)
            .finish_non_exhaustive()
    }
}

impl DesktopRequestStream {
    /// Waits for the next `connected` or `request` event from the server, returning `None` when
    /// the stream ends (server eviction, cancellation, or transport disconnect).
    pub async fn recv(
        &mut self,
    ) -> Option<Result<PreviewAutomationStreamEvent, serde_json::Error>> {
        let raw = self.rx.recv().await?;
        Some(serde_json::from_value(raw))
    }

    /// Explicitly cancels the stream and releases the server-side registration.
    pub fn close(self) {
        drop(self);
    }
}

impl Drop for DesktopRequestStream {
    fn drop(&mut self) {
        self.connection.cancel_stream(self.stream_id);
    }
}

/// Active `subscribePreviewEvents` stream.
///
/// Dropping this handle cancels the server-side subscription.
pub struct PreviewEventsStream {
    connection: Connection,
    stream_id: StreamId,
    rx: mpsc::Receiver<Value>,
}

impl fmt::Debug for PreviewEventsStream {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PreviewEventsStream")
            .field("stream_id", &self.stream_id)
            .finish_non_exhaustive()
    }
}

impl PreviewEventsStream {
    /// Waits for the next [`PreviewEvent`], returning `None` when the stream ends.
    pub async fn recv(&mut self) -> Option<Result<PreviewEvent, serde_json::Error>> {
        let raw = self.rx.recv().await?;
        Some(serde_json::from_value(raw))
    }
}

impl Drop for PreviewEventsStream {
    fn drop(&mut self) {
        self.connection.cancel_stream(self.stream_id);
    }
}

impl Connection {
    /// Creates a preview tab record on the server (`preview.open`).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] on transport, codec, or server RPC failure.
    pub async fn preview_open(
        &self,
        input: &PreviewOpenInput,
    ) -> Result<PreviewSessionSnapshot, ClientError> {
        self.call(TAG_PREVIEW_OPEN, input).await
    }

    /// Lists preview tab records for `thread_id` (`preview.list`).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] on transport, codec, or server RPC failure.
    pub async fn preview_list(&self, thread_id: &str) -> Result<PreviewListResult, ClientError> {
        let payload = conn_contract::OrchestrationV2GetThreadFamilyInput {
            thread_id: thread_id.to_owned(),
        };
        self.call(TAG_PREVIEW_LIST, &payload).await
    }

    /// Reports navigation status for a desktop preview tab (`preview.reportStatus`).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] on transport, codec, or server RPC failure.
    pub async fn preview_report_status(
        &self,
        input: &PreviewReportStatusInput,
    ) -> Result<(), ClientError> {
        let payload = serde_json::to_value(input)?;
        self.call_json(TAG_PREVIEW_REPORT_STATUS, payload)
            .await
            .map(|_| ())
    }

    /// Updates a preview tab's viewport setting (`preview.resize`).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] on transport, codec, or server RPC failure.
    pub async fn preview_resize(
        &self,
        input: &PreviewResizeInput,
    ) -> Result<PreviewSessionSnapshot, ClientError> {
        self.call(TAG_PREVIEW_RESIZE, input).await
    }

    /// Updates a preview tab's appearance or zoom (`preview.adjust`).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] on transport, codec, or server RPC failure.
    pub async fn preview_adjust(
        &self,
        input: &PreviewAdjustInput,
    ) -> Result<PreviewSessionSnapshot, ClientError> {
        self.call(TAG_PREVIEW_ADJUST, input).await
    }

    /// Closes one preview tab (or every tab of `thread_id` when `tab_id` is `None`) via
    /// `preview.close`.
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] on transport, codec, or server RPC failure.
    pub async fn preview_close(&self, input: &PreviewCloseInput) -> Result<(), ClientError> {
        let payload = serde_json::to_value(input)?;
        self.call_json(TAG_PREVIEW_CLOSE, payload).await.map(|_| ())
    }

    /// Registers a desktop-hosted browser tab with the server relay (`preview.desktopRegister`).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] on transport, codec, or server RPC failure (e.g.
    /// `DesktopTabRelayError` with reason `binding` or `conflict`).
    pub async fn preview_desktop_register(
        &self,
        binding: &DesktopTabBinding,
    ) -> Result<DesktopTabConnection, ClientError> {
        self.call(TAG_PREVIEW_DESKTOP_REGISTER, binding).await
    }

    /// Subscribes to the request stream for a desktop tab registration (`preview.desktopRequests`).
    #[must_use]
    pub fn preview_desktop_requests(&self, connection_id: &str) -> DesktopRequestStream {
        let payload = json!({ "connectionId": connection_id });
        let (stream_id, rx) = self.stream_json(TAG_PREVIEW_DESKTOP_REQUESTS, payload);
        DesktopRequestStream {
            connection: self.clone(),
            stream_id,
            rx,
        }
    }

    /// Answers an agent automation request received on [`DesktopRequestStream`]
    /// (`preview.desktopRespond`).
    ///
    /// # Errors
    ///
    /// Returns [`ClientError`] on transport, codec, or server RPC failure.
    pub async fn preview_desktop_respond(
        &self,
        response: &PreviewAutomationResponse,
    ) -> Result<(), ClientError> {
        let payload = serde_json::to_value(response)?;
        self.call_json(TAG_PREVIEW_DESKTOP_RESPOND, payload)
            .await
            .map(|_| ())
    }

    /// Subscribes to preview lifecycle events (`subscribePreviewEvents`).
    #[must_use]
    pub fn subscribe_preview_events(&self) -> PreviewEventsStream {
        let (stream_id, rx) = self.stream_json(TAG_SUBSCRIBE_PREVIEW_EVENTS, json!({}));
        PreviewEventsStream {
            connection: self.clone(),
            stream_id,
            rx,
        }
    }
}

impl DesktopRequests for DesktopRequestStream {
    fn next(
        &mut self,
    ) -> Pin<Box<dyn Future<Output = Option<PreviewAutomationStreamEvent>> + Send + '_>> {
        Box::pin(async move {
            loop {
                // An event this client cannot decode is not a request for it.
                if let Ok(event) = self.recv().await? {
                    return Some(event);
                }
            }
        })
    }
}

impl PreviewApi for Connection {
    fn open(&self, input: PreviewOpenInput) -> ApiFuture<PreviewSessionSnapshot> {
        let connection = self.clone();
        Box::pin(async move { connection.preview_open(&input).await })
    }
    fn close(&self, input: PreviewCloseInput) -> ApiFuture<()> {
        let connection = self.clone();
        Box::pin(async move { connection.preview_close(&input).await })
    }
    fn report_status(&self, input: PreviewReportStatusInput) -> ApiFuture<()> {
        let connection = self.clone();
        Box::pin(async move { connection.preview_report_status(&input).await })
    }
    fn list(&self, thread_id: String) -> ApiFuture<PreviewListResult> {
        let connection = self.clone();
        Box::pin(async move { connection.preview_list(&thread_id).await })
    }
    fn register(&self, binding: DesktopTabBinding) -> ApiFuture<DesktopTabConnection> {
        let connection = self.clone();
        Box::pin(async move { connection.preview_desktop_register(&binding).await })
    }
    fn requests(&self, connection_id: &str) -> Box<dyn DesktopRequests> {
        Box::new(self.preview_desktop_requests(connection_id))
    }
    fn respond(&self, response: PreviewAutomationResponse) -> ApiFuture<()> {
        let connection = self.clone();
        Box::pin(async move { connection.preview_desktop_respond(&response).await })
    }
    fn resize(&self, input: PreviewResizeInput) -> ApiFuture<PreviewSessionSnapshot> {
        let connection = self.clone();
        Box::pin(async move { connection.preview_resize(&input).await })
    }
    fn adjust(&self, input: PreviewAdjustInput) -> ApiFuture<PreviewSessionSnapshot> {
        let connection = self.clone();
        Box::pin(async move { connection.preview_adjust(&input).await })
    }
}

/// Checks whether a [`ClientError::Rpc`] carries `DesktopTabRelayError` with the given `reason`
/// (`"binding"`, `"session"`, or `"conflict"`).
#[must_use]
pub fn is_desktop_relay_error_reason(err: &ClientError, expected_reason: &str) -> bool {
    let ClientError::Rpc(val) = err else {
        return false;
    };
    fn matches(v: &Value, expected: &str) -> bool {
        if v.get("_tag").and_then(Value::as_str) == Some("DesktopTabRelayError")
            && v.get("reason").and_then(Value::as_str) == Some(expected)
        {
            return true;
        }
        if let Some(reasons) = v.get("reasons").and_then(Value::as_array) {
            return reasons.iter().any(|r| {
                r.get("error").is_some_and(|e| matches(e, expected))
                    || r.get("defect").is_some_and(|d| matches(d, expected))
            });
        }
        false
    }
    matches(val, expected_reason)
}

#[cfg(test)]
mod tests {
    use super::*;
    use conn_contract::{
        PreviewAutomationOperation, PreviewAutomationRequest, PreviewAutomationResponseError,
        PreviewNavStatus, PreviewNavStatusIdle, PreviewOpenInputRuntime, PreviewViewportSetting,
        PreviewViewportSettingFill, lit,
    };

    #[test]
    fn desktop_relay_error_reason_matches_flat_and_wrapped_cause() {
        let flat = ClientError::Rpc(json!({
            "_tag": "DesktopTabRelayError",
            "reason": "binding"
        }));
        assert!(
            is_desktop_relay_error_reason(&flat, "binding"),
            "flat DesktopTabRelayError must match"
        );
        assert!(
            !is_desktop_relay_error_reason(&flat, "conflict"),
            "wrong reason must not match"
        );

        let wrapped = ClientError::Rpc(json!({
            "_tag": "Fail",
            "reasons": [{
                "_tag": "Fail",
                "error": { "_tag": "DesktopTabRelayError", "reason": "conflict" }
            }]
        }));
        assert!(
            is_desktop_relay_error_reason(&wrapped, "conflict"),
            "Effect Cause-wrapped DesktopTabRelayError must match"
        );
    }

    #[test]
    fn contract_types_roundtrip_wire_json() {
        let open = PreviewOpenInput {
            thread_id: "thread-1".to_owned(),
            url: None,
            viewport: Some(PreviewViewportSetting::Fill(PreviewViewportSettingFill {
                tag: lit::Fill,
            })),
            profile_id: None,
            runtime: Some(PreviewOpenInputRuntime::Desktop),
            color_scheme: None,
            zoom_factor: None,
            reveal: None,
        };
        let encoded = serde_json::to_value(&open).expect("PreviewOpenInput serializes");
        assert_eq!(encoded["threadId"], "thread-1", "threadId camelCase");
        assert_eq!(encoded["runtime"], "desktop", "runtime desktop");
        assert!(
            encoded.get("url").is_none(),
            "empty tab omits url for Idle snapshot"
        );

        let snapshot = PreviewSessionSnapshot {
            thread_id: "thread-1".to_owned(),
            tab_id: "tab_1_epoch".to_owned(),
            nav_status: PreviewNavStatus::Idle(PreviewNavStatusIdle { tag: lit::Idle }),
            can_go_back: false,
            can_go_forward: false,
            viewport: Some(PreviewViewportSetting::Fill(PreviewViewportSettingFill {
                tag: lit::Fill,
            })),
            color_scheme: None,
            zoom_factor: None,
            profile_id: None,
            runtime: Some(PreviewOpenInputRuntime::Desktop),
            host: None,
            hosted_here: None,
            headless: None,
            automation_owner: None,
            reveal: None,
            reveal_request: None,
            updated_at: "2026-11-25T15:00:00Z".to_owned(),
        };
        let binding = DesktopTabBinding {
            environment_id: "env-1".to_owned(),
            thread_id: "thread-1".to_owned(),
            tab_id: "tab_1_epoch".to_owned(),
            device_name: "Mac".to_owned(),
            snapshot,
        };
        let binding_json = serde_json::to_value(&binding).expect("DesktopTabBinding serializes");
        assert_eq!(
            binding_json["snapshot"]["navStatus"]["_tag"], "Idle",
            "Idle navStatus preserved"
        );

        let req_json = json!({
            "type": "request",
            "connectionId": "conn-1",
            "request": {
                "requestId": "preview-0",
                "threadId": "thread-1",
                "tabId": "tab_1_epoch",
                "operation": "status",
                "input": {},
                "timeoutMs": 15000
            }
        });
        let event: PreviewAutomationStreamEvent =
            serde_json::from_value(req_json).expect("request stream event decodes");
        match event {
            PreviewAutomationStreamEvent::Request(ev) => {
                assert_eq!(
                    ev.request.operation,
                    PreviewAutomationOperation::Status,
                    "operation decodes"
                );
                let _: PreviewAutomationRequest = ev.request;
            }
            PreviewAutomationStreamEvent::Connected(_) => panic!("expected request event"),
        }

        let response = PreviewAutomationResponse {
            client_id: "desktop".to_owned(),
            connection_id: "conn-1".to_owned(),
            request_id: "preview-0".to_owned(),
            ok: false,
            result: None,
            error: Some(PreviewAutomationResponseError {
                tag: "PreviewAutomationExecutionError".to_owned(),
                message: "Not supported on desktop tabs: cdpEndpoint.".to_owned(),
                detail: None,
            }),
        };
        let resp_json = serde_json::to_value(&response).expect("response serializes");
        assert_eq!(resp_json["ok"], false, "ok flag serialized");
        assert_eq!(
            resp_json["error"]["_tag"], "PreviewAutomationExecutionError",
            "error tag serialized"
        );
    }
}
