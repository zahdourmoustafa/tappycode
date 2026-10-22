/**
 * Tappy, tappy's mascot: the engine.
 *
 * A ball of LED dots (the tappy icon's dots wrapped round a sphere) whose face
 * is made of lit dots. Every dot rides its own spring towards a target that
 * depends on the mood, so the body wobbles, ripples and settles on its own;
 * the face, the light patterns and the little extras around the head are all
 * computed per frame. Ported from the "Tappy Matrix" prototype the user chose
 * (`~/.gg/goals/tappy-gg/mascot/tappy.html`).
 *
 * Pure and Expo-free: no React, no Skia. Drawing goes through a tiny
 * `TappyPainter` interface (dots, glows, ovals, lines, polygons, a shadow), so
 * `bun test` can record a frame and the app can paint the same frame with
 * Skia. Every function carries the `"worklet"` directive because the app runs
 * this on the UI thread (`Tappy.tsx`); to `bun` the directive is an inert
 * string.
 *
 * Coordinates are in points inside an S×S box. Time `t` is in seconds.
 */
// The engine is two files: the body that simulates (`engineBody.ts`) and the
// painter that draws a frame of it (`enginePaint.ts`). This module is the
// public face the app and the tests import, so neither has to know.
export {
  TAPPY_AMBER,
  TAPPY_MOODS,
  TAPPY_SLEEP_STYLES,
  advanceTappy,
  blink,
  clamp,
  dragTappy,
  gridPoints,
  hash,
  makeTappyBody,
  tappyCount,
  tappySleepSeed,
  tappySleepStyle,
  pokeTappy,
  releaseTappy,
  settleTappy,
  talkOpen,
  type TappyBody,
  type TappyMood,
  type TappyPainter,
  type TappyPalette,
  type RGB,
} from "./engineBody";
export { ledFace, paintTappy } from "./enginePaint";
