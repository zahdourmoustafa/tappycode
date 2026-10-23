/**
 * GG Coder App's model button must not depend on a window being open.
 *
 * Regression: the pickers were read only from an open GG Coder window, so a
 * phone looking at GG Coder App with the app closed got commands but no model
 * button. They now fall back to the GG Coder CLI's cached probe — same engine,
 * same models.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeProbeCache } from "../probe-cache.ts";
import { fallbackConfigOptions } from "./bridge.ts";

const saved = process.env.TAPPY_HOME;
afterAll(() => {
  if (saved === undefined) delete process.env.TAPPY_HOME;
  else process.env.TAPPY_HOME = saved;
});

test("offers the CLI's model and thinking pickers, and nothing else", async () => {
  process.env.TAPPY_HOME = await mkdtemp(join(tmpdir(), "gg-fallback-"));
  expect(await fallbackConfigOptions()).toEqual([]);
  await writeProbeCache("ggcoder", {
    sessions: [],
    canResume: true,
    configOptions: [
      { id: "model", name: "Model", category: "model", type: "select", currentValue: "opus", options: [{ value: "opus", name: "Opus" }, { value: "sonnet", name: "Sonnet" }] },
      { id: "thinking", name: "Thinking", type: "select", currentValue: "high", options: [{ value: "off", name: "Off" }, { value: "high", name: "high" }] },
      { id: "mode", name: "Mode", category: "mode", type: "select", currentValue: "default", options: [{ value: "default", name: "Default" }] },
    ],
  });
  const options = await fallbackConfigOptions();
  expect(options.map((o) => [o.id, o.category, o.currentValue, o.options.length])).toEqual([
    ["model", "model", "opus", 2],
    ["thinking", "thought_level", "high", 2],
  ]);
});
