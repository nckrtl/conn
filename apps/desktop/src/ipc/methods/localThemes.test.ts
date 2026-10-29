import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentThemeFile, type EnvironmentTheme } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as IpcChannels from "../channels.ts";
import { installLocalThemesWatcher, readLocalThemes } from "./localThemes.ts";

const encodeThemeFile = Schema.encodeSync(Schema.fromJsonString(EnvironmentThemeFile));

const themeFile = (name: string) =>
  encodeThemeFile({ name, appearance: "dark", canvas: "#101820", accent: "#3b82f6" });

describe("readLocalThemes", () => {
  it.effect("reads usable theme files and skips the rest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-desktop-local-themes-test-" });
      yield* fs.writeFileString(`${dir}/nightfall.json`, themeFile("Nightfall"));
      yield* fs.writeFileString(`${dir}/broken.json`, "{ not json");
      yield* fs.writeFileString(
        `${dir}/colorless.json`,
        encodeThemeFile({ name: "No colors", appearance: "dark" }),
      );
      // A built-in id would shadow the built-in theme, so it is not publishable.
      yield* fs.writeFileString(`${dir}/dark.json`, themeFile("Dark"));
      yield* fs.writeFileString(`${dir}/notes.txt`, "not a theme");

      const themes = yield* readLocalThemes(dir);
      assert.deepStrictEqual(
        themes.map((theme) => [theme.id, theme.name]),
        [["nightfall", "Nightfall"]],
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("returns no themes when the folder does not exist", () =>
    Effect.gen(function* () {
      const themes = yield* readLocalThemes("/nonexistent/t3-desktop-local-themes");
      assert.deepStrictEqual(themes, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("sends the themes to every window when a theme file changes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "t3-desktop-local-themes-watch-test-",
      });
      const sent = yield* Deferred.make<{ channel: string; themes: unknown }>();
      const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
        create: () => Effect.die("unexpected window creation"),
        main: Effect.die("unexpected main window read"),
        currentMainOrFirst: Effect.die("unexpected current window read"),
        focusedMainOrFirst: Effect.die("unexpected focused window read"),
        setMain: () => Effect.void,
        clearMain: () => Effect.void,
        prepareReveal: () => Effect.succeed(false),
        reveal: () => Effect.void,
        sendAll: (channel, themes) =>
          Deferred.succeed(sent, { channel, themes }).pipe(Effect.asVoid),
        destroyAll: Effect.void,
        syncAllAppearance: () => Effect.void,
      });
      const environmentLayer = DesktopEnvironment.layer({
        dirname: "/repo/apps/desktop/src",
        homeDirectory: baseDir,
        platform: "darwin",
        processArch: "x64",
        appVersion: "1.2.3",
        appPath: "/repo",
        isPackaged: true,
        resourcesPath: "/missing/resources",
        runningUnderArm64Translation: false,
      }).pipe(
        Layer.provide(
          Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
        ),
      );

      yield* Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        yield* installLocalThemesWatcher();
        yield* fs.writeFileString(
          `${environment.stateDir}/themes/nightfall.json`,
          themeFile("Nightfall"),
        );
        const message = yield* Deferred.await(sent);
        assert.strictEqual(message.channel, IpcChannels.LOCAL_THEMES_CHANGED_CHANNEL);
        assert.deepStrictEqual(
          (message.themes as ReadonlyArray<EnvironmentTheme>).map((theme) => theme.id),
          ["nightfall"],
        );
      }).pipe(
        Effect.provide(Layer.mergeAll(environmentLayer, electronWindowLayer)),
        Effect.timeout("30 seconds"),
      );
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
