/**
 * Tell the phone when GG Coder's chats change on disk.
 *
 * The desktop app writes every conversation to `~/.gg/sessions/<project>/`.
 * Before this, the phone only learned about a new project or chat when it next
 * asked — reopening the drawer, or a minute later at best — so starting work in
 * the app looked like it never reached the phone.
 *
 * Polled rather than `fs.watch`ed: a recursive watch is unreliable across the
 * three platforms (Linux has none), and what changes is cheap to detect — the
 * newest modification time across a few directories and files.
 */
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { ggSessionsRoot } from "./sessions.js";

/**
 * A fingerprint of the sessions tree: every project directory, every session
 * file, and their modification times. Changes whenever a chat is created,
 * appended to or removed, or a project appears.
 */
export async function sessionsFingerprint(root: string = ggSessionsRoot()): Promise<string> {
  let projects: string[];
  try {
    projects = (await readdir(root)).sort();
  } catch {
    return "";
  }
  const parts: string[] = [];
  for (const project of projects) {
    const dir = join(root, project);
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl")).sort();
    } catch {
      continue;
    }
    parts.push(`${project}/${names.length}`);
    for (const name of names) {
      try {
        parts.push(`${name}:${(await stat(join(dir, name))).mtimeMs}`);
      } catch {
        // Removed between readdir and stat: the next poll sees it gone.
      }
    }
  }
  return parts.join("|");
}

export interface SessionsWatcher {
  stop(): void;
}

/**
 * Call `onChange` once per settled change to the sessions tree. The first read
 * only sets the baseline. A change is reported after it has held for one more
 * poll, so a reply streaming into a file does not fire on every line.
 */
export function watchSessions(
  onChange: () => void,
  {
    root = ggSessionsRoot(),
    intervalMs = 1500,
    fingerprint = sessionsFingerprint,
  }: { root?: string; intervalMs?: number; fingerprint?: (root: string) => Promise<string> } = {},
): SessionsWatcher {
  let last: string | undefined;
  let pending: string | undefined;
  let running = false;
  let stopped = false;
  const tick = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const now = await fingerprint(root);
      if (last === undefined) {
        last = now;
      } else if (now !== last) {
        if (pending === now) {
          last = now;
          pending = undefined;
          onChange();
        } else {
          pending = now;
        }
      } else {
        pending = undefined;
      }
    } catch {
      // An unreadable tree is retried on the next tick.
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  // Never the reason the daemon stays alive.
  (timer as { unref?: () => void }).unref?.();
  void tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
