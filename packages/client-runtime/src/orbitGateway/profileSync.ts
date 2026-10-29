import {
  OrbitGatewayError,
  SETTINGS_VERSION_CONFLICT,
  type OrbitGatewayClient,
  type OrbitGatewayNode,
  type OrbitGatewaySectionMeta,
  type OrbitGatewaySectionPatch,
  type OrbitGatewaySettings,
} from "./client.ts";
import { isJsonObject, type JsonObject, type ProfileSectionName } from "./profileDocument.ts";
import { jsonEqual, toGatewayForm } from "./sectionMerge.ts";

/**
 * Keeps sections of this device's Orbit profile in step with the device, one channel per section
 * (appearance, this device type's settings). The workspace list has its own sync.
 *
 * Each channel reads and writes the device through two callbacks. The engine remembers, per
 * section, the profile's version, the value it last agreed on (`base`, in the device's own form)
 * and the profile's raw value (`remote`, kept so keys this build does not know are sent back):
 *
 * - A device value that differs from `base` holds unsent edits; a profile version that differs
 *   from the remembered one holds another device's edits. Both is a conflict, merged by the
 *   channel and retried (at most `MAX_ATTEMPTS` times) because the PATCH is all-or-nothing.
 * - Applying the profile's value to the device sets `base` to what the device reads back, so the
 *   write never echoes: after a pull the next run sends nothing.
 * - The first sync of a section adopts the profile's value (the device's previous value goes to
 *   `onAdopt` first) or, when the profile has none, seeds it from the device.
 * - A change that is not the user's own (a server-pushed default theme) is recorded with
 *   `beginNonUserChange`; while the device still holds exactly that value it counts as clean.
 */

export interface ProfileSyncChannel {
  readonly name: ProfileSectionName;
  /**
   * The device's current value, or null while it cannot be read (settings still loading).
   * `base` is the value last agreed with the profile, for a channel that must keep a part of it
   * while the device cannot resolve that part yet.
   */
  readonly readLocal: (base: JsonObject | null) => JsonObject | null;
  /**
   * Writes the profile's value to the device. `previous` is the last value agreed with the
   * profile (null on the first sync), for channels that must remove what another device deleted.
   */
  readonly applyRemote: (value: JsonObject, previous: JsonObject | null) => void;
  /** Three-way merge, see sectionMerge.ts. The result is what gets sent. */
  readonly merge: (base: JsonObject | null, local: JsonObject, remote: JsonObject) => JsonObject;
}

export interface ProfileSyncSectionState {
  /** The section version this device last agreed on with the profile. */
  readonly version: number;
  /** The value agreed on, as the device reads it back; null when the profile had none. */
  readonly base: JsonObject | null;
  /** The profile's raw value at that version. */
  readonly remote: JsonObject | null;
}

export interface ProfileSyncState {
  readonly profileId: number;
  /** The whole-document version last seen, to know when a probe needs a full read. */
  readonly profileVersion: number;
  readonly sections: Readonly<Partial<Record<ProfileSectionName, ProfileSyncSectionState>>>;
  /** Device values that are not the user's own picks, see `beginNonUserChange`. */
  readonly ignored: Readonly<Partial<Record<ProfileSectionName, JsonObject>>>;
}

export interface ProfileSyncPorts {
  readonly client: Pick<OrbitGatewayClient, "settings" | "patchSections">;
  readonly channels: () => readonly ProfileSyncChannel[];
  readonly loadState: () => ProfileSyncState | null;
  readonly saveState: (state: ProfileSyncState) => void;
  /** Opt-outs are local: a channel that is not enabled is skipped entirely. */
  readonly isEnabled?: (name: ProfileSectionName) => boolean;
  /** Called before the profile's value replaces the device's on a first sync, with the old value. */
  readonly onAdopt?: (name: ProfileSectionName, previousLocal: JsonObject) => void;
  readonly now?: () => number;
}

export type ProfileSyncOutcome = "adopted" | "seeded" | "pulled" | "pushed" | "merged";

export type ProfileSyncResult =
  | { readonly kind: "unbound" }
  | { readonly kind: "idle" }
  /** The Gateway predates profile sections: nothing was read or written. */
  | { readonly kind: "unsupported" }
  | {
      readonly kind: "synced";
      readonly outcomes: Readonly<Partial<Record<ProfileSectionName, ProfileSyncOutcome>>>;
      /** Who changed what, from the latest read or write of this run; null when none happened. */
      readonly sections: Readonly<Record<string, OrbitGatewaySectionMeta>> | null;
    };

export interface ProfileSyncRunOptions {
  /** Overwrite the profile with this device's value (`push`) or this device with the profile's (`pull`). */
  readonly force?: {
    readonly push?: readonly ProfileSectionName[];
    readonly pull?: readonly ProfileSectionName[];
  };
}

/** Attempts at a PATCH before giving up on a run, when other devices keep writing in between. */
const MAX_ATTEMPTS = 3;
/** How long an old Gateway is left alone before the next probe. */
const UNSUPPORTED_RETRY_MS = 10 * 60_000;

export function emptyProfileSyncState(profileId = -1): ProfileSyncState {
  return { profileId, profileVersion: -1, sections: {}, ignored: {} };
}

/** The state without one section, so enabling it again is a first sync (profile wins, with a backup). */
export function withoutSection(
  state: ProfileSyncState,
  name: ProfileSectionName,
): ProfileSyncState {
  const { [name]: _section, ...sections } = state.sections;
  const { [name]: _ignored, ...ignored } = state.ignored;
  return { ...state, sections, ignored };
}

interface Remote {
  readonly version: number;
  readonly value: JsonObject | null;
}

function remoteSection(settings: OrbitGatewaySettings, name: ProfileSectionName): Remote {
  const document = settings.document;
  const raw =
    name === "appearance"
      ? document.appearance
      : name.startsWith("devices.")
        ? (document.devices as Record<string, unknown> | undefined)?.[name.slice("devices.".length)]
        : undefined;
  return {
    version: settings.sections?.[name]?.version ?? 0,
    value: isJsonObject(raw) ? raw : null,
  };
}

interface Push {
  readonly channel: ProfileSyncChannel;
  readonly version: number;
  readonly value: JsonObject;
  /** The device value this push was planned from. */
  readonly local: JsonObject;
  readonly kind: "seed" | "push" | "merge";
}

export function createProfileSync(ports: ProfileSyncPorts) {
  const now = ports.now ?? Date.now;
  let unsupportedUntil = 0;
  /** A local value the Gateway refused (validation), so the same value is not sent again. */
  const rejected = new Map<ProfileSectionName, JsonObject>();

  const load = (profileId: number): ProfileSyncState => {
    const saved = ports.loadState();
    if (saved?.profileId === profileId) return saved;
    // Another profile (or none yet): every section starts over, the non-user marks stay.
    return { ...emptyProfileSyncState(profileId), ignored: saved?.ignored ?? {} };
  };

  async function runOnce(
    me: OrbitGatewayNode,
    options: ProfileSyncRunOptions = {},
  ): Promise<ProfileSyncResult> {
    const profile = me.profile;
    if (profile === null) return { kind: "unbound" };
    const forced = options.force !== undefined;
    if (!forced && now() < unsupportedUntil) return { kind: "unsupported" };
    const channels = ports.channels().filter((channel) => ports.isEnabled?.(channel.name) ?? true);

    let state = load(profile.id);
    const sections: Partial<Record<ProfileSectionName, ProfileSyncSectionState>> = {
      ...state.sections,
    };
    const ignored: Partial<Record<ProfileSectionName, JsonObject>> = { ...state.ignored };
    const commit = (profileVersion = state.profileVersion): void => {
      state = { profileId: profile.id, profileVersion, sections, ignored };
      ports.saveState(state);
    };
    const read = (channel: ProfileSyncChannel): JsonObject | null =>
      channel.readLocal(sections[channel.name]?.base ?? null);
    const outcomes: Partial<Record<ProfileSectionName, ProfileSyncOutcome>> = {};
    let meta: Readonly<Record<string, OrbitGatewaySectionMeta>> | null = null;
    let conflict: unknown = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const readable = channels.filter((channel) => read(channel) !== null);
      if (readable.length === 0) return { kind: "idle" };

      const mustFetch =
        attempt > 1 ||
        forced ||
        profile.settingsVersion !== state.profileVersion ||
        readable.some((channel) => sections[channel.name] === undefined);
      let remote: OrbitGatewaySettings | null = null;
      if (mustFetch) {
        remote = await ports.client.settings(profile.id);
        if (remote.sections === null) {
          unsupportedUntil = now() + UNSUPPORTED_RETRY_MS;
          return { kind: "unsupported" };
        }
        meta = remote.sections;
      }

      // Everything from here to the PATCH is synchronous, so an edit cannot slip in between
      // reading the device and writing to it.
      const pushes: Push[] = [];
      for (const channel of readable) {
        const name = channel.name;
        const local = read(channel);
        if (local === null) continue;
        const known = sections[name];
        const profileSide: Remote | null = remote
          ? remoteSection(remote, name)
          : known
            ? { version: known.version, value: known.remote }
            : null;
        if (profileSide === null) continue;

        const forcePull = options.force?.pull?.includes(name) === true;
        const forcePush = options.force?.push?.includes(name) === true;
        const pull = (value: JsonObject): void => {
          channel.applyRemote(value, known?.base ?? null);
          sections[name] = {
            version: profileSide.version,
            base: read(channel) ?? value,
            remote: value,
          };
          delete ignored[name];
        };

        if (known === undefined) {
          // First sync of this section.
          if (forcePush && !jsonEqual(rejected.get(name), local)) {
            pushes.push({
              channel,
              version: profileSide.version,
              value: toGatewayForm(
                profileSide.value === null
                  ? local
                  : channel.merge(profileSide.value, toGatewayForm(local), profileSide.value),
              ),
              local,
              kind: "push",
            });
          } else if (profileSide.value !== null) {
            if (!jsonEqual(toGatewayForm(local), profileSide.value)) ports.onAdopt?.(name, local);
            pull(profileSide.value);
            outcomes[name] = "adopted";
          } else if (ignored[name] && jsonEqual(local, ignored[name])) {
            // Nothing the user chose: a server default must not seed the profile.
            sections[name] = { version: profileSide.version, base: null, remote: null };
          } else if (!jsonEqual(rejected.get(name), local)) {
            pushes.push({
              channel,
              version: profileSide.version,
              value: toGatewayForm(local),
              local,
              kind: "seed",
            });
          }
          continue;
        }

        const remoteChanged = remote !== null && profileSide.version !== known.version;
        // A section another device cleared has no value to agree on any more.
        const base = remoteChanged && profileSide.value === null ? null : known.base;
        const dirty =
          forcePush ||
          (!jsonEqual(local, base ?? undefined) &&
            !(ignored[name] !== undefined && jsonEqual(local, ignored[name])));

        if (forcePull && profileSide.value !== null) {
          pull(profileSide.value);
          outcomes[name] = "pulled";
          continue;
        }
        if (!dirty) {
          if (remoteChanged && profileSide.value !== null) {
            pull(profileSide.value);
            outcomes[name] = "pulled";
          } else if (remoteChanged) {
            sections[name] = { version: profileSide.version, base: known.base, remote: null };
          }
          continue;
        }
        if (jsonEqual(rejected.get(name), local)) continue;

        // Compared and sent the way the Gateway stores it (see toGatewayForm), so a value it
        // trimmed or an empty string it turned into null does not read as a remote edit.
        const sendable = toGatewayForm(local);
        const value = toGatewayForm(
          profileSide.value === null
            ? local
            : forcePush
              ? channel.merge(profileSide.value, sendable, profileSide.value)
              : channel.merge(
                  base === null ? null : toGatewayForm(base),
                  sendable,
                  profileSide.value,
                ),
        );
        if (profileSide.value !== null && jsonEqual(value, profileSide.value)) {
          // The profile already holds the result: nothing to send.
          if (!jsonEqual(sendable, value)) channel.applyRemote(value, known.base);
          sections[name] = {
            version: profileSide.version,
            base: read(channel) ?? value,
            remote: profileSide.value,
          };
          delete ignored[name];
          continue;
        }
        pushes.push({
          channel,
          version: profileSide.version,
          value,
          local,
          kind: remoteChanged ? "merge" : "push",
        });
      }

      if (pushes.length === 0) {
        commit(remote?.version ?? state.profileVersion);
        return { kind: "synced", outcomes, sections: meta };
      }
      commit(remote?.version ?? state.profileVersion);

      const patch: Record<string, OrbitGatewaySectionPatch> = {};
      for (const push of pushes) {
        patch[push.channel.name] = { version: push.version, value: push.value };
      }
      let saved: OrbitGatewaySettings;
      try {
        saved = await ports.client.patchSections(profile.id, patch);
      } catch (error) {
        if (error instanceof OrbitGatewayError) {
          if (error.status === 404 || error.status === 405) {
            unsupportedUntil = now() + UNSUPPORTED_RETRY_MS;
            return { kind: "unsupported" };
          }
          if (error.code === SETTINGS_VERSION_CONFLICT) {
            conflict = error;
            continue;
          }
          if (error.status === 422) {
            for (const push of pushes) rejected.set(push.channel.name, push.local);
          }
        }
        throw error;
      }

      meta = saved.sections ?? meta;
      for (const push of pushes) {
        const { channel, local, value } = push;
        const name = channel.name;
        rejected.delete(name);
        const written = remoteSection(saved, name);
        const version = saved.sections ? written.version : push.version + 1;
        // The device may have changed while the PATCH was in flight; its newer edit then stays
        // dirty against `base` and goes out on the next run instead of being overwritten.
        const unchanged = jsonEqual(read(channel) ?? undefined, local);
        if (unchanged && !jsonEqual(toGatewayForm(local), value)) {
          channel.applyRemote(value, sections[name]?.base ?? null);
        }
        sections[name] = {
          version,
          base: unchanged ? (read(channel) ?? value) : value,
          remote: written.value ?? value,
        };
        delete ignored[name];
        outcomes[name] =
          push.kind === "seed" ? "seeded" : push.kind === "merge" ? "merged" : "pushed";
      }
      commit(saved.version);
      return { kind: "synced", outcomes, sections: meta };
    }
    throw conflict;
  }

  /**
   * Call before a change the user did not make (a server-pushed default theme); the returned
   * function, called after the change, records the new device value as not the user's own so it
   * is not pushed. Unsent user edits are left alone: they still go out, with the change in them.
   */
  function beginNonUserChange(name: ProfileSectionName): () => void {
    const channel = ports.channels().find((entry) => entry.name === name);
    if (!channel) return () => {};
    const saved = ports.loadState();
    const section = saved?.sections[name];
    const before = channel.readLocal(section?.base ?? null);
    const mark = saved?.ignored[name];
    const clean =
      before === null ||
      section === undefined ||
      jsonEqual(before, section.base ?? undefined) ||
      (mark !== undefined && jsonEqual(before, mark));
    return () => {
      const after = channel.readLocal(section?.base ?? null);
      if (!clean || after === null) return;
      const current = ports.loadState() ?? emptyProfileSyncState();
      ports.saveState({ ...current, ignored: { ...current.ignored, [name]: after } });
    };
  }

  /**
   * One run at a time. Two runs side by side would both read the same section versions and
   * PATCH them; the second would be refused as stale. A run that starts while another is in
   * flight waits for it and then reads the state it saved, so it sends only what is still dirty.
   */
  let lastRun: Promise<unknown> = Promise.resolve();
  function run(
    me: OrbitGatewayNode,
    options: ProfileSyncRunOptions = {},
  ): Promise<ProfileSyncResult> {
    const result = lastRun.then(() => runOnce(me, options));
    lastRun = result.catch(() => undefined);
    return result;
  }

  return { run, beginNonUserChange };
}
