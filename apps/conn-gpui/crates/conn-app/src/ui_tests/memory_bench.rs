//! Retained-memory bench with a counting allocator. `heap` cannot see the Rust heap of the live
//! app (CEF's PartitionAlloc serves it), so this counts every allocation in the test process.
//!
//! It opens 30 threads with a loaded timeline each and stages 20 pasted 1920×1080 images in the
//! composer, drawing each, then leaves the threads (one more thread opens) and removes the
//! images. It prints the bytes still allocated against the start.
//!
//! ```text
//! cargo test -p conn-app --features memory-bench memory_bench -- --ignored --nocapture --test-threads=1
//! ```

use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicIsize, Ordering};

use conn_state::testkit::{SyntheticThread, synthetic_thread_snapshot_json};
use gpui_kit::test::TestWindowExt as _;
use gpui_kit::{AppContext as _, TestAppContext};
use serde_json::json;

use super::mount_app;

struct Counting;

static LIVE: AtomicIsize = AtomicIsize::new(0);

// SAFETY: every call forwards to the system allocator unchanged and only counts sizes.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::alloc`'s contract for `layout`.
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            LIVE.fetch_add(layout.size() as isize, Ordering::Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        // SAFETY: `ptr` came from `alloc` with this `layout`.
        unsafe { System.dealloc(ptr, layout) };
        LIVE.fetch_sub(layout.size() as isize, Ordering::Relaxed);
    }

    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        // SAFETY: the caller upholds `GlobalAlloc::realloc`'s contract.
        let new = unsafe { System.realloc(ptr, layout, new_size) };
        if !new.is_null() {
            LIVE.fetch_add(
                new_size as isize - layout.size() as isize,
                Ordering::Relaxed,
            );
        }
        new
    }
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

const THREADS: usize = 30;
const IMAGES: usize = 20;

fn live() -> isize {
    LIVE.load(Ordering::Relaxed)
}

fn mib(bytes: isize) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

fn thread_id(i: usize) -> String {
    format!("bench-{i:02}")
}

fn bench_shell() -> conn_state::ShellState {
    let project: conn_state::ProjectShell = conn_contract::from_json(json!({
        "id": "proj-bench", "title": "bench", "workspaceRoot": "/tmp/bench",
        "defaultModelSelection": null, "scripts": [],
        "createdAt": "2026-11-20T09:00:00.000Z", "updatedAt": "2026-11-26T22:00:00.000Z"
    }))
    .expect("project decodes");
    let threads = (0..=THREADS)
        .map(|i| {
            let id = thread_id(i);
            conn_contract::from_json(json!({
                "createdBy": "user", "creationSource": "web", "id": id, "projectId": "proj-bench",
                "title": format!("Thread {id}"), "providerInstanceId": "claude-default",
                "modelSelection": { "provider": "claude", "model": "claude-sonnet-4-6" },
                "runtimeMode": "auto-accept-edits", "interactionMode": "default",
                "branch": "main", "worktreePath": null,
                "lineage": { "parentThreadId": null, "relationshipToParent": null, "rootThreadId": id },
                "forkedFrom": null, "activeProviderThreadId": null, "latestRunId": "run-1",
                "activeRunId": null, "activityRunStatus": null, "status": "completed",
                "pendingRuntimeRequest": null, "latestVisibleMessage": null,
                "latestUserMessageAt": "2026-11-26T22:00:00.000Z",
                "hasActionableProposedPlan": false, "itemCount": 2, "visibleItemCount": 2,
                "pinnedAt": null, "pinOrderKey": null, "settledOverride": null,
                "settledAt": null, "archivedAt": null,
                "lastVisitedAt": "2026-11-26T22:00:00.000Z",
                "createdAt": "2026-11-26T21:00:00.000Z", "updatedAt": "2026-11-26T22:00:00.000Z",
            }))
            .expect("thread decodes")
        })
        .collect();
    let mut shell = conn_state::ShellState::from_parts(vec![project], threads, Vec::new(), Some(1));
    shell.synchronized = true;
    shell
}

/// A thread's snapshot with 40 turns, each a 4 KB answer and two 2 KB command outputs.
fn snapshot(id: &str) -> conn_contract::OrchestrationV2ThreadStreamItem {
    let mut value: serde_json::Value =
        serde_json::from_str(&synthetic_thread_snapshot_json(SyntheticThread {
            turns: 40,
            commands_per_turn: 2,
            command_output_bytes: 2_000,
            assistant_bytes: 4_000,
        }))
        .expect("synthetic snapshot");
    value["snapshotSequence"] = json!(20);
    value["projection"]["thread"]["id"] = json!(id);
    conn_contract::from_json(value).expect("snapshot decodes")
}

/// A 1920×1080 PNG screenshot stand-in; `seed` makes each one's bytes (its cache key) distinct.
fn png(seed: u8) -> Vec<u8> {
    let picture = image::RgbaImage::from_fn(1920, 1080, |x, y| {
        image::Rgba([(x % 256) as u8, (y % 256) as u8, seed, 255])
    });
    let mut bytes = Vec::new();
    picture
        .write_to(
            &mut std::io::Cursor::new(&mut bytes),
            image::ImageFormat::Png,
        )
        .expect("encode PNG");
    bytes
}

#[gpui_kit::test]
#[ignore = "bench: run on its own with --features memory-bench"]
fn memory_bench(cx: &mut TestAppContext) {
    let (window, app) = mount_app(cx);
    let frames = |cx: &mut TestAppContext| {
        for _ in 0..3 {
            let _ = cx.update_window(window, |_, w, cx| w.render_frame(cx));
            cx.run_until_parked();
        }
    };
    let pngs: Vec<Vec<u8>> = (0..IMAGES).map(|i| png(i as u8)).collect();
    cx.update(|cx| app.update(cx, |app, cx| app.set_shell(bench_shell(), cx)));
    frames(cx);
    let start = live();

    // Open 30 threads, each loading its timeline.
    for i in 0..THREADS {
        let id = thread_id(i);
        cx.update(|cx| {
            app.update(cx, |app, cx| {
                app.select_thread(id.clone(), cx);
                app.apply_thread_item_for_test(&id, snapshot(&id), cx);
            })
        });
        frames(cx);
    }
    let threads_open = live();

    // Paste 20 images into the composer; each chip draws.
    let composer = cx.read(|cx| app.read(cx).chat_for_test().read(cx).composer_for_test());
    let mut staged = Vec::new();
    for (i, bytes) in pngs.iter().enumerate() {
        let id = cx
            .update_window(window, |_, window, cx| {
                composer.update(cx, |composer, cx| {
                    composer.stage_image_for_test(
                        &format!("shot-{i}.png"),
                        "image/png",
                        bytes.clone(),
                        window,
                        cx,
                    )
                })
            })
            .expect("window");
        staged.push(id);
        frames(cx);
    }
    frames(cx);
    let images_shown = live();

    // Leave the threads and remove the images.
    cx.update(|cx| {
        app.update(cx, |app, cx| app.select_thread(thread_id(THREADS), cx));
        composer.update(cx, |composer, cx| {
            for id in &staged {
                composer.remove_attachment_for_test(*id, cx);
            }
        });
    });
    frames(cx);
    frames(cx);
    let end = live();

    println!(
        "memory_bench: after {THREADS} threads +{:.1} MiB; after {IMAGES} images +{:.1} MiB; \
         retained after closing +{:.1} MiB ({} bytes); resident timelines {}",
        mib(threads_open - start),
        mib(images_shown - start),
        mib(end - start),
        end - start,
        cx.read(|cx| app.read(cx).resident_threads_for_test().len()),
    );
}
