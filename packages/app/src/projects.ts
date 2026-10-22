/**
 * Which project the drawer is showing, and which one a new conversation opens
 * in.
 *
 * The history list is a recent-work switcher: the newest conversations across
 * everything this agent has done. That answers "what was I just doing" and
 * nothing else — a repo touched last month has no rows in it at all, so there
 * was no way to say "work on *that* one" without going back to the desk. The
 * project selector is that missing axis, and it does two jobs at once: it
 * narrows the list, and it decides where the next session starts.
 *
 * The daemon folds projects from the agent's *whole* session list, which is
 * why they arrive separately from `sessions` rather than being grouped from
 * it here. This module still derives them from whatever sessions it can see,
 * as a fallback for an older daemon and so a project used seconds ago appears
 * before the next probe lands.
 *
 * Pure and react-free: the matching rules below are the fiddly part and are
 * directly testable.
 */
import { folderName } from "./projectFolder";
import { agentForProvider, type Terminal } from "./terminalTyping";
import type { Session } from "./useDaemon";

/** A project as the drawer offers it. */
export interface Project {
  /** Absolute path. The identity of a project everywhere, and what a new session is started with. */
  path: string;
  /** Last path segment: the project as people say it. */
  name: string;
  /** Conversations the agent holds in it, when the daemon counted them. */
  sessions?: number;
  /** ISO 8601 of the newest of those, for ordering. */
  updatedAt?: string;
  /** This agent is running in it right now, in a terminal on the laptop. */
  live?: boolean;
}

/** As announced by the daemon, folded from the agent's full history. */
export interface WireProject {
  path: string;
  name: string;
  sessions?: number;
  updatedAt?: string;
}

/**
 * Every project this agent can be pointed at, newest work first.
 *
 * Two sources, unioned by path. The daemon's list is authoritative and
 * complete; the sessions on screen add anything newer than the last probe —
 * including the conversation started in this app a minute ago, which would
 * otherwise be filed under a project the menu does not yet offer.
 */
export function projectsForProvider(
  announced: WireProject[] | undefined,
  sessions: Session[],
  providerId: string | undefined,
  terminals: readonly Terminal[] = [],
): Project[] {
  if (!providerId) return [];

  const byPath = new Map<string, Project>();
  for (const project of announced ?? []) {
    if (!project.path || !project.name) continue;
    byPath.set(project.path, { ...project });
  }

  for (const session of sessions) {
    if (session.providerId !== providerId) continue;
    const path = session.cwd;
    if (!path) continue;
    const name = folderName(path);
    if (!name) continue;
    // The daemon's count is over the agent's whole history; a session already
    // on screen is part of that count, so nothing is added to it here.
    //
    // A project the daemon has not announced yet gets its stamp from the
    // session itself, or a repo opened a minute ago would sort below every
    // dated one — last in a menu that promises newest first.
    if (!byPath.has(path)) {
      byPath.set(path, {
        path,
        name,
        updatedAt: Number.isFinite(session.startedAt)
          ? new Date(session.startedAt).toISOString()
          : undefined,
      });
    }
  }

  // A project this agent was just opened in on the laptop, in a terminal. It
  // belongs in the list the moment the window opens — before the agent has
  // written a single conversation into it, which is when history alone would
  // first notice it. Stamped with when the window opened, so it sorts with
  // the newest work.
  const agent = agentForProvider(providerId);
  for (const terminal of terminals) {
    if (terminal.agent !== agent || !terminal.cwd) continue;
    const name = folderName(terminal.cwd);
    if (!name) continue;
    const opened = Number.isFinite(terminal.startedAt) ? new Date(terminal.startedAt).toISOString() : undefined;
    const known = byPath.get(terminal.cwd);
    byPath.set(terminal.cwd, {
      ...(known ?? { path: terminal.cwd, name }),
      live: true,
      updatedAt: [known?.updatedAt, opened].filter(Boolean).sort().at(-1),
    });
  }

  // Projects open in a terminal first — the ones being worked on right now —
  // then everything else, newest first.
  return [...byPath.values()].sort(
    (a, b) => Number(b.live ?? false) - Number(a.live ?? false) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""),
  );
}

/**
 * The only parts of the session list that can change the project list.
 *
 * The sessions array is rebuilt on every streamed chunk — each one updates the
 * mirror of turns hanging off the active session — so it takes a new identity
 * many times a second while an agent is answering. Used directly as a memo
 * dependency, that made `projectsForProvider` rebuild its Map and run a
 * `localeCompare` sort on every chunk, for a drawer that is usually closed and
 * whose contents had not changed.
 *
 * This is that list reduced to what the function above actually reads: `cwd`
 * and `startedAt`, over the sessions belonging to this agent. Building it is a
 * linear pass over values already in memory, cheaper than the sort it now
 * nearly always avoids — and it is exact rather than a heuristic: if this
 * string is unchanged, so is the list it would have produced. It errs toward
 * including a session the caller later discards, never toward omitting one.
 *
 * The separators are control characters because a path may contain anything the
 * filesystem allows, including whatever punctuation an ordinary delimiter would
 * have picked.
 */
export function projectSourceKey(
  sessions: Session[],
  providerId: string | undefined,
): string {
  if (!providerId) return "";
  let key = "";
  for (const session of sessions) {
    if (session.providerId !== providerId || !session.cwd) continue;
    key += `${session.cwd}\u0000${session.startedAt}\u0001`;
  }
  return key;
}

/**
 * Does this conversation belong to the chosen project?
 *
 * `cwd` is the real answer, but a session this app started never had one: the
 * daemon stamps only the folder *name* onto it when the turn finishes. Falling
 * back to that name is what keeps a conversation you just started from
 * vanishing out of the project you started it in. Two repos with the same last
 * segment could collide there, which is why it is the fallback and not the
 * rule.
 */
export function sessionInProject(session: Pick<Session, "cwd" | "folder">, project: Project): boolean {
  if (session.cwd) return session.cwd === project.path;
  return session.folder !== undefined && session.folder === project.name;
}

/** The history list, narrowed to one project. `undefined` means all of them. */
export function sessionsInProject<T extends Pick<Session, "cwd" | "folder">>(sessions: T[], project: Project | undefined): T[] {
  if (!project) return sessions;
  return sessions.filter((session) => sessionInProject(session, project));
}

/** The selector's own label. Named for the state it is in, never left blank. */
export function projectLabel(project: Project | undefined): string {
  return project?.name ?? "All projects";
}

/** One chip in the drawer's project strip. `path` undefined is "All". */
export interface ProjectTabItem {
  path?: string;
  label: string;
  a11y: string;
}

/**
 * The project strip's data, "All" first. Built once per project list so the
 * windowed strip gets stable items, and only the chips on screen mount: an
 * agent with hundreds of projects (GG Coder) mounted every one on switch.
 */
export function projectTabItems(projects: readonly Project[]): ProjectTabItem[] {
  return [
    { label: "All", a11y: "All projects" },
    ...projects.map((project) => ({
      path: project.path,
      // A dot for a project open in a terminal on the laptop right now: the
      // one the composer will type into, told apart at a glance.
      label: project.live ? `● ${project.name}` : project.name,
      a11y: project.live ? `Project ${project.name}, open in a terminal` : `Project ${project.name}`,
    })),
  ];
}
