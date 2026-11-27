//! `scheduledTasks.*`: the service in `conn_features::scheduled`. Owner: the Conn-only areas
//! track. Webhook deliveries arrive on `/api/hooks/...` (`routes/hooks.rs`).
//!
//! Scopes: `scopes.rs`. As the T3 server (`withVisibleWebhookUrls`), the list stream shows a
//! webhook task's URL only to sessions with `orchestration:operate`: the URL starts agents.

use std::sync::Arc;

use conn_contract::{
    ScheduledTaskGetWebhookDeliveryInput, ScheduledTaskListWebhookDeliveriesInput,
    ScheduledTaskSetEnabledInput, to_json,
};
use conn_engine::BoxFuture;
use conn_features::scheduled::{
    Config, EngineRunner, Failure as TaskFailure, ScheduledTasks, TaskError, UpsertInput,
};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;

use super::Deps;
use crate::{
    modules::{Boot, Module},
    table::{Failure, MethodTable},
};

/// The scheduled tasks module: the store and its timer, `scheduledTasks.*`, the webhook route
/// and the agent's schedule tools. Deleting a thread removes its tasks through the `Host` slot.
pub(crate) const MODULE: Module = Module {
    name: "scheduled-tasks",
    start,
    methods: register,
    routes: crate::routes::hooks::router,
    tools: &[
        "schedule_task",
        "list_scheduled_tasks",
        "delete_scheduled_task",
        "run_scheduled_task_now",
    ],
    // One-time and fresh-session schedules, which mobile gates on.
    capabilities: |capabilities| {
        capabilities.one_time_schedules = Some(true);
        capabilities.scheduled_task_thread_modes = Some(true);
    },
};

fn start<'a>(boot: &'a Boot<'a>, deps: &'a mut Deps) -> BoxFuture<'a, ()> {
    Box::pin(async move {
        let tasks = ScheduledTasks::start(Config {
            state_dir: boot.state_dir.to_owned(),
            clock: Arc::new(conn_features::clock::SystemClock),
            zone: jiff::tz::TimeZone::system(),
            runner: Arc::new(EngineRunner::new(boot.engine.clone())),
            secret_requests: deps.secrets.clone(),
            // A rehearsal copy holds the original's tasks: it must run none of them.
            start_timer: !crate::serve::inert(),
        })
        .await;
        let _ = boot.host.scheduled_tasks.set(tasks.clone());
        deps.scheduled_tasks = Some(tasks);
    })
}

/// `ScheduledTaskDeleteInput` and `ScheduledTaskRunNowInput`: `{id}`.
#[derive(Debug, Deserialize)]
struct IdInput {
    id: String,
}

fn task_failure(error: &TaskError) -> Failure {
    Failure::Fail(error.to_contract())
}

fn register(table: &mut MethodTable, deps: &Deps) {
    let Some(service) = deps.scheduled_tasks.clone() else {
        return;
    };

    let tasks = service.clone();
    table.stream("scheduledTasks.subscribe", move |ctx, _: Value| {
        let mut updates = tasks.subscribe();
        let sees_urls = ctx
            .principal
            .as_ref()
            .is_none_or(|p| p.has_scope("orchestration:operate"));
        async move {
            let (tx, rx) = mpsc::channel(1);
            tokio::spawn(async move {
                while let Some(mut list) = updates.recv().await {
                    if !sees_urls {
                        for task in list.tasks.iter_mut().flatten() {
                            task.webhook = None;
                        }
                    }
                    if tx.send(Ok(to_json(&list))).await.is_err() {
                        return;
                    }
                }
            });
            Ok(rx)
        }
    });

    let tasks = service.clone();
    table.unary("scheduledTasks.upsert", move |_, input: UpsertInput| {
        let tasks = tasks.clone();
        async move {
            match tasks.upsert(input).await {
                Ok(task) => Ok(json!({ "task": task })),
                Err(TaskFailure::Task(error)) => Err(task_failure(&error)),
                // A payload the contract's schema refuses: a defect, as Effect answers it.
                Err(TaskFailure::Invalid(message)) => Err(Failure::die(message)),
            }
        }
    });

    let tasks = service.clone();
    table.unary(
        "scheduledTasks.setEnabled",
        move |_, input: ScheduledTaskSetEnabledInput| {
            let tasks = tasks.clone();
            async move {
                tasks
                    .set_enabled(&input.id, input.enabled)
                    .await
                    .map(|task| json!({ "task": task }))
                    .map_err(|e| task_failure(&e))
            }
        },
    );

    let tasks = service.clone();
    table.unary("scheduledTasks.delete", move |_, input: IdInput| {
        let tasks = tasks.clone();
        async move {
            tasks
                .delete(&input.id)
                .await
                .map(|id| json!({ "id": id }))
                .map_err(|e| task_failure(&e))
        }
    });

    let tasks = service.clone();
    table.unary(
        "scheduledTasks.rotateWebhookToken",
        move |_, input: IdInput| {
            let tasks = tasks.clone();
            async move {
                tasks
                    .rotate_webhook_token(&input.id)
                    .await
                    .map(|task| json!({ "task": task }))
                    .map_err(|e| task_failure(&e))
            }
        },
    );

    let tasks = service.clone();
    table.unary(
        "scheduledTasks.listWebhookDeliveries",
        move |_, input: ScheduledTaskListWebhookDeliveriesInput| {
            let tasks = tasks.clone();
            async move {
                tasks
                    .list_webhook_deliveries(&input.id, input.accept_any_outcome == Some(true))
                    .await
                    .map(|deliveries| json!({ "deliveries": deliveries }))
                    .map_err(|e| task_failure(&e))
            }
        },
    );

    let tasks = service.clone();
    table.unary(
        "scheduledTasks.getWebhookDelivery",
        move |_, input: ScheduledTaskGetWebhookDeliveryInput| {
            let tasks = tasks.clone();
            async move {
                tasks
                    .get_webhook_delivery(
                        &input.id,
                        &input.delivery_id,
                        input.accept_any_outcome == Some(true),
                    )
                    .await
                    .map(|delivery| json!({ "delivery": delivery }))
                    .map_err(|e| task_failure(&e))
            }
        },
    );

    let tasks: ScheduledTasks = service;
    table.unary("scheduledTasks.runNow", move |_, input: IdInput| {
        let tasks = tasks.clone();
        async move {
            // The contract's result is `{task}`; the thread is for `/mcp`.
            tasks
                .run_now(&input.id)
                .await
                .map(|outcome| json!({ "task": outcome.task }))
                .map_err(|e| task_failure(&e))
        }
    });
}
