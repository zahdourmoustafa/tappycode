/**
 * The bridge must boot and list chats with no GG Coder app running.
 *
 * Regression: tappy opens a session on every probe, and the bridge used to
 * create it inside the app. When the app was closed — or tappy could not reach
 * it — the probe failed outright and the phone showed GG Coder App with no
 * chats and no projects at all, though they were all on disk.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { connectProvider } from "../acp/connect.js";
import { loadProviders } from "../providers/registry.js";

const savedHome = process.env.HOME;
const savedProfile = process.env.USERPROFILE;
afterAll(() => {
  process.env.HOME = savedHome;
  process.env.USERPROFILE = savedProfile;
});

test("with no app running, the bridge still connects and lists stored chats", async () => {
  const home = await mkdtemp(join(tmpdir(), "gg-bridge-boot-"));
  const project = join(home, "proj");
  await mkdir(project);
  const dir = join(home, ".gg", "sessions", "proj");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "2026-10-22T10-00-00-000Z_abcd1234.jsonl"),
    [
      JSON.stringify({ type: "session", version: 2, id: "conv-1", conversationId: "conv-1", cwd: project }),
      JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: "Build the login page" } }),
      JSON.stringify({ type: "message", id: "m2", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } }),
    ].join("\n") + "\n",
  );
  // No ~/.gg/app-connections: exactly a machine whose app is closed.
  process.env.HOME = home;
  process.env.USERPROFILE = home;

  const { providers } = await loadProviders([], process.env, { bundled: true });
  const bundled = providers.find((p) => p.manifest.id === "ggcoder-app");
  if (!bundled) throw new Error("ggcoder-app is not bundled");
  // Launched the way the echo-agent tests launch theirs. Spawning
  // process.execPath directly exits silently inside the test runner only.
  const provider = {
    ...bundled,
    command: "bun",
    args: ["run", fileURLToPath(new URL("../cli/index.ts", import.meta.url)), "gg-app-bridge"],
  };

  const handle = await connectProvider({
    provider,
    cwd: project,
    onUpdate: () => {},
    onPermissionRequest: () => {},
  });
  try {
    const { all } = await handle.listSessions();
    expect(all.map((s) => [s.sessionId, s.title])).toEqual([["conv-1", "Build the login page"]]);
  } finally {
    handle.close();
  }
}, 30_000);
