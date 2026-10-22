/**
 * Manual live check (not part of `npm test`): drives the real tappy Daemon
 * against a real GG Coder ACP build, exercising the `_gg/*` extensions.
 *
 *   GG_CLI=/path/to/ggcoder/dist/cli.js bun run packages/daemon/src/testing/gg-live-check.ts
 *
 * Costs a couple of real model turns. Never creates goals (lists only).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../index.js";
import { handleMessage } from "../handler.js";
import type { LoadedProvider } from "../providers/registry.js";

const cli = process.env.GG_CLI;
if (!cli) throw new Error("set GG_CLI to ggcoder's dist/cli.js");

const provider: LoadedProvider = {
  manifest: {
    id: "ggcoder",
    name: "GG Coder",
    description: "",
    tappy: { transport: "acp", requiresWorkspace: false, commandDirs: [] },
  } as unknown as LoadedProvider["manifest"],
  source: "<live-check>",
  command: process.execPath.includes("bun") ? "node" : process.execPath,
  args: [cli, "acp"],
  missingEnv: [],
  commandMissing: false,
};

const root = await mkdtemp(join(tmpdir(), "tappy-live-"));
process.env.TAPPY_HOME = join(root, "home");
process.env.TAPPY_WORKSPACE = root;

const sent: any[] = [];
const daemon = new Daemon({ id: "live", name: "live" });
daemon.attach((m) => sent.push(m));
(daemon as any).providers = [provider];
const ctx = {
  daemon,
  reply: (m: unknown) => sent.push({ ...(m as object), replied: true }),
  broadcast: (m: unknown) => sent.push(m),
  cwd: root,
};
const send = (m: unknown) => handleMessage(JSON.stringify(m), ctx);

async function until<T>(read: () => T | undefined, what: string, ms = 180_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = read();
    if (v !== undefined && v !== false) return v;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const results: Record<string, unknown> = {};
try {
  await send({ t: "goals", requestId: "g1" });
  const goals = await until(() => sent.find((m) => m.t === "goals" && m.requestId === "g1"), "goals");
  results.goals = { count: goals.goals?.length, error: goals.error, first: goals.goals?.[0]?.name };

  await send({ t: "session.start", requestId: "s", providerId: "ggcoder" });
  const started = await until(() => sent.find((m) => m.t === "session.started" && m.requestId === "s"), "start");
  const id = started.sessionId as string;
  await send({
    t: "session.prompt",
    sessionId: id,
    text: "Run this exact bash command and nothing else: sleep 8 && echo first-done. Then reply with one short line.",
  });
  await until(
    () => sent.find((m) => m.t === "session.event" && m.sessionId === id && /tool_call/.test(m.payload?.sessionUpdate ?? m.payload?.update?.sessionUpdate ?? JSON.stringify(m.payload))),
    "first tool call",
  );
  await send({ t: "session.prompt", sessionId: id, text: "Also: when you're done, say the word BANANA." });
  const queued = await until(() => sent.find((m) => m.t === "session.queue" && m.queued.length === 1), "queued");
  results.queuedWhileRunning = queued.queued.map((q: any) => q.text);
  await until(() => sent.find((m) => m.t === "session.idle" && m.sessionId === id), "idle", 240_000);
  // Allow a follow-on turn (turnEnded hand-back) to complete.
  await Bun.sleep(1500);
  await until(() => !(daemon as any).sessions.get(id)?.working, "settled", 240_000);
  const users = sent.filter((m) => m.t === "session.event" && m.payload?.kind === "user_message").map((m) => m.payload.text);
  const agentText = JSON.stringify(sent.filter((m) => m.t === "session.event" && m.sessionId === id).map((m) => m.payload));
  results.userMessages = users;
  results.finalQueue = sent.findLast((m) => m.t === "session.queue")?.queued;
  results.saidBanana = /BANANA/.test(agentText);
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error);
  results.trace = sent.filter((m) => m.t !== "session.event").map((m) => `${m.t}:${m.code ?? ""}:${(m.message ?? "").slice(0, 300)}`);
} finally {
  daemon.closeAll();
}
console.log(JSON.stringify(results, null, 2));
process.exit(results.error ? 1 : 0);
