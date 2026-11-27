# conn-source-control-core

The source control rules that the engine needs too. It sits below both `conn-engine` and
`conn-source-control`, so the engine never depends on a feature crate. Text in, text out: no
I/O, no async, no state.

| Path | Holds | T3 |
| --- | --- | --- |
| `src/registry/` | The host definition registry (`mod.rs`), its URL routes (`paths.rs`), thread link keys (`thread_keys.rs`) | `packages/source-control-core/src/shared/definition.ts`, `threadPullRequests.ts` |
| `src/remote.rs` | Clone URL and remote text, the canonical repository path and key | `packages/shared/src/cloneUrl.ts`, `git.ts` |
| `src/wake.rs` | A pull request watch's wake, and several wakes as one | `combinePullRequestWatchWakes` in `pullRequestWatch.ts` |

The engine reads two things here: a link's key (`registry::thread_keys`) when it decides
`thread.pull-request.link` and `unlink`, and `wake::combine` when it rebuilds a queued wake.
A key takes the registry's URL parser, which takes the remote text; that is why both moved
here whole.

`conn-source-control` shows `registry` as its own module and writes the wake texts
(`pull_requests/watch.rs`). The checks live there too: `tools/registry-diff.mjs` and
`tools/pr-watch-diff.mjs` run T3's functions and these on the same cases.

Put a rule here only when the engine needs it. Everything else about a host belongs in
`conn-source-control`.
