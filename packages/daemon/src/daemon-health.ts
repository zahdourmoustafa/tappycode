/**
 * Is a tappy daemon already answering on this port, and which version is it?
 *
 * Asked by `tappy serve` before it starts and by `doctor`. Older daemons answer
 * `{ ok: true }` without a version, which reads as `version: undefined`.
 */
export interface RunningDaemon {
  version: string | undefined;
}

export async function runningDaemon(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<RunningDaemon | undefined> {
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { ok?: unknown; version?: unknown };
    if (body.ok !== true) return undefined;
    return { version: typeof body.version === "string" ? body.version : undefined };
  } catch {
    return undefined;
  }
}
