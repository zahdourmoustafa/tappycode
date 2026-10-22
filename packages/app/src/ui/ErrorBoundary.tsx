/**
 * The last thing standing between a render crash and a blank screen.
 *
 * React unmounts the whole tree when a render throws. Without a boundary the
 * app becomes a black rectangle: nothing to read, nothing to tap, and nothing a
 * tester can put in a bug report beyond "it broke". That is the worst possible
 * feedback loop for a build going to people who cannot attach a debugger.
 *
 * So this shows what happened and offers the one action that actually recovers
 * a bad render — try again. The error text is on screen rather than only in a
 * log, because the person hitting it is holding a phone, not a terminal.
 *
 * Deliberately not a crash *reporter*. Sending diagnostics off this device would
 * mean shipping prompts and file paths to a third party, which is the opposite
 * of what the encryption work was for. If reporting is ever added it should be
 * opt-in and say exactly what it sends.
 *
 * It also uses only system fonts. The app's display family is loaded at runtime
 * by `useFonts`, and naming an unloaded family on iOS silently falls back — so a
 * crash that happened *during* font loading would render this screen in the
 * wrong metrics, or not at all. A last resort cannot depend on something that
 * may be the thing that broke.
 */
import { Component, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { Tappy } from "../tappy/Tappy";
import { haptics } from "./haptics";
import { StageButton } from "./stage/StageButton";
import { tappyInk } from "../tappy/palette";

/** tappy's own coral. */
const TAPPY_CORAL = tappyInk();

interface Props {
  children: ReactNode;
}

interface State {
  error?: Error;
  recovering: boolean;
  details: boolean;
}

/** Tappy is decoration here: if it throws too, the screen must still draw. */
class Guard extends Component<{ children: ReactNode; fallback: ReactNode }, { broken: boolean }> {
  state = { broken: false };
  static getDerivedStateFromError() {
    return { broken: true };
  }
  render() {
    return this.state.broken ? this.props.fallback : this.props.children;
  }
}

/** How long Tappy stands back up before the tree is retried. */
const RECOVER_MS = 700;
/** Amber "!" badge on the oops Tappy. */
const BADGE = 24;

export class ErrorBoundary extends Component<Props, State> {
  state: State = { recovering: false, details: false };
  private timer: ReturnType<typeof setTimeout> | undefined;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error, recovering: false, details: false };
  }

  componentDidCatch(error: Error) {
    // Also to the console, so `expo start` shows it during development. The
    // on-screen copy is for everyone who has no console attached.
    console.error("[tappy] render crashed:", error);
    try {
      haptics.failed();
    } catch {
      // A haptic is never worth a second crash.
    }
  }

  componentWillUnmount() {
    if (this.timer) clearTimeout(this.timer);
  }

  private reset = () => {
    if (this.state.recovering) return;
    this.setState({ recovering: true });
    this.timer = setTimeout(() => this.setState({ error: undefined, recovering: false, details: false }), RECOVER_MS);
  };

  render() {
    const retry = () => {
      try {
        haptics.tap();
      } catch {
        // ignore
      }
      this.reset();
    };
    const plainRetry = (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Try again"
        onPress={retry}
        style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
      >
        <Text style={styles.buttonText}>Try again</Text>
      </Pressable>
    );
    const { error, recovering, details } = this.state;
    if (!error) return this.props.children;

    return (
      <View style={styles.screen}>
        <Guard fallback={<View style={styles.tappySpace} />}>
          <View style={styles.tappyWrap}>
            <Tappy size={112} mood={recovering ? "happy" : "oops"} accessibilityLabel={recovering ? "Tappy, recovering" : "Tappy, hurt"} style={styles.tappy} />
            {!recovering && (
              <View style={styles.badge}>
                <Text style={styles.badgeText}>!</Text>
              </View>
            )}
          </View>
        </Guard>
        <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit>
          {recovering ? "Back on my feet" : "tappy hit a problem"}
        </Text>
        <Text style={styles.body} numberOfLines={2}>
          Something failed to draw. Trying again usually works.
        </Text>

        {/* The Stage button, guarded: this is the crash screen, so if the
            button itself can't draw, the plain one below still can. */}
        <Guard fallback={plainRetry}>
          <StageButton label="Try again" color={TAPPY_CORAL} feel="none" onPress={retry} />
        </Guard>

        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: details }}
          accessibilityLabel={details ? "Hide details" : "Show details"}
          onPress={() => this.setState({ details: !details })}
          style={styles.detailsToggle}
        >
          <Text style={styles.detailsToggleText}>{details ? "Hide details" : "Details"}</Text>
        </Pressable>

        {/* Scrollable and selectable: a stack is long, and truncating it
            removes the only part that makes the report useful. */}
        {details && (
          <ScrollView style={styles.detail} contentContainerStyle={styles.detailContent}>
            <Text style={styles.detailText} selectable>
              {error.message}
              {error.stack ? `\n\n${error.stack}` : ""}
            </Text>
          </ScrollView>
        )}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: theme.color.bg,
    paddingHorizontal: theme.gutter,
    justifyContent: "center",
    gap: theme.space(4),
  },
  tappySpace: { height: theme.space(4) },
  tappyWrap: { alignSelf: "flex-start" },
  // The globe fills ~60% of its box: pull the heading up under it.
  tappy: { margin: -theme.space(5) },
  badge: {
    position: "absolute",
    right: theme.space(1),
    top: 0,
    width: BADGE,
    height: BADGE,
    borderRadius: BADGE / 2,
    backgroundColor: theme.color.attention,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeText: { color: theme.color.bg, fontSize: theme.font.body, fontWeight: "800" },
  // System font only: the display face may be the thing that failed to load.
  title: { color: theme.color.text, fontSize: theme.font.greeting, fontWeight: "600" },
  body: { color: theme.color.textDim, fontSize: theme.font.body, lineHeight: theme.line.body },
  detail: {
    maxHeight: 220,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
  },
  detailContent: { padding: theme.space(3) },
  detailText: {
    color: theme.color.textDim,
    fontSize: theme.font.tiny,
    // System monospace, always present: a stack trace in a proportional face is
    // materially harder to read, and this is the part worth reporting.
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
  },
  button: {
    backgroundColor: theme.color.accent,
    borderRadius: theme.radius.pill,
    paddingVertical: theme.space(3),
    alignItems: "center",
  },
  buttonPressed: { opacity: 0.85 },
  buttonText: { color: theme.color.onAccent, fontSize: theme.font.body, fontWeight: "600" },
  detailsToggle: { minHeight: theme.size.touch, justifyContent: "center", alignSelf: "flex-start" },
  detailsToggleText: { color: theme.color.textDim, fontSize: theme.font.body },
});
