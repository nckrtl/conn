# Session recordings

Real client sessions against the TypeScript server at the contract of this tree, and against
the Conn Server (`rust-*`). They are the ground truth for what a Conn client sends and
expects, and the first replay input for `conn-server`. [CONNECT.md](CONNECT.md) reads them for you.

## Files

| Path                              | Holds                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------- |
| `sessions/<scenario>.ndjson`      | One wire frame per line: `{"dir","ms","ws","frame"}`, plus `"parts"` if split |
| `sessions/<scenario>.http.ndjson` | HTTP calls to the same server, the `/ws` upgrade URLs, and socket closes      |
| `recorder/summarize.mjs`          | Prints one recording as a timeline of HTTP calls and RPCs                     |
| `recorder/compare.mjs`            | Pairs the calls of two recordings and diffs their answers                     |
| `recorder/compare-terminal.mjs`   | Prints a terminal recording as a timeline                                     |
| `decode-check/`                   | Rust test: every frame decodes with `conn_wire`                               |

Line format, as the workspace README fixes it, with two additions:

- `dir`: `in` is client → server (`FromClient`), `out` is server → client (`FromServer`).
- `ms`: milliseconds since the first recorded `/ws` socket opened. HTTP entries before it are
  negative.
- `ws` (added): which socket of the page carried the frame (0, 1, ...). The `.http.ndjson` file
  has the upgrade URL for each index. A page opens a new socket after a full navigation.
- `parts` (added): the server sent this frame as that many
  [frame parts](../README.md#the-wire); the line holds the joined frame.

## Scenarios

| Scenario                                                        | What happens                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairing`                                                       | A fresh browser opens `/pair#token=…` on a fresh server and lands in the app                                                                            |
| `reconnect`                                                     | The same browser (session cookie) opens `/` again                                                                                                       |
| `turn`                                                          | New thread in the project, Claude Haiku 5.5, one short message, one full turn                                                                           |
| `permission`                                                    | New thread in Supervised mode; Claude asks to run `echo conn-recording`; the user approves once                                                         |
| `interrupt`                                                     | New thread; Claude runs `ping -c 30 127.0.0.1` (approved); the user stops the turn while it runs                                                        |
| `remote`                                                        | From Settings › Connections, pair a second fresh server as a remote environment                                                                         |
| `terminal`                                                      | On a draft: terminal drawer, `echo`, resize, reload (scrollback returns), 50 MB `yes`, close                                                            |
| `rust-attachment`, `rust-worktree`, `rust-mcp`, `rust-subagent` | Claude names an uploaded image's colour; a launch into a new worktree; Claude calls `conn_thread_list` over `/mcp`; a subagent row opens its child thread |
| `rust-*`                                                        | As `remote`, with the Rust `conn-server` as the remote environment (`--rust <binary>`)                                                                  |
| `rust-worktree-files`                                           | Claude writes a file in a new worktree; it is there and not in the root; the file tree opens a tracked file and the new one; the diff shows it         |
| `rust-review-added`                                             | A project added to the running server (`conn-server project add`); a thread in it; the diff panel shows its branch's changes                            |
| `rust-secrets`                                                  | A hub key stored from the client, a generator key seeded on disk; toggle the generator, reload: both keys real on disk, the client holds `••••••`       |
| `rust-model-switch`                                             | Two turns, Haiku 5.5 then Haiku 4.5: the client sends the new model, the thread keeps it, Claude's session log names it                                 |
| `rust-archive`                                                  | Archive a thread from its sidebar menu: gone from the list, listed in Settings › Archive, restored by Unarchive                                         |
| `rust-two-clients`                                              | A second browser context opens the thread; it sees the first client's next turn run and its reply arrive, with no reload                                |
| `rust-stop-continue`                                            | `rust-stop`, then the same thread takes the next message                                                                                                |
| `rust-memory`                                                   | Three turns, then the idle session closes; samples the server and its SDK host at each step                                                             |
| `ts-*`                                                          | The same drivers as `rust-follow-up`, `rust-queue`, `rust-search`, with a paired TypeScript server, for side-by-side comparison                         |
| `*-files`                                                       | Favicon, `@` search, image upload, content search, open a file; no model call                                                                           |

The server starts with `--auto-bootstrap-project-from-cwd` in a scratch git repo, so it has one
project and one empty thread before the client arrives. `pairing` therefore lands on that thread,
not on an empty list. `remote` records only the second server's traffic.

## Read them

The recorder that drove the web client (`record.mjs`, its scenarios and `rust-scenarios.sh`)
was removed with the TypeScript checks; these recordings are frozen. To read them:

```sh
cargo test --manifest-path fixtures/decode-check/Cargo.toml -- --nocapture
node fixtures/recorder/summarize.mjs turn
node fixtures/recorder/compare.mjs ts-queue rust-queue
```

`recorder/compare.mjs <a> <b> [tag prefix ...]` pairs the calls of two recordings (names in
`sessions/` or paths to `.ndjson` files) and diffs their answers, for the `ts-`/`rust-` pairs.
`recorder/compare-terminal.mjs <recording>` prints a terminal recording as a timeline.

## Redaction

The recorder redacted every line before it wrote it, keeping shapes and lengths:

- Values under secret-like keys become `<redacted:N>` (N is the original length): tokens,
  tickets, credentials, cookies, `authorization` (the scheme stays: `Bearer <redacted:N>`), DPoP
  proofs, `clientDevice`, and account ids (`workspaceId`, `accountId`, `organizationId`,
  `userId`).
- Each such value, the pairing token, and every browser cookie value is also replaced wherever
  else it appears, URL-encoded or not, such as `wsTicket=` on a `/ws` URL or a form body.
- The home directory becomes `/Users/user`, the login name and host label become `user`, and
  email addresses become `user@example.com`. JWT-shaped strings and `sk-…` keys are removed.

A redacted value no longer matches its schema (a redacted id is not a UUID), so contract
round-trips must skip those fields.

Before you commit a recording made another way, search it for: the login name, `/Users/` followed by
anything but `user`, `eyJ`, `sk-`, `Bearer ` or `DPoP ` followed by anything but `<redacted`,
and `wsTicket=` followed by anything but `<redacted>`.
