import { expect, test } from "bun:test";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { goalFilesRoot, storeGoalFiles } from "./goalFiles";

const b64 = (s: string) => Buffer.from(s).toString("base64");

test("phone files are written under tappy's home, owner-only, in order", async () => {
  const root = await mkdtemp(join(tmpdir(), "goal-files-"));
  const paths = await storeGoalFiles(
    [
      { name: "spec.md", mimeType: "text/markdown", data: b64("# spec") },
      { name: "../../etc/passwd", mimeType: "text/plain", data: b64("nope") },
    ],
    root,
  );
  expect(paths).toHaveLength(2);
  for (const p of paths) expect(p.startsWith(root)).toBe(true);
  expect(await readFile(paths[0]!, "utf8")).toBe("# spec");
  // A name off a phone is a label: it can't climb out of the goal's folder.
  expect(paths[1]!.includes("..")).toBe(false);
  // Owner-only is a Unix permission; Windows has no equivalent to check.
  if (process.platform !== "win32") expect((await stat(paths[0]!)).mode & 0o777).toBe(0o600);
});

test("nothing to store writes nothing", async () => {
  expect(await storeGoalFiles([], join(tmpdir(), "never-created"))).toEqual([]);
});

test("the attachment ceilings apply", async () => {
  const big = "A".repeat(12 * 1024 * 1024);
  await expect(
    storeGoalFiles([{ name: "big.bin", mimeType: "application/octet-stream", data: big }], tmpdir()),
  ).rejects.toThrow();
});

test("lives under TAPPY_HOME, never the tempdir", () => {
  // Built with join on both sides, so the separator is the platform's own.
  expect(goalFilesRoot({ TAPPY_HOME: join("x", "home") } as NodeJS.ProcessEnv)).toBe(join("x", "home", "goal-files"));
});
