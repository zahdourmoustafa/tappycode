/**
 * Guards the fix for the UI-thread crash in React Native Skia's runtime table
 * (see `skiaFrame.ts`): painters share one never-freed blank picture and one
 * recorder, and make no Skia objects of their own per frame.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

const sources = files(SRC).map((path) => ({ path: relative(SRC, path), text: readFileSync(path, "utf8") }));
const painters = sources.filter((s) => s.text.includes("useFrameCallback") && s.text.includes("@shopify/react-native-skia"));

test("there are painters to check", () => {
  expect(painters.map((p) => p.path).sort()).toEqual(["tappy/Tappy.tsx", "ui/LaunchFx.tsx", "ui/ThinkingDial.tsx"]);
});

test("a painter starts from the shared blank picture, never one of its own", () => {
  for (const p of painters) {
    expect({ file: p.path, blank: p.text.includes("blankPicture()") }).toEqual({ file: p.path, blank: true });
    expect({ file: p.path, own: /useState\([^)]*[Pp]icture/.test(p.text) }).toEqual({ file: p.path, own: false });
  }
});

test("frames are recorded with the shared recorder", () => {
  for (const p of [...painters, ...sources.filter((s) => s.path === "ui/LaunchFx.tsx")]) {
    expect({ file: p.path, recorder: p.text.includes("Skia.PictureRecorder(") }).toEqual({ file: p.path, recorder: false });
  }
});

test("nothing painted per frame makes a shader, a colour or a path", () => {
  // Made once per runtime and cached on `globalThis` (the tools line) is fine.
  for (const p of painters) {
    const lines = p.text.split("\n").filter((line) => !line.includes("g.__"));
    for (const made of ["MakeRadialGradient", "MakeLinearGradient", "Skia.Color(", "Skia.Path.Make("]) {
      const found = lines.some((line) => line.includes(made) && !line.trim().startsWith("*") && !line.includes("typeof"));
      expect({ file: p.path, made, found }).toEqual({ file: p.path, made, found: false });
    }
  }
});
