import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverApps, processAlive } from "./discovery.js";
import { ggAppInstalled, ggAppInstallPaths } from "./installed.js";

async function dirWith(files: Record<string, unknown>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gg-conn-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));
  }
  return dir;
}

const file = (pid: number, over: Record<string, unknown> = {}) => ({
  version: 1,
  pid,
  host: "127.0.0.1",
  port: 4000 + pid,
  token: `tok${pid}`,
  startedAt: `2026-10-22T00:00:0${pid}.000Z`,
  ...over,
});

test("finds running apps, newest first", async () => {
  const dir = await dirWith({ "1.json": file(1), "2.json": file(2) });
  const apps = await discoverApps({ dir, alive: () => true });
  expect(apps.map((a) => a.pid)).toEqual([2, 1]);
  expect(apps[0]).toEqual({
    pid: 2,
    baseUrl: "http://127.0.0.1:4002",
    token: "tok2",
    startedAt: "2026-10-22T00:00:02.000Z",
  });
});

test("ignores crashed apps, malformed files and non-loopback hosts", async () => {
  const dir = await dirWith({
    "1.json": file(1),
    "2.json": file(2, { host: "203.0.113.9" }),
    "3.json": "{oops",
    "4.json": file(4, { version: 2 }),
    "5.json": file(5, { token: "" }),
    "notes.txt": "hello",
  });
  const apps = await discoverApps({ dir, alive: (pid) => pid !== 1 });
  expect(apps).toEqual([]);
});

test("a missing directory means no app is running", async () => {
  expect(await discoverApps({ dir: join(tmpdir(), "definitely-absent-gg"), alive: () => true })).toEqual(
    [],
  );
});

test("this process counts as alive", () => {
  expect(processAlive(process.pid)).toBe(true);
});

test("the Windows per-user install is where the installer puts it", () => {
  const paths = ggAppInstallPaths({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a");
  expect(paths.some((p) => p.endsWith(join("GG Coder", "gg-app.exe")) && p.includes("AppData"))).toBe(true);
});

test("installed when the app or its connection folder exists", () => {
  const home = "/home/u";
  expect(ggAppInstalled({}, () => false, "darwin", home)).toBe(false);
  expect(ggAppInstalled({}, (p) => p === "/Applications/GG Coder.app", "darwin", home)).toBe(true);
  expect(ggAppInstalled({}, (p) => p === join(home, ".gg", "app-connections"), "linux", home)).toBe(
    true,
  );
});
