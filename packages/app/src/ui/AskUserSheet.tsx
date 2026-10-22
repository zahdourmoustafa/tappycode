/**
 * GG Coder's `ask_user` card, modelled on gg-app's AskBand: one card, every
 * question in it, one shape of option row whatever the kind. The agent's
 * recommendation is tagged, never preselected. Free text is offered unless the
 * agent opted out. Submit sends every answer at once — a half-filled form
 * never reaches the agent; dismissing the sheet tells it the user declined.
 *
 * Answer-building lives in `askUser.ts` (Expo-free, tested).
 */
import { Dissolve } from "./motion/Dissolve";
import { memo, useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { StageScroll } from "./stage/StageScroll";
import Ionicons from "@expo/vector-icons/Ionicons";
import { withAlpha } from "../motion";
import { dashedOutline } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { StageButton } from "./stage/StageButton";
import { Sheet } from "./Sheet";
import {
  allowsOther,
  buildAskResult,
  CANCEL_RESULT,
  EMPTY_DRAFT,
  optionValue,
  pickOption,
  questionHint,
  questionOptions,
  typeOther,
  type AskDraft,
  type AskQuestion,
  type AskRequest,
  type AskResult,
} from "../askUser";

interface AskUserSheetProps {
  /** The open question, or undefined once answered. */
  ask?: AskRequest;
  onAnswer: (requestId: string, result: AskResult) => void;
}

function AskUserSheetView({ ask, onAnswer }: AskUserSheetProps) {
  const held = useRef(ask);
  if (ask) held.current = ask;
  const shown = held.current;
  const [draft, setDraft] = useState<AskDraft>(EMPTY_DRAFT);
  const requestId = shown?.requestId;
  // A new question starts blank.
  useEffect(() => setDraft(EMPTY_DRAFT), [requestId]);

  const result = shown ? buildAskResult(shown.questions, draft) : undefined;
  const single = (shown?.questions.length ?? 0) === 1;

  return (
    <Sheet
      visible={ask !== undefined}
      label="Question"
      labelTone="attention"
      tappyMood="talking"
      title={single ? "One question" : `${shown?.questions.length ?? 0} questions`}
      dismissLabel="Skip these questions"
      onClose={() => {
        if (ask) onAnswer(ask.requestId, CANCEL_RESULT);
      }}
    >
      <StageScroll style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {shown?.questions.map((question, index) => (
          <QuestionBlock
            key={question.id}
            question={question}
            number={single ? undefined : index + 1}
            draft={draft}
            onChange={setDraft}
          />
        ))}
        <StageButton
          style={styles.submit}
          disabled={!result}
          feel="sent"
          label={result ? "Send answer" : "Choose an answer"}
          onPress={() => {
            if (!shown || !result) return;
            onAnswer(shown.requestId, result);
          }}
        />
      </StageScroll>
    </Sheet>
  );
}

function QuestionBlock({
  question,
  number,
  draft,
  onChange,
}: {
  question: AskQuestion;
  number?: number;
  draft: AskDraft;
  onChange: (draft: AskDraft) => void;
}) {
  const options = questionOptions(question);
  const picks = draft.picks[question.id] ?? [];
  const hint = questionHint(question);
  const multi = question.kind === "multi";
  const agent = useAgentColor();
  const other = draft.other[question.id] ?? "";
  const otherOn = other.trim().length > 0;

  return (
    <View style={styles.question}>
      <Text style={styles.heading}>
        {number !== undefined ? `${number}. ` : ""}
        {question.question}
      </Text>
      {question.detail ? <Text style={styles.detail}>{question.detail}</Text> : null}
      {options.length > 0 && (
        <View style={styles.opts}>
          {options.map((option, index) => {
            const value = optionValue(option);
            const on = picks.includes(value);
            return (
              <Dissolve
                key={`${option.label}:${index}`}
                kind="row"
                delay={index * 40}
                // The pill straddles the top border, half above it: the extra
                // room keeps it clear of the option (or heading) above.
                style={option.recommended && styles.recommendedRoom}
              >
                <Pressable
                  accessibilityRole={multi ? "checkbox" : "radio"}
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={option.recommended ? `${option.label}, recommended` : option.label}
                  style={({ pressed }) => [
                    styles.option,
                    on && { borderStyle: "solid", borderColor: agent, backgroundColor: withAlpha(agent, 0.1) },
                    pressed && styles.optionPressed,
                  ]}
                  onPress={() => {
                    haptics.select();
                    onChange(pickOption(draft, question, value));
                  }}
                >
                  <Radio on={on} square={multi} color={agent} />
                  {/* Never truncated: an option the user can't read in full
                      is one they can't choose. */}
                  <View style={styles.optionMain}>
                    <Text style={styles.optionLabel}>{option.label}</Text>
                    {option.hint ? <Text style={styles.optionHint}>{option.hint}</Text> : null}
                  </View>
                  {option.recommended ? (
                    <View style={styles.badge} pointerEvents="none">
                      <Text style={styles.badgeText} numberOfLines={1}>Recommended</Text>
                    </View>
                  ) : null}
                </Pressable>
              </Dissolve>
            );
          })}
        </View>
      )}
      {allowsOther(question) && (
        <View style={[styles.option, otherOn && { borderStyle: "solid", borderColor: agent, backgroundColor: withAlpha(agent, 0.1) }]}>
        <Radio on={otherOn} square={multi} color={agent} />
        <TextInput
          style={styles.input}
          value={other}
          onChangeText={(text) => onChange(typeOther(draft, question, text))}
          placeholder="Your own answer…"
          placeholderTextColor={theme.color.placeholder}
          accessibilityLabel={`${question.question}, your own answer`}
          multiline
        />
        </View>
      )}
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
    </View>
  );
}

function Radio({ on, square, color }: { on: boolean; square: boolean; color: string }) {
  return (
    <View
      style={[
        styles.radio,
        square && styles.radioSquare,
        on && { borderColor: color, shadowColor: color, shadowOpacity: 0.8, shadowRadius: 6, shadowOffset: { width: 0, height: 0 } },
      ]}
    >
      {on ? (square ? <Ionicons name="checkmark" size={12} color={color} /> : <View style={[styles.radioDot, { backgroundColor: color }]} />) : null}
    </View>
  );
}

const BADGE_HEIGHT = 18;

const styles = StyleSheet.create({
  scroll: { maxHeight: 520 },
  body: { gap: theme.space(5), paddingBottom: theme.space(2) },
  question: { gap: theme.space(2) },
  heading: { color: theme.color.text, fontSize: theme.font.body, fontWeight: "600", paddingHorizontal: theme.space(1) },
  detail: { color: theme.color.textDim, fontSize: theme.font.small, paddingHorizontal: theme.space(1) },
  hint: { color: theme.color.textFaint, fontSize: theme.font.tiny, paddingHorizontal: theme.space(1) },
  opts: { gap: theme.space(2) },
  option: {
    ...dashedOutline,
    borderRadius: theme.radius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    minHeight: theme.size.touch,
    paddingVertical: theme.space(2.5),
    paddingHorizontal: theme.space(4),
  },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: theme.color.textDim, alignItems: "center", justifyContent: "center" },
  radioSquare: { borderRadius: 4 },
  radioDot: { width: 8, height: 8, borderRadius: 4 },
  optionPressed: { backgroundColor: theme.color.surfacePressed },
  optionMain: { flex: 1, gap: theme.space(0.5) },
  optionLabel: { color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body },
  optionHint: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 18 },
  // Sat on the option's top border, centred on the line, like a legend: an
  // opaque fill so the dashes stop either side of it.
  recommendedRoom: { marginTop: BADGE_HEIGHT / 2 + theme.space(1) },
  badge: {
    position: "absolute",
    top: -BADGE_HEIGHT / 2 - 1,
    right: theme.space(4),
    height: BADGE_HEIGHT,
    justifyContent: "center",
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.accent,
    backgroundColor: theme.color.accentSoft,
    paddingHorizontal: theme.space(2),
  },
  badgeText: { color: theme.color.accent, fontSize: theme.font.tiny, lineHeight: 14, fontWeight: "600" },
  input: { flex: 1, color: theme.color.text, fontSize: theme.font.body, padding: 0 },
  submit: { marginTop: theme.space(2) },
  pressed: { opacity: 0.7 },
});

export const AskUserSheet = memo(AskUserSheetView);
