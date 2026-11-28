# Development

Build, packaging and CI rules for this repository that are not features. App-specific
build steps live with each app; see the [README](../README.md).

## Legacy desktop build and signing

These rules cover the legacy Electron desktop app (`apps/desktop`, `apps/web`).

- `main` is the only long-lived development branch. New work lands there through pull
  requests. `wip/*` branches hold unreviewed saved work. Never force-push `main`.
- Build, sign and install with the [build guide][build]. Builds ship no update feed
  (`publish: null` in `scripts/build-desktop-artifact.ts`), so the app never replaces itself
  with an upstream release. Build and sign the Mac app on Nick's MacBook;
  `scripts/sign-macos-local.ts` re-signs it with the Developer ID of team 9SVJ4SYB9B (not
  notarized). Build server runtimes with `scripts/build-cli-archive.ts`.

## iPhone app (native)

`apps/ios` is the native SwiftUI app. It builds only in nick-vm; the VM rules in
[AGENTS.md](../AGENTS.md), "Build in nick-vm" (own checkout, own simulator, the GUI lock),
apply too. Run from the repo root:

1. `apps/ios/scripts/ios-bindings.sh` builds the host `conn-ffi` library and generates the
   Swift bindings, C header and modulemap into `apps/ios/ConnCore/Generated/`.
2. `apps/ios/scripts/build-core.sh` builds `conn-ffi` (release) for `aarch64-apple-ios` and
   `aarch64-apple-ios-sim`, installing missing Rust targets, and packages
   `apps/ios/build/ConnCore.xcframework`. It needs step 1 first, and `rustup` and `xcodebuild`.
3. Build `apps/ios/Conn.xcodeproj` with the `Conn` scheme (`xcodebuild -project
   apps/ios/Conn.xcodeproj -scheme Conn`), passing your simulator's UDID as the destination.
   The scheme's tests are `ConnTests` and `ConnUITests`.

`Conn.xcodeproj` is generated from `apps/ios/project.yml` with XcodeGen (`xcodegen generate`);
commit both. The project also needs the `DesignKit` package at `../../../design-kit/DesignKit`
relative to `apps/ios`.

## Dependency pins

`playwright-core` in `apps/server`, `apps/desktop` and `packages/shared` must stay on one
version: `@t3tools/shared/previewPage` takes the pages both runners create, so a split fails
the server typecheck. Conn pins 1.60.0 (1.64.1 breaks `DesktopTabRunner` resize fill); move
all three together. `scripts` and `apps/web` (`playwright`) do not share pages with the
runners.

## Vendored dependency patches

Upstream vendors some dependencies as tarballs in `apps/mobile/deps`, which pnpm
patches cannot target. Conn keeps its changes to them as patch files and ships a
rebuilt tarball next to upstream's:

- `react-native-screens`: `patches/react-native-screens-conn.patch` adds a
  search field accessory (a toolbar menu item shown inside the toolbar search
  field) and a `fontSize` prop for the search bar.
- `react-native-enriched-markdown`:
  `patches/react-native-enriched-markdown-conn.patch` sizes each list's marker
  column to its widest number (iOS), so numbers start at the list's edge like
  bullets, and ends bullets where numbers end, so both keep the same gap to the
  item text. `pnpm-workspace.yaml` allows the Conn tarball's install script next
  to upstream's.

`node scripts/build-conn-vendored-tarball.ts <package>` applies a patch to
upstream's tarball and writes `<upstream tarball name>-conn.tgz`;
`apps/mobile/package.json` points at that file.

To move a vendored package to a new upstream tarball, add the new tarball, delete
the old `-conn.tgz`, run
`node scripts/build-conn-vendored-tarball.ts <package>`, point
`apps/mobile/package.json` at the new `-conn.tgz` and run `vp install`. If a
hunk no longer applies, port the change to the new upstream sources, regenerate
the patch with `diff -ruN a b` from the two extracted `package` directories, and
rebuild. The guard test fails while any of this is missing.

## Pull request runners

Fork CI runs on GitHub-hosted Ubuntu and macOS. Upstream uses Blacksmith. The fork targets a five-minute full CI run from the first job start through Check. It fits the largest CI fan-out in GitHub's 20-job limit with eight server shards, five web shards, four package shards, Build and Typecheck, Rust and Release Smoke, and Mobile Native Static Analysis. Other workflows and runner queues can affect wall time.

Build and Typecheck also runs the fork's Lint checks. Check requires it to succeed even for docs-only changes. One fork runner runs Rust and Release Smoke, each with its own change gate. Upstream still runs separate jobs. Full inputs such as CI setup, dependency patches, vendored mobile dependencies and manifests exercise all Linux checks. Pushes to main always run the Linux checks and also run native mobile analysis for affected files.

`apps/server/src/testUtils/shardWeights.json` sets the server shards. Refresh it from the per-file durations in Test Server logs when shards drift.

The fork's server imports a few client-runtime modules (`apps/server/src/orbit/OrbitEnvironmentLink.ts` uses the Orbit Gateway client), which upstream's server does not. `FORK_FILE_DEPS` in `.github/scripts/ci-changes.cjs` makes the server depend on those files, not on the whole package, so a client-runtime change elsewhere skips the server shards. `scripts/ci-changes-fork.test.ts` walks the server's imports into client-runtime (failing on any it cannot resolve) and fails when one leaves that list, or when client-runtime gains a workspace dependency the server lacks.

The fork also skips upstream's `setup-apt-mirrors` action and installs the browser secret helper's libraries with `.github/scripts/fork-apt-install.sh`. On 2026-11-11 Canonical's nameservers stopped answering, the runners could not resolve `*.ubuntu.com`, and every Build and Test job hit its limit in apt. The script skips apt when the packages are installed (`libsecret-1-dev` is not on GitHub's image). Otherwise it tries azure.archive.ubuntu.com, mirrors.edge.kernel.org and archive.ubuntu.com in turn. It skips a host that does not resolve and gives each mirror 60 s, with private signed noble main and universe indexes, 5 s network timeouts and no retries. The Finish step waits at most 240 s and always prints the log.

Test Web runs its tests through `.github/scripts/web-test.cjs`. Headless Chromium on the GitHub-hosted runners sometimes drops its vitest connection (`VITEST_BROWSER_CONNECTION_CLOSED`) with no failed test, several times a day, during a different file each time. A check that fails on infrastructure is not a gate, but a test that crashes the page every time must stay red. So when the only problem is that error (no failed test, failed file, assertion or other unhandled error), the wrapper reruns only the files that did not finish, including the one that closed, and passes with a warning annotation if they pass. It fails if the browser closes again, if Vitest printed no summary, or if no file had passed. `web-test-reporter.mjs` records the shard's files (sharded with Vitest's own sequencer) and each finished file, so the list survives the crash. The Changes job runs the wrapper's tests (`web-test.test.cjs`).

Upstream-only workflows need upstream's Blacksmith runners and secrets (relay, web, EAS and macOS previews, showcase screenshots, Windows tests), and the fork has neither. Their entry jobs check `github.repository == 'pingdotgg/t3code'`, so they skip in the fork instead of queueing forever; jobs that depend on them skip too. This covers `relay-preview.yml`, `relay-preview-cleanup.yml` (its daily schedule queued forever before), `web-preview.yml`, `mobile-eas-preview.yml`, `mobile-eas-preview-fork.yml`, `desktop-macos-preview.yml`, `desktop-macos-preview-publish.yml` (the `resolve` job), `mobile-showcase-screenshots.yml`, `windows-tests.yml`, `mobile-android-apk.yml`, `publish-aur.yml`, `deploy-relay.yml` and `release.yml` (the `resolve_commit` job). `release-desktop.yml` has no check of its own: only `release.yml` and `desktop-macos-preview-publish.yml` call it, and both skip here.

[build]: ../.agents/skills/nckrtl-shell-design/references/build.md
