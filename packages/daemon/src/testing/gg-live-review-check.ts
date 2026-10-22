/**
 * Manual live check (not part of `npm test`), round 2: checklist, Autopilot
 * state and a real plan review through the real tappy Daemon against a real GG
 * Coder ACP build. Works in a throwaway git repo in tempdir.
 *
 *   GG_CLI=/path/to/ggcoder/dist/cli.js bun run packages/daemon/src/testing/gg-live-review-check.ts
 *
 * Costs a few real model turns.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "../index.js";
import { handleMessage } from "../handler.js";
import type { LoadedProvider } from "../providers/registry.js";

const cli = process.env.GG_CLI;
if (!cli) throw new Error("set GG_CLI to ggcoder's dist/cli.js");

const root = await mkdtemp(join(tmpdir(), "tappy-live2-"));
const project = join(root, "proj");
execFileSync("mkdir", ["-p", project]);
await writeFile(join(project, "README.md"), "# tiny\n");
execFileSync("git", ["init", "-q"], { cwd: project });
process.env.TAPPY_HOME = join(root, "home");
process.env.TAPPY_WORKSPACE = project;

const provider: LoadedProvider = {
  manifest: {
    id: "ggcoder",
    name: "GG Coder",
    description: "",
    tappy: { transport: "acp", requiresWorkspace: false, commandDirs: [] },
  } as unknown as LoadedProvider["manifest"],
  source: "<live-check>",
  command: "node",
  args: [cli, "acp"],
  missingEnv: [],
  commandMissing: false,
};

const sent: any[] = [];
const daemon = new Daemon({ id: "live", name: "live" });
daemon.attach((m) => sent.push(m));
(daemon as any).providers = [provider];
const ctx = {
  daemon,
  reply: (m: unknown) => sent.push({ ...(m as object), replied: true }),
  broadcast: (m: unknown) => sent.push(m),
  cwd: project,
};
const send = (m: unknown) => handleMessage(JSON.stringify(m), ctx);

async function until<T>(read: () => T | undefined, what: string, ms = 150_000): Promise<T> {
  console.error(`[live] waiting: ${what}`);
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = read();
    if (v !== undefined && v !== false) return v;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const results: Record<string, unknown> = {};
try {
  await send({ t: "session.start", requestId: "s", providerId: "ggcoder" });
  const started = await until(() => sent.find((m) => m.t === "session.started" && m.requestId === "s"), "start");
  const id = started.sessionId as string;
  const idles = () => sent.filter((m) => m.t === "session.idle" && m.sessionId === id).length;

  // Capabilities carry the extensions.
  // The app asks again whenever it needs to; the first answer can be the
  // empty "still probing" frame if the probe lost a race with this session.
  let caps: any;
  for (let i = 0; i < 5 && !caps; i++) {
    await send({ t: "provider.capabilities", providerId: "ggcoder" });
    caps = await until(() => sent.find((m) => m.t === "provider.capabilities" && m.extensions) ?? (Bun.sleep(1500), undefined), "extensions", 3000).catch(() => undefined);
  }
  if (!caps) throw new Error("no extensions after 5 asks");
  results.extensions = caps.extensions;

  // Checklist.
  await send({ t: "checklist", requestId: "c1", sessionId: id });
  const list = await until(() => sent.find((m) => m.t === "checklist" && m.requestId === "c1"), "checklist");
  results.checklist = list.error ?? { items: list.items?.length, first: list.items?.[0]?.title, status: list.items?.[0]?.status };

  // Autopilot state round trip (left off for the plan test).
  await send({ t: "autopilot.set", sessionId: id, enabled: true });
  await until(() => sent.find((m) => m.t === "autopilot.state" && m.enabled === true), "autopilot on");
  await send({ t: "autopilot.set", sessionId: id, enabled: false });
  await until(() => sent.findLast((m) => m.t === "autopilot.state")?.enabled === false, "autopilot off");
  results.autopilotToggle = "ok";

  // Plan review: ask for a plan, accept it.
  await send({
    t: "session.prompt",
    sessionId: id,
    text:
      "Enter plan mode now (enter_plan) and submit (exit_plan) a 2-step plan to add a file hello.txt containing 'hi' " +
      "and then list the folder. Keep the plan tiny. Do not implement anything before approval.",
  });
  const plan = await until(() => sent.find((m) => m.t === "plan.state" && m.pending), "pending plan");
  results.planPending = { generation: plan.pending.generation, chars: plan.pending.content.length };
  await until(() => idles() >= 1, "plan turn idle");
  await send({ t: "plan.decide", sessionId: id, generation: plan.pending.generation, action: "accept" });
  await until(() => idles() >= 2, "implementation idle", 400_000);
  const events = sent.filter((m) => m.t === "session.event" && m.sessionId === id).map((m) => m.payload);
  results.planEvents = events.filter((p) => p?.kind === "plan_decision" || p?.kind === "plan_accepted");
  results.helloWritten = (() => {
    try {
      return execFileSync("cat", [join(project, "hello.txt")]).toString().trim();
    } catch {
      return null;
    }
  })();
  results.planCleared = sent.findLast((m) => m.t === "plan.state")?.pending === null;

  if (process.env.LIVE_AUTOPILOT) {
    // A real Ken cycle: autopilot on, a small task, Ken reviews it.
    await send({ t: "autopilot.set", sessionId: id, enabled: true });
    await until(() => sent.findLast((m) => m.t === "autopilot.state")?.enabled === true, "autopilot on (2)");
    const before = idles();
    await send({
      t: "session.prompt",
      sessionId: id,
      text: "Create bye.txt containing 'bye', then verify it with `cat bye.txt`.",
    });
    await until(() => idles() > before, "autopilot turn idle", 480_000);
    results.autopilotEvents = sent
      .filter((m) => m.t === "session.event" && m.sessionId === id && m.payload?.kind === "autopilot")
      .map((m) => ({ phase: m.payload.phase, round: m.payload.round, text: String(m.payload.body ?? m.payload.reason ?? "").slice(0, 120) }));
    results.reviewingSeen = sent.some((m) => m.t === "autopilot.state" && m.reviewing === true);
    results.finalReviewing = sent.findLast((m) => m.t === "autopilot.state")?.reviewing;

    // Reopen the same conversation in a fresh daemon: Ken's bubbles come back.
    const agentSessionId = daemon.agentSessionId(id);
    const second: any[] = [];
    const reopened = new Daemon({ id: "live2", name: "live2" });
    reopened.attach((m) => second.push(m));
    (reopened as any).providers = [provider];
    try {
      await handleMessage(JSON.stringify({ t: "session.resume", providerId: "ggcoder", agentSessionId, cwd: project }), {
        daemon: reopened,
        reply: (m: unknown) => second.push(m),
        broadcast: (m: unknown) => second.push(m),
        cwd: project,
      });
      await until(() => second.find((m) => m.t === "session.replay" && m.complete !== false), "reopened replay", 120_000);
      const replayed = second
        .flatMap((m) => (m.t === "session.replay" ? m.events : m.t === "session.event" ? [m] : []))
        .map((e: any) => e.payload)
        .filter((p: any) => p?.kind === "autopilot")
        .map((p: any) => p.phase);
      results.reopenedKenPhases = replayed;
    } finally {
      reopened.closeAll();
    }
  }
} catch (error) {
  results.error = error instanceof Error ? error.message : String(error);
  results.trace = sent
    .filter((m) => m.t !== "session.event")
    .map((m) => `${m.t}:${m.code ?? ""}:${(m.message ?? m.error ?? "").toString().slice(0, 200)}`);
} finally {
  daemon.closeAll();
}
console.log(JSON.stringify(results, null, 2));
process.exit(results.error ? 1 : 0);
