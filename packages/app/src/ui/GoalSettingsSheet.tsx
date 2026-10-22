/**
 * A goal's settings: context folders, standing instructions, and the model its
 * workers (critters) run on → `goal.action` update / critterModel. The daemon
 * refuses an update mid-run; its error is shown.
 */
import { memo, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { StageScroll } from "./stage/StageScroll";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { StageButton } from "./stage/StageButton";
import { Sheet } from "./Sheet";
import { FolderPicker } from "./FolderPicker";
import { CHIP_LAYOUT, CONTEXT_MAX, ContextChips, Field, INSTRUCTIONS_MAX, INSTRUCTIONS_PLACEHOLDER, StageInput } from "./NewGoalSheet";
import { dashedOutline } from "./stage/DashedRule";
import { KEN_COLOR } from "../tappy/palette";
import { withAlpha } from "../motion";
import type { GoalResult, GoalState, GoalSummary } from "../ggState";
import type { ConfigOption, WorkspaceBrowse } from "../useDaemon";
import Reanimated from "react-native-reanimated";
import { useReducedMotion } from "./useReducedMotion";
import { AgentColorProvider } from "./stage/agentColor";

type Action = (
  goalId: string,
  action: "update" | "critterModel",
  extra: { context?: string[]; instructions?: string; model?: string | null },
) => string | undefined;

interface GoalSettingsSheetProps {
  visible: boolean;
  goal?: GoalSummary;
  state?: GoalState;
  onAction: Action;
  results: Record<string, GoalResult>;
  /** The ggcoder provider's `model` selector; absent until it has been probed. */
  modelOption?: ConfigOption;
  onClose: () => void;
  browse?: WorkspaceBrowse;
  onBrowse: (path?: string) => void;
  /** Connected to the computer (the folder picker retries when this turns true). */
  online?: boolean;
}

function GoalSettingsSheetView({ visible, goal, state, onAction, results, modelOption, onClose, browse, onBrowse, online }: GoalSettingsSheetProps) {
  const reduce = useReducedMotion();
  const [context, setContext] = useState<string[]>([]);
  const [instructions, setInstructions] = useState("");
  const [model, setModel] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!visible || !goal) return;
    setContext(goal.context.map((item) => item.path));
    setInstructions(goalInstructions(goal));
    setModel(state?.critterModel ?? "");
    setPending([]);
    setError(undefined);
    // Seed once per opening, not on every goal.state tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, goal?.id]);

  useEffect(() => {
    if (pending.length === 0) return;
    const answered = pending.map((id) => results[id]);
    if (answered.some((result) => result === undefined)) return;
    setPending([]);
    const failed = answered.find((result) => result && !result.ok);
    if (failed) setError(failed.error ?? "Couldn't save");
    else onClose();
  }, [pending, results, onClose]);

  const working = goal?.status === "running" && state?.paused !== true;
  const originalContext = goal ? goal.context.map((item) => item.path) : [];
  const contextChanged = context.join("\n") !== originalContext.join("\n");
  const instructionsChanged = goal ? instructions.trim() !== goalInstructions(goal).trim() : false;
  const nextModel = model || null;
  const modelChanged = nextModel !== (state?.critterModel ?? null);
  const dirty = contextChanged || instructionsChanged || modelChanged;
  const canSave = dirty && !working && pending.length === 0;

  const save = () => {
    if (!goal || !canSave) return;
    haptics.sent();
    setError(undefined);
    const ids: string[] = [];
    if (contextChanged || instructionsChanged) {
      const id = onAction(goal.id, "update", {
        context: contextChanged ? context : undefined,
        instructions: instructionsChanged ? instructions.trim() : undefined,
      });
      if (!id) return setError("Not connected to your computer");
      ids.push(id);
    }
    if (modelChanged) {
      const id = onAction(goal.id, "critterModel", { model: nextModel });
      if (!id) return setError("Not connected to your computer");
      ids.push(id);
    }
    setPending(ids);
  };

  const models = [
    { value: "", name: "Same as GG Goals" },
    ...(modelOption?.options ?? []),
    ...(model && !modelOption?.options?.some((o) => o.value === model) ? [{ value: model, name: model }] : []),
  ];

  return (
    // GG Goals' purple for everything lit here, the sheet's strip included.
    <AgentColorProvider value={KEN_COLOR}>
    <Sheet visible={visible} label="Goal settings" title={goal?.name ?? "Goal"} onClose={onClose}>
      <StageScroll style={styles.scroll} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {working ? <Text style={styles.locked} numberOfLines={1}>Pause the goal to change its settings</Text> : null}
        <Field label="Instructions">
          <StageInput
            style={styles.multi}
            value={instructions}
            onChangeText={setInstructions}
            maxLength={INSTRUCTIONS_MAX}
            placeholder={INSTRUCTIONS_PLACEHOLDER}
            multiline
            editable={!working}
          />
        </Field>
        <Field label="Context">
          <ContextChips chosen={context} onChange={setContext} disabled={working} />
          {visible && !working && (
            <Reanimated.View layout={reduce ? undefined : CHIP_LAYOUT}>
              <FolderPicker chosen={context} onChange={(next) => setContext(next.slice(0, CONTEXT_MAX))} browse={browse} onBrowse={onBrowse} online={online} allowFiles hideChosen />
            </Reanimated.View>
          )}
        </Field>
        <Field label="Workers model">
          <View style={styles.chips}>
            {models.map((option) => {
              const selected = option.value === model;
              return (
                <Pressable
                  key={option.value || "same"}
                  accessibilityRole="radio"
                  accessibilityState={{ selected, disabled: working }}
                  disabled={working}
                  style={[styles.option, selected ? styles.optionOn : dashedOutline, working && styles.off]}
                  onPress={() => {
                    haptics.select();
                    setModel(option.value);
                  }}
                >
                  <Text style={[styles.optionText, selected && styles.optionTextOn]} numberOfLines={1}>
                    {option.name}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </Field>
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {/* save() plays the haptic. */}
        <StageButton color={KEN_COLOR} disabled={!canSave} feel="none" label={pending.length > 0 ? "Saving…" : "Save"} onPress={save} />
      </StageScroll>
    </Sheet>
    </AgentColorProvider>
  );
}

/** Standing instructions from the goal; absent from an older GG Coder. */
function goalInstructions(goal: GoalSummary): string {
  return goal.instructions ?? "";
}

const styles = StyleSheet.create({
  scroll: { maxHeight: 560 },
  body: { gap: theme.space(5), paddingBottom: theme.space(2) },
  locked: { color: theme.color.attention, fontSize: theme.font.small },
  multi: { minHeight: 88, textAlignVertical: "top" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) },
  option: { paddingHorizontal: theme.space(3), paddingVertical: theme.space(2), borderRadius: theme.radius.pill, borderWidth: 1, borderColor: "transparent" },
  optionOn: { borderColor: KEN_COLOR, backgroundColor: withAlpha(KEN_COLOR, 0.1) },
  optionText: { color: theme.color.textDim, fontSize: theme.font.small },
  optionTextOn: { color: theme.color.text },
  off: { opacity: 0.5 },
  error: { color: theme.color.danger, fontSize: theme.font.small },
  pressed: { opacity: 0.7 },
});

export const GoalSettingsSheet = memo(GoalSettingsSheetView);
