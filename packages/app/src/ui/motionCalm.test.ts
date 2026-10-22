import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SPRING } from "../motion";

// The user found the app's springs "way too gooey". tappy settles rather than
// bounces: shared springs in motion.ts are near critically damped, and no
// screen sets its own bouncy spring.
test("every shared spring is near critically damped", () => {
  for (const spring of Object.values(SPRING)) expect(spring.dampingRatio).toBeGreaterThanOrEqual(0.9);
});

test("no screen defines a bouncy spring of its own", () => {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !/\.(test|harness)\./.test(name)) files.push(path);
    }
  };
  walk(join(import.meta.dir, ".."));
  files.push(join(import.meta.dir, "..", "..", "App.tsx"));
  const offenders = files
    .filter((f) => !f.includes("/tappy/engine"))
    .filter((f) => {
      const src = readFileSync(f, "utf8");
      // `.springify()` builders and raw low-damping springs are what wobble.
      return /\.springify\(\)/.test(src) || /damping:\s*1[0-8]\b/.test(src);
    });
  expect(offenders).toEqual([]);
});
