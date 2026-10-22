/**
 * GG Coder round-2 surfaces: the plan review sheet (gg-app PlanReviewModal),
 * the strip above the composer (plan-mode chip, Autopilot toggle, "Ken is
 * reviewing…", checklist entry), and the project checklist sheet.
 * Rules live in `ggReview.ts` (Expo-free, tested).
 */
import { memo, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { StageScroll } from "./stage/StageScroll";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { StageButton } from "./stage/StageButton";
import { Sheet } from "./Sheet";
import { Led, type LedTone } from "./stage/Led";
import { DashedRule, dashedOutline } from "./stage/DashedRule";
import { Pixel } from "./stage/Pixel";
import { PressScale } from "./stage/PressScale";
import { withAlpha } from "../motion";
import { MarkdownText } from "./MarkdownText";
import { Dissolve } from "./motion/Dissolve";
import { Tappy } from "../tappy/Tappy";
import { KEN_COLOR } from "../tappy/palette";
import {
  CHECKLIST_STATUS_LABEL,
  checklistRunPrompt,
  groupChecklist,
  type AutopilotInfo,
  type ChecklistItem,
  type PendingPlan,
} from "../ggReview";


// ── Plan review ─────────────────────────────────────────────

/** The plan as a document: its first heading, and its numbered steps (none when it has no list). */
function readPlan(content: string): { title?: string; steps: string[] } {
  const lines = content.split("\n");
  const heading = lines.find((l) => /^#{1,6}\s+\S/.test(l));
  const steps = lines
    .map((l) => /^\s*(?:\d+[.)]|[-*]\s+\[[ x]\])\s+(.+)$/.exec(l)?.[1])
    .filter((t): t is string => t !== undefined)
    .map((t) => t.replace(/\*\*|`/g, "").trim());
  return { title: heading?.replace(/^#+\s+/, "").trim(), steps };
}

function PlanReviewSheetView({
  plan,
  busy,
  onDecide,
}: {
  plan?: PendingPlan;
  /** The daemon refuses `plan.decide` mid-turn, so every decision waits for idle. */
  busy: boolean;
  onDecide: (generation: number, action: "accept" | "feedback" | "reject", feedback?: string) => void;
}) {
  const held = useRef(plan);
  if (plan) held.current = plan;
  const shown = held.current;
  const [feedback, setFeedback] = useState("");
  const [writing, setWriting] = useState(false);
  // "Decide later" hides this generation only; the plan stays pending at the agent.
  const [deferred, setDeferred] = useState<number | undefined>(undefined);
  const generation = shown?.generation;
  useEffect(() => {
    setFeedback("");
    setWriting(false);
  }, [generation]);
  const decide = (action: "accept" | "feedback" | "reject") => {
    if (!shown || busy) return;
    if (action === "reject") haptics.warned();
    else haptics.sent();
    onDecide(shown.generation, action, action === "feedback" ? feedback.trim() : undefined);
  };
  const doc = readPlan(shown?.content ?? "");
  const feedbackOff = busy || (writing && !feedback.trim());

  return (
    <Sheet
      visible={plan !== undefined && plan.generation !== deferred}
      label="Plan ready"
      tappyMood="happy"
      title={doc.title ?? "The plan"}
      dismissLabel="Decide later"
      onClose={() => setDeferred(plan?.generation)}
    >
      <StageScroll style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {doc.steps.length > 0 ? (
          <>
            <Text style={styles.sub} numberOfLines={1}>{`${doc.steps.length} step${doc.steps.length === 1 ? "" : "s"}`}</Text>
            <View>
              {doc.steps.map((step, i) => (
                <Dissolve key={`${i}:${step}`} kind="row" delay={i * 50}>
                  {i > 0 ? <DashedRule /> : null}
                  <View style={styles.step}>
                    <Led style={styles.stepNum}>{String(i + 1).padStart(2, "0")}</Led>
                    <Text style={styles.stepText} numberOfLines={2}>{step}</Text>
                  </View>
                </Dissolve>
              ))}
            </View>
          </>
        ) : (
          <View style={[styles.planCard, dashedOutline]}>
            <MarkdownText text={shown?.content ?? ""} />
          </View>
        )}
        {writing ? (
          <TextInput
            style={styles.input}
            value={feedback}
            onChangeText={setFeedback}
            placeholder="What should change?"
            placeholderTextColor={theme.color.textFaint}
            multiline
            autoFocus
          />
        ) : null}
        {busy ? <Text style={styles.hint}>Agent is working. Decide when it finishes.</Text> : null}
        {/* decide() plays its own haptic (sent / warned), so the buttons stay quiet. */}
        <StageButton label="Accept and build" disabled={busy} feel="none" onPress={() => decide("accept")} />
        <View style={styles.row}>
          <StageButton
            compact
            kind="secondary"
            style={styles.half}
            disabled={feedbackOff}
            feel={writing ? "none" : "tap"}
            label={writing ? "Send feedback" : "Give feedback"}
            onPress={() => {
              if (writing) decide("feedback");
              else setWriting(true);
            }}
          />
          <StageButton compact kind="danger" style={styles.half} disabled={busy} feel="none" label="Reject" onPress={() => decide("reject")} />
        </View>
      </StageScroll>
    </Sheet>
  );
}
export const PlanReviewSheet = memo(PlanReviewSheetView);

// ── Strip above the composer ────────────────────────────────

function GgControlStripView({
  planMode,
  autopilot,
  showAutopilot,
  showChecklist,
  onToggleAutopilot,
  onOpenChecklist,
}: {
  planMode: boolean;
  autopilot?: AutopilotInfo;
  showAutopilot: boolean;
  showChecklist: boolean;
  onToggleAutopilot: () => void;
  onOpenChecklist: () => void;
}) {
  if (!planMode && !showAutopilot && !showChecklist) return null;
  const on = autopilot?.enabled === true;
  return (
    <View style={styles.strip}>
      {planMode ? (
        <Dissolve kind="in" dissolveKey="plan-mode">
          <View style={styles.ledChip} accessibilityLabel="Plan mode">
            <Pixel kind="live" />
            <Led>Plan mode</Led>
          </View>
        </Dissolve>
      ) : null}
      {showAutopilot ? (
        <Pressable
          accessibilityRole="switch"
          accessibilityState={{ checked: on }}
          accessibilityLabel="Autopilot"
          style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.pressed]}
          onPress={onToggleAutopilot}
        >
          <Tappy size={22} style={styles.tappy} color={KEN_COLOR} mood={autopilot?.reviewing ? "thinking" : on ? "idle" : "sleepy"} paused={!on} />
          <Text style={[styles.chipText, on && styles.chipTextOn]}>
            {autopilot?.reviewing ? "Ken is reviewing…" : on ? "Autopilot on" : "Autopilot"}
          </Text>
        </Pressable>
      ) : null}
      {showChecklist ? (
        <PressScale accessibilityLabel="Checklist" feel="tap" style={styles.ledChip} onPress={onOpenChecklist}>
          <Pixel kind="unread" />
          <Led>Checklist</Led>
        </PressScale>
      ) : null}
    </View>
  );
}
export const GgControlStrip = memo(GgControlStripView);

// ── Checklist ───────────────────────────────────────────────

type Band = "Failing" | "Due" | "Passing";
const BAND_OF: Record<ChecklistItem["status"], Band> = {
  "needs-work": "Failing",
  due: "Due",
  "not-run": "Due",
  passed: "Passing",
  "not-applicable": "Passing",
};
const BAND_TONE: Record<Band, LedTone> = { Failing: "danger", Due: "attention", Passing: "dim" };
const BANDS: readonly Band[] = ["Failing", "Due", "Passing"];

function StateGlyph({ band }: { band: Band }) {
  if (band === "Passing")
    return (
      <View style={[styles.glyph, { backgroundColor: withAlpha(theme.color.success, 0.15) }]}>
        <Ionicons name="checkmark" size={14} color={theme.color.success} />
      </View>
    );
  if (band === "Failing")
    return (
      <View style={styles.glyph}>
        <Ionicons name="close" size={16} color={theme.color.danger} />
      </View>
    );
  return <View style={[styles.glyph, styles.glyphDue]} />;
}

function ChecklistRow({ item, band, busy, onRun }: { item: ChecklistItem; band: Band; busy: boolean; onRun: (prompt: string) => void }) {
  const [open, setOpen] = useState(false);
  const prompt = checklistRunPrompt(item);
  return (
    <View>
      <View style={styles.itemTop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${item.title}, ${CHECKLIST_STATUS_LABEL[item.status]}`}
          onPress={() => {
            haptics.tap();
            setOpen((o) => !o);
          }}
          style={styles.itemMain}
        >
          <StateGlyph band={band} />
          <Text style={styles.itemTitle} numberOfLines={1}>{item.title}</Text>
        </Pressable>
        {prompt ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Run ${item.title}`}
            accessibilityState={{ disabled: busy }}
            disabled={busy}
            hitSlop={8}
            style={({ pressed }) => [styles.runButton, busy && styles.dim, pressed && styles.pressed]}
            onPress={() => {
              haptics.sent();
              onRun(prompt);
            }}
          >
            <Led size={10}>Run</Led>
          </Pressable>
        ) : null}
      </View>
      {open ? (
        <Dissolve kind="row" dissolveKey={item.id}>
          <View style={styles.detail}>
            {item.changedSinceCheck ? <Text style={styles.hint}>Code changed since this check</Text> : null}
            <Text style={styles.dimText}>{item.summary ?? item.description}</Text>
            {item.findings.map((f) => (
              <Text key={`f:${f}`} style={styles.dimText}>• {f}</Text>
            ))}
            {item.evidence.map((e) => (
              <Text key={`e:${e}`} style={styles.hint}>{e}</Text>
            ))}
            {prompt && busy ? <Text style={styles.hint}>Agent is working</Text> : null}
          </View>
        </Dissolve>
      ) : null}
    </View>
  );
}

function ChecklistSheetView({
  visible,
  items,
  error,
  busy,
  onClose,
  onRun,
}: {
  visible: boolean;
  /** A check sent mid-turn would be queued into the current turn. */
  busy: boolean;
  items?: ChecklistItem[];
  error?: string;
  onClose: () => void;
  onRun: (prompt: string) => void;
}) {
  // Same in-band order as the desktop (status, then title), regrouped by state.
  const sorted = items ? groupChecklist(items).flatMap((g) => g.items) : [];
  const bands = BANDS.map((band) => ({ band, items: sorted.filter((i) => BAND_OF[i.status] === band) })).filter((b) => b.items.length > 0);
  const passing = sorted.filter((i) => i.status === "passed").length;
  const counted = sorted.filter((i) => i.status !== "not-applicable").length;
  let row = 0;
  return (
    <Sheet visible={visible} label="Checklist" title={items ? `${passing} of ${counted} passing` : "Checklist"} onClose={onClose}>
      <StageScroll style={styles.scroll} contentContainerStyle={styles.body}>
        {error ? <Text style={styles.dimText}>{error}</Text> : null}
        {!items && !error ? <Text style={styles.dimText}>Loading…</Text> : null}
        {bands.map((b) => (
          <View key={b.band} style={styles.group}>
            <Led tone={BAND_TONE[b.band]}>{`${b.band} · ${b.items.length}`}</Led>
            <View>
              {b.items.map((item) => (
                <Dissolve key={item.id} kind="row" delay={row++ * 40}>
                  <ChecklistRow item={item} band={b.band} busy={busy} onRun={onRun} />
                </Dissolve>
              ))}
            </View>
          </View>
        ))}
      </StageScroll>
    </Sheet>
  );
}
export const ChecklistSheet = memo(ChecklistSheetView);

const styles = StyleSheet.create({
  // Tappy's globe fills the middle of its box; the rest is room to bounce,
  // so the box overhangs the old icon's footprint instead of growing the row.
  tappy: { margin: -4 },
  scroll: { maxHeight: 560 },
  body: { gap: theme.space(3), paddingBottom: theme.space(2) },
  planCard: { padding: theme.space(4), borderRadius: theme.radius.md },
  sub: { color: theme.color.textDim, fontSize: theme.font.small },
  step: { flexDirection: "row", alignItems: "flex-start", gap: theme.space(3), paddingVertical: theme.space(3) },
  stepNum: { width: theme.space(6), paddingTop: 2 },
  stepText: { flex: 1, color: theme.color.text, fontSize: theme.font.body },
  ledChip: {
    ...dashedOutline,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1.5),
  },
  glyph: { width: 20, height: 20, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  glyphDue: { borderWidth: 1.5, borderStyle: "dashed", borderColor: theme.color.attention, width: 16, height: 16, margin: 2, borderRadius: 3 },
  row: { flexDirection: "row", gap: theme.space(2) },
  input: {
    minHeight: 80,
    borderRadius: theme.radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    color: theme.color.text,
    fontSize: theme.font.body,
    padding: theme.space(3),
  },
  half: { flex: 1 },
  dim: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
  strip: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2), paddingHorizontal: theme.gutter, paddingBottom: theme.space(2) },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    borderRadius: theme.radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surface,
    paddingHorizontal: theme.space(2.5),
    paddingVertical: theme.space(1),
  },
  chipOn: { borderColor: theme.color.accent, backgroundColor: theme.color.accentSoft },
  chipText: { color: theme.color.textDim, fontSize: theme.font.small },
  chipTextOn: { color: theme.color.accent, fontWeight: "600" },
  group: { gap: theme.space(1.5) },
  groupTitle: { color: theme.color.textDim, fontSize: theme.font.small, fontWeight: "600", paddingHorizontal: theme.space(1) },
  itemTop: { flexDirection: "row", alignItems: "center", gap: theme.space(3), minHeight: theme.size.touch },
  itemMain: { flex: 1, flexDirection: "row", alignItems: "center", gap: theme.space(3), paddingVertical: theme.space(2.5) },
  itemTitle: { color: theme.color.text, fontSize: theme.font.body },
  detail: { gap: theme.space(1.5), paddingLeft: 20 + theme.space(3), paddingBottom: theme.space(3) },
  dimText: { color: theme.color.textDim, fontSize: theme.font.small },
  hint: { color: theme.color.textFaint, fontSize: theme.font.tiny },
  runButton: { ...dashedOutline, borderRadius: theme.radius.pill, paddingHorizontal: theme.space(3), paddingVertical: theme.space(1) },
});
