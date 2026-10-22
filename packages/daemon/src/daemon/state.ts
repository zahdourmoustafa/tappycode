/**
 * The Daemon's state: every field it holds, its tuning constants, and the
 * constructor. The behaviour lives in the layers stacked on top of this
 * (`spares.ts` … `index.ts`), all of which read and write these same fields
 * through `this`, so a test reaching in by name still finds them on the
 * instance.
 */
import type { LoadedProvider } from "../providers/registry.js";
import type { AcpSessionHandle, AgentSession } from "../acp/connect.js";
import { PushRegistry } from "../push.js";
import type { wire } from "@tappy/protocol";
import type { ActiveSession, ProviderCapabilities } from "./types.js";

export abstract class DaemonState {
  protected providers: LoadedProvider[] = [];
  protected readonly sessions = new Map<string, ActiveSession>();
  /** Mints queued-message ids (`q_<n>`), unique for this process. */
  protected queueCounter = 0;
  protected send: (message: unknown) => void = () => {};
  // What a provider offers, learned by probing it: selectors, and the
  // conversations it already has on disk. Keyed by provider id, and stored in
  // flight rather than resolved so concurrent asks share one spawn.
  protected readonly probes = new Map<string, Promise<ProviderCapabilities>>();
  /**
   * When each provider's answer above was last obtained — from a live probe, or
   * from the timestamp inside the cache file that answered instead.
   *
   * Monotonic: a disk file older than what is already known never rewinds this,
   * so a failed refresh backs off for a full interval rather than spawning the
   * agent again on every ask.
   */
  protected readonly probedAt = new Map<string, number>();
  /** Background refreshes in flight, so concurrent asks share one spawn. */
  protected readonly refreshing = new Map<string, Promise<void>>();
  /**
   * Every session a provider reported, uncapped, keyed by provider id.
   *
   * The app is only ever sent the newest handful, because message counts cost
   * a disk read each. Choosing a project then needs a *different* handful —
   * one repo's newest — and this is what answers that without spawning the
   * agent again.
   */
  protected readonly projectHistory = new Map<string, AgentSession[]>();

  /**
   * Directories recently shown to a browsing client.
   *
   * A path only becomes a "known project" once a session exists in it, so a
   * folder reached by browsing would otherwise be unrecognised at exactly the
   * moment it is chosen. Insertion-ordered and capped, so it stays an echo check
   * rather than a growing record of what is on the disk.
   */
  protected readonly offeredWorkspaces = new Set<string>();

  /**
   * The same check's durable half: projects a client has actually opened, read
   * from disk on first use. See `known-projects.ts` — the app re-sends its
   * chosen project for days, so "offered seconds ago" is not the whole rule.
   */
  protected chosen?: Promise<Set<string>>;
  /** Serialises the read-modify-write behind `rememberProject`. */
  protected chosenWrites: Promise<void> = Promise.resolve();

  /**
   * One already-booted agent process per provider, left over from the last
   * probe. Spawning is the slow part of opening a conversation — GG Coder
   * takes ~5s to boot while `session/load` answers in ~30ms — so the next
   * session *adopts* this process instead of paying the spawn again. A spare
   * idles out after `SPARE_TTL_MS` so an unused agent does not run forever.
   */
  /**
   * Phones to notify when a turn ends while their app is asleep.
   *
   * Owned by the daemon rather than by a connection, and that is the point: the
   * socket a token arrived on is usually gone by the time it is needed — the app
   * was backgrounded, which is the whole reason a push is being sent. Both
   * transports share it for the same reason `handleMessage` is shared, so a
   * phone that paired over the LAN and later reconnects through the relay does
   * not have to be told twice.
   */
  readonly pushTargets = new PushRegistry();

  protected readonly spares = new Map<
    // Keyed by provider *and* directory. `cwd` is part of a spare's identity
    // rather than a note about it: some agents ignore ACP's per-session `cwd`
    // and run wherever their process was spawned, so a warm process is only
    // reusable for the project it was booted for.
    //
    // Keyed by provider alone, only one project could be warm at a time, and
    // opening a conversation in any other one paid a full cold spawn — two to
    // three seconds of staring at an empty thread.
    string,
    { handle: AcpSessionHandle; timer: NodeJS.Timeout; cwd: string; providerId: string }
  >();
  /**
   * At most this many warm processes per provider, oldest evicted first.
   *
   * One, not three. A warm agent is a whole language server: opencode measures
   * 326-491MB each, so three per provider is over a gigabyte idling for one
   * agent nobody is talking to.
   *
   * Three was worth trying when a spare was the only thing standing between a
   * tap and an empty screen. It is not any more \u2014 the transcript cache paints
   * the conversation from disk immediately and the agent reconnects behind it,
   * so a missed spare now costs a background reconnect rather than a visible
   * wait. Memory is the harder constraint, and this is the side to err on.
   */
  protected static readonly MAX_SPARES_PER_PROVIDER = 1;
  /** Provider boots already in flight, shared by a tap instead of duplicated. */
  protected readonly warming = new Map<string, Promise<void>>();
  /**
   * Resolves as soon as a boot has a usable process, well before the probe it
   * belongs to has finished listing history.
   *
   * These used to be one promise, so the first tap waited on a `session/list`
   * plus a message count read for every stored conversation — seconds of disk
   * work that opening a new conversation does not need at all.
   */
  protected readonly spareReady = new Map<
    string,
    { ready: Promise<void>; announce: () => void }
  >();
  protected static readonly SPARE_TTL_MS = 15 * 60 * 1000;

  /**
   * How old a provider's session list may be before the next ask refreshes it.
   *
   * The probe used to be memoised for the daemon's lifetime, refreshed exactly
   * once — on the first cache hit after boot. A daemon runs for days, and the
   * user spends those days working at the desk, so every conversation and every
   * project started after that one refresh was invisible to the phone until the
   * daemon was restarted. The cache on this machine was two days stale while
   * the agent had written sessions minutes earlier.
   *
   * A minute, because the ask that matters arrives when the app reconnects —
   * once per foreground — and "I just put the laptop down" is exactly the case
   * that has to work. The cached answer is still served immediately; this only
   * decides when a refresh runs behind it. The spawn it costs is not wasted
   * either: the probe leaves its process parked as the spare that the next
   * conversation adopts.
   */
  protected static readonly PROBE_TTL_MS = 60 * 1000;

  /**
   * How long a conversation may sit untouched before its agent is closed.
   *
   * The same fifteen minutes as a warm spare, and for the same reason: what is
   * being held is a process, and the conversation itself is on disk. Reopening
   * one measures ~1.1s — and the thread paints from cache first, so that second
   * is spent behind a screen the user is already reading.
   *
   * This started at an hour, which was too timid to be worth much: an agent is
   * 90-370MB, and a morning's work leaves several of them parked long before an
   * hour is up. Comparable tools are tighter still — openclaw evicts at ten
   * minutes, and paperclip, which speaks the same ACP protocol, tears the
   * process down after every single run.
   *
   * Nothing bounded these at all before. Every conversation opened held its
   * agent until the daemon died, so an afternoon of testing accumulated eleven
   * GG Coder processes and 2.2GB for conversations nobody had touched in hours.
   */
  protected static readonly SESSION_TTL_MS = 15 * 60 * 1000;
  /**
   * How often the reaper looks.
   *
   * Two minutes, so the sweep is a rounding error on the window rather than a
   * silent extension of it: a five-minute tick would make a fifteen-minute TTL
   * mean twenty in the worst case.
   */
  protected static readonly REAP_INTERVAL_MS = 2 * 60 * 1000;
  /**
   * How long a session may sit blocked on an unanswered permission.
   *
   * Nothing times a permission out — deliberately, because a phone that lost
   * signal mid-request must still be able to answer, and an agent stopped
   * mid-task is better than one that guessed. But `working` is true for the
   * whole wait, so the idle reaper never touched such a session: a request the
   * user never saw pinned an agent, and its slot under `MAX_LIVE_SESSIONS`, for
   * as long as the daemon ran.
   *
   * An hour is far past the point where anyone is coming back to that tap, and
   * closing is not answering: the whole session goes, the app sees the id leave
   * `activeSessions`, and reopening resumes the conversation — the same path a
   * daemon restart already takes. A long turn with no pending permission is
   * untouched.
   */
  protected static readonly BLOCKED_TTL_MS = 60 * 60 * 1000;
  protected reaper?: NodeJS.Timeout;
  /**
   * How many conversations may hold an agent process at once.
   *
   * The time limit alone does not bound memory, it only bounds *lingering*.
   * Someone working through a morning — a task here, a new one in another
   * project, a third to check something — opens conversations faster than any
   * idle clock retires them, and ten live agents is roughly two gigabytes.
   *
   * Four, because that is about as many conversations as a person actually has
   * in play at once, and closing one is cheap: the transcript is on disk and the
   * agent keeps its own history, so returning to it resumes. The cost of being
   * wrong is a few seconds of reconnect on an old conversation; the cost of no
   * cap is the machine.
   */
  protected static readonly MAX_LIVE_SESSIONS = 4;

  /**
   * GG extensions last seen on any connection to a provider. The probe is the
   * usual source, but it can lose a race (a session starting in the same breath
   * parks a second spare and closes the probe's process mid-list), and the
   * answer it then gives carries no extensions — which hides Autopilot, the
   * checklist and goals for that conversation. Any live connection knows them.
   */
  protected knownExtensions = new Map<string, wire.ProviderExtensions>();

  /**
   * Where this daemon's files live, fixed at construction.
   *
   * The probe cache path is derived from `TAPPY_HOME`, and the background refresh
   * that follows a cache hit outlives the call that started it. Reading the
   * ambient environment when that write finally lands means it goes to whatever
   * home is installed *then* rather than the one this daemon was built for — so
   * a refresh could overwrite a cache belonging to something else entirely.
   *
   * In production nothing ever moves `TAPPY_HOME`, so this is the same value
   * either way. It matters wherever more than one home exists in a process,
   * which is every test that works in a temporary directory.
   */
  protected readonly env: NodeJS.ProcessEnv;

  constructor(
    protected readonly machine: { id: string; name: string },
    protected readonly includeExperimental = false,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    // Copied, not referenced: the point is a value that cannot change under a
    // write that lands later.
    this.env = { ...env };
  }

  /**
   * "This machine is behind", for the phone to show.
   *
   * Set by the update scheduler, which is the only thing that knows. Held here
   * because `announceProviders` is the frame every client already gets on
   * connect — a separate message would need its own replay rule to survive a
   * reconnect, and this one is re-sent on every `hello` for free.
   */
  protected updateStatus?: { latest: string; automatic: boolean };

  /**
   * Agents the user has turned off.
   *
   * Checked before announcing, probing or warming: a disabled agent must not
   * appear in the drawer and must never be spawned. An installed agent nobody
   * uses still costs a process every time the app connects, because the app
   * asks each available agent what it supports.
   */
  protected disabled = new Set<string>();

  /** Goal folder paths (resolved) -> goal name, from the last goals list. */
  protected goalNames = new Map<string, string>();

  /** One shared boot of a GG Coder connection for goal calls, while in flight. */
  protected ggConnecting?: Promise<AcpSessionHandle>;

  // ── Implemented by a later layer, called from an earlier one ─────────────
  // Type-only declarations: they emit nothing, so every call still goes through
  // the instance and a test override of the member still takes effect.

  abstract capabilitiesFor(
    providerId: string,
    options?: { refresh?: boolean },
  ): Promise<ProviderCapabilities>;
  protected abstract isEnabled(providerId: string): boolean;
  protected abstract record(session: ActiveSession, payload: unknown): void;
  protected abstract require(sessionId: string): ActiveSession;
  abstract sessionNotice(sessionId: string): { folder?: string; agentName?: string; lastText?: string };
  abstract cancel(sessionId: string): Promise<void>;
  abstract sessionOrigin(sessionId: string): { providerId?: string; folder?: string };
  protected abstract closeAsk(session: ActiveSession, requestId: string): void;
}
