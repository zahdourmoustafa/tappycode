/**
 * Manual live check (not part of `npm test`): drives the real tappy Daemon
 * through the GG Coder app bridge into a real GG Coder app engine.
 *
 *   GG_SIDECAR=/path/to/gg-coder/packages/ggcoder/dist/app-sidecar.js \
 *     bun run packages/daemon/src/testing/gg-app-live-check.ts
 *
 * Starts the sidecar as the app would, opens a conversation in it the way a
 * window does and keeps a viewer on it, then proves the phone path end to end:
 *   - the phone's prompt streams back as agent chunks and the turn ends,
 *   - the "window" sees the phone's prompt as `prompt_sent` from tappy,
 *   - a prompt typed in the "window" reaches the phone as a user turn.
 *
 * Uses the real ~/.gg (for the login), so it costs two short model turns and
 * leaves one small conversation in that project's history.
 */
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Daemon } from "../index.js";
import { handleMessage } from "../handler.js";
import { AppClient } from "../gg-app/client.js";
import { discoverApps } from "../gg-app/discovery.js";
import { loadProviders } from "../providers/registry.js";

const sidecarPath = process.env.GG_SIDECAR;
if (!sidecarPath) throw new Error("set GG_SIDECAR to gg-coder's packages/ggcoder/dist/app-sidecar.js");

async function until<T>(read: () => T | undefined | false, what: string, ms = 180_000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = read();
    if (v !== undefined && v !== false) return v as T;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const project = await mkdtemp(join(tmpdir(), "tappy-gg-app-"));
const before = new Set((await discoverApps()).map((a) => a.pid));
const sidecar = spawn("node", [sidecarPath], { stdio: "ignore", env: { ...process.env, GG_APP_CWD: project } });
const results: Record<string, unknown> = {};

try {
  const app = await (async () => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const found = (await discoverApps()).find((a) => !before.has(a.pid) && a.pid === sidecar.pid);
      if (found) return found;
      await Bun.sleep(200);
    }
    throw new Error("sidecar never wrote its connection file");
  })();
  results.connectionFile = "found";

  // The "window": one conversation for the project, with a live viewer.
  const window = new AppClient(app);
  const windowSession = await window.createSession(project);
  const seen: { type: string; data: Record<string, unknown> }[] = [];
  (globalThis as any).__seen = seen;
  const viewer = new AbortController();
  void (async () => {
    try {
      for await (const event of window.events(windowSession, viewer.signal)) seen.push(event);
    } catch {
      // The stream ends when the check aborts the viewer.
    }
  })();
  await until(() => seen.some((e) => e.type === "ready"), "window ready", 15_000);

  // The phone: tappy's real daemon with only the bundled ggcoder-app provider.
  process.env.TAPPY_HOME = join(project, ".tappy-home");
  // The daemon only honours a client cwd it published itself; with none sent,
  // a session opens in TAPPY_WORKSPACE, which is exactly the phone's default.
  process.env.TAPPY_WORKSPACE = project;
  const { providers } = await loadProviders([], process.env, { bundled: true });
  const provider = providers.find((p) => p.manifest.id === "ggcoder-app");
  if (!provider) throw new Error("ggcoder-app provider not bundled");
  results.providerInstalled = !provider.commandMissing;

  const sent: any[] = [];
  (globalThis as any).__sent = sent;
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

  await send({ t: "session.start", requestId: "s", providerId: "ggcoder-app" });
  const started = await until(() => sent.find((m) => m.t === "session.started"), "session.started", 60_000);
  results.joinedWindow = started.agentSessionId === windowSession || started.sessionId;

  const events = (sessionId: string) =>
    sent
      .filter((m) => m.t === "session.event" && m.sessionId === sessionId)
      .map((m) => ({ kind: "update", update: m.payload?.update }));

  await send({ t: "session.prompt", sessionId: started.sessionId, text: "Reply with exactly the word: pong" });
  await until(() => sent.find((m) => m.t === "session.idle" && m.sessionId === started.sessionId), "phone turn to end");
  const phoneReply = events(started.sessionId)
    .filter((e: any) => e.kind === "update" && e.update?.sessionUpdate === "agent_message_chunk")
    .map((e: any) => e.update.content?.text ?? "")
    .join("");
  results.phoneReply = phoneReply.trim().slice(0, 40);
  results.windowSawPhonePrompt = seen.some((e) => e.type === "prompt_sent" && e.data.origin === "tappy");
  results.windowSawReply = seen.some((e) => e.type === "text_delta");

  // Typed in the window: the phone must see it as a user turn.
  await window.prompt(windowSession, "Reply with exactly the word: ping").catch(() => {});
  const beforeCount = events(started.sessionId).length;
  await until(
    () =>
      events(started.sessionId)
        .slice(beforeCount - 1)
        .some(
          (e: any) =>
            e.kind === "update" &&
            e.update?.sessionUpdate === "user_message_chunk" &&
            /ping/.test(e.update.content?.text ?? ""),
        ),
    "window prompt on the phone",
    60_000,
  );
  results.phoneSawWindowPrompt = true;
  viewer.abort();
} catch (error) {
  results.failure = (error as Error).message;
  results.lastDaemonFrames = (globalThis as any).__sent?.slice(-6);
  results.windowEvents = (globalThis as any).__seen?.map((e: any) => e.type);
} finally {
  console.log(JSON.stringify(results, null, 2));
  sidecar.kill("SIGTERM");
  await Bun.sleep(1500);
  process.exit(0);
}
