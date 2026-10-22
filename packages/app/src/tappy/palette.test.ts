import { describe, expect, test } from "bun:test";
import { activityMood, tappyInk, tappyPalette, homeMood, TAPPY_TAPPY, roleColor, workerMood } from "./palette";

const luminance = ([r, g, b]: number[]) => {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
};
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
};
const CANVAS = [10, 10, 12];

describe("tappyPalette", () => {
  test("no colour, or a bad one, is tappy's own coral", () => {
    expect(tappyPalette()).toBe(TAPPY_TAPPY);
    expect(tappyPalette("not a colour")).toBe(TAPPY_TAPPY);
  });

  test("every agent's lit dots read on the canvas, and unlit ones stay dark", () => {
    // The manifest colours in providers/*.json, plus GG Goals.
    for (const brand of ["#4ade80", "#d97757", "#10a37f", "#4285f4", "#26c6da", "#e4e4e7", "#94a3b8", "#615ced", "#8b7cf6", "#000000", "#ffffff"]) {
      const p = tappyPalette(brand);
      expect(contrast(p.base, CANVAS)).toBeGreaterThan(4.5);
      expect(contrast(p.light, CANVAS)).toBeGreaterThan(contrast(p.base, CANVAS));
      expect(luminance(p.off)).toBeLessThan(luminance(p.base) / 4);
    }
  });

  test("each agent gets its own colour", () => {
    const a = tappyPalette("#d97757").base.join();
    const b = tappyPalette("#4285f4").base.join();
    expect(a).not.toBe(b);
  });
});

describe("moods", () => {
  test("the activity line: writing is talking, tools are working, otherwise thinking", () => {
    expect(activityMood("composing")).toBe("talking");
    expect(activityMood("breathing")).toBe("thinking");
    expect(activityMood("searching")).toBe("working");
    expect(activityMood("weaving")).toBe("working");
  });
  test("workers", () => {
    expect(workerMood("running")).toBe("working");
    expect(workerMood("failed")).toBe("oops");
    expect(workerMood("completed")).toBe("happy");
    expect(workerMood("closed")).toBe("sleepy");
  });
  test("home sleeps while the computer is away", () => {
    expect(homeMood(false, false)).toBe("sleepy");
    expect(homeMood(true, false)).toBe("idle");
  });
  test("roles have their own colour; anything else is Ken's purple", () => {
    expect(roleColor("builder")).not.toBe(roleColor("scout"));
    expect(roleColor(undefined)).toBe("#8b7cf6");
  });
});

describe("tappyInk", () => {
  test("is a hex colour that reads on the canvas, coral by default", () => {
    expect(tappyInk("#4285f4")).toMatch(/^#[0-9a-f]{6}$/);
    expect(tappyInk()).toBe(tappyInk(undefined));
    expect(tappyInk("#4285f4")).not.toBe(tappyInk("#4ade80"));
  });
});
