/**
 * Finding the GG Coder desktop app that is open on this machine.
 *
 * The app's engine (its "sidecar") answers on a loopback port guarded by a
 * per-launch token. Builds from zahdourmoustafa/gg-coder write both to
 * `~/.gg/app-connections/<pid>.json` while running (0600 on POSIX; the user
 * profile's ACL on Windows) and delete it on exit. A crash leaves the file, so
 * a reader trusts it only while that pid is alive.
 *
 * Anything able to read this file already runs as the user and can read
 * `~/.gg/auth.json` — the provider keys themselves — so using it hands tappy no
 * more than the user's own processes already had.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { z } from "zod";

/** The only file shape this build understands. */
const ConnectionFile = z.object({
  version: z.literal(1),
  pid: z.number().int().positive(),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  token: z.string().min(1),
  startedAt: z.string().optional(),
});

export interface AppConnection {
  pid: number;
  /** `http://host:port`, never a hostname that resolves off this machine. */
  baseUrl: string;
  token: string;
  startedAt?: string;
}

export function appConnectionsDir(home: string = homedir()): string {
  return join(home, ".gg", "app-connections");
}

/** True when a process with this id exists; EPERM still means it exists. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Loopback only: the token must never be sent to another machine. */
function loopbackBase(host: string, port: number): string | undefined {
  if (host === "127.0.0.1" || host === "localhost") return `http://127.0.0.1:${port}`;
  if (host === "::1") return `http://[::1]:${port}`;
  return undefined;
}

export interface DiscoverOptions {
  dir?: string;
  alive?: (pid: number) => boolean;
}

/**
 * Every running GG Coder app, newest first. Usually one; two only when the
 * user runs a second instance, and the newest is the one they just opened.
 */
export async function discoverApps(options: DiscoverOptions = {}): Promise<AppConnection[]> {
  const dir = options.dir ?? appConnectionsDir();
  const alive = options.alive ?? processAlive;
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: AppConnection[] = [];
  for (const name of names.filter((entry) => /^\d+\.json$/.test(entry)).sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const parsed = ConnectionFile.safeParse(raw);
    if (!parsed.success || !alive(parsed.data.pid)) continue;
    const baseUrl = loopbackBase(parsed.data.host, parsed.data.port);
    if (!baseUrl) continue;
    found.push({
      pid: parsed.data.pid,
      baseUrl,
      token: parsed.data.token,
      ...(parsed.data.startedAt ? { startedAt: parsed.data.startedAt } : {}),
    });
  }
  return found.sort(
    (a, b) => (b.startedAt ?? "").localeCompare(a.startedAt ?? "") || b.pid - a.pid,
  );
}
