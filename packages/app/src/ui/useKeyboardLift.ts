/**
 * The keyboard's effect on the main screen: the lift that carries the thread
 * and composer, and whether the composer currently owns the screen.
 */
import { useEffect, useRef, useState } from "react";
import { Keyboard, Platform } from "react-native";
import { useKeyboardHandler } from "react-native-keyboard-controller";
import { Easing, useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

/**
 * The curve iOS moves its keyboard along.
 *
 * UIKit animates the keyboard with a private curve — `UIViewAnimationCurve(7)`,
 * which has no public constant and is not any of the four documented ones. This
 * bezier is the long-standing community match for it, and it only matters when
 * the pane is animating itself because the platform has not reported the
 * keyboard's real position; when frames do arrive they overwrite this anyway.
 */
const KEYBOARD_CURVE = Easing.bezier(0.17, 0.59, 0.4, 0.77);

/**
 * Raises the thread and the composer by exactly the visible keyboard's height,
 * and returns a second style for content that is centred rather than
 * bottom-anchored.
 *
 * Written from a worklet on the keyboard's own animation, so the two move in
 * perfect step. No JS re-render can land halfway through and move things a
 * second time.
 *
 * A transform, deliberately, not a height. The thread is a recycling list, and
 * `RecyclerView` answers any container resize with a full layout pass in JS — so
 * shortening the pane per frame queued sixty of them across the keyboard's
 * animation, which is the stutter. Translating moves the same pixels on the UI
 * thread and lays out nothing.
 *
 * Cross-platform by construction rather than by branch: `useKeyboardHandler`
 * calls the library's `useResizeMode`, which sets Android to `adjustResize`, and
 * `KeyboardProvider` puts it in edge-to-edge — a pairing that stops Android
 * resizing the window at all. So on both platforms nothing but this transform
 * moves, and neither needs a `softwareKeyboardLayoutMode` in app.json.
 *
 * The keyboard is measured from the physical screen edge, so the home-indicator
 * clearance the dock keeps is handed back while it is open, and the composer
 * keeps the same gap above either boundary.
 *
 * @returns `pane` for bottom-anchored content, `centred` to cancel half of it,
 *   `progress` (0 closed to 1 open) for content that reacts to typing.
 */
export function useKeyboardLift(bottomInset: number) {
  const height = useSharedValue(0);
  const progress = useSharedValue(0);

  useKeyboardHandler(
    {
      // Start the movement on the platform's own terms before a single frame
      // has been reported.
      //
      // `onMove` is the good path and stays the good path — it is the keyboard's
      // real position, sampled per frame. But it is *not guaranteed to arrive*.
      // iOS 26 stopped delivering those frames to release builds: the library
      // finds the keyboard by walking the window hierarchy for private UIKit
      // class names (`UIInputSetHostView` and friends) and driving a
      // `CADisplayLink` off the view it finds, and when that lookup comes back
      // empty there is no per-frame anything. `onStart`/`onEnd` still fire,
      // because those are ordinary keyboard notifications. So the pane sat
      // still for the whole animation and then snapped — in TestFlight only,
      // while every development build looked perfect, which is exactly the
      // shape of the bug that was so maddening to chase.
      //
      // Animating here removes the dependency. `event.duration` is what the
      // system says the keyboard will take, so the pane covers the same
      // distance in the same time whether or not a single frame is ever
      // reported. When they are reported, the assignment in `onMove` simply
      // takes over — assigning to a shared value cancels whatever animation is
      // running on it — and the exact path wins. Degrading, not branching:
      // there is no version check to go stale.
      onStart: (event) => {
        "worklet";
        const target = Math.max(0, event.height - bottomInset * event.progress);
        if (event.duration <= 0) {
          height.value = target;
          progress.value = event.progress;
          return;
        }
        const timing = { duration: event.duration, easing: KEYBOARD_CURVE };
        height.value = withTiming(target, timing);
        progress.value = withTiming(event.progress, timing);
      },
      onMove: (event) => {
        "worklet";
        height.value = Math.max(0, event.height - bottomInset * event.progress);
        progress.value = event.progress;
      },
      // The keyboard has stopped, so this is the authoritative position — but
      // only assign it if it is not already there. On the fallback path the
      // timing started in `onStart` is still running toward this exact value,
      // and overwriting it lands the last few points as a cut instead of the
      // end of the movement.
      onEnd: (event) => {
        "worklet";
        const target = Math.max(0, event.height - bottomInset * event.progress);
        if (Math.abs(height.value - target) > 0.5) {
          height.value = target;
        }
        progress.value = event.progress;
      },
    },
    [bottomInset],
  );

  const pane = useAnimatedStyle(() => ({
    transform: [{ translateY: -height.value }],
  }));

  // The empty state is centred in the pane rather than anchored to its bottom
  // edge, so the full lift would carry it up by a whole keyboard — twice what
  // re-centring needs, and far enough to push the greeting under the nav. Half
  // the lift keeps it centred in what is left of the screen.
  const centred = useAnimatedStyle(() => ({
    transform: [{ translateY: height.value / 2 }],
  }));

  return { pane, centred, progress };
}

/**
 * Whether the keyboard is up, as state for rendering and as a ref for handlers
 * that must read it without re-subscribing.
 */
export function useTypingState() {
  /** The keyboard is up, so the composer owns the screen. */
  const [typing, setTyping] = useState(false);
  // `typingRef` mirrors the app's own keyboard state (set from the will-show /
  // will-hide events below). `Keyboard.isVisible()` was the first try and is
  // not reliable here: it could stay true after the keyboard had gone, and
  // then every tap on Tappy only "dismissed" a keyboard that wasn't there.
  const typingRef = useRef(false);

  // Composing takes the screen. iOS gets `will`, so the button is gone before
  // the keyboard arrives rather than vanishing once it has settled; Android
  // only ever emits `did`, and listening for `will` there would never fire.
  useEffect(() => {
    const willShow = Platform.OS === "ios";
    const shown = Keyboard.addListener(
      willShow ? "keyboardWillShow" : "keyboardDidShow",
      () => {
        typingRef.current = true;
        setTyping(true);
      },
    );
    const hidden = Keyboard.addListener(
      willShow ? "keyboardWillHide" : "keyboardDidHide",
      () => {
        typingRef.current = false;
        setTyping(false);
      },
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  return { typing, typingRef };
}
