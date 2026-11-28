# conn-server

> [`docs/status.md`](docs/status.md) says where the work stands: what is proven, what is not,
> and what is left, in order. Nothing uses this server yet.

The Conn Server: our own Rust server for Conn clients. It serves the same client contract as
the T3 server (`apps/server` in the Conn monorepo, TypeScript on Effect) with a far smaller
memory footprint. We reproduce behaviour at three boundaries (the client contract, `/mcp`, the
provider protocols). We do not translate the TypeScript.

**Base:** the Conn monorepo this folder sits in (`apps/conn-server` of `nckrtl/conn`). The
checks need nothing outside this folder; the audit kit (`tools/audit.sh`) reads the TypeScript
server from the same tree.
**Contract:** hand-owned since upstream T3 Code `05e3674636` (`crates/conn-contract`). Its files
were generated from `packages/contracts` until the generators were removed; see
[Frozen files](#frozen-files).

## Run

```sh
cargo build --release
./target/release/conn-server serve --host 127.0.0.1 --port 3773 --base-dir /tmp/conn-home
./target/release/conn-server --state-dir /tmp/conn-state --project ~/code/my-repo   # short form
```

The command line follows the T3 server's (`t3 serve`, `t3 pair`, `t3 auth …`,
`t3 project add`, `t3 thread list|start|send|show`); [`crates/conn-server/DROP-IN.md`](crates/conn-server/DROP-IN.md) lists what
Orbit and Conn desktop run and what the Conn Server does with it. `conn-server --help` prints
every command.

| Flag or variable                            | Default                                                | Meaning                                                            |
| ------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| `--host`, `--port` (`T3CODE_HOST`, `_PORT`) | `127.0.0.1`, first free from 3773                      | Listen address; `--listen <host:port>` sets both                   |
| `--base-dir` (`T3CODE_HOME`)                | `~/.t3`                                                | T3 home; state lives in `<home>/userdata`, shared with T3's format |
| `--state-dir`                               | `<home>/userdata`                                      | The state directory itself (`$CONN_SERVER_HOME` still works)       |
| `--project <dir>` (repeatable)              | the current folder in the short form; none with `serve` | Folders offered as projects, plus `projects.json` (`project add`)  |
| `--label <name>`                            | the host name                                          | Environment label in clients                                       |
| `--mode desktop`, `--bootstrap-fd <fd>`     | web                                                    | Conn desktop's start: reads its bootstrap line, accepts its token  |

The default home is `~/.t3`, the T3 server's. To try the server next to a running T3 server,
always pass `--base-dir` or `--state-dir` with a folder of its own.

At start it takes the home's ownership lock (exit 78 when another server holds it), prints the
address, the environment id, the method coverage and a `pairingUrl`, and writes
`server-runtime.json` and `model-manifest.json` (the bundled model manifest, which Orbit reads;
the server fetches none). SIGTERM or SIGINT stops it cleanly. A turn that was running when the
server stopped continues on the next start in the same provider thread (at most 3 restarts in
a row within 5 minutes).

## Pair a client

The server serves the remote-environment path: bearer token plus WebSocket ticket. In Conn,
open **Settings › Connections › Add environment › Remote link** and paste the `pairingUrl`
(`http://<host>:<port>/pair#token=<code>`). The code is single use and valid 24 hours; each
start prints a new one, and `conn-server pair` or `auth pairing create` issue more while it
runs. Sessions and pairing links persist in `<state-dir>/auth.json`, so a paired client
reconnects after a restart without pairing again; **Settings › Sharing & access** lists and
revokes them. There are no browser cookie sessions, so the server's own origin (`/pair` in a
browser) does not work; use Connections.

## Checks

Run every check from `apps/conn-server`. One command runs all checks that need no model and no
TypeScript:

```sh
(cd helpers/sdk-host && npm ci)       # once: else instances-flow is skipped
tools/check.sh                        # or --group rust, --group flows
```

CI runs the same two groups (`.github/workflows/conn-server-checks.yml`); see
[`docs/upkeep.md`](docs/upkeep.md#when-the-checks-run).

| Check               | Command                                                                                                                         | Proves                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Timeout wrapper     | `bash tools/check-timeout.test.sh` | Each check stops at its time limit |
| Toolchain pin       | `rust-toolchain.toml` against `RUST_TOOLCHAIN` in the monorepo's `.github/workflows/conn-server-*.yml`                          | CI builds with the pinned toolchain                                                                  |
| Format, lint, tests | `cargo fmt --check`, `cargo clippy --workspace --all-targets --all-features -- -D warnings`, `cargo test --workspace`           | All crates, offline, under the lint set (`CRATES.md`, "Lint set")                                    |
| Recordings decode   | `cargo test --manifest-path fixtures/decode-check/Cargo.toml`                                                                   | Every recorded frame decodes with `conn_wire`                                                        |
| Gateway API current | `cargo run -p conn-gateway-api --features gen -- --check` | `conn-gateway-api` types and ops match its pinned `openapi.json` |
| Dependencies        | `cargo deny check` | Advisories, licences, bans and sources (`deny.toml`) |
| Sealed run          | `node tools/sealed-run-check.mjs` | A hand run of `cargo test` is sealed, the way out works, and the runner order holds |
| Release build       | `cargo build --release --workspace --bins --examples --features fake-provider`                                                  | The binaries and every example build, the audit kit's included                                       |
| Capabilities        | `node crates/conn-server/tools/capabilities-check.mjs target/release/conn-server` | A capability is advertised if and only if what it promises is registered; every contract flag has a row in `capabilities.json` |
| Orbit flow          | `node crates/conn-server/tools/orbit-flow.mjs target/release/examples/replay_server`                                            | Orbit's container flow: start, project add, session issue, launch over `/mcp`, revoke, clean stop; then its task-turn path: the model check on the written `model-manifest.json`, `t3 thread` start, list, show, send, a turn that asks, and `t3_copy_rpc.mjs`'s read and interrupt   |
| Instances flow      | `node crates/conn-server/tools/instances-flow.mjs target/release/conn-server` (skipped without `npm ci` in `helpers/sdk-host`)  | Claude and Codex instances from `providerInstances` written before start: a turn on each starts its stub with its settings; a change and a removal through `server.updateSettings` apply to the next session; disabled instances refused and listed disabled |
| Canary (last)       | `node tools/canary.mjs verify` (set up before the first check) | No check read a decoy file of the home, changed the home, let a marker variable or file reach any output or written file, ran a provider or host CLI, or connected outside loopback; no passwd home lookup in our code |

**The canary.** `tools/check.sh` and `tools/audit.sh` run every check with a decoy HOME (marker files where
`~/.claude`, `~/.codex`, `~/.grok`, `~/.config/gh`, `~/.gitconfig`, `~/.netrc` and `~/.t3` would
be; the credential files mode 000), marker values in `ANTHROPIC_*`, `OPENAI_API_KEY`,
`CODEX_HOME`, `XAI_API_KEY`, `GH_TOKEN`, `GITHUB_TOKEN`, `GITLAB_TOKEN`, `T3CODE_HOME` and
`CONN_CANARY`, a stand-in `SHELL`, and a `TMPDIR` that the canary scans twice a second. Cargo
and rustup keep their real folders (`CARGO_HOME`, `RUSTUP_HOME`), and cargo runs without the
global git configuration. Reads are seen by access time (a self-test fails the check on a
`noatime` file system), opens of a mode-000 file only when the error names the decoy path, and
a stat or a file that lived less than half a second without printing a marker not at all. Marker
executables named after the provider and host CLIs (`claude`, `codex`, `grok`, `gh`, `glab`, `fj`, `tea`, `az`, `cafe`) go first on `PATH` and fail the canary when run; a Node hook
(`NODE_OPTIONS=--import`) and `CONN_NETWORK_LOG` in our server refuse and record any
connection outside loopback. `mark` names the check behind each record.

`replay_server` is `conn-server` with the engine's scripted fake provider, so these checks call
no model. Each server they start gets a temp state folder.

Checks that call a model are not in `tools/check.sh`:

- `cargo test -p conn-provider-claude live_ -- --ignored --test-threads=1` (real CLI, Haiku),
  and the same for `conn-provider-codex`.
- `orbit-flow.mjs target/release/conn-server`: one Haiku turn.

### The audit kit

`tools/audit.sh` runs the comparisons against the T3 server's own code. The
`audit-t3-providers` skill runs it; CI does not. It reads the TypeScript tree of this monorepo
(`tools/monorepo.mjs`), so it needs `vp i` at the monorepo root and `npm ci` in
`helpers/sdk-host`. No tool calls a model.

```sh
tools/audit.sh [--from <sha> --to <sha>]
```

| Tool | Proves |
| --- | --- |
| `tools/sdk-pin.mjs` | `helpers/sdk-host` pins the Claude Agent SDK version the T3 server locks |
| Codex, Claude, ACP (Grok) and Antigravity conformance | argv, environment, every stdin frame and shutdown equal the T3 server's, on stub CLIs or a recorded agent |
| Codex, Claude and Grok probe conformance | each `ServerProvider` entry and every CLI run of its status probe equal the T3 server's |
| `claude t3-replay` | the T3 server's Claude transcripts: exactly the scenarios in `expected-failures.txt` fail |
| `t3 fixture replay` | T3's testkit fixtures through this engine and our providers, judged by T3's own assertions |
| `provider-auth-diff.mjs` | every `provider.auth.*` reply equals the T3 server's, and neither runs a CLI for them |
| `textgen-diff.mjs` | text generation requests and titles equal T3's own code, on a loopback stub |
| Codex, Antigravity and Claude model catalogs (`--check`) | the frozen catalogs equal the ones T3's manifest gives |
| `tools/bump-report.mjs` (with `--from` and `--to`) | the upstream commits in that range for each part of the server (`tools/upkeep/followed-files.txt`), frozen parts included |

The capture tools (`capture-ts-events.mjs`, Claude's `capture-ts/run.sh`) and the catalog
generators without `--check` adopt upstream changes into `testdata` and the catalogs; the
`cargo test` replays then hold them in CI. `tools/audit.sh` lists them.

### Frozen files

These files were generated from the Conn monorepo until the generators were removed. They are
hand-owned now: change them by hand, with a test. Upstream changes to their sources reach the
audit through `tools/upkeep/followed-files.txt`.

- The contract: `crates/conn-contract/src/{generated.rs,upstream.rs}`, `methods.json`,
  `tests/registry/mod.rs`, `tests/fixtures/sampled.jsonl`.
- The `/mcp` catalog, schemas, texts and `exposure/generated.rs` in `crates/conn-mcp/src`; the
  preview spec and script (`crates/conn-preview/src/{spec.json,injected.js}`); the MCP App
  bootstrap and constants.
- The upstream tables: scopes, settings, limits, text generation, close commands, `conn-vcs`,
  devices, keybindings and GitHub GraphQL operations.
- The Codex and ACP instruction texts.
- The case files the Rust tests read (pull requests, credentials, themes, handoffs, composer
  context, dates, limits).
- The bundled model manifest (`crates/conn-server/src/model_manifest/bundled.json`).

## Upkeep

The Conn Server no longer follows Conn's TypeScript tree in CI. The audit kit compares it with
the T3 server and lists upstream commits per part. See [`docs/upkeep.md`](docs/upkeep.md).

Releases: push a tag `conn-server-v<version>` (the `conn-server` crate's version) to
`nckrtl/conn`. `.github/workflows/conn-server-release.yml` builds
`conn-server-<version>-linux-x64.tar.gz` and its `.sha256` and attaches them to a GitHub
Release, which Orbit downloads.

## Crates

| Crate                   | Holds                                                                 |
| ----------------------- | --------------------------------------------------------------------- |
| `conn-wire`             | Effect RPC frame types and JSON codec                                 |
| `conn-contract`         | Contract types (hand-owned, once generated), method list, ids          |
| `conn-gateway-api`      | Typed Orbit Gateway operations generated from the Gateway's OpenAPI document; no HTTP client (see its README) |
| `conn-engine`           | `Engine` trait; SQLite event store, projections, streams, turn runner |
| `conn-provider`         | `Provider` and `Session` traits, `ProviderEvent`, `ProviderSet` (the instances, changed as the settings change) |
| `conn-provider-claude`  | The Claude provider, through the official Agent SDK in the SDK host (see [Claude](#claude)) |
| `conn-provider-codex`   | The Codex provider over `codex app-server` (JSON-RPC on stdio)        |
| `conn-provider-acp`     | The ACP provider (Grok so far, offered by the server; off until settings enable it) |
| `conn-provider-support` | Ids, line framing, the process supervisor, the SDK host client (`sdk_host`), a rooted file host, and a provider instance's settings envelope (`instance`: enabled rule, identity, environment with T3's `~` expansion), shared by providers |
| `conn-mcp`              | `/mcp`: T3 tools over MCP Streamable HTTP; see its README             |
| `conn-vcs`              | Git status, refs, review diffs, worktrees and their setup             |
| `conn-files`            | Project files, search, asset URLs, attachments                        |
| `conn-terminal`         | Shells on PTYs: sessions, scrollback, viewers (`terminal.*`)          |
| `conn-source-control`   | GitHub source control: discovery, sign-in, stars, repositories, provider detection, GitHub's GraphQL operations; later pull requests |
| `conn-source-control-core` | The source control rules the engine needs too: the host definition registry, remote text, a watch's wake; see its README |
| `conn-server`           | Binary: HTTP, `/ws` session, pairing, method table, handlers          |
| `conn-support`          | Helpers several crates share: time, hex, base64, SHA-256 and HMAC, atomic writes, v4 ids, the T3 secret store, URL text |
| `conn-features`         | Scheduled tasks (webhook tasks too) and the Conn-only areas beside the engine; see its README |
| `conn-devices`          | Device hosts (this machine, a Mac over SSH): `device.*`, the hub proxy rules, the device tools |

Dependencies point one way: `conn-server` → `conn-engine` → `conn-provider` → `conn-contract`;
`conn-provider-claude` → `conn-provider`; `conn-server` → `conn-wire`. `conn-wire` and
`conn-contract` depend on nothing of ours. The engine depends on no feature crate: what it
needs of source control is in `conn-source-control-core`, below both.

The method table lives in `conn-server` (`src/table.rs`), not its own crate: every handler
module lives in `conn-server/src/methods/` anyway, one file per area.

## The three interfaces

Change one only on purpose, and list the change in the commit.

### 1. Provider (`crates/conn-provider/src/lib.rs`)

Shaped from `ProviderAdapterV2` in `packages/provider-core/src/server/ProviderAdapter.ts`, which
the Claude and Codex adapters implement.

```rust
pub trait Provider: Send + Sync {
    fn instance_id(&self) -> &ProviderInstanceId;
    fn driver(&self) -> &str;                       // "claudeAgent", "codex", ...
    fn capabilities(&self) -> BoxFuture<'_, ProviderResult<ProviderCapabilities>>;
    fn open_session(&self, input: OpenSessionInput) -> BoxFuture<'_, ProviderResult<OpenedSession>>;
}
pub struct OpenedSession { pub session: Box<dyn Session>, pub events: mpsc::Receiver<ProviderEvent> }

pub trait Session: Send + Sync {
    fn provider_session_id(&self) -> &ProviderSessionId;
    fn ensure_thread(&self, input: EnsureThreadInput) -> BoxFuture<'_, ProviderResult<ProviderThread>>;
    fn resume_thread(&self, input: ResumeThreadInput) -> BoxFuture<'_, ProviderResult<ProviderThread>>;
    fn start_turn(&self, input: TurnInput) -> BoxFuture<'_, ProviderResult<()>>;
    fn steer_turn(&self, input: SteerInput) -> ...;                        // default: Unsupported
    fn interrupt_turn(&self, input: InterruptInput) -> BoxFuture<'_, ProviderResult<()>>;
    fn abandon_turn_start(&self, input: AbandonTurnStartInput) -> BoxFuture<'_, ()>; // default: nothing
    fn apply_model_selection(&self, thread, selection) -> ...;            // default: Unsupported
    fn apply_runtime_policy(&self, thread, policy) -> ...;                // default: Unsupported
    fn respond_to_runtime_request(&self, input: RuntimeRequestResponse) -> BoxFuture<'_, ProviderResult<()>>;
    fn close(&self) -> BoxFuture<'_, ()>;
}
```

`ProviderEvent` mirrors `ProviderAdapterV2Event` (same `type` names, camelCase fields, no
`driver`): session, thread, turn, node, subagent, message, turn item, command output delta,
runtime request (permission prompts and questions), plan, `turn.terminal`.
`apply_runtime_policy` is new: it carries a permission mode change to a running Claude process
(`setPermissionMode`). `abandon_turn_start` is new too: a Stop before the provider accepted the
turn ends the run in the engine, and the provider stops the start in flight as T3's effect
worker interrupts it (Claude aborts a booting CLI; ACP sends nothing more; Codex sends nothing
more, and stops a turn that its `turn/start`, already written, still started: a deliberate
difference, `crates/conn-provider-codex/README.md`). Left out
until needed: compact, rollback, fork, thread snapshots, history
injection, background tasks, subagent stop.

Adding a provider: one new crate that implements both traits.

**Instances.** As in the T3 server, a driver has a default instance whose id is the driver
kind (`claudeAgent`, `codex`), and each `providerInstances` entry of that driver is one more
instance (Orbit's `claudeLow` … `claudeMax`). `conn-server/src/instances.rs` builds them
from the settings at start and again on every change: an entry that changes gives a new
provider for that id, a removed one is dropped, and open sessions keep the provider they
opened with, as T3's open sessions keep their adapter. The engine, titles, `/mcp` and the
server share one `ProviderSet`. Grok's default instance follows its settings itself.

### 2. Engine (`crates/conn-engine/src/lib.rs`)

```rust
pub type Subscription<T, E> = mpsc::Receiver<Result<T, E>>;
pub enum EngineError<E> { Rejected(E), Internal(String) }   // → Fail exit / Die exit

pub trait Engine: Send + Sync {
    fn dispatch(&self, command: Command)
        -> BoxFuture<'_, Result<DispatchCommandResult, EngineError<DispatchCommandError>>>;
    fn subscribe_shell(&self, input: SubscribeShellInput)
        -> BoxFuture<'_, Result<Subscription<ShellStreamItem, GetShellSnapshotError>, EngineError<GetShellSnapshotError>>>;
    fn subscribe_thread(&self, input: SubscribeThreadInput)
        -> BoxFuture<'_, Result<Subscription<ThreadStreamItem, GetThreadProjectionError>, EngineError<GetThreadProjectionError>>>;
    // JSON in and out; each defaults to an Internal error.
    fn launch_thread(&self, input: Value) -> BoxFuture<'_, Result<Value, EngineError<Value>>>;
    fn get_thread_projection(&self, thread_id: ThreadId) -> ...;   // getThreadProjection
    fn shell_snapshot(&self) -> ...;                               // GET /api/orchestration/shell
    fn thread_snapshot(&self, thread_id: ThreadId) -> ...;         // GET .../threads/:id, None → 404
}
```

These back `orchestration.dispatchCommand`, `launchThread`, `subscribeShell`,
`subscribeThread`, `getThreadProjection` and the two HTTP snapshot routes. Clients start every
new thread from the composer with `launchThread` (thread plus first message), and send later
messages with `dispatchCommand` `message.dispatch`. An `Err` item ends a stream with a typed
failure; a closed channel ends it successfully; dropping the receiver unsubscribes. The engine
trusts provider events to be valid contract rows; it fills in `threadId` and `runId` and
assigns ordinals.

### 3. Method table (`crates/conn-server/src/table.rs`)

```rust
table.unary("server.probe", |ctx: CallContext, input: I| async { Ok::<O, Failure>(..) });
table.stream("orchestration.subscribeShell", |ctx, input: I| async { Ok::<ItemStream, Failure>(rx) });
table.get(tag)        // Option<&Handler>; None → not_supported_exit(tag)
table.coverage()      // "15 of 235 methods (9 of 32 streams)", plus the missing tags
```

- Registration panics at startup on a tag not in the contract, a duplicate, or a unary handler
  for a stream method (or the reverse).
- Registration also panics on a tag with no entry in the scope table. That table holds the
  auth scope T3 requires per method (T3 leaves none unguarded). It holds the T3 server's
  `RPC_REQUIRED_SCOPES` in `src/scopes/generated.rs` (hand-owned, once generated);
  the payload-dependent rules stay by hand in `scopes.rs`, and a test holds their list to the
  T3 server's. The table checks the scope before the handler runs and fails with
  `EnvironmentAuthorizationError`. Handlers do not check scopes.
- A payload that does not decode into `I` ends the call with a defect, as Effect does.
- `Failure::Fail(value)` is a typed contract error; `Failure::Die(value)` is a defect.
- An unsupported method answers at once with
  `{"_tag":"Failure","cause":[{"_tag":"Die","defect":{"name":"ConnServerNotSupported","message":"conn-server does not support `<tag>` yet"}}]}`.
  The Effect client decodes that defect into an `Error` (checked with the real client).
- Each area registers from its own file: `methods/server.rs`, `methods/orchestration.rs`,
  `methods/provider.rs`. To add an area, add a file and one line in `methods/mod.rs`.

## The wire

Effect RPC over WebSocket, `RpcSerialization.layerJson`: one JSON value per text message, and a
JSON array holds several frames. Sources: `.repos/effect/packages/effect/src/rpc/` (4.1.2);
the installed `effect` is 4.1.3, whose `RpcMessage.ts` and `RpcSerialization.ts` are identical
and whose `RpcServer.ts`/`RpcClient.ts` changes do not touch the wire.

| Direction       | Frame                                                                                         | Notes                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| client → server | `Request {id, tag, payload, headers, isNotification?, discard?, traceId?, spanId?, sampled?}` | ids are numbers from a counter                                                                                                 |
| client → server | `Ack {requestId}`                                                                             | one per received `Chunk`                                                                                                       |
| client → server | `Interrupt {requestId}`                                                                       | server ends the request with an `Interrupt` exit                                                                               |
| client → server | `Ping`                                                                                        | every 5 s; Conn fails the connection after 15 s without any frame (`packages/client-runtime/src/rpc/protocol.ts`)              |
| client → server | `Eof`                                                                                         | end after in-flight requests finish                                                                                            |
| server → client | `Chunk {requestId, values[]}`                                                                 | non-empty batch of stream items                                                                                                |
| server → client | `Exit {requestId, exit}`                                                                      | `Success {value}` or `Failure {cause: [Fail{error} \| Die{defect} \| Interrupt{fiberId}]}`; a stream's success value is `null` |
| server → client | `Defect {defect}`                                                                             | connection-level; fails every pending request                                                                                  |
| server → client | `Pong`                                                                                        |                                                                                                                                |
| server → client | `ClientProtocolError {error, requestIds?}`                                                    | decoder accepts it; servers do not send it                                                                                     |
| server → client | `Request`                                                                                     | server-originated; unused by T3                                                                                                |

T3 adds on top (`apps/server/src/ws.ts`): the `/ws` URL must carry `orchestrationProtocol=2`
(else 426); auth on upgrade (`authenticateWebSocketUpgrade`); frame parts when the URL has
`frameParts` (`packages/shared/src/socketFrameParts.ts`; Conn always sets it); an ack window of 8 chunks for
`subscribeServerConfig`, `subscribeShell`, `subscribeThread`, and 8 chunks / 64 KiB for
`terminal.attach`/`observe` (`apps/server/src/terminal/OutputProtocol.ts`); server options
`disableTracing` and `disableFatalDefects`. Constants are in `conn_wire::frame_parts` and
`conn_wire::ack_window`.

## Dependencies and runtime

- **tokio, current-thread runtime.** One thread, no work-stealing pool. A container serves one
  or two clients; each extra worker thread costs a stack and allocator arenas. Blocking work
  (SQLite, file reads) goes to `spawn_blocking` or one dedicated thread.
- **axum 0.8** with `default-features = false` (`http1`, `ws`, `json`, `query`, `tokio`). It
  is hyper plus a router and WebSocket upgrade; writing those by hand saves little memory.
- **serde / serde_json** for all wire and contract values.
- Release profile: `opt-level = "z"`, thin LTO, one codegen unit, `panic = "abort"`,
  stripped. See [Status](#status) for its memory.
- **rusqlite** with `bundled` SQLite for the event store; `tokio::process` for provider CLIs;
  `getrandom` and `sha2` for credentials.
- **flate2** (`rust_backend`: miniz_oxide) decodes text generator answers sent gzip or
  deflate encoded, which the T3 server's `fetch` asks for and this server now asks for too.
- **Settings secrets** live in the T3 server's secret store, `<state>/secrets/<name>.bin`
  (0700 folder, 0600 files); `settings.json` holds `••••••` in their place
  (`docs/conn-only-areas.md`, "Settings secrets").
- No `async-trait`, no `futures`: traits return `BoxFuture`, streams are `tokio::sync::mpsc`.

## What clients need (read from the code)

Read from `packages/client-runtime` and `apps/web` at the pinned commit. References are to
`packages/client-runtime/src` unless noted.

### Pairing and connect

No DPoP: it is only used on the T3 Connect relay path (`authorization/service.ts`
`authorizeDpop`). Direct pairing is bearer token + WebSocket ticket.

1. **Pairing URL** `<origin>/pair#token=<code>`, printed at startup (`apps/server/src/startupAccess.ts`).
   Code: 12 chars from `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, case-insensitive, single use, 5 min
   TTL, scopes `AuthStandardClientScopes` (`packages/contracts/src/auth.ts`). The desktop reads
   the token from the URL; it never loads `/pair`.
2. **`GET /.well-known/t3/environment`**, no auth → `ExecutionEnvironmentDescriptor`
   (`contracts/src/environment.ts`). Must carry `orchestrationProtocolVersion: 2` (else the
   client blocks, `connection/compatibility.ts`) and a stable `environmentId` (persist it).
3. **`POST /oauth/token`**, form-encoded token exchange:
   `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<code>`,
   `subject_token_type=urn:t3:params:oauth:token-type:environment-bootstrap` → `{access_token,
   issued_token_type, token_type:"Bearer", expires_in, scope}` with `cache-control: no-store`.
   No refresh token. Errors: 400 `invalid_request`, 401 `auth_invalid`
   (`contracts/src/environmentHttp.ts`).
4. **`POST /api/auth/websocket-ticket/rpc`**, `Authorization: Bearer` → `{ticket, expiresAt}`,
   5 min.
5. **`GET /ws?wsTicket=…&orchestrationProtocol=2&clientCapabilities=…&frameParts=1&client…`**.
   426 with `{code:"orchestration_protocol_incompatible", …}` unless `orchestrationProtocol=2`;
   then the ticket authenticates. `client*` params are analytics only.

The token format is ours to choose; the client treats it as opaque. To stay paired across
restarts, persist the environment id, the signing key and the sessions (with scopes and
revocation). Not served: browser cookie sessions, `/api/auth/session` (SSH only),
access-management endpoints, MCP OAuth, relay, DPoP.

### Calls a client makes, and what a failure does

| Method                          | When                                                               | If it fails                                                                                                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `subscribeServerConfig`         | first, on every connect (`rpc/session.ts`)                         | **Never connects.** Its first item must be `{version:1, type:"snapshot", config}` with `config.environment.environmentId` equal to the descriptor's. If the stream ends, the session closes. |
| `orchestration.subscribeShell`  | after connect (`state/shell.ts`)                                   | **No sidebar.** A defect ends it with no retry.                                                                                                                                              |
| `subscribeServerLifecycle`      | at boot (`apps/web/src/routes/__root.tsx`, `FirstRunGate.tsx`)     | A client that never finished onboarding waits on the `welcome` event. Send `{version:1, sequence:0, type:"welcome", payload:{environment, cwd, projectName, bootstrapStatus:"complete"}}`.   |
| `orchestration.subscribeThread` | when a thread opens (`state/threads.ts`)                           | Thread shows "Could not synchronize"; retries.                                                                                                                                               |
| `orchestration.launchThread`    | new thread with first message (`operations/commands.ts`)           | Send fails.                                                                                                                                                                                  |
| `orchestration.dispatchCommand` | `message.dispatch`, `thread.create`, …                             | Send fails.                                                                                                                                                                                  |
| `server.probe`                  | on wake, network change, long silence (`connection/supervisor.ts`) | **Tears the session down and reconnects.** Implemented.                                                                                                                                      |
| `panels.requests` (fork)        | at boot in web (`apps/web/src/panels/agentPanelRequests.ts`)       | Re-subscribes after a delay; nothing visible. Not served, as the T3 server leaves it unmounted (`wsFork.ts`).                                                                               |
| everything else                 | from a specific view or user action                                | That feature shows an error.                                                                                                                                                                 |

`server.getConfig` is never called by clients. Of the fork methods, only `panels.requests` runs
without a user action; the rest belong to the credentials, test-login and annotation views.

`ServerConfig` (`contracts/src/server.ts`) needs `environment`, `auth`, `cwd`,
`keybindingsConfigPath`, `keybindings`, `issues`, `providers`, `availableEditors`,
`observability` and `settings`. Advertise only capabilities the server really serves: an
absent capability hides its feature, and `shellThreadFamilies` or `shellOlderSettled` make the
client send `omit*` shell flags and call methods we would then need.

### Streams

- **Shell:** full `snapshot`, then `synchronized`, then `project.*`/`thread.*` items with an
  increasing `sequence` above `snapshotSequence`. Clients always send
  `requestCompletionMarker: true`; without `synchronized` the sidebar stays "synchronizing". A
  full snapshot is a valid answer to any `afterSequence`, `httpSnapshotFallback` or
  `knownProjectIdentities`.
- **Thread:** `snapshot {snapshotSequence, projection}`, then `synchronized`, then
  `event {sequence, event}` with a per-thread sequence. Clients always send
  `requestCompletionMarker` and `acceptDedupedBodies`, and send `acceptBoundedSnapshot`,
  `acceptDeferredWork`, `acceptCompactTurnItems`, `acceptCompactIds` whenever they have an HTTP
  client, whatever the server advertises. `acceptBoundedSnapshot` is served: the newest window
  and a `historyCursor`, which the client pages back through `/history`. The others may be
  ignored: full bodies, plain ids, no `idTable`.
- **Also emit `thread.updated` on the shell** as a turn runs, so the sidebar status moves.

### HTTP orchestration routes

`GET /api/orchestration/shell` and `GET /api/orchestration/threads/:id` are served. Both need
`x-t3-orchestration-protocol: 2` (else 400) and a bearer with `orchestration:read` (else 401 or
403). The shell route ignores its query and always sends the full snapshot. An unknown thread
is a plain 404, never `EnvironmentResourceNotFoundError`, which would make the client mark the
thread deleted. `/transcript` is served as T3 serves it: the whole visible turn items, the
same header and bearer, `thread_transcript_too_large` past `PROVIDER_SEND_TURN_MAX_FILE_BYTES`,
and T3's structured `thread_not_found`. `/history` is served for a bounded snapshot's cursor
(T3's `invalid_history_cursor` and `thread_not_found`; no work folding). `/bounded` is not
routed; the client falls back to the socket.

### Opt-in flags

- **Thread stream:** the client sends `acceptBoundedSnapshot`, `acceptDeferredWork`,
  `acceptCompactTurnItems` and `acceptCompactIds` whenever it has an HTTP client and a history
  controller (`state/threads.ts`), whatever the server advertises. So it sends them to this
  server too. The engine serves `acceptBoundedSnapshot`, `acceptDedupedBodies` and, outside a
  bounded snapshot, `acceptCompactTurnItems`. It ignores the rest: no deferred work, plain ids,
  never an `idTable`.
- **Shell stream:** `omitIdleSubagents` and `omitOlderSettled` are sent only when the descriptor
  advertises `shellThreadFamilies` / `shellOlderSettled` (`state/shell.ts`). This server
  advertises both (`environment::capabilities`, the one place for capabilities), and the
  engine serves the matching methods.

## Status

The method table reports coverage at startup. Every
registered method checks the scope the T3 server requires (`src/scopes.rs`). `assets.createUrl`, `terminal.open` and `terminal.attach` also get the contract's
length, pattern and range limits before decode (`crates/conn-support/src/input.rs`). Every
capability flag of the contract has a row that says what proves it, and the advertised flags
must agree with what is registered (`tools/capabilities-check.mjs`, `capabilities.json`). The engine's
`dispatchCommand` coverage is in `crates/conn-engine/README.md`; each other area's crate README
lists what it serves.

| Area            | Served by                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------- |
| Connect, config | `methods/server.rs`: config and lifecycle streams, settings, keybindings, access, diagnostics. `docs/server-area.md` maps all 42 `server.*` methods |
| Threads         | `conn-engine`: dispatch (43 of 56 commands), launch, streams, reads, search, families, projects, checkpoints |
| Agents          | `conn-provider-claude`, `conn-provider-codex`, `conn-provider-acp` (Grok); `/mcp` (`conn-mcp`, 20 tools) |
| Workspace       | `conn-vcs` (status, refs, review, worktrees), `conn-files` (files, search, assets, uploads)     |
| Terminals       | `conn-terminal`                                                                                 |
| Source control  | `conn-source-control`: GitHub discovery, all 9 `sourceControl.*` (GitHub repositories)  |
| Text generators | `server.listTextGeneratorModels` lists configured models. For thread titles, Conn can use the configured text generator, the Claude or Codex CLI, or the Grok or Antigravity ACP adapter. |

The server joins them in `src/host.rs`: each provider session gets a `/mcp` credential, messages
claim their uploads, a `worktree` launch provisions a worktree, archive and delete close the
thread's terminals, and a turn's end refreshes VCS status. One idle rule closes provider
sessions (`--session-idle-timeout`). By default, resumable providers close after two idle minutes and other providers after thirty. Background work can hold a session for up to four hours.
SIGTERM and SIGINT stop terminals and close every provider session before the server exits.

**Proven with the real web client** (headless Chromium; `fixtures/README.md`): pairing, a turn,
a restart with reconnect, an approved prompt, Stop during a tool call, settings and access,
search, VCS views and the diff, files and uploads, terminals, a launch into a new worktree, and
a turn that calls `/mcp`. `crates/conn-server/tools/orbit-flow.mjs` runs Orbit's container
flow and its task-turn path against a binary.

**Memory on Linux**, measured 2026-11-14 (Conn pin `b12470dcad`) on the Orbit container host (x86_64, Ubuntu, kernel
7.0). Figures are MiB from `/proc/<pid>/smaps_rollup`. The server is the musl release build of
`examples/replay_server` (`conn-server` with the engine's fake provider, so no model and no
`claude` process), with the binary on ext4. `crates/conn-server/tools/memory-flow.mjs` drives
it: it pairs, opens the web client's boot streams over `/ws`, opens one thread stream per
thread, and runs turns through `/mcp`.

| Server (musl, fake provider) | Rss  | Pss  | Pss_Anon | Private_Dirty |
| ---------------------------- | ---- | ---- | -------- | ------------- |
| Just started                 | 8.7  | 8.7  | 1.4      | 1.4           |
| Client connected, streams open | 10.0 | 10.0 | 1.9    | 1.9           |
| After 20 turns in 3 threads  | 13.1 | 13.1 | 4.3      | 4.3           |
| After 2 idle minutes         | 12.3 | 12.3 | 4.1      | 4.2           |

Five container T3 servers (`/opt/orbit-agent/current/agent/bin/t3 serve`), read at the same
moments: `Pss_Anon` 354, 283, 285, 299 and 285 MiB (mean 301), unchanged through the run. The
server's anonymous memory after 20 turns is about 70 times smaller. The rest of its `Rss` is the
binary's file pages, which every container on the host shares through the page cache.

| SDK host (Node 26.12.1 single executable, stub `claude`) | Rss   | Pss   | Pss_Anon | Private_Dirty |
| -------------------------------------------------------- | ----- | ----- | -------- | ------------- |
| Idle after start, no driver loaded                       | 66.3  | 60.3  | 20.9     | 20.9          |
| In a session, turn 1 running                             | 81.1  | 74.9  | 32.0     | 32.0          |
| After 10 turns                                           | 91.7  | 85.5  | 38.5     | 38.5          |
| After the last session closed                            | gone  | gone  | gone     | gone          |

The SDK host runs only while a Claude session is open. Measured with
`crates/conn-provider-claude/examples/helper_memory` and
`crates/conn-provider-claude/tools/conformance/stub-claude` replaying a 10-turn transcript. Its
152 MB executable is mostly file pages, and how many are resident varies: a run before the
2026-11-14 pin bump read 94 to 117 MiB `Rss` with the same `Pss_Anon` (21 to 41). Only
`Pss_Anon` is private to one container. A real
session also has the `claude` CLI (about 140 MiB `Pss_Anon` in an earlier run) and the MCP
helpers from the user's Claude settings. The T3 figures do not count those either.

Build for `x86_64-unknown-linux-musl`: in an earlier run the glibc build used slightly more
(`Pss_Anon` 3.0 against 2.6 MiB after 11 Haiku turns).

On macOS arm64 (release, `ps` RSS / `footprint`, one Haiku turn): `opt-level = "z"` gave a
4.8 MiB binary and 5.7 / 2.5 MiB idle, 7.5 / 3.4 MiB peak; `opt-level = 3` gave 7.5 MiB and
6.5 / 2.8, 9.4 / 3.9. The release profile keeps `"z"`.

**Linux build:** on a Linux host, `cargo build --release -p conn-server` takes about a minute
from clean with 4 jobs; add `--target x86_64-unknown-linux-musl` (with `musl-gcc` installed)
for a static binary (15.7 MB on 2026-11-14; 7.2 MB in the early spike). From macOS the build needs a C
cross-compiler for bundled SQLite, such as `cargo zigbuild`.

## Known gaps

What a real Conn session hits that this server does not do:

- **Not supported (error in that view):** previews, annotations, devices, pull requests,
  scheduled-task edits, provider sign-in and install, peer links, discovered local servers and
  the other methods the startup coverage line lists as missing.
- **No checkpoints:** turns are not captured as git refs, so no turn diff or restore.
- **`/mcp` serves 28 of 87 T3 tools** (`crates/conn-mcp/README.md`).
- **Worktree launch and worktree delegates:** the worktree is made before the thread exists;
  `prepared-run.*` stays refused. A launch runs no project setup script; a `delegate_task`
  child with `isolation: worktree` starts it in its terminal without waiting for it.
- **Provider coverage.** Conn runs Claude Code, Codex, Grok and Antigravity. Grok child work
  can continue across turns. The [Claude](crates/conn-provider-claude/README.md),
  [Codex](crates/conn-provider-codex/README.md) and [ACP](crates/conn-provider-acp/README.md)
  guides describe native session behavior and supported settings. Codex managed setup and
  shadow homes are outside the Rust adapter.
- **Auth:** bearer and ticket only. No cookie sessions, DPoP or relay (`DROP-IN.md` §4).
- **Desktop-local backend:** the `--bootstrap-fd` start works; the desktop itself still
  spawns the T3 server (`DROP-IN.md` §2).
- **Each start prints a new pairing code**; unspent ones expire after 24 hours.

## Claude

Claude runs through Anthropic's official Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`, at
the T3 server's version), as in the T3 server. The SDK runs in the SDK host
(`helpers/sdk-host`), a small Node program that the Rust server starts with the first Claude
session and stops after the last. An idle server runs no Node. A Claude session adds one SDK
host for all sessions: about 44 MB of private memory on macOS arm64.

- **From a checkout:** run `npm ci` in `helpers/sdk-host` once. The server then runs
  `helpers/sdk-host/index.mjs` with `node` from `PATH`.
- **In a container:** the release tarball (`tools/release-tarball.mjs`) puts
  `sdk-host/index.mjs` with its production `node_modules` beside the `conn-server` binary; the
  server runs it with `node` from `PATH` (Orbit's runtime folder gives Node 24.22.1). See
  `crates/conn-server/DROP-IN.md`, "Release tarball for Orbit". A `conn-sdk-host` single
  executable (`helpers/sdk-host/build-sea.sh`) beside the binary wins over it.
  `--sdk-host <path>` or `CONN_SDK_HOST` names another place.
- **Proofs, with no model call:** `crates/conn-provider-claude/tools/conformance/run.sh`
  proves that the `claude` CLI gets the same argv, environment and stdin from the Conn Server
  as from the T3 server. `crates/conn-provider-claude/tools/t3-replay/run.sh` replays the T3
  server's own Claude transcripts against our session (18 of 39 pass, all that it drives; its
  README lists the rest with reasons). `tools/audit.sh` runs both.
- **Live:** `cargo test -p conn-provider-claude live_ -- --ignored --test-threads=1` runs
  11 tests on Claude Haiku through the SDK host.

Known gaps are in `crates/conn-provider-claude/README.md`: stopping background tasks, some
settings, and a Linux build of the SDK host.
