/**
 * The one bottom sheet every modal in this app is made of.
 *
 * Commands, an agent's thinking, and an approval request are all "a titled card
 * arriving from the bottom edge", so they share this chrome exactly: same
 * travel, same spring, same grabber, same header, same card height. Three
 * hand-rolled copies would drift the moment one of them was tuned.
 *
 * `onClose` is optional on purpose. A sheet the user opened is dismissed by the
 * scrim, the grabber, or the close button; an approval request is *not* — the
 * agent is blocked on an answer, and a stray tap that dismissed it would strand
 * the turn with no way back.
 *
 * A sheet with steps changes its own title and swaps close for back as it goes.
 * Both cross-fade, because the content underneath them is travelling: a header
 * that cuts while the panes slide is the one part of the movement that gives
 * away there were two cards all along.
 *
 * ## Why every value here lives on the UI thread
 *
 * This used to be legacy `Animated` with the travel distance held in React
 * state. Opening cost three commits of the whole app tree before a single pixel
 * moved — render to mount, render to measure, render to animate — and that dead
 * air between the finger leaving the glass and the card starting to move is
 * exactly what read as "not smooth". UIKit starts a sheet's transition on the
 * same frame as the touch.
 *
 * So: one commit, and everything after it is Reanimated. The card is present in
 * the same render that flips `visible`, its measured height goes into a shared
 * value rather than state (no re-render), and the spring runs on the UI thread
 * where React cannot starve it. What is left is a single layout pass — which is
 * what the platform spends too.
 */
import { Dissolve } from "./motion/Dissolve";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dimensions, Keyboard, Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  FadeIn,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useReanimatedKeyboardAnimation } from "react-native-keyboard-controller";
import { theme } from "../theme";
import { CircleButton } from "./controls";
import { DotGlyph, type DotGlyphName } from "./stage/DotGlyph";
import { haptics } from "./haptics";
import { useReducedMotion } from "./useReducedMotion";
import { Tappy } from "../tappy/Tappy";
import type { TappyMood } from "../tappy/engine";
import { Led } from "./stage/Led";
import { DotGrid } from "./stage/DotGrid";
import { dashedOutline } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";

/** Rows visible in a list sheet before it scrolls. */
export const SHEET_VISIBLE_ROWS = 5;
export const SHEET_ROW_HEIGHT = 60;
/** The card's height when a sheet is full: five rows. */
export const SHEET_CARD_HEIGHT = SHEET_VISIBLE_ROWS * SHEET_ROW_HEIGHT;

interface SheetProps {
  visible: boolean;
  title: string;
  /** Omitted for a blocking sheet: no close button, and the scrim is inert. */
  onClose?: () => void;
  /**
   * Turns the header's close button into a back button, for a sheet that has a
   * second step. Dismissal stays available on the scrim, which is how a pushed
   * screen behaves everywhere else on the platform — two buttons in a header
   * this size would crowd the title off centre.
   */
  onBack?: () => void;
  /** Accessible name for the scrim and close button. */
  dismissLabel?: string;
  /**
   * Stage's Terminal header: an LED strip with a small Tappy and this label in
   * dot-matrix type, and the title on its own line under it. Without a label
   * the strip carries the title itself, so every sheet gets the strip.
   */
  label?: string;
  /** The strip's LED tone: attention for a sheet that blocks the agent. */
  labelTone?: "agent" | "attention";
  /** Tappy's mood in the strip. Defaults to talking for a blocking sheet. */
  tappyMood?: TappyMood;
  /**
   * Leave the keyboard up on open. For a picker opened mid-sentence (model,
   * thinking level): switching a setting is not leaving the draft. The card
   * rides above the keyboard instead of opening behind it.
   */
  keepKeyboard?: boolean;
  children: ReactNode;
}

/**
 * How far down the card has to be dragged before letting go dismisses it,
 * as a fraction of its own height. A quarter is the platform's own feel: far
 * enough that a scroll that leaks into a drag does not close anything, close
 * enough that a deliberate flick never has to travel the whole card.
 */
const DISMISS_FRACTION = 0.25;
/** …or this fast, in card-heights per second, however far it actually got. */
const DISMISS_VELOCITY = 2.2;

/**
 * The arrival.
 *
 * Underdamped on purpose. A critically damped spring cannot overshoot, but the
 * price is a long imperceptible creep into the final few points — the card looks
 * parked while the scrim is still darkening, which is the "mushy" feel this
 * replaced. `dampingRatio` 0.85 is what UIKit's own sheet transitions use: it
 * arrives, tightens once by well under a point, and is *done*.
 *
 * `duration` here is perceptual, not literal — Reanimated runs the spring for
 * about 1.5× the number, so 420 is a ~630ms tail with the last third of it
 * invisible.
 */
const ARRIVE = { duration: 420, dampingRatio: 0.85 } as const;
/**
 * The departure, and deliberately not a spring.
 *
 * A sheet leaving has nowhere to settle — it is gone the moment it clears the
 * edge — so spring physics buy nothing and cost the tail. Fast, decelerating,
 * and ~40% shorter than the arrival, which is the asymmetry every platform
 * uses: you wait for things to arrive, you never wait for them to leave.
 */
const DEPART = { duration: 240, easing: Easing.out(Easing.cubic) } as const;
/** Spring back after a drag that did not go far enough to dismiss. */
const RETURN = { duration: 320, dampingRatio: 0.9 } as const;
/**
 * Reduced motion: the same movement with the time taken out.
 *
 * A zero-duration timing rather than a bare assignment, because the unmount
 * hangs off the closing animation's completion callback. Assigning a plain
 * number skips the animation machinery, and with it the callback — which would
 * leave the sheet mounted forever for exactly the users who cannot see it.
 */
const INSTANT = { duration: 0 } as const;

/**
 * Where the card sits before it has ever been measured.
 *
 * Only ever used for the first frame of the first open, and only as a distance
 * to start *from* — so an overestimate is invisible (the card is off screen
 * either way) and there is no underestimate that could leave it peeking.
 */
const OFF_SCREEN = Dimensions.get("window").height;

/** How far the header panel sits inside the card's edges. */
const STRIP_INSET = theme.space(2);

/** The sheet's inner rail: title, rows and buttons all start here. */
const SHEET_PAD = theme.space(5);

/** The strip's Tappy: chip-sized, with room in its box to bounce. */
const STRIP_TAPPY = 40;

function SheetView({ visible, title, onClose, onBack, dismissLabel, label, labelTone, tappyMood, keepKeyboard = false, children }: SheetProps) {
  const insets = useSafeAreaInsets();
  const agentColor = useAgentColor();
  const reduceMotion = useReducedMotion();

  // Present in the tree, which outlasts `visible` by exactly one closing
  // animation: an always-mounted overlay would swallow every touch meant for
  // the conversation behind it.
  //
  // Raised *during render* rather than from an effect. An effect would cost a
  // second commit of the whole app tree before the card existed at all, and
  // that commit is the latency being removed here — this way the tap and the
  // first frame of movement land together, the way they do on the platform.
  const [present, setPresent] = useState(visible);
  if (visible && !present) setPresent(true);

  /**
   * How far in the card is: 0 is fully off the bottom edge, 1 is resting.
   *
   * One value for the whole movement, arriving and leaving and dragged, so
   * every one of those can interrupt any other by simply being retargeted —
   * which is what makes a sheet feel like an object rather than a clip being
   * played at you.
   *
   * Deliberately *not* a layout animation on `originY`, which is what this used
   * to be. A layout animation resolves its destination from the measurement
   * taken when it starts, and these sheets contain a card that measures itself
   * a frame later — so the first open of a sheet whose content had never been
   * laid out animated to a position derived from a 1pt-tall card and stopped
   * short. Every later open looked right because the measurement was by then
   * left over from the first. A transform to zero has no such dependency: zero
   * means "wherever layout puts you", which stays true however the card resizes
   * around it.
   */
  const progress = useSharedValue(0);

  // The card's own height, so a drag is judged against the thing being dragged
  // rather than against the screen. Written from `onLayout`, read only on the
  // UI thread; nothing here re-renders.
  const travel = useSharedValue(0);

  useEffect(() => {
    if (!visible) return;
    // Opening a sheet from the composer leaves the conversation's draft: the
    // keyboard goes down so the sheet is the whole focus. A sheet with its own
    // field (a filter, an answer) raises it again on focus, and the card rides
    // above it (`keyboardLift` below) instead of opening behind it.
    if (!keepKeyboard) Keyboard.dismiss();
  }, [visible, keepKeyboard]);

  // The keyboard's live height, negative while open, tracked on the UI thread
  // frame-for-frame with the keyboard's own curve. The card's bottom padding
  // already clears the home indicator, which the keyboard covers, so that much
  // of the lift is given back.
  const keyboard = useReanimatedKeyboardAnimation();
  const homeIndicator = insets.bottom;

  // Removed only once the card has actually left. Guarded against a sheet
  // reopened mid-exit: the callback for the old animation still arrives, and
  // unmounting on it would delete a card that is on its way back in.
  const finishExit = useCallback(() => {
    setPresent((wasPresent) => (visible ? wasPresent : false));
  }, [visible]);

  useEffect(() => {
    if (visible) {
      progress.value = reduceMotion
        ? withTiming(1, INSTANT)
        : withSpring(1, ARRIVE);
      return;
    }
    progress.value = withTiming(0, reduceMotion ? INSTANT : DEPART, (finished) => {
      "worklet";
      // Interrupted means it was reopened on the way out, and the newer
      // animation owns what happens next.
      if (finished) runOnJS(finishExit)();
    });
  }, [visible, reduceMotion, progress, finishExit]);

  const dismiss = onClose;
  // Bound out of `haptics` here, on the JS thread, so the worklet below captures
  // a bare function instead of the object. See the note in `onEnd`.
  const tapHaptic = useCallback(() => {
    haptics.tap();
  }, []);
  // The card follows the finger one-to-one downward and refuses to go up: a
  // sheet already flush against the bottom edge has nothing above it to reveal,
  // and letting it lift would show daylight underneath.
  //
  // Expressed as a change in `progress` rather than as its own offset, so a
  // release can hand straight over to the spring, and so the scrim thins with
  // the drag for free.
  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(dismiss !== undefined && !reduceMotion)
        .onChange((event) => {
          const height = travel.value;
          if (height <= 0) return;
          progress.value = Math.min(1, progress.value - event.changeY / height);
        })
        .onEnd((event) => {
          const height = travel.value;
          const thrown = height > 0 ? event.velocityY / height : 0;
          if (progress.value < 1 - DISMISS_FRACTION || thrown > DISMISS_VELOCITY) {
            // Left exactly where the finger let go: the closing animation picks
            // `progress` up from here, so the card never snaps back up a single
            // point before leaving.
            // `tapHaptic`, never `runOnJS(haptics.tap)`: this body is a worklet,
            // so naming `haptics.tap` reads a property off the `haptics` object
            // on the UI runtime, and that object cannot be sent there. Worklets
            // throws, and a throw on the UI thread is not catchable JS — it
            // aborts the process. Same bug as the drawer's `Keyboard.dismiss`.
            runOnJS(tapHaptic)();
            if (dismiss) runOnJS(dismiss)();
            return;
          }
          progress.value = withSpring(1, RETURN);
        }),
    [dismiss, reduceMotion, progress, travel, tapHaptic],
  );

  const cardStyle = useAnimatedStyle(() => ({
    // Falls back to a whole screen only until the first measurement lands, and
    // only as a starting distance — the resting end of this is always exactly
    // zero, which is why a card that resizes after arriving still ends flush.
    transform: [
      {
        translateY:
          (1 - progress.value) * (travel.value || OFF_SCREEN) +
          Math.min(0, keyboard.height.value + homeIndicator * keyboard.progress.value),
      },
    ],
  }));

  // The scrim tracks the same value, so dragging the card away brings the
  // conversation back under the thumb. Squared off early: it reaches full
  // darkness at 70% of the travel, because a scrim still visibly dark at the
  // point of release makes the dismissal read as reluctant.
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.7], [0, 1], "clamp"),
  }));

  if (!present) return null;

  return (
    // Inert while leaving: the card is still on screen for the length of its
    // exit, and a scrim that kept taking touches for that quarter second would
    // eat the first tap of whatever the user turned to next.
    <View
      style={styles.host}
      pointerEvents={visible ? "box-none" : "none"}
      accessibilityViewIsModal={visible}
      accessibilityElementsHidden={!visible}
      importantForAccessibility={visible ? "yes" : "no-hide-descendants"}
      onAccessibilityEscape={visible ? onClose : undefined}
    >
      {/* Tapping away is the primary dismissal, so the scrim is a control —
          except on a blocking sheet, where it is only a dimming layer that
          still absorbs touches meant for the conversation. */}
      {onClose ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel ?? `Dismiss ${title}`}
          onPress={onClose}
        >
          <Animated.View style={[styles.scrim, scrimStyle]} />
        </Pressable>
      ) : (
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]} />
      )}

      <Animated.View
        onLayout={(event) => {
          travel.value = event.nativeEvent.layout.height;
        }}
        style={[
          styles.sheet,
          // The home indicator's clearance is inside the sheet, not under it,
          // so the content clears the indicator while the surface still
          // reaches the physical edge.
          { paddingBottom: insets.bottom + theme.space(3) },
          cardStyle,
        ]}
      >
        {/* Dragging is bound to the header strip rather than the whole card:
            every sheet's body is a scrolling list, and a pan over one would have
            to win a fight against the scroll on every gesture. The grabber sits
            inside it, so the affordance is where the gesture actually is. */}
        <GestureDetector gesture={dragGesture}>
          {/* Not collapsable: React Native flattens a View that adds no styling
              of its own, and gesture-handler needs a real native view to attach
              to. */}
          <View collapsable={false}>
            <View style={styles.grabber} />

            {/* The Terminal strip: Tappy and an LED label on a dotted panel, the
                way a machine labels its own displays. Full-bleed across the
                card, ruled off with a dash. */}
            <View style={styles.strip}>
              <DotGrid fine />
              {onBack ? (
                <CircleButton key="back" label="Back" onPress={onBack} size={36}>
                  <CrossfadeIcon name="back" />
                </CircleButton>
              ) : null}
              <Tappy size={STRIP_TAPPY} mood={tappyMood ?? (onClose ? "idle" : "talking")} color={agentColor} paused={!visible} style={styles.stripTappy} />
              <View style={styles.stripLabel}>
                <Led tone={labelTone === "attention" ? "attention" : "agent"}>{label ?? title}</Led>
              </View>
              {/* Keyed, so swapping close for back remounts the icon and its
                  fade plays instead of hard-cutting. */}
              {onClose && !onBack ? (
                <CircleButton
                  key="close"
                  label={dismissLabel ?? `Close ${title}`}
                  onPress={onClose}
                  size={36}
                >
                  <CrossfadeIcon name="close" />
                </CircleButton>
              ) : (
                <View style={styles.headerSpacer} />
              )}
            </View>
            {label !== undefined ? (
              <View style={styles.header}>
                <CrossfadeTitle title={title} />
              </View>
            ) : (
              <View style={styles.headerGap} />
            )}
          </View>
        </GestureDetector>

        {/* Contents resolve in on each open, after the card starts to land. */}
        <Dissolve dissolveKey={visible ? "open" : "closed"} enabled={visible} delay={60} style={styles.dissolveBody}>
          {children}
        </Dissolve>
      </Animated.View>
    </View>
  );
}

/**
 * The title, re-fading whenever the words change.
 *
 * Out then in, rather than two copies dissolving into each other: a title is
 * centred, so two of different widths overlapping mid-fade read as a smear. The
 * swap happens at zero opacity, and the pane travelling underneath is what
 * carries the sense of direction.
 */
function CrossfadeTitle({ title }: { title: string }) {
  const reduceMotion = useReducedMotion();
  const shown = useRef(title);
  const fade = useSharedValue(1);
  const [rendered, setRendered] = useState(title);

  useEffect(() => {
    if (title === shown.current) return;
    shown.current = title;
    if (reduceMotion) {
      setRendered(title);
      return;
    }
    // The swap happens inside the animation's own completion, on the UI thread,
    // so the words change at exactly zero opacity rather than on whichever
    // frame a JS timer happened to land on.
    fade.value = withTiming(0, { duration: 110 }, (finished) => {
      "worklet";
      // A second change interrupts the first: an interrupted timing reports
      // unfinished, and the newer effect owns the swap. Without this guard the
      // stale title would be committed on top of it.
      if (!finished) return;
      runOnJS(setRendered)(title);
      fade.value = withTiming(1, { duration: 150 });
    });
  }, [title, reduceMotion, fade]);

  const style = useAnimatedStyle(() => ({ opacity: fade.value }));

  return (
    <Animated.Text style={[styles.title, style]} numberOfLines={1} accessibilityRole="header">
      {rendered}
    </Animated.Text>
  );
}

/**
 * The header glyph, fading in when it is swapped for a different one.
 *
 * Remounted by the keys on the buttons above, so this only ever plays the
 * arrival — the half that matters when close becomes back.
 */
function CrossfadeIcon({ name }: { name: DotGlyphName }) {
  return (
    <Animated.View entering={FadeIn.duration(160)}>
      <DotGlyph name={name} size={14} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  dissolveBody: { flexShrink: 1 },
  host: { ...StyleSheet.absoluteFillObject, zIndex: 20, justifyContent: "flex-end" },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  // Inset left and right so the thread stays visible down both sides, but sat
  // on the bottom edge: a sheet rises *from* the screen edge, and a gap under
  // it would leave the home indicator stranded on the conversation behind.
  // Square where it meets that edge, for the same reason — rounding a corner
  // there implies a boundary the sheet does not actually have.
  // Content sits on one rail with the title: the sheet's own padding. A sheet's
  // body adds no horizontal padding of its own.
  sheet: {
    marginHorizontal: theme.gutter,
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.pane,
    borderTopRightRadius: theme.radius.pane,
    paddingHorizontal: SHEET_PAD,
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.color.textFaint,
    marginTop: theme.space(2),
  },
  // Full-bleed across the card: the sheet's own padding is cancelled so the
  // strip's texture and rule reach both edges.
  // A panel inside the card, rounded and inset STRIP_INSET from its edges.
  // It used to run edge to edge as a square block, and sat high enough that
  // the card's rounded top corners curved in past it: its corners poked out.
  strip: {
    flexDirection: "row",
    alignItems: "center",
    marginHorizontal: -(SHEET_PAD - STRIP_INSET),
    marginTop: theme.space(2),
    borderRadius: theme.radius.lg,
    ...dashedOutline,
    // Tappy's globe fills the middle ~60% of its box, so the box starts 8pt
    // short of the rail and the globe's edge lands on it. The close button's
    // edge lands 4pt inside the right rail.
    paddingLeft: SHEET_PAD - 8 - STRIP_INSET,
    paddingRight: SHEET_PAD - 4 - STRIP_INSET,
    // Breathing room above and below the 36pt buttons, so the close/back never
    // touches the strip's edge or the dashed rule under it. Every sheet.
    minHeight: 56,
    paddingVertical: theme.space(2.5),
    backgroundColor: theme.stage.strip,
    overflow: "hidden",
  },
  stripTappy: { marginVertical: -4 },
  stripLabel: { flex: 1, minWidth: 0 },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: theme.space(4),
    paddingBottom: theme.space(3),
  },
  headerGap: { height: theme.space(3) },
  headerSpacer: { width: 36 },
  // Left-aligned on the sheet's rail with everything under it; one line, so
  // a long title truncates instead of pushing the content down.
  title: {
    flex: 1,
    minWidth: 0,
    color: theme.color.text,
    fontSize: 19,
    lineHeight: 24,
    fontWeight: "600",
  },
});

/** The card the sheet's content sits in: one rounded, clipped raised surface. */
export const sheetCardStyle = {
  backgroundColor: theme.color.surfaceRaised,
  borderRadius: theme.radius.lg,
  overflow: "hidden",
} as const;

export const Sheet = memo(SheetView);
