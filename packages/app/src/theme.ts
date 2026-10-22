import { Easing } from "react-native";
import { DUR, EASE } from "./motion";
import { approvalActionColors, fallbackGlassTokens } from "./materialTokens";

/**
 * Design tokens.
 *
 * Near-black canvas with two raised greys. Agent output is read for long
 * stretches, often one-handed and at night, so the canvas recedes and every
 * control is a soft-grey pill floating on it.
 *
 * The drawer sits one step lighter than the conversation. Because the drawer is
 * revealed by sliding the conversation aside rather than covering it, that
 * difference is what separates the planes: the darker surface reads as on top.
 *
 * Palette is GG Coder's desktop (gg-app App.css :root): near-black canvas
 * separated by lightness alone, periwinkle accent, luminous semantics.
 * Measured WCAG ratios on bg #0a0a0c / surface #141519 / raised #1c1e23 /
 * pressed #24262c: text 17.8/16.5/15.0/13.6, textDim 7.2/6.6/6.0/5.5,
 * textFaint #90919c 6.3/5.8/5.3/4.8 (the floor for dim text on raised
 * surfaces), accent 10.3/9.5/8.7/7.9, danger 7.1/6.5/6.0/5.4,
 * success 13.1/12.1/11.1/10.0, thought (critter pink) 9.5/8.8/8.0/7.3.
 * accent on accentSoft 7.2, text on accentSoft 12.5, onAccent on accent 9.9.
 */
export const theme = {
  color: {
    /** Conversation canvas. The upper plane, and the darker of the two. */
    bg: "#0a0a0c",
    /** Drawer canvas. The lower plane, revealed as the conversation slides. */
    drawer: "#141519",
    /** Resting control: chips, composer. */
    surface: "#141519",
    /** Raised control: top bar pills, sheets. */
    surfaceRaised: "#1c1e23",
    /** Pressed feedback for any surface. */
    surfacePressed: "#24262c",
    border: "#2a2c33",

    text: "#f2f3f7",
    textDim: "#9a9ba5",
    textFaint: "#90919c",
    /** Icon glyphs on a glass control. Sampled from the reference. */
    glyph: "#c8c9d2",
    /** Placeholder text inside the composer. */
    placeholder: "#90919c",

    accent: "#b0b6ff",
    /**
     * The accent at control-fill strength, for a button that is *on* rather
     * than merely tappable — the mic while it is listening. Opaque rather than
     * a transparency, so it reads the same over glass as over a flat surface.
     */
    accentSoft: "#262a4d",
    success: "#7fe89a",
    /**
     * Needs a look, not broken: an interrupted goal, a check that is due.
     * Amber so red stays reserved for real failures. 9.09:1 on surfaceRaised.
     */
    attention: "#f2b45a",
    danger: "#ff6b60",
    thought: "#ff8fd0",
    /** Neutral orb base, used when a provider declares no colour. */
    orb: "#b0b6ff",
    /** Ink on an accent fill. */
    onAccent: "#0c0e26",
  },

  /** Libraries.dev Beam composer: opaque card, quiet inset pills. */
  composer: {
    radius: 20,
    fill: "#141519",
    border: "#3a3c44",
    chip: "#1c1e23",
    ink: "#c8c9d2",
    placeholder: "#9a9ba5",
  },

  /**
   * Stage: tappy's LED look. Dashed rules instead of solid borders, a dot grid
   * on the canvas, dot-matrix labels that glow in the agent's colour. The
   * glow is the agent's colour, so these are geometry, not colours.
   */
  stage: {
    /** Dashed rules and resting card outlines. 3.4:1 on bg: decoration, not text. */
    dash: "#34363e",
    /** Terminal sheet header strip. */
    strip: "#121317",
    /** Canvas dot grid: spacing, dot radius, dot colour. */
    grid: 14,
    gridDot: 1,
    gridColor: "rgba(255,255,255,0.055)",
    /** Strip/ticker texture: a finer grid. */
    fine: 5,
    fineColor: "rgba(255,255,255,0.06)",
    /** LED label type. */
    ledSize: 11,
    ledSpacing: 1.6,
    /** Glow radius on lit LED text. */
    glow: 8,
  },

  /** 4pt base grid. */
  space: (n: number) => n * 4,

  /**
   * Single horizontal gutter for every top-level surface. The drawer header,
   * its chips and list, and the conversation's top bar and composer all sit on
   * this one rail, so controls stay aligned as the drawer slides.
   */
  gutter: 20,

  /**
   * Single vertical step between the drawer's stacked sections.
   *
   * "Connected Apps" to the agent pills, the pills to the project selector, the
   * selector to "Latest chats" — each of those was its own number before (12,
   * 12, 20), so the column read as three loosely related blocks rather than one
   * list. Lives here rather than in `Sidebar.tsx` because `ProjectSelect` sits
   * in that column too and has to keep the same rhythm from another file.
   */
  sectionGap: 16,

  /**
   * Vertical inset from the safe area to the first row of controls. The drawer
   * header and the conversation's top bar must both use this, or the title and
   * the hamburger it sits beside land on different lines as the drawer opens.
   */
  headerInset: 8,

  /**
   * Non-Apple fallback only. iOS 26/27 uses the native adaptive Liquid Glass
   * material, including the user's Clear/Tinted and accessibility preferences.
   * These values preserve the same hierarchy on web and Android: controls are
   * lighter than content, while composer/approval surfaces use regular-material
   * opacity for text legibility over a moving transcript.
   */
  glass: fallbackGlassTokens,

  /** Approval actions keep explicit contrast even over adaptive glass. */
  approval: approvalActionColors,

  /**
   * `composer` is half of `size.composerCollapsed`, which is what makes the
   * resting composer a true stadium rather than a rounded rectangle. Keep the
   * two in step: a radius below half the height reads as a slightly squared
   * box, which is exactly how this control looked beside its peers before.
   */
  radius: { sm: 8, md: 14, lg: 18, composer: 32, pane: 34, pill: 999 },

  /**
   * Control heights.
   *
   * `control` is the whole top bar — the hamburger, the selector pills, and the
   * drawer header that has to line up with them — and it is deliberately the
   * same 44 as `touch`. It used to be 38 and lean on `hitSlop` for the
   * difference, which satisfies the tap target but not the eye: the controls
   * read as small for the surface they sit on, and an invisible slop cannot fix
   * that. Sizing them at the minimum instead means the visible control is the
   * touch target.
   */
  size: {
    control: 44,
    chip: 40,
    /**
     * Resting composer: one row, text inline between the two buttons.
     * 64 = button (40) + inset (12) top and bottom, so the buttons sit
     * centred when collapsed and in the corners once it grows.
     */
    composerCollapsed: 64,
    /** Minimum text area + top inset + action row + padding and border. */
    composerResting: 126,
    composerButton: 40,
    /** Inset from the pill's edge to each action button. */
    composerInset: 12,
    orb: 44,
    /** Apple HIG minimum touch target. */
    touch: 44,
  },

  font: {
    tiny: 11,
    small: 13,
    body: 15,
    title: 17,
    greeting: 20,
  },

  /**
   * Display family, for main titles only.
   *
   * Bitcount Prop Single is a dot-matrix face: it carries the brand at heading
   * size but is unreadable in a paragraph, so body copy, agent output and
   * controls stay on the system font. Named here so the family string is
   * written once and every title changes together.
   *
   * Only applied once `useFonts` reports loaded. Naming an unloaded family on
   * iOS silently falls back with different metrics, which shifts layout after
   * the font arrives.
   */
  display: {
    regular: "BitcountPropSingle_400Regular",
    semibold: "BitcountPropSingle_600SemiBold",
    bold: "BitcountPropSingle_700Bold",
  },

  line: {
    body: 22,
    greeting: 28,
  },

  /** Named so transitions never use `all` and share one curve. */
  motion: {
    fast: 120,
    base: 200,
    /** GG Coder durations (`--dur-*`), from motion.ts. */
    ...DUR,
  },

  /** GG Coder curves as bezier control points; `Easing.bezier(...theme.curve.out)`. */
  curve: EASE,

  /**
   * One shared curve. Decelerating, so a control arrives and settles rather
   * than stopping dead — which is what makes a resize read as smooth.
   */
  easing: Easing.bezier(0.22, 1, 0.36, 1),
} as const;

/**
 * Lighten (ratio > 0) or darken (ratio < 0) a hex colour.
 * Used to build the orb's gloss from a single provider colour, so adding a
 * provider never requires hand-picking a gradient.
 */
export function shade(hex: string, ratio: number): string {
  const value = hex.replace("#", "");
  const normalised =
    value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value;
  const num = Number.parseInt(normalised, 16);
  if (Number.isNaN(num)) return hex;

  const channel = (shift: number) => {
    const base = (num >> shift) & 0xff;
    const next = ratio >= 0 ? base + (255 - base) * ratio : base * (1 + ratio);
    return Math.round(Math.min(255, Math.max(0, next)));
  };

  return `#${[channel(16), channel(8), channel(0)]
    .map((c) => c.toString(16).padStart(2, "0"))
    .join("")}`;
}
