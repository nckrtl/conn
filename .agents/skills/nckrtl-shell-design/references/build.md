# Build and install Conn

Conn is the fork's one customizations branch: `main` of `nckrtl/conn` (renamed
from `nckrtl/t3code` and its `nckrtl` branch on 2026-10-11). It is checked out
on Nick's MacBook (`~/apps/conn`) and tracks `origin/main`. Merge
`upstream/main` into it to take upstream changes (it carries merge commits,
so a rebase replays them), then run the sync procedure in
[SKILL.md](../SKILL.md).

`~/apps/conn` is shared. Never build, switch branches or stash there. Every
build uses its own worktree.

Where each build happens:

| Build               | Build on       | Sign on           | Run or install on                        |
| ------------------- | -------------- | ----------------- | ---------------------------------------- |
| Mac desktop app     | Nick's MacBook | Nick's MacBook    | start check in nick-vm, then the MacBook |
| iPhone (Polar)      | nick-vm        | Nick's MacBook    | Polar, with `devicectl`                  |
| iOS simulator proof | nick-vm        | ad-hoc, in the VM | own simulator on the MacBook             |

Reach nick-vm only through VMPal: `vmpal_exec` for commands, `vmpal_act` for
GUI steps, the shared Agent folder for files. Never ssh, scp or rsync to it,
also not over WireGuard. Follow "Share the VM" in `~/apps/AGENTS.md`.

## Mac desktop app

### 1. Build on the MacBook

Build from a fresh detached worktree at the exact commit:

```bash
git -C ~/apps/conn fetch origin
git -C ~/apps/conn worktree add --detach ~/apps/conn-build-<task> <full sha>
cd ~/apps/conn-build-<task>
vp i
node scripts/publish-sync-branch.ts        # pushes HEAD to origin sync/<full sha>
node scripts/check-sync-provenance.ts --json
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64 \
  --build-version 0.1.8-nckrtl.<YYYYMMDD>.<n>
```

- Version: the upstream desktop version (now `0.1.8`), `-nckrtl.`, the build
  date, and a build number for that day (`0.1.8-nckrtl.20261110.4`).
- Artifacts land in `release/`: `Conn-<version>-arm64.zip` and a `.dmg`.
- `publish-sync-branch.ts` never force-pushes. Packaging and signing fail
  unless the full 40-character HEAD SHA is the tip of an `origin`
  `refs/heads/sync/*` branch.

### 2. Sign on the MacBook

The app builds as **Conn** (`Conn.app`, app id `com.nckrtl.conn`, see
`apps/desktop/src/branding/forkBrand.json`). The `--signed` flag needs T3's
Apple team, so re-sign with `scripts/sign-macos-local.ts`. With no identity
argument and no `LOCAL_SIGNING_IDENTITY`, it finds the Developer ID
Application certificate of team 9SVJ4SYB9B (from `forkBrand.json`) in the
login keychain and checks `TeamIdentifier` afterwards. It applies hardened
runtime and the release entitlements minus the team-bound passkey ones, so
passkey sign-in is unavailable.

```bash
tmp=$(mktemp -d)
ditto -x -k "release/Conn-<version>-arm64.zip" "$tmp"
node scripts/sign-macos-local.ts "$tmp/Conn.app"
ditto -c -k --keepParent "$tmp/Conn.app" "release/Conn-<version>-arm64-signed.zip"
```

Verify:

```bash
codesign --verify --deep --strict "$tmp/Conn.app"
codesign -dv --verbose=2 "$tmp/Conn.app" 2>&1 | grep -E 'Authority=Developer ID|TeamIdentifier'
defaults read "$tmp/Conn.app/Contents/Info.plist" CFBundleShortVersionString
node scripts/check-sync-provenance.ts --artifact "$tmp/Conn.app"
shasum -a 256 "release/Conn-<version>-arm64-signed.zip"
```

The build is **not notarized**. `spctl` rejects it as "Unnotarized Developer
ID". That is expected; the installed builds get the same result.

### 3. Start check in nick-vm, before any install

1. Copy the signed zip into the VM through the Agent folder (see
   [Move files](#move-files-through-the-agent-folder)) and unpack it into an
   own folder, for example `~/conn-check-<task>/Conn.app`.
2. Save the `t3` shims: `readlink ~/.local/bin/t3` and `cat ~/.t3/bin/t3`.
   A first launch installs the `t3` command and repoints these shims, which
   other agents in the VM use.
3. Launch with an own home. Use `open -n`, not `nohup`; VMPal kills `nohup`
   children when the exec job ends.

   ```bash
   env -u ELECTRON_RUN_AS_NODE open -n --env T3CODE_HOME=$HOME/conn-check-<task>/home \
     $HOME/conn-check-<task>/Conn.app
   ```

4. Take `/tmp/vm-gui.lock` only around each GUI step (screenshot, click,
   appearance change), and remove it right after, also on failure.
5. Show: the main window renders with the sidebar, in light and in dark, and
   the app stays up at least 60 s with no crash report and no error dialog.
   Restore the VM's appearance afterwards.
6. Do not switch the test build to Orbit mode. That would make real pairings.
7. Quit only your app, by PID. Restore both shims and show they match the
   saved copies. Known-good state: `~/.local/bin/t3 -> ~/.t3/bin/t3`, which
   runs the VM's runtime `t3`. Delete your check folder and transfer folder.

Under-window vibrancy renders black in the VM. Judge Conn's glass on a real
Mac.

### 4. Install on the MacBook

1. Back up the installed build, one rollback only:
   `~/Library/Caches/conn-app-backups/<installed version>/Conn.app` (`ditto`).
   Verify its codesign and version. Older backups go (see [Disk](#disk)).
2. Stage the new build as `Conn.app` inside a temporary folder in
   /Applications (`S=$(mktemp -d /Applications/.conn-install-XXXXXX)`). Never
   rename the bundle to a staging label; Spotlight can keep it. Check that the
   designated requirements (`codesign -d -r-`) of the app and its helpers
   match the installed build, and check version and team.
3. Quit only `/Applications/Conn.app/Contents/MacOS/Conn`, gracefully, by
   PID. Never `killall`. Leave the T3 headless server under `~/.t3/headless`
   running; agent threads run on it.
4. Replace the bundle. With
   `/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister`,
   unregister the staging paths and obsolete backup paths (`-u`), register
   `/Applications/Conn.app` (`-f`), and check its path in `-dump`. Do not reset the whole
   LaunchServices database. Remove the staging folder.
5. Relaunch with `env -u ELECTRON_RUN_AS_NODE open /Applications/Conn.app`.
   Check for 60 s that it runs the new version and no new crash report shows
   in `~/Library/Logs/DiagnosticReports`.
6. On failure, put the backup back the same way and relaunch.

User data in `~/.t3` is untouched. The first launch of a renamed app copies
the old app's user data (see FORK.md, "Conn").

## iPhone (Polar)

### Device build in nick-vm

Use an own VM worktree of `nckrtl/conn` at the exact commit
(`git worktree add --detach ~/apps/conn-<task> <sha>` from the VM's
`~/apps/conn`, then
`pnpm install --frozen-lockfile --filter '@t3tools/mobile...'`). In an
existing worktree whose lockfile did not change, skip `pnpm install`. Run the long
build as one `vmpal_exec` job that writes a log and an rc file, and poll in
separate calls.

```bash
cd ~/apps/conn-<task>/apps/mobile
export APP_VARIANT=production T3CODE_IOS_BUNDLE_ID=com.nckrtl.conn \
  T3CODE_IOS_TEAM_ID=9SVJ4SYB9B T3CODE_APP_NAME=Conn EXPO_NO_GIT_STATUS=1 CI=1 \
  LANG=en_US.UTF-8
npx expo prebuild --clean --platform ios
xcodebuild -workspace ios/Conn.xcworkspace -scheme Conn -configuration Release \
  -destination generic/platform=iOS -derivedDataPath ios/.derived-device \
  CODE_SIGNING_ALLOWED=NO build
```

- `LANG=en_US.UTF-8`: CocoaPods fails without it.
- `T3CODE_APP_NAME=Conn` for both prebuild and xcodebuild, or the build shows
  T3 Code branding.
- `ios/` and `ios/.derived-device` are git-ignored.

### Sign on the MacBook and install

1. Copy `Conn.app` and the three prebuild `.entitlements` files to the Mac,
   in one zip (about 58 MB). Keep their folders: `<ents>/Conn/`,
   `<ents>/ExpoWidgetsTarget/`, `<ents>/expo-sharing-extension/`.
2. Sign: `~/conn-ios-sign/sign.sh <Conn.app> <ents dir> <out>`, with `<out>`
   exactly `~/conn-ios-sign/work/polar-<new sha>/signed` (`sign.sh` empties
   `<out>` first, so never pass the `polar-<sha>` folder itself). `<sha>` is
   the 7-character short SHA. It embeds the Xcode-managed
   profiles and signs with Apple Development G9Y9TT23QF. Check
   `codesign --verify --deep --strict` and the embedded profiles.
3. Find the signed app of the build now on Polar
   (`~/conn-ios-sign/work/polar-<old sha>/signed/Conn.app`). Keep it as the one
   rollback.
4. Install in place, never uninstall:

   ```bash
   xcrun devicectl device install app --device 00008140-00014C941E80801C \
     ~/conn-ios-sign/work/polar-<new sha>/signed/Conn.app
   xcrun devicectl device process launch --device 00008140-00014C941E80801C com.nckrtl.conn
   ```

5. After 30 s, check it still runs
   (`xcrun devicectl device info processes --device 00008140-00014C941E80801C`).
   On a crash, install the rollback app the same way. To read a device-only
   JS crash:
   `xcrun devicectl device sysdiagnose --device <udid> --destination <dir>`,
   then
   `/usr/bin/log show <archive> --predicate 'process == "Conn"'`.

## iOS simulator proof

Build in nick-vm, run on the MacBook.

1. In the VM worktree, run the same exports and prebuild as the device
   build, then build Release for the simulator with ad-hoc signing and an own
   git-ignored derived-data folder (for example `ios/.derived-sim`). Without signing the app has no
   entitlements, so secure storage fails and it shows "Loading environments"
   forever.

   ```bash
   xcodebuild -workspace ios/Conn.xcworkspace -scheme Conn -configuration Release \
     -destination 'generic/platform=iOS Simulator' -derivedDataPath ios/.derived-sim \
     CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual \
     DEVELOPMENT_TEAM= PROVISIONING_PROFILE_SPECIFIER= build
   ```

   Check with `otool -l Conn.app/Conn | grep __entitlements`.

2. Copy the `.app` to the MacBook. Create an own simulator
   (`xcrun simctl create "conn-<task>" "iPhone 18 Pro"`) and install the app.
3. Launch, tap, type and take screenshots only with the T3 device tools
   (`device_list`, `device_open`, `device_screenshot`), so Nick can watch in
   the Device panel.
4. To pair a Release build, use Add environment with host `10.44.0.14:3773`
   and a code from the VM's `t3 pair --label <label> --ttl 30m` (run under
   `env -i`). The `t3code://pair` link works only in dev builds. Revoke the
   session afterwards (`t3 auth session list`, `t3 auth session revoke <id>`).
5. Clean up: `device_close`, then shut down and delete your simulator and
   remove the copied app.

## Move files through the Agent folder

- Mac: `~/Library/Application Support/VMPal/Virtual Machines/macOS VM 1.vmpal/Agent/conn/<task>/`
- VM: `/Volumes/My Shared Files/Agent/conn/<task>/`

The folder refuses writes once it holds about 1 GB. Check `agentFolder` in
`vmpal_status` first. When it is near full, send big files in chunks of about
60 MB (`split -b 60m`, then `cat` them together). Compare `shasum -a 256` on
both sides. Remove your transfer folder when done, and leave other agents'
files alone.

## Disk

- Clean up in the same task, once the build is installed and its check
  passed: VM build folder, derived data, archives and Agent-folder copies;
  on the Mac staged zips, unsigned bundles and signing work folders.
- Keep exactly one rollback per app and device, the previously installed
  build: `~/Library/Caches/conn-app-backups/<version>/Conn.app` for the Mac,
  `~/conn-ios-sign/work/polar-<sha>/` for Polar. Older ones go.
- Delete safely: list a target in its own step, check it is yours, then
  delete. Never shared caches, `~/Library/Developer` as a whole, another
  agent's build folder, or VM snapshots.
- Measure the VM on the Mac: the size of
  `~/Library/Application Support/VMPal/Virtual Machines/macOS VM 1.vmpal/disk.asif`
  against `diskLimit` in that folder's `config.json` (300 GB). Guest `df` is
  not the limit. Start no VM build with less than 25 GB left; report it to the
  orchestrator instead.
- Remove old build folders in the VM before a new build, so it writes into
  freed blocks.
- Report what you removed and free space before and after, for the VM and the
  MacBook.

## CI and native code

CI lints Swift and Kotlin but compiles neither. A PR head that touches native
mobile code can pass CI and still not compile. Build it in nick-vm before
merging.

## What the fork's build already does

- No update feed: every build sets `publish: null`, so the app never replaces
  itself with an upstream release (`scripts/build-desktop-artifact.ts`).
- Desktop typecheck: `scripts/build-desktop-artifact.ts` runs
  `vp run --no-cache --filter @t3tools/desktop typecheck` (the existing Vite
  task) before packing. A missing window or preview member fails the build.
- Sync-source provenance: packaging records the full HEAD SHA and the origin
  `sync/*` ref whose tip is that commit. `scripts/sign-macos-local.ts` refuses
  to sign a short SHA, a local-only commit, or a stale/mismatched remote ref.
  Publish first with `node scripts/publish-sync-branch.ts`. External nightly
  install scripts that never call these entrypoints are not protected.
- T3 Code has no in-page annotator of its own. The browser panel's
  "Annotate preview" feature (`apps/web/src/annotations/`) is product code: it
  loads the overlay into the previewed page from an annotation server the user
  configures, and it does ship.
