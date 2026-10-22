/**
 * The Skia plumbing shared by everything that records a picture per frame on
 * the UI thread (Tappy, the goal launch, the thinking dial).
 *
 * Why it exists: React Native Skia (2.2) files every Skia object a worklet
 * touches into one global table per runtime, and that table has no lock. An
 * object made on the JS thread, drawn on the UI thread and later garbage
 * collected on the JS thread is removed from the UI runtime's table *from the
 * JS thread*, while the UI thread is adding the objects of the next frame.
 * Two threads in one hash table: the app crashed in
 * `RuntimeLifecycleMonitor::addListener` (EXC_BAD_ACCESS on the main thread).
 *
 * So: the blank picture every painter starts from is made once and never
 * freed, and a frame reuses one recorder and one bounds rectangle instead of
 * making new ones, which also keeps the table from churning by hundreds of
 * entries a second.
 *
 * That could not close the race on its own: every declarative `<Canvas>` makes
 * recorders of its own, and Hermes frees those on its background GC thread
 * (crash in `removeListener` on thread "hades"). Skia 2.3.8 put a mutex on the
 * table, which is why the app is pinned at 2.3.14 rather than Expo SDK 54's
 * suggested 2.2.12; do not go back below 2.3.8. The reuse above stays, for the
 * churn.
 */
import { Skia, type SkCanvas, type SkPicture } from "@shopify/react-native-skia";

let blank: SkPicture | undefined;

/** The one blank picture a painter shows before its first frame. Never freed (see above). */
export function blankPicture(): SkPicture {
  if (!blank) {
    const recorder = Skia.PictureRecorder();
    recorder.beginRecording(Skia.XYWHRect(0, 0, 1, 1));
    blank = recorder.finishRecordingAsPicture();
  }
  return blank;
}

interface FrameKit {
  recorder: ReturnType<typeof Skia.PictureRecorder>;
  rects: Record<string, ReturnType<typeof Skia.XYWHRect>>;
}

/** Start recording a w×h frame on the UI thread, with the runtime's one recorder. */
export function beginFrame(w: number, h: number): SkCanvas {
  "worklet";
  const g = globalThis as unknown as { __tappyFrameKit?: FrameKit };
  if (!g.__tappyFrameKit) g.__tappyFrameKit = { recorder: Skia.PictureRecorder(), rects: {} };
  const kit = g.__tappyFrameKit;
  const key = w + "x" + h;
  let rect = kit.rects[key];
  if (!rect) {
    rect = Skia.XYWHRect(0, 0, w, h);
    kit.rects[key] = rect;
  }
  return kit.recorder.beginRecording(rect);
}

/** Finish the frame `beginFrame` started. */
export function endFrame(): SkPicture {
  "worklet";
  const g = globalThis as unknown as { __tappyFrameKit: FrameKit };
  return g.__tappyFrameKit.recorder.finishRecordingAsPicture();
}
