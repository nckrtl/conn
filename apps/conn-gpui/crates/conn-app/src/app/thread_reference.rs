//! Copy > Thread (`threadChipCopyTarget` through `copyThreadReference`): a plain link that opens
//! the thread from anywhere. A T3 composer turns the pasted link into a thread chip
//! (`threadLinkContextReferences`), titled from the threads it knows, else "Thread".
//!
//! The link names the environment by the id its own server reports (`server.getConfig`
//! `environment.environmentId`). Until that id is known there is no link to copy: the menu row is
//! disabled, and no stand-in id is used, because an Orbit target id can differ from it.
//!
//! T3 also writes a chip fragment under its own clipboard type. GPUI cannot write that type, and
//! the paste above does not need it, so only the text is copied.

use std::fmt::Write as _;

use gpui_kit::{ClipboardItem, Context};

use super::ConnApp;
use crate::sidebar::thread_menu::{ThreadMenuAction, ThreadMenuItem};

/// `DEFAULT_HOSTED_APP_URL`. Native has no build-time override like `VITE_HOSTED_APP_URL`.
const HOSTED_APP_URL: &str = "https://app.t3.codes";

/// What a click that raced with losing the id shows, in the composer's error banner.
const COPY_THREAD_UNAVAILABLE: &str =
    "Can't copy this thread yet: its environment has not reported its id. Try again in a moment.";

/// `hostedThreadLink`: `encodeURIComponent` on each id, then `.!~*'()` too, so a sentence's
/// closing period never joins an id.
fn hosted_thread_link(environment_id: &str, thread_id: &str) -> String {
    format!(
        "{HOSTED_APP_URL}/threads/{}/{}",
        hosted_segment(environment_id),
        hosted_segment(thread_id)
    )
}

fn hosted_segment(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for byte in id.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_') {
            out.push(char::from(byte));
        } else {
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

impl ConnApp {
    /// The id `thread_id`'s server gives itself: its linked environment's, else the primary
    /// connection's. `None` until that environment's config has loaded, which a saved linked
    /// environment listed while asleep has not.
    fn thread_reference_environment(&self, thread_id: &str) -> Option<String> {
        let config = match self.linked_environment_of_thread(thread_id) {
            Some(linked) => self.linked_server_config(linked)?,
            None => self.server_config.as_ref(),
        };
        config.environment_id().map(str::to_owned)
    }

    /// Disables Copy > Thread in `items` while `thread_id`'s environment id is unknown.
    pub(super) fn disable_copy_thread_until_known(
        &self,
        thread_id: &str,
        items: &mut [ThreadMenuItem],
    ) {
        if self.thread_reference_environment(thread_id).is_some() {
            return;
        }
        let rows = items
            .iter_mut()
            .filter(|item| item.action == ThreadMenuAction::Copy)
            .flat_map(|copy| copy.children.iter_mut())
            .filter(|row| row.action == ThreadMenuAction::CopyThread);
        for row in rows {
            row.disabled = true;
        }
    }

    /// Copy > Thread. The clipboard stays as it was when the id is unknown.
    pub(super) fn copy_thread_reference(&mut self, thread_id: &str, cx: &mut Context<'_, Self>) {
        let Some(environment) = self.thread_reference_environment(thread_id) else {
            self.chat.update(cx, |chat, cx| {
                chat.set_error(Some(COPY_THREAD_UNAVAILABLE.to_owned()), cx);
            });
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(hosted_thread_link(
            &environment,
            thread_id,
        )));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use conn_contract::{ServerConfigStreamEvent, from_json};
    use conn_state::providers::ServerConfigState;
    use conn_state::{ProjectShell, ShellState, ThreadShell};
    use gpui_kit::{AnyWindowHandle, AppContext as _, Entity, TestAppContext};
    use serde_json::{Value, json};

    use super::*;
    use crate::ui_tests::mount_app;

    #[test]
    fn ids_are_escaped_like_hosted_thread_link() {
        // The expected links come from running `hostedThreadLink` in Node.
        assert_eq!(
            hosted_thread_link("env-1", "thread-1"),
            "https://app.t3.codes/threads/env-1/thread-1"
        );
        assert_eq!(
            hosted_thread_link("env/1", "thread:a.b"),
            "https://app.t3.codes/threads/env%2F1/thread%3Aa%2Eb"
        );
        assert_eq!(
            hosted_thread_link("é env", "t (1)!"),
            "https://app.t3.codes/threads/%C3%A9%20env/t%20%281%29%21"
        );
    }

    fn thread_json(id: &str, project_id: &str, title: &str) -> Value {
        json!({
            "createdBy": "user",
            "creationSource": "web",
            "id": id,
            "projectId": project_id,
            "title": title,
            "providerInstanceId": "claude-default",
            "modelSelection": { "provider": "claude", "model": "claude-sonnet-4-6" },
            "runtimeMode": "auto-accept-edits",
            "interactionMode": "default",
            "branch": null,
            "worktreePath": null,
            "lineage": { "parentThreadId": null, "relationshipToParent": null, "rootThreadId": id },
            "forkedFrom": null,
            "activeProviderThreadId": null,
            "latestRunId": null,
            "activeRunId": null,
            "activityRunStatus": null,
            "status": "completed",
            "pendingRuntimeRequest": null,
            "latestVisibleMessage": null,
            "latestUserMessageAt": "2026-11-22T15:00:00.000Z",
            "hasActionableProposedPlan": false,
            "itemCount": 2,
            "visibleItemCount": 2,
            "pinnedAt": null,
            "pinOrderKey": null,
            "settledOverride": null,
            "settledAt": null,
            "archivedAt": null,
            "lastVisitedAt": "2026-11-22T14:00:00.000Z",
            "createdAt": "2026-11-22T12:00:00.000Z",
            "updatedAt": "2026-11-22T15:10:00.000Z",
            "latestRun": null,
        })
    }

    fn shell_with_thread(project_id: &str, thread_id: &str, title: &str) -> ShellState {
        let project: ProjectShell = match from_json(json!({
            "id": project_id,
            "title": "orbit",
            "workspaceRoot": "/work/orbit",
            "defaultModelSelection": null,
            "scripts": [],
            "createdAt": "2026-11-20T09:00:00.000Z",
            "updatedAt": "2026-11-22T15:00:00.000Z",
        })) {
            Ok(project) => project,
            Err(err) => panic!("ProjectShell failed: {err}"),
        };
        let thread: ThreadShell = match from_json(thread_json(thread_id, project_id, title)) {
            Ok(thread) => thread,
            Err(err) => panic!("ThreadShell failed: {err}"),
        };
        ShellState::from_parts(vec![project], vec![thread], Vec::new(), Some(1))
    }

    /// The config a server of descriptor id `environment_id` reports (a recorded `snapshot`).
    fn config_of(environment_id: &str) -> Arc<ServerConfigState> {
        let mut snapshot: Value = match serde_json::from_str(include_str!(
            "../../../../../../crates/conn-state/tests/fixtures/server-config-snapshot.json"
        )) {
            Ok(snapshot) => snapshot,
            Err(err) => panic!("server config fixture is not JSON: {err}"),
        };
        snapshot["config"]["environment"]["environmentId"] = json!(environment_id);
        let event: ServerConfigStreamEvent = match from_json(snapshot) {
            Ok(event) => event,
            Err(err) => panic!("server config fixture failed: {err}"),
        };
        let mut state = ServerConfigState::new();
        state.apply(event);
        Arc::new(state)
    }

    fn run_action(
        cx: &mut TestAppContext,
        window: AnyWindowHandle,
        app: &Entity<ConnApp>,
        thread_id: &str,
        action: ThreadMenuAction,
    ) {
        let thread_id = thread_id.to_owned();
        let _ = cx.update_window(window, |_, window, cx| {
            app.update(cx, |app, cx| {
                app.run_thread_menu_action(thread_id, action, window, cx);
            });
        });
    }

    fn clipboard_text(cx: &mut TestAppContext) -> Option<String> {
        cx.read(|cx| cx.read_from_clipboard().and_then(|item| item.text()))
    }

    fn put_on_clipboard(cx: &mut TestAppContext, text: &str) {
        cx.update(|cx| cx.write_to_clipboard(ClipboardItem::new_string(text.to_owned())));
    }

    /// Whether `Copy > Thread` and `Copy > Thread ID` are disabled in the menu of `thread_id`.
    fn copy_rows_disabled(
        cx: &mut TestAppContext,
        app: &Entity<ConnApp>,
        thread_id: &str,
    ) -> (bool, bool) {
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.open_thread_menu(thread_id.to_owned(), gpui_kit::Point::default(), cx);
                let items = app
                    .thread_menu
                    .as_ref()
                    .and_then(|anchor| app.thread_menu_items(anchor))
                    .unwrap_or_default();
                let disabled = |action| {
                    items
                        .iter()
                        .filter(|item| item.action == ThreadMenuAction::Copy)
                        .flat_map(|copy| copy.children.iter())
                        .find(|row| row.action == action)
                        .map(|row| row.disabled)
                };
                let (Some(thread), Some(id)) = (
                    disabled(ThreadMenuAction::CopyThread),
                    disabled(ThreadMenuAction::CopyThreadId),
                ) else {
                    panic!("the Copy submenu must list Thread and Thread ID");
                };
                (thread, id)
            })
        })
    }

    #[gpui_kit::test]
    fn copy_thread_on_a_url_only_connection_uses_the_descriptor_id(cx: &mut TestAppContext) {
        let (window, app) = mount_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                // No Orbit target: the connection is an address and nothing else.
                app.server_url = Some("http://127.0.0.1:3891".to_owned());
                app.server_config = config_of("desc-local");
                app.set_shell(shell_with_thread("proj-a", "thread-local", "Local"), cx);
            });
        });
        assert_eq!(
            copy_rows_disabled(cx, &app, "thread-local"),
            (false, false),
            "Copy > Thread is enabled once the id is known"
        );

        run_action(
            cx,
            window,
            &app,
            "thread-local",
            ThreadMenuAction::CopyThread,
        );
        assert_eq!(
            clipboard_text(cx).as_deref(),
            Some("https://app.t3.codes/threads/desc-local/thread-local")
        );

        run_action(
            cx,
            window,
            &app,
            "thread-local",
            ThreadMenuAction::CopyThreadId,
        );
        assert_eq!(clipboard_text(cx).as_deref(), Some("thread-local"));
    }

    #[gpui_kit::test]
    fn copy_thread_prefers_the_descriptor_id_over_the_orbit_target_id(cx: &mut TestAppContext) {
        let (window, app) = mount_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.orbit.active_server_id = Some("node-orbit".to_owned());
                app.server_config = config_of("desc-local");
                app.set_shell(shell_with_thread("proj-a", "thread-local", "Local"), cx);
            });
        });

        run_action(
            cx,
            window,
            &app,
            "thread-local",
            ThreadMenuAction::CopyThread,
        );
        assert_eq!(
            clipboard_text(cx).as_deref(),
            Some("https://app.t3.codes/threads/desc-local/thread-local")
        );
    }

    #[gpui_kit::test]
    fn copy_thread_on_a_linked_thread_names_its_own_servers_id(cx: &mut TestAppContext) {
        let (window, app) = mount_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.orbit.active_server_id = Some("node-primary".to_owned());
                app.server_config = config_of("desc-primary");
                app.set_shell(shell_with_thread("proj-a", "thread-local", "Local"), cx);
                // The Orbit target `mini`, whose server calls itself `desc-mini`.
                app.add_linked_shell_for_test(
                    "mini",
                    "mini",
                    shell_with_thread("proj-mini", "thread-mini", "Mini diagnostics"),
                    cx,
                );
                app.set_linked_config_for_test("mini", config_of("desc-mini"));
            });
        });
        assert_eq!(
            cx.read(|cx| app.read(cx).thread_environment_for_test("thread-mini")),
            Some("mini".to_owned())
        );
        assert_eq!(copy_rows_disabled(cx, &app, "thread-mini"), (false, false));

        run_action(
            cx,
            window,
            &app,
            "thread-mini",
            ThreadMenuAction::CopyThread,
        );
        assert_eq!(
            clipboard_text(cx).as_deref(),
            Some("https://app.t3.codes/threads/desc-mini/thread-mini")
        );

        // A thread of the primary environment still names the primary server.
        run_action(
            cx,
            window,
            &app,
            "thread-local",
            ThreadMenuAction::CopyThread,
        );
        assert_eq!(
            clipboard_text(cx).as_deref(),
            Some("https://app.t3.codes/threads/desc-primary/thread-local")
        );

        run_action(
            cx,
            window,
            &app,
            "thread-mini",
            ThreadMenuAction::CopyThreadId,
        );
        assert_eq!(clipboard_text(cx).as_deref(), Some("thread-mini"));
    }

    #[gpui_kit::test]
    fn copy_thread_is_disabled_and_leaves_the_clipboard_alone_while_the_id_is_unknown(
        cx: &mut TestAppContext,
    ) {
        let (window, app) = mount_app(cx);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                // An Orbit id the server never confirmed, and no config on either side.
                app.orbit.active_server_id = Some("node-primary".to_owned());
                app.set_shell(shell_with_thread("proj-a", "thread-local", "Local"), cx);
                // A cached peer: its snapshot is listed, its connection never reported a config.
                app.add_linked_shell_for_test(
                    "mini",
                    "mini",
                    shell_with_thread("proj-mini", "thread-mini", "Mini diagnostics"),
                    cx,
                );
            });
        });
        put_on_clipboard(cx, "before");

        for thread in ["thread-local", "thread-mini"] {
            assert_eq!(
                copy_rows_disabled(cx, &app, thread),
                (true, false),
                "{thread}: only Copy > Thread is disabled; Thread ID stays available"
            );
            // A click that raced with losing the id reaches the action itself.
            run_action(cx, window, &app, thread, ThreadMenuAction::CopyThread);
            assert_eq!(
                clipboard_text(cx).as_deref(),
                Some("before"),
                "{thread}: the clipboard is unchanged"
            );
            assert_eq!(
                cx.read(|cx| app.read(cx).chat_for_test().read(cx).error_for_test())
                    .as_deref(),
                Some(COPY_THREAD_UNAVAILABLE),
                "{thread}: the error notice says why"
            );
            cx.update(|cx| {
                let chat = app.read(cx).chat_for_test();
                chat.update(cx, |chat, cx| chat.set_error(None, cx));
            });
        }

        run_action(
            cx,
            window,
            &app,
            "thread-mini",
            ThreadMenuAction::CopyThreadId,
        );
        assert_eq!(clipboard_text(cx).as_deref(), Some("thread-mini"));

        // The config arrives: the same thread now copies.
        cx.update(|cx| {
            app.update(cx, |app, _| {
                app.set_linked_config_for_test("mini", config_of("desc-mini"));
            });
        });
        assert_eq!(copy_rows_disabled(cx, &app, "thread-mini"), (false, false));
    }
}
