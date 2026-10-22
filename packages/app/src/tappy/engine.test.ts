import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  advanceTappy,
  blink,
  tappyCount,
  TAPPY_MOODS,
  dragTappy,
  gridPoints,
  ledFace,
  makeTappyBody,
  TAPPY_SLEEP_STYLES,
  tappySleepStyle,
  paintTappy,
  pokeTappy,
  releaseTappy,
  settleTappy,
  talkOpen,
  type TappyMood,
  type TappyPainter,
  type RGB,
} from "./engine";
import { TAPPY_TAPPY } from "./palette";

/** Records every call and fails on any non-finite number. */
function recorder() {
  const calls: { kind: string; args: number[] }[] = [];
  const nums = (xs: unknown[]) =>
    xs.flatMap((x) => (typeof x === "number" ? [x] : Array.isArray(x) ? (x as number[]) : []));
  const rec =
    (kind: string) =>
    (...args: unknown[]) => {
      calls.push({ kind, args: nums(args) });
    };
  const painter: TappyPainter = {
    dot: rec("dot"),
    glow: rec("glow"),
    oval: rec("oval"),
    line: rec("line"),
    poly: rec("poly"),
    shadow: rec("shadow"),
  };
  return { painter, calls };
}

function run(S: number, mood: TappyMood, seconds: number, from = 0) {
  const B = makeTappyBody(S);
  let t = from;
  for (let i = 0; i < seconds * 60; i++) {
    t += 1 / 60;
    advanceTappy(B, t, 1 / 60, mood);
  }
  return { B, t };
}

describe("body", () => {
  test("is a globe of unit-length dots, more of them the bigger it is", () => {
    const pts = gridPoints(420);
    for (let i = 0; i < pts.length; i += 3) expect(Math.hypot(pts[i]!, pts[i + 1]!, pts[i + 2]!)).toBeCloseTo(1, 5);
    expect(tappyCount(18)).toBeLessThan(tappyCount(40));
    expect(tappyCount(40)).toBeLessThan(tappyCount(120));
    expect(tappyCount(120)).toBeLessThan(tappyCount(200));
    expect(makeTappyBody(120).n).toBeGreaterThan(300);
  });

  test("bursts out from a speck to full size", () => {
    const B = makeTappyBody(120);
    const radius = () => Math.hypot(B.p[0]!, B.p[1]!, B.p[2]!);
    expect(radius()).toBeLessThan(0.1);
    for (let i = 1; i <= 90; i++) advanceTappy(B, i / 60, 1 / 60, "idle");
    expect(radius()).toBeGreaterThan(0.9);
    expect(radius()).toBeLessThan(1.1);
  });

  test("stays finite in every mood, at every size, for a long time", () => {
    for (const S of [18, 40, 120, 200]) {
      for (const mood of TAPPY_MOODS) {
        const { B, t } = run(S, mood, 3);
        const { painter, calls } = recorder();
        paintTappy(B, t, mood, TAPPY_TAPPY, painter);
        expect(calls.length).toBeGreaterThan(B.n * 0.5);
        for (const c of calls) for (const n of c.args) expect(Number.isFinite(n)).toBe(true);
      }
    }
  });

  test("settling puts every dot on its target at once", () => {
    const B = makeTappyBody(60);
    settleTappy(B, 1, "idle");
    for (let i = 0; i < B.n; i++) expect(Math.hypot(B.p[i * 3]!, B.p[i * 3 + 1]!, B.p[i * 3 + 2]!)).toBeGreaterThan(0.9);
    expect(B.v.every((v) => v === 0)).toBe(true);
  });
});

describe("face", () => {
  const lit = (mood: TappyMood, open = 1) => {
    let n = 0;
    for (let u = -0.6; u <= 0.6; u += 0.02) for (let w = -0.5; w <= 0.5; w += 0.02) n += ledFace(u, w, mood, open, 0.3);
    return n;
  };
  test("every mood lights a face", () => {
    for (const mood of TAPPY_MOODS) expect(lit(mood)).toBeGreaterThan(5);
  });
  test("a blink closes the eyes", () => {
    expect(lit("idle", 0.05)).toBeLessThan(lit("idle", 1));
    let shut = false;
    for (let t = 0; t < 12; t += 0.01) if (blink(t) < 0.2) shut = true;
    expect(shut).toBe(true);
  });
  test("talking opens and closes its mouth", () => {
    const opens = Array.from({ length: 200 }, (_, i) => talkOpen(i * 0.02));
    expect(Math.max(...opens)).toBeGreaterThan(0.6);
    expect(Math.min(...opens)).toBeLessThan(0.2);
  });
  test("small Tappies draw their face as shapes, big ones in lit dots", () => {
    const small = run(24, "happy", 1);
    const big = run(120, "happy", 1);
    const a = recorder();
    paintTappy(small.B, small.t, "happy", TAPPY_TAPPY, a.painter);
    const b = recorder();
    paintTappy(big.B, big.t, "happy", TAPPY_TAPPY, b.painter);
    expect(a.calls.some((c) => c.kind === "line")).toBe(true);
    expect(b.calls.filter((c) => c.kind === "glow").length).toBeGreaterThan(5);
  });
});

describe("touch", () => {
  test("a poke ripples it and makes it happy for a moment", () => {
    const { B, t } = run(120, "idle", 2);
    const { painter } = recorder();
    paintTappy(B, t, "idle", TAPPY_TAPPY, painter);
    const speedBefore = B.v.reduce((s, v) => s + Math.abs(v), 0);
    pokeTappy(B, 60, 55);
    expect(B.v.reduce((s, v) => s + Math.abs(v), 0)).toBeGreaterThan(speedBefore + 1);
    expect(B.reactUntil).toBeGreaterThan(t);
    const shown: string[] = [];
    const rec = recorder();
    advanceTappy(B, t + 0.1, 1 / 60, "idle");
    paintTappy(B, t + 0.1, "idle", TAPPY_TAPPY, rec.painter);
    shown.push(B.mood);
    expect(shown[0]).toBe("happy");
  });

  test("its face eases out of a mood instead of snapping", () => {
    // The user: "click -> smile -> goes straight back to normal face, not
    // smoothly". A few frames after happy → idle, paint the very same body
    // twice: as it is (it remembers it was happy) and with that memory wiped.
    // A snap paints both the same; a dissolve still shows part of the smile in
    // the lit face (the glows are the lit face dots).
    const { B, t } = run(200, "happy", 2);
    let tt = t;
    for (let i = 0; i < 6; i++) {
      tt += 1 / 60;
      advanceTappy(B, tt, 1 / 60, "idle");
    }
    const lit = () => {
      let sum = 0;
      const painter: TappyPainter = {
        dot: () => undefined,
        glow: (_x, _y, _r, _c, a) => {
          sum += a;
        },
        oval: () => undefined,
        line: () => undefined,
        poly: () => undefined,
        shadow: () => undefined,
      };
      paintTappy(B, tt, "idle", TAPPY_TAPPY, painter);
      return sum;
    };
    const blending = lit();
    const remembered = B.prevMood;
    B.prevMood = "";
    const snapped = lit();
    B.prevMood = remembered;
    expect(remembered).toBe("happy");
    expect(Math.abs(blending - snapped)).toBeGreaterThan(0.2);
  });

  test("a drag spins it, and it settles back upright after letting go", () => {
    const { B, t } = run(120, "idle", 1);
    dragTappy(B, 40, 30, 0.05);
    releaseTappy(B);
    expect(B.spinV).not.toBe(0);
    let tt = t;
    for (let i = 0; i < 6 * 60; i++) {
      tt += 1 / 60;
      advanceTappy(B, tt, 1 / 60, "idle");
    }
    const turns = B.yawExtra / (Math.PI * 2);
    expect(Math.abs(turns - Math.round(turns))).toBeLessThan(0.02);
    expect(Math.abs(B.pitchExtra)).toBeLessThan(0.05);
  });
});

test("an oops shakes amber and sends up a warning", () => {
  const { B, t } = run(120, "oops", 0.2);
  const { painter, calls } = recorder();
  paintTappy(B, t, "oops", TAPPY_TAPPY, painter);
  const amber: RGB = [242, 180, 90];
  const isAmber = (c: { args: number[] }) => c.args.slice(-4, -1).join() === amber.join();
  expect(calls.some((c) => c.kind === "dot" && isAmber(c))).toBe(true);
});

describe("sleeping styles", () => {
  const paintAt = (S: number, style: number, t: number) => {
    const B = makeTappyBody(S, style);
    settleTappy(B, 0, "sleepy");
    for (let f = 1; f <= Math.round(t * 30); f++) advanceTappy(B, f / 30, 1 / 30, "sleepy");
    const { painter, calls } = recorder();
    paintTappy(B, t, "sleepy", TAPPY_TAPPY, painter);
    return calls;
  };

  test("every style stays finite over a long run", () => {
    for (const S of [24, 48, 176])
      for (let s = 0; s < TAPPY_SLEEP_STYLES; s++) {
        const B = makeTappyBody(S, s);
        for (let f = 1; f <= 900; f++) {
          advanceTappy(B, f / 30, 1 / 30, "sleepy");
          if (f % 150 === 0) {
            const { painter, calls } = recorder();
            paintTappy(B, f / 30, "sleepy", TAPPY_TAPPY, painter);
            for (const c of calls) for (const n of c.args) expect(Number.isFinite(n)).toBe(true);
          }
        }
      }
  });

  test("styles paint measurably differently", () => {
    for (const S of [48, 176]) {
      const sigs = new Set<string>();
      for (let s = 0; s < TAPPY_SLEEP_STYLES; s++) {
        const calls = paintAt(S, s, 2.3);
        const sum = calls.reduce((a, c) => a + c.args.reduce((x, y) => x + y, 0), 0);
        sigs.add(`${calls.length}:${sum.toFixed(1)}`);
      }
      expect(sigs.size).toBe(TAPPY_SLEEP_STYLES);
    }
  });

  test("no seed is style 0", () => {
    expect(makeTappyBody(48).sleep).toBe(0);
  });

  test("hash is deterministic and spreads ids", () => {
    expect(tappySleepStyle("claude")).toBe(tappySleepStyle("claude"));
    const seen = new Set<number>();
    for (let i = 0; i < 200; i++) {
      const s = tappySleepStyle(`agent-${i}`);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThan(TAPPY_SLEEP_STYLES);
      seen.add(s);
    }
    expect(seen.size).toBe(TAPPY_SLEEP_STYLES);
    expect(new Set(["claude", "codex", "gemini", "gg-coder", "echo"].map(tappySleepStyle)).size).toBeGreaterThan(2);
  });
});

// On the UI thread a worklet captures the module-level helpers it uses when it
// is *defined*, so one declared further down the file is captured as
// undefined and crashes only on a device ("talkOpen is not a function"). The
// JS-thread tests can't see that, so the ordering is checked from the source.
// Per file: the engine is split in two, and an import is always evaluated
// before the importing file defines anything, so only same-file order matters.
test.each(["engineBody.ts", "enginePaint.ts"])("no worklet in %s calls a helper declared below it", (file) => {
  const raw = readFileSync(join(import.meta.dir, file), "utf8");
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
  const decl = new Map<string, number>();
  for (const m of src.matchAll(/^(?:export )?(?:function|const|let) (\w+)/gm)) decl.set(m[1]!, m.index!);
  const late: string[] = [];
  for (const m of src.matchAll(/^(?:export )?function (\w+)\(([^)]*)\)[^{]*\{/gm)) {
    let i = m.index! + m[0].length;
    let depth = 1;
    while (depth > 0) {
      const c = src[i++];
      if (c === "{") depth++;
      else if (c === "}") depth--;
    }
    const body = src.slice(m.index! + m[0].length, i);
    const local = new Set([...m[2]!.matchAll(/(\w+)\s*[:?,)=]/g)].map((x) => x[1]!));
    for (const x of body.matchAll(/\b(?:const|let|var)\s+(\w+)/g)) local.add(x[1]!);
    for (const x of body.matchAll(/\b([A-Za-z_]\w*)\b/g)) {
      const name = x[1]!;
      const at = decl.get(name);
      if (at !== undefined && at > m.index! && name !== m[1] && !local.has(name)) late.push(`${m[1]} -> ${name}`);
    }
  }
  expect([...new Set(late)]).toEqual([]);
});
