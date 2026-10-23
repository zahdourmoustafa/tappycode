/**
 * Capability probing: what a provider offers before a conversation exists,
 * served stale-while-revalidate from memory and the probe cache.
 */
import { isAvailable } from "../providers/registry.js";
import { connectProvider, type AcpSessionHandle, type ConfigOption } from "../acp/connect.js";
import { dirname as __dirname, resolve as __resolve } from "node:path";
import { resolveWorkspace } from "../workspace.js";
import { readProbeCache, writeProbeCache } from "../probe-cache.js";
import { readConfigPrefs } from "../config-prefs.js";
import { readCommandDirs } from "../commands/from-disk.js";
import { DaemonSpares } from "./spares.js";
import { listConversations } from "../gg-app/sessions.js";
import { fallbackConfigOptions, liveGgAppControls } from "../gg-app/bridge.js";
import { hydrateMessageCounts } from "../acp/messageCounts.js";
import { foldProjects } from "../projects.js";
import { SESSION_HISTORY_LIMIT } from "../session-history.js";
import type { AgentSession } from "../acp/connect.js";
import {
  EMPTY_CAPABILITIES,
  GG_GOALS_ID,
  GG_PROVIDER_ID,
  GG_APP_PROVIDER_ID,
  goalsRoot,
  readExtensions,
  withStoredPrefs,
  type ProviderCapabilities,
} from "./types.js";

export abstract class DaemonProbes extends DaemonSpares {
  /**
   * Ask a provider what it currently offers, without starting a conversation.
   *
   * Selectors are a property of a live session, so the only honest way to learn
   * them is to open one and throw it away. That keeps the model list true after
   * the connected app updates — tappy stores no model names of its own — and lets
   * the empty state show real options instead of nothing.
   *
   * Cached per provider: spawning an agent is slow, and a live session's own
   * selectors always take precedence over this. The cache is stale-while-
   * revalidate rather than permanent — see `PROBE_TTL_MS` — because the work
   * this list describes is mostly done at the desk, while the daemon runs.
   */
  async probeProvider(providerId: string, { refresh = false } = {}): Promise<ProviderCapabilities> {
    if (providerId === GG_GOALS_ID) {
      if (!this.isEnabled(GG_GOALS_ID)) return EMPTY_CAPABILITIES;
      const base = await this.probeRaw(GG_PROVIDER_ID, { refresh });
      if (base === EMPTY_CAPABILITIES) return base;
      const ext = base.extensions ?? this.knownExtensions.get(GG_PROVIDER_ID);
      return {
        ...base,
        sessions: base.sessions
          .filter((s) => this.isGoalFolder(s.cwd))
          .map((s) => {
            const name = this.goalNames.get(__resolve(s.cwd));
            return name ? { ...s, title: name } : s;
          }),
        projects: [],
        commands: [],
        extensions: {
          ...(ext?.queue !== undefined ? { queue: ext.queue } : {}),
          ...(ext?.askUser !== undefined ? { askUser: ext.askUser } : {}),
          ...(ext?.goals !== undefined ? { goals: ext.goals } : {}),
        },
      };
    }
    if (providerId === GG_APP_PROVIDER_ID) return this.probeGgApp();
    const raw = await this.probeRaw(providerId, { refresh });
    if (providerId !== GG_PROVIDER_ID || raw === EMPTY_CAPABILITIES) return raw;
    return {
      ...raw,
      sessions: raw.sessions.filter((s) => !this.isGoalFolder(s.cwd)),
      ...(raw.projects ? { projects: raw.projects.filter((p) => !this.isGoalFolder(p.path)) } : {}),
    };
  }

  /**
   * The GG Coder desktop app's chats and projects, read straight from
   * `~/.gg/sessions` inside this process.
   *
   * Every other agent is asked by spawning it, because only it knows where its
   * history lives. This one's history is files tappy can read itself, and its
   * agent is tappy — spawning `tappy.exe gg-app-bridge` just to read them cost a
   * cold start of a ~100 MB unsigned binary, which Windows Defender scans before
   * it runs. On real Windows machines that took minutes, and a start that
   * stalled sat out the full three-minute handshake timeout before anything was
   * shown. The bridge is still what runs a conversation; listing needs none of it.
   */
  protected async probeGgApp(): Promise<ProviderCapabilities> {
    if (!this.isEnabled(GG_APP_PROVIDER_ID)) return EMPTY_CAPABILITIES;
    const provider = this.providers.find((p) => p.manifest.id === GG_APP_PROVIDER_ID);
    if (!provider || !isAvailable(provider)) return EMPTY_CAPABILITIES;
    const started = Date.now();
    try {
      const all: AgentSession[] = (await listConversations()).map((entry) => ({
        sessionId: entry.sessionId,
        cwd: entry.cwd,
        ...(entry.title ? { title: entry.title } : {}),
        updatedAt: entry.updatedAt,
      }));
      this.projectHistory.set(GG_APP_PROVIDER_ID, all);
      const sessions = all.slice(0, SESSION_HISTORY_LIMIT);
      await hydrateMessageCounts(GG_APP_PROVIDER_ID, sessions);
      const cwd = sessions[0]?.cwd ?? resolveWorkspace();
      // The app's own pickers and commands, when it is open. Read from a window
      // rather than a spawn, so this stays as fast as the listing above; a
      // closed app leaves the start screen with the commands on disk.
      const live = await liveGgAppControls(cwd);
      const capabilities: ProviderCapabilities = {
        configOptions: live?.configOptions.length
          ? live.configOptions
          : await fallbackConfigOptions(),
        sessions,
        canResume: true,
        projects: foldProjects(all),
        commands: live?.commands.length
          ? live.commands.map(({ name, description, input }) => ({
              name,
              description,
              ...(input ? { hint: input.hint } : {}),
            }))
          : await readCommandDirs(provider.manifest.tappy.commandDirs, cwd),
      };
      console.log(
        `[${GG_APP_PROVIDER_ID}] listed ${all.length} chats from disk in ${Date.now() - started}ms`,
      );
      return capabilities;
    } catch (error) {
      console.error(`[${GG_APP_PROVIDER_ID}] could not read ~/.gg/sessions:`, error);
      return EMPTY_CAPABILITIES;
    }
  }

  /**
   * Push GG Coder App's current chats and projects to every phone. Called when
   * the app writes to `~/.gg/sessions`, so a project or chat started in the app
   * shows up on the phone within seconds instead of on its next request.
   */
  async announceGgAppHistory(): Promise<void> {
    const capabilities = await this.capabilitiesFor(GG_APP_PROVIDER_ID);
    if (capabilities === EMPTY_CAPABILITIES) return;
    this.send({ t: "provider.capabilities", providerId: GG_APP_PROVIDER_ID, ...capabilities });
  }

  /** A directory directly inside the goals root, or a path from the last goals list. */
  isGoalFolder(cwd: string): boolean {
    const abs = __resolve(cwd);
    return this.goalNames.has(abs) || __dirname(abs) === __resolve(goalsRoot());
  }

  protected async probeRaw(
    providerId: string,
    { refresh = false } = {},
  ): Promise<ProviderCapabilities> {
    // A disabled agent answers as if it has nothing, rather than spawning to
    // find out. The app should never ask \u2014 it is not announced \u2014 but a stale
    // client or a direct CLI call must not be able to boot it either.
    if (!this.isEnabled(providerId)) return EMPTY_CAPABILITIES;
    // A refresh runs *beside* the cached answer rather than replacing it up
    // front. Clearing the slot first published the in-flight reprobe to every
    // other reader: an ask arriving during a refresh waited on the agent's boot
    // instead of being answered instantly, and a refresh that failed handed that
    // reader nothing at all — which is how announcing a preference could go
    // silent while the agent it belongs to was mid-restart. The new answer is
    // installed below, once it exists.
    const cached = refresh ? undefined : this.probes.get(providerId);
    if (cached) {
      // The answer is instant; whether it is still true is settled behind it.
      // Without this the first probe after boot was the only one that ever ran.
      this.revalidateIfStale(providerId);
      return cached;
    }

    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider || !isAvailable(provider)) return EMPTY_CAPABILITIES;

    // Armed here, while still synchronous with the call: everything below is
    // behind an await, and a tap landing in that window must find a promise to
    // wait on rather than spawning a second process next to this one.
    const { announce: announceSpare } = this.armSpare(providerId);

    // A spawn plus session/list is seconds per provider. Serve the last good
    // answer from disk instantly and refresh it in the background instead of
    // making the drawer wait on the agent's boot time.
    if (!refresh) {
      const disk = await readProbeCache(providerId, this.env);
      // Used whatever it holds. This used to insist every row carried a message
      // count and reprobe otherwise \u2014 which was reasonable while counts came
      // from opening each conversation, and became a trap the moment that
      // stopped: a count most agents never supply would have made the gate
      // permanently false, so the cache would never be used and every drawer
      // open would pay a full spawn.
      if (disk) {
        // How old this answer is, so the staleness check below has something to
        // measure. A file written days ago is stale the moment it is read.
        this.markProbed(providerId, disk.probedAt);
        // Return disk history immediately while booting the matching provider.
        // The first tap can then adopt this process instead of starting cold.
        void this.warmProvider(providerId);
        // Independent of the warm-up above, which returns early when a spare is
        // already parked — that short circuit was the second way a stale list
        // could survive: a provider warmed by anything else never refreshed.
        this.revalidateIfStale(providerId);
        // Survives a daemon restart, so the first project chosen after a reboot
        // is answered from disk rather than waiting on the background reprobe.
        if (disk.allSessions?.length) this.projectHistory.set(providerId, disk.allSessions);
        const served = Promise.resolve<ProviderCapabilities>({
          // The agent's own values, uncorrected. Preferences are applied when a
          // caller is answered (`capabilitiesFor`), never baked in here: this
          // promise outlives the ask that created it, so a value folded in now
          // would still be reported after the user picked something else —
          // the pill would name a model the next prompt was not going to use.
          configOptions: disk.configOptions,
          sessions: disk.sessions,
          canResume: disk.canResume,
          // A cache from an older daemon has neither; the background refresh
          // below fills both in, and until then the app falls back to the
          // projects it can see in the history it holds.
          projects: disk.projects ?? [],
          ...(disk.extensions ? { extensions: disk.extensions } : {}),
          // A cache written by an older daemon predates commands entirely; the
          // background refresh below fills them in.
          commands: disk.commands ?? [],
        });
        this.probes.set(providerId, served);
        return served;
      }
    }

    // `announceSpare` settles the moment the process answers, so a tap can
    // adopt it while the history probe below is still reading the disk. It only
    // ever resolves: a failed boot leaves no spare, which the caller already
    // handles by spawning cold, and rejecting would be an unhandled rejection
    // whenever nobody happened to be waiting.

    const probe = (async (): Promise<ProviderCapabilities> => {
      let handle: AcpSessionHandle | undefined;
      try {
        const workspace = resolveWorkspace();
        handle = await connectProvider({
          provider,
          // Same rule as session.start: under launchd cwd is `/`, which is not a
          // project directory. Probing from it hid every agent's sessions.
          cwd: workspace,
          // A probe session is never shown, so its output goes nowhere.
          onUpdate: () => {},
          onPermissionRequest: () => {},
        });
        const booted = handle;
        // Published before the history below, which is the slow half: listing
        // sessions and counting each one's messages is seconds of disk work,
        // and a new conversation needs none of it. Whoever adopts this calls
        // `session/new` on the same process; `listSessions` does not touch the
        // adopted session, so the two can safely overlap.
        this.stashSpare(providerId, booted, workspace);
        handle = undefined;
        announceSpare();

        // Needed several times below, and `listSessions` is the slow call:
        // once only.
        const { sessions, projects, all } = await booted.listSessions();
        // Held so choosing a project can be answered from memory. The agent was
        // already asked for every session it has; asking again per project
        // would pay the spawn and the list a second time for data this process
        // is already holding.
        this.projectHistory.set(providerId, all);

        const capabilities: ProviderCapabilities = {
          // The agent's own list, at the agent's own values. `capabilitiesFor`
          // is what folds the user's remembered choices over it, so that the
          // correction happens per answer rather than once per daemon lifetime —
          // and so what lands in the probe cache stays the agent's answer,
          // which is the one thing that file is documented to hold.
          configOptions: booted.configOptions,
          // The agent's own history, including everything started at the desk.
          sessions,
          canResume: booted.canLoadSession,
          // The complete set of places this agent has worked, which the capped
          // `sessions` above cannot describe.
          projects,
          ...((ext) => (ext ? { extensions: ext } : {}))(
            readExtensions(booted.ggCapabilities as Record<string, unknown> | undefined),
          ),
          // Read after `listSessions` deliberately. Commands arrive as a
          // notification rather than in `session/new`'s result, so reading them
          // the instant the session opened would find none; that round trip is
          // the window they land in.
          //
          // Falling back to the project's own files when the agent sent none:
          // some agents ship no such notification at all, and their commands
          // would otherwise be invisible. The agent always wins when it does
          // answer, since only it knows its built-ins.
          commands: booted.availableCommands.length
            ? booted.availableCommands
            : await readCommandDirs(
                provider.manifest.tappy.commandDirs,
                // The agent's own most recent project, not the daemon's cwd.
                // Under launchd that cwd is `/` and `resolveWorkspace()` falls
                // back to home, which holds no project's commands — so the
                // fallback would find nothing for every agent that needs it.
                sessions[0]?.cwd ?? workspace,
              ),
        };
        // Persist so the next ask — and the next daemon boot — answers from
        // disk instead of spawning again.
        void writeProbeCache(providerId, capabilities, this.env, all).catch(() => {});
        // Installed only now that it exists, which is what lets a refresh leave
        // the previous answer serving readers until this moment.
        this.probes.set(providerId, Promise.resolve(capabilities));
        // This is the answer the staleness clock is about: everything served
        // from here until it expires is this moment's view of the agent's disk.
        this.markProbed(providerId, Date.now());
        return capabilities;
      } catch (error) {
        // A probe is best-effort: this is what the app shows before a session
        // exists, and failing here must not stop the user starting a real one.
        console.error(`[${providerId}] capability probe failed:`, error);
        // A failed refresh changes nothing: whatever was serving before still
        // is. Only a failed *first* probe has an entry to withdraw.
        if (!refresh) this.probes.delete(providerId);
        // Backs the next staleness check off by a full interval. Dropping the
        // probe above sends the next ask back to the cache file, whose older
        // timestamp would otherwise ask for another spawn immediately — an
        // agent that fails to boot would be respawned on every drawer open.
        this.markProbed(providerId, Date.now());
        // Releases anyone waiting on the boot. Harmless once already announced.
        announceSpare();
        return EMPTY_CAPABILITIES;
      } finally {
        handle?.close();
      }
    })();

    // A refresh deliberately does not park its pending promise here — readers
    // must keep getting the last good answer while it runs.
    if (!refresh) {
      this.probes.set(providerId, probe);
      // Stamped while the probe is still in flight, not just when it lands. A
      // pending probe with no stamp reads as "never probed", so the next asker
      // to arrive during the boot — the drawer opening while a project is being
      // chosen — judged it stale and spawned a *second* agent alongside the one
      // it was already waiting on. Stamped again when the answer lands.
      this.markProbed(providerId, Date.now());
    }
    return probe;
  }

  /**
   * Capabilities as a client must see them: the agent's list, at the values the
   * next session will really open with.
   *
   * The probe reports the agent's defaults, and a new session has this user's
   * remembered choices applied to it on connect — so an uncorrected reply
   * describes a state that never reaches the screen. Applied here, on every
   * answer, because the probe behind it is cached while a preference changes
   * whenever someone taps a pill.
   */
  async capabilitiesFor(
    providerId: string,
    { refresh = false } = {},
  ): Promise<ProviderCapabilities> {
    const probed = await this.probeProvider(providerId, { refresh });
    if (probed === EMPTY_CAPABILITIES) return probed;
    const extensions = probed.extensions ?? this.knownExtensions.get(providerId);
    if (providerId === GG_GOALS_ID) {
      return {
        ...probed,
        configOptions: withStoredPrefs(probed.configOptions, await readConfigPrefs(providerId)),
      };
    }
    return {
      ...probed,
      ...(extensions ? { extensions } : {}),
      // Ambient env, like every other preference read here: `this.env` is fixed
      // at construction for the probe cache's sake, and prefs are written
      // through the ambient one.
      configOptions: withStoredPrefs(probed.configOptions, await readConfigPrefs(providerId)),
    };
  }

  /**
   * Tell every client what a new conversation with this provider will now use.
   *
   * Sent whenever a provider-level preference is written — from the empty state
   * *and* from inside a live session, since a choice made mid-conversation is
   * recorded against the provider too. The empty state has no session to read
   * selectors from, so without this it fell back to whatever the last
   * conversation was holding: reopening an old chat on Opus and then starting a
   * new one showed "Opus" while the prompt actually ran on the remembered
   * model. A pill that names the wrong model is worse than no pill.
   *
   * `fallback` is the live session's own list, used when this provider has no
   * probe to name its options — an agent that never probed cleanly can still be
   * configured, and the answer must not be silence.
   */
  protected async publishProviderConfig(providerId: string, fallback?: ConfigOption[]) {
    const probed = await this.probes.get(providerId);
    const base = probed?.configOptions.length ? probed.configOptions : fallback;
    if (!base?.length) return;
    this.send({
      t: "provider.config",
      providerId,
      configOptions: withStoredPrefs(base, await readConfigPrefs(providerId)),
    });
  }
}
