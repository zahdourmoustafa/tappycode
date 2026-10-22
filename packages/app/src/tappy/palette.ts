/**
 * Tappy's colours and moods. Pure and Expo-free (tested with `bun`).
 *
 * tappy's own Tappy is coral, the tappy icon's dots. Every agent gets its own
 * Tappy in its brand colour (the `color` in its provider manifest), worked
 * out here so a new agent needs no artwork: a lit LED in the brand hue, a
 * deep unlit body in the same hue, and a pale glow.
 */
import type { TappyMood, TappyPalette, RGB } from "./engine";

/** tappy itself: the coral of the app icon. */
export const TAPPY_TAPPY: TappyPalette = {
  light: [255, 202, 182],
  base: [224, 122, 90],
  dark: [107, 42, 26],
  glow: [255, 211, 193],
  eye: [255, 246, 241],
  off: [48, 35, 31],
};

/** GG Goals and Ken, its reviewer: the GG Goals purple. */
export const KEN_COLOR = "#8b7cf6";

/** GG Goals' workers, by role, so a roster reads at a glance. */
export const ROLE_COLORS: Record<string, string> = {
  builder: "#4ade80",
  scout: "#26c6da",
  researcher: "#f2b45a",
  checker: "#c084fc",
};

export function roleColor(role: string | undefined): string {
  const key = (role ?? "").toLowerCase();
  for (const [name, color] of Object.entries(ROLE_COLORS)) if (key.includes(name)) return color;
  return KEN_COLOR;
}

function hexToRgb(hex: string): RGB | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return undefined;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return [Number.parseInt(h.slice(0, 2), 16), Number.parseInt(h.slice(2, 4), 16), Number.parseInt(h.slice(4, 6), 16)];
}

function relLum([r, g, b]: RGB): number {
  const f = (c: number) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Against the app canvas (#0a0a0c). */
function contrastOnCanvas(c: RGB): number {
  const canvas = relLum([10, 10, 12]);
  return (relLum(c) + 0.05) / (canvas + 0.05);
}

function toHsl([r, g, b]: RGB): [number, number, number] {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const mx = Math.max(R, G, B);
  const mn = Math.min(R, G, B);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === R ? ((G - B) / d) % 6 : mx === G ? (B - R) / d + 2 : (R - G) / d + 4;
  h = (h * 60 + 360) % 360;
  return [h, s, l];
}

function fromHsl(h: number, s: number, l: number): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/**
 * A Tappy in `color`. No colour (or an unreadable one) is tappy's own coral.
 * Greys stay grey (a silver Tappy) rather than being forced into a hue.
 */
/**
 * An agent's colour for lit UI (LED labels, outlines, a sheet's strip): its
 * Tappy's lit-dot colour as a CSS string, so it clears the same contrast bar on
 * the canvas. No colour is tappy's coral.
 */
export function tappyInk(color?: string): string {
  const [r, g, b] = tappyPalette(color).base;
  const hex = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
  return `#${hex(r)}${hex(g)}${hex(b)}`;
}

export function tappyPalette(color?: string): TappyPalette {
  const rgb = color ? hexToRgb(color) : undefined;
  if (!rgb) return TAPPY_TAPPY;
  const [h, s0] = toHsl(rgb);
  const s = Math.min(s0, 0.9);
  // Lit LEDs must read on the near-black canvas whatever the brand. Lightness
  // alone does not guarantee it (a saturated blue at 66% is still dark), so
  // raise it until the lit dot clears 4.5:1.
  let l = 0.66;
  let base = fromHsl(h, s, l);
  while (contrastOnCanvas(base) < 4.6 && l < 0.9) {
    l += 0.02;
    base = fromHsl(h, s, l);
  }
  return {
    base,
    light: fromHsl(h, Math.min(1, s + 0.1), 0.86),
    dark: fromHsl(h, s * 0.65, 0.22),
    glow: fromHsl(h, Math.min(1, s + 0.1), 0.82),
    eye: fromHsl(h, Math.min(s, 0.3), 0.97),
    off: fromHsl(h, Math.min(s, 0.32) * 0.65, 0.15),
  };
}

// ── moods from what is actually happening ──────────────────

/** The thinking-orb states the activity line already computes. */
type ActivityState =
  | "working"
  | "searching"
  | "solving"
  | "listening"
  | "connecting"
  | "weaving"
  | "composing"
  | "breathing"
  | "shaping";

/** The agent's turn: writing a reply is talking, a tool is working, otherwise thinking. */
export function activityMood(state: ActivityState): TappyMood {
  if (state === "composing") return "talking";
  if (state === "breathing") return "thinking";
  return "working";
}

/** One of GG Goals' workers. */
export function workerMood(state: string): TappyMood {
  switch (state) {
    case "running":
      return "working";
    case "starting":
      return "thinking";
    case "completed":
      return "happy";
    case "failed":
      return "oops";
    default:
      return "sleepy";
  }
}

/** The home screen: asleep while the computer is away, otherwise awake. */
export function homeMood(online: boolean, busy: boolean): TappyMood {
  if (!online) return "sleepy";
  return busy ? "working" : "idle";
}
