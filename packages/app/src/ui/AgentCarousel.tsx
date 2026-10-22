/**
 * Agent picker, "Carousel": a full-screen overlay paging through every agent,
 * each a big Tappy over a wash of its colour. Snapping clicks (detent); the
 * primary button selects the agent and closes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BackHandler,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { theme } from "../theme";
import { Tappy } from "../tappy/Tappy";
import { tappyInk } from "../tappy/palette";
import { haptics } from "./haptics";
import { Led } from "./stage/Led";
import { DotGrid } from "./stage/DotGrid";
import { AgentGlow } from "./AgentGlow";
import { pageForScroll, type PagingHold } from "../carouselPaging";
import { DotGlyph } from "./stage/DotGlyph";
import { StageButton } from "./stage/StageButton";
import { useReducedMotion } from "./useReducedMotion";

export interface CarouselAgent {
  id: string;
  name: string;
  color?: string;
  available?: boolean;
}

export interface AgentCarouselProps {
  agents: readonly CarouselAgent[];
  currentId?: string;
  onSelect: (id: string) => void;
  onClose: () => void;
  /** Opened by a tap on Tappy, which was smiling: its Tappy arrives smiling and settles. */
  arriveSmiling?: boolean;
}

/** How long the arriving smile holds before Tappy settles back to its usual mood. */
const SMILE_HOLD_MS = 1100;

const TAPPY = 200;

export function AgentCarousel({ agents, currentId, onSelect, onClose, arriveSmiling = false }: AgentCarouselProps) {
  const [smiling, setSmiling] = useState(arriveSmiling);
  useEffect(() => {
    if (!smiling) return;
    const t = setTimeout(() => setSmiling(false), SMILE_HOLD_MS);
    return () => clearTimeout(t);
  }, [smiling]);
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const list = useRef<FlatList<CarouselAgent>>(null);
  const start = Math.max(0, agents.findIndex((a) => a.id === currentId));
  const [page, setPage] = useState(start);
  const agent = agents[page];
  const ink = tappyInk(agent?.color);

  useEffect(() => {
    if (Platform.OS !== "android") return;
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // An arrow press slides the list to its page. While that slide runs, the
  // scroll events pass back through the pages in between (the old one first),
  // and following them flipped the page, its colour and the button back and
  // forth. So the scroll handlers ignore positions until the slide lands on
  // the arrow's page; a timer releases the hold if no landing is reported.
  // Created on first use rather than as the ref's initial value: a live reload
  // can hand this hook a ref left over from an earlier version whose value was
  // undefined, and writing `.target` on it crashed the switcher.
  const arrowHoldRef = useRef<PagingHold | undefined>(undefined);
  const arrowHold = useCallback((): PagingHold => (arrowHoldRef.current ??= {}), []);
  const arrowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(arrowTimer.current), []);
  const goTo = useCallback(
    (i: number) => {
      const next = Math.max(0, Math.min(agents.length - 1, i));
      if (next === page) return;
      arrowHold().target = next;
      clearTimeout(arrowTimer.current);
      arrowTimer.current = setTimeout(() => {
        arrowHold().target = undefined;
      }, 700);
      list.current?.scrollToIndex({ index: next, animated: !reduceMotion });
      setPage(next);
      haptics.detent();
    },
    [agents.length, page, reduceMotion, arrowHold],
  );
  /** The page a scroll position means, or undefined while an arrow slide is still travelling. */
  const settledPage = useCallback(
    (x: number) => pageForScroll(x, width, agents.length, arrowHold()),
    [agents.length, width, arrowHold],
  );

  const onMomentumEnd = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = settledPage(e.nativeEvent.contentOffset.x);
      if (next !== undefined && next !== page) {
        setPage(next);
        haptics.detent();
      }
    },
    [page, settledPage],
  );

  // The page under the finger, live while dragging, so Tappy recolours as you
  // swipe rather than after the scroll has settled.
  const onScroll = useCallback(
    (e: NativeSyntheticEvent<NativeScrollEvent>) => {
      const next = settledPage(e.nativeEvent.contentOffset.x);
      if (next !== undefined && next !== page) {
        setPage(next);
        haptics.detent();
      }
    },
    [page, settledPage],
  );

  const getItemLayout = useMemo(
    () => (_: unknown, index: number) => ({ length: width, offset: width * index, index }),
    [width],
  );

  const isCurrent = agent?.id === currentId;

  return (
    // Fades in over home rather than cutting to it, so the smiling Tappy reads as
    // the same Tappy carrying on.
    <Animated.View entering={reduceMotion ? undefined : FadeIn.duration(220)} style={[StyleSheet.absoluteFill, styles.root]}>
      <DotGrid />
      <View style={[styles.top, { paddingTop: insets.top + theme.space(2) }]}>
        <Led color={ink}>Switch agent</Led>
        <Pressable
          onPress={() => {
            haptics.tap();
            onClose();
          }}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={12}
        >
          <DotGlyph name="close" size={20} color={theme.color.text} />
        </Pressable>
      </View>
      {/* ONE Tappy, fixed in the middle: swiping recolours and renames it rather
          than sliding in a fresh Tappy per agent (which all arrived in the same
          rest pose, so the carousel felt static). It keeps whatever it was
          doing; only its colour morphs, and its glow cross-fades. The pages
          underneath carry just the text, and swipes pass through Tappy. */}
      <View style={styles.listWrap}>
      <FlatList
        ref={list}
        data={agents as CarouselAgent[]}
        keyExtractor={(a) => a.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        initialScrollIndex={start}
        getItemLayout={getItemLayout}
        onMomentumScrollEnd={onMomentumEnd}
        onScroll={onScroll}
        onScrollBeginDrag={() => {
          arrowHold().target = undefined;
          clearTimeout(arrowTimer.current);
        }}
        scrollEventThrottle={32}
        style={styles.pages}
        renderItem={({ item }) => (
          <View style={[styles.page, { width }]}>
            <View style={styles.tappySpot} />
            <View style={styles.label}>
              <Text style={styles.name} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.5}>
                {item.name}
              </Text>
              <Led color={tappyInk(item.color)} tone={item.available === false ? "dim" : "agent"}>
                {item.id === currentId ? "Current" : item.available === false ? "Not set up" : "Ready"}
              </Led>
            </View>
          </View>
        )}
      />
      <View style={[StyleSheet.absoluteFill, styles.page]} pointerEvents="none">
        <View style={styles.tappySpot}>
          <AgentGlow color={ink} size={TAPPY * 1.9} />
          <Tappy size={TAPPY} mood={smiling ? "happy" : agent?.available === false ? "sleepy" : "idle"} color={agent?.color} />
        </View>
        <View style={styles.label} />
      </View>
      </View>
      <View style={styles.dots}>
        {agents.map((a, i) => (
          <View key={a.id} style={[styles.dot, i === page && { backgroundColor: ink, width: 16 }]} />
        ))}
      </View>
      <View style={[styles.bottom, { paddingBottom: insets.bottom + theme.space(4) }]}>
        <Pressable onPress={() => goTo(page - 1)} accessibilityRole="button" accessibilityLabel="Previous agent" style={styles.arrow} disabled={page === 0}>
          <DotGlyph name="back" size={20} color={page === 0 ? theme.color.textDim : theme.color.text} />
        </Pressable>
        {/* One button for every agent: its colour blends and its label
            changes in place. It used to be re-keyed per agent, which faded it
            out and back in on every arrow tap: a flicker. */}
        {agent && (
          <View style={styles.primaryWrap}>
            <StageButton
              color={ink}
              feel="select"
              label={isCurrent ? `Keep ${agent.name}` : `Switch to ${agent.name}`}
              onPress={() => {
                if (!isCurrent) onSelect(agent.id);
                onClose();
              }}
            />
          </View>
        )}
        <Pressable
          onPress={() => goTo(page + 1)}
          accessibilityRole="button"
          accessibilityLabel="Next agent"
          style={styles.arrow}
          disabled={page >= agents.length - 1}
        >
          {/* The back chevron, mirrored: one pixel glyph for both directions. */}
          <View style={styles.mirror}>
            <DotGlyph name="back" size={20} color={page >= agents.length - 1 ? theme.color.textDim : theme.color.text} />
          </View>
        </Pressable>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: theme.color.bg, zIndex: 50 },
  tappySpot: { width: TAPPY, height: TAPPY, alignItems: "center", justifyContent: "center" },
  mirror: { transform: [{ scaleX: -1 }] },
  top: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: theme.gutter },
  listWrap: { flex: 1 },
  pages: { flex: 1 },
  // Fixed height, so the text pages and the Tappy overlay lay out identically.
  label: { height: 96, alignSelf: "stretch", alignItems: "center", justifyContent: "flex-start", gap: theme.space(2) },
  page: { alignItems: "center", justifyContent: "center", paddingHorizontal: theme.gutter, gap: theme.space(2) },
  name: { color: theme.color.text, fontFamily: theme.display.regular, fontSize: 34, alignSelf: "stretch", textAlign: "center" },
  dots: { flexDirection: "row", justifyContent: "center", gap: theme.space(1.5), marginBottom: theme.space(4) },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.stage.dash },
  bottom: { flexDirection: "row", alignItems: "center", paddingHorizontal: theme.gutter, gap: theme.space(3) },
  arrow: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  primaryWrap: { flex: 1 },
});
