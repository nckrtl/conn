# Conn

Conn is an agent workspace across Mac and iPhone, with its own server. You start and follow
coding-agent threads (Claude, Codex, Grok, Antigravity) from a native macOS app or the iPhone
app. Each thread runs on a Conn Server, one per Orbit container, which drives the provider CLIs
and SDKs.

## The stack

| Folder                                                                | What it is                                                                                                                                          | Start here                                                                                                            |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `apps/conn-server`                                                    | The Conn Server: a Rust server for Conn clients. It serves the T3 client contract, `/mcp` and the provider protocols with a small memory footprint. | [README](apps/conn-server/README.md), [AGENTS](apps/conn-server/AGENTS.md), [status](apps/conn-server/docs/status.md) |
| `apps/conn-gpui`                                                      | The desktop client: a native Rust + GPUI macOS app that talks to the Conn Server through its typed Rust contract crates.                            | [README](apps/conn-gpui/README.md), [AGENTS](apps/conn-gpui/AGENTS.md), [scope](apps/conn-gpui/docs/scope.md)         |
| `apps/ios`                                                            | The iPhone app: native SwiftUI on the shared Rust core through UniFFI (`conn-ffi`).                                                                 | [features](apps/ios/docs/features.md)                                                                                 |
| `crates/`                                                             | The GPUI-free Rust core both native clients share: `conn-client`, `conn-state`, `conn-theme`, `conn-orbit`, `conn-ffi` and others.                  | [AGENTS](AGENTS.md), "Where code lives"                                                                               |
| `apps/lab-gpui`, `apps/lab-ios`                                       | Design labs: browser mocks of the desktop and iPhone shells with local fixtures.                                                                    | [lab-gpui README](apps/lab-gpui/README.md)                                                                            |
| `apps/web`, `apps/desktop`, `apps/mobile`, `apps/server`, `packages/` | Legacy TypeScript apps from T3 Code. They stay as the design reference until the native clients reach parity, then go.                              | [FORK.md](FORK.md), [Conn features](apps/conn-gpui/docs/reference/conn-features.md)                                   |

## Build and run

- **Conn Server:** `cargo build --release` in `apps/conn-server`, then run it against a temp
  state folder. See [Run](apps/conn-server/README.md#run). Check it with `tools/check.sh`.
- **Desktop client:** see [Prerequisites & commands](apps/conn-gpui/README.md#prerequisites--commands)
  and the [dev loop](apps/conn-gpui/docs/dev-loop.md).
- **iPhone app:** builds only in the nick-vm macOS VM. See
  [iPhone app (native)](apps/ios/README.md).
- **Shared core:** `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`
  and `cargo test --workspace` at the repo root.
- **Design labs:** `npm ci --prefix apps`, then `npm --prefix apps run lab:gpui` or `lab:ios`.
  They are a standalone npm package (`apps/package.json`), outside the pnpm workspace.

## Origin

Conn started as a fork of [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools, under
the MIT license. The [LICENSE](LICENSE) keeps T3 Tools' copyright notice. [FORK.md](FORK.md)
says how Conn relates to T3 Code today.
