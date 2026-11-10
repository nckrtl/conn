import {
  EnvironmentTheme,
  EnvironmentThemeFile,
  EnvironmentThemeId,
  environmentThemeFileHasColors,
} from "@t3tools/contracts";
import { UNPUBLISHABLE_THEME_IDS } from "@t3tools/shared/themePalettes";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const THEME_FILE_SUFFIX = ".json";
// Same bounds as the server's theme watcher, so both read the same set.
const MAX_THEME_FILES = 32;
const MAX_THEME_FILE_BYTES = 32 * 1024;

const decodeThemeFile = Schema.decodeUnknownExit(Schema.fromJsonString(EnvironmentThemeFile));
const isThemeId = Schema.is(EnvironmentThemeId);

/**
 * Reads the themes in `<stateDir>/themes`, the folder the local server
 * publishes. The renderer uses them when the local environment is off, so a
 * selected theme still renders without a server. Unusable files are skipped.
 */
export const readLocalThemes = Effect.fn("desktop.localThemes.read")(function* (themesDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(themesDir)
    .pipe(Effect.orElseSucceed((): Array<string> => []));

  const themes: Array<EnvironmentTheme> = [];
  for (const entry of entries.toSorted().slice(0, MAX_THEME_FILES)) {
    if (!entry.endsWith(THEME_FILE_SUFFIX)) continue;
    const id = entry.slice(0, -THEME_FILE_SUFFIX.length);
    if (!isThemeId(id) || UNPUBLISHABLE_THEME_IDS.has(id)) continue;

    const filePath = path.join(themesDir, entry);
    const info = yield* fs.stat(filePath).pipe(Effect.option);
    if (info._tag === "None" || info.value.type !== "File") continue;
    if (Number(info.value.size) > MAX_THEME_FILE_BYTES) continue;

    const raw = yield* fs.readFileString(filePath).pipe(Effect.option);
    if (raw._tag === "None") continue;
    const decoded = decodeThemeFile(raw.value);
    if (Exit.isFailure(decoded) || !environmentThemeFileHasColors(decoded.value)) continue;
    themes.push({ id, ...decoded.value });
  }
  return themes;
});

const localThemesDir = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const path = yield* Path.Path;
  return path.join(environment.stateDir, "themes");
});

export const getLocalThemes = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.GET_LOCAL_THEMES_CHANNEL,
  payload: Schema.Void,
  result: Schema.Array(EnvironmentTheme),
  handler: Effect.fn("desktop.ipc.localThemes.get")(function* () {
    return yield* readLocalThemes(yield* localThemesDir);
  }),
});

/**
 * Sends the themes to every window when a file in the themes folder changes,
 * so an edited theme retints without a reload. Debounced like the server's
 * watcher: one save fires several events, some before the content is flushed.
 */
export const installLocalThemesWatcher = Effect.fn("desktop.ipc.localThemes.installWatcher")(
  function* () {
    const fs = yield* FileSystem.FileSystem;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const themesDir = yield* localThemesDir;
    // The folder must exist for the watcher to attach before a theme is written.
    yield* fs.makeDirectory(themesDir, { recursive: true }).pipe(Effect.ignore);

    let last = yield* readLocalThemes(themesDir);
    // Return only once the watcher is attached, so a write right after startup is seen.
    const ready = yield* Deferred.make<void>();
    yield* fs.watch(themesDir, { onReady: () => Deferred.doneUnsafe(ready, Exit.void) }).pipe(
      Stream.debounce(Duration.millis(100)),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const next = yield* readLocalThemes(themesDir);
          // A touch or an identical rewrite must not repaint every window.
          if (Equal.equals(last, next)) return;
          last = next;
          yield* electronWindow.sendAll(IpcChannels.LOCAL_THEMES_CHANGED_CHANNEL, next);
        }),
      ),
      Effect.ignoreCause({ log: true }),
      Effect.ensuring(Deferred.done(ready, Exit.void)),
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
  },
);
