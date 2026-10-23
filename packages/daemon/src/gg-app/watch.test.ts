import { expect, test } from "bun:test";
import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sessionsFingerprint, watchSessions } from "./watch.js";

test("the fingerprint changes when a project or chat appears or is written", async () => {
  const root = await mkdtemp(join(tmpdir(), "gg-watch-"));
  const empty = await sessionsFingerprint(root);
  await mkdir(join(root, "proj"));
  const withProject = await sessionsFingerprint(root);
  await writeFile(join(root, "proj", "a.jsonl"), "{}\n");
  await utimes(join(root, "proj", "a.jsonl"), 1000, 1000);
  const withChat = await sessionsFingerprint(root);
  await utimes(join(root, "proj", "a.jsonl"), 2000, 2000);
  const written = await sessionsFingerprint(root);
  expect(new Set([empty, withProject, withChat, written]).size).toBe(4);
  expect(await sessionsFingerprint(join(root, "absent"))).toBe("");
});

test("one notification per settled change, none for the baseline", async () => {
  let value = "a";
  const seen: number[] = [];
  const watcher = watchSessions(() => seen.push(Date.now()), {
    intervalMs: 5,
    fingerprint: async () => value,
  });
  await Bun.sleep(30);
  expect(seen).toEqual([]);
  value = "b";
  await Bun.sleep(40);
  expect(seen.length).toBe(1);
  await Bun.sleep(30);
  expect(seen.length).toBe(1);
  watcher.stop();
});
