/**
 * Model / thinking-level selector: Stage's "Dial" sheet.
 *
 * Everything here comes from the agent's own `configOptions`, so connecting a
 * new app brings its models and reasoning levels with it and tappy never carries
 * a hardcoded model list that would go stale.
 *
 * Models are a compact list capped at ~5 rows that scrolls inside the sheet
 * (agents like GG Coder carry dozens), with a filter field once it is long. A thinking level, when the agent
 * advertises one, is a dial (`ThinkingDial.tsx`): an LED arc lit up to the
 * chosen level with Tappy in the middle, the level shown as energy round him. An agent's plain list (opened
 * for "mode") is a simple Stage list.
 *
 * A `Sheet`, like every other picker, so it gets the Terminal header.
 * `anchorX`/`anchorY` are kept for App.tsx's call but no longer position it.
 */
import { memo, useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { StageScroll } from "./stage/StageScroll";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import type { ConfigOption } from "../useDaemon";
import { useReducedMotion } from "./useReducedMotion";
import { Sheet } from "./Sheet";
import { Led } from "./stage/Led";
import { Dissolve } from "./motion/Dissolve";
import { DashedRule, dashedOutline } from "./stage/DashedRule";
import { useAgentColor } from "./stage/agentColor";
import { ThinkingDial, levelMood } from "./ThinkingDial";
import { summarise, valueName } from "./configSlots";

// Slot assignment lives in a react-native-free module so it can be unit tested.
export { summarise, valueName } from "./configSlots";

interface ConfigPickerProps {
  visible: boolean;
  onClose: () => void;
  options: ConfigOption[];
  onSelect: (configId: string, value: string | boolean) => void;
  /** Kept for callers; the sheet rises from the bottom edge. */
  anchorX?: number;
  /** Kept for callers; the sheet rises from the bottom edge. */
  anchorY?: number;
}

/** Model list: fixed row height so the list can open scrolled to the pick. */
const ROW = 56;
const LIST_MAX = ROW * 5 + 20;
const FILTER_AFTER = 8;

/** How long a tapped level is shown before the agent's own answer must confirm it. */
const LEVEL_CONFIRM_MS = 4000;

function ConfigPickerView({ visible, onClose, options, onSelect }: ConfigPickerProps) {
  const agent = useAgentColor();
  const { model, mode, level: reported } = summarise(options);
  // The level moves the moment it is tapped. Waiting for the agent's answer
  // (phone → relay → computer → agent and back) made every step lag behind
  // the finger. The tap is shown until the agent reports that same value. An
  // answer for an earlier tap in a quick run does not pull the dial back to
  // it; and if the agent never confirms (it refused, or nothing came back),
  // the dial returns to what the agent says after a few seconds of quiet.
  const [tapped, setTapped] = useState<string>();
  const reportedValue = reported?.currentValue;
  useEffect(() => {
    if (tapped === undefined) return;
    if (reportedValue === tapped) {
      setTapped(undefined);
      return;
    }
    const timer = setTimeout(() => setTapped(undefined), LEVEL_CONFIRM_MS);
    return () => clearTimeout(timer);
  }, [tapped, reportedValue]);
  useEffect(() => {
    if (!visible) setTapped(undefined);
  }, [visible]);
  const level = reported && tapped !== undefined ? { ...reported, currentValue: tapped } : reported;
  const modeOnly = !model && !level && mode;
  const list = modeOnly ? mode : undefined;
  const chips = list ? undefined : model;
  const levelIndex = level?.options?.findIndex((v) => v.value === level.currentValue) ?? -1;
  const levelCount = level?.options?.length ?? 0;
  const fraction = levelCount > 1 ? Math.max(0, levelIndex) / (levelCount - 1) : 0;

  const title = list ? (list.name || "Mode") : (valueName(model) ?? "Model");
  const sub = list ? undefined : [model?.name, level ? `${valueName(level) ?? ""} thinking` : undefined].filter(Boolean).join(" · ");

  const pick = (option: ConfigOption, value: string) => {
    haptics.select();
    onSelect(option.id, value);
    onClose();
  };

  // The dial plays its own haptic, climbing with the level.
  const step = (index: number) => {
    const value = level?.options?.[index];
    if (!level || !value || index === levelIndex) return;
    setTapped(value.value);
    onSelect(level.id, value.value);
  };

  return (
    <Sheet
      visible={visible}
      label={list ? "Mode" : "Model"}
      title={title}
      onClose={onClose}
      dismissLabel="Close picker"
      tappyMood={level ? levelMood(fraction) : undefined}
      // Switching model mid-sentence is not leaving the draft.
      keepKeyboard
    >
      <View style={styles.body}>
        {!!sub && <Text style={styles.sub} numberOfLines={1}>{sub}</Text>}

        {!chips && !list && <Text style={styles.sub}>This agent offers no model options.</Text>}

        {chips && (
          <ModelList option={chips} color={agent} visible={visible} onPick={(value) => pick(chips, value)} />
        )}

        {level && levelCount > 0 && (
          <ThinkingDial
            names={level.options?.map((v) => v.name) ?? []}
            index={Math.max(0, levelIndex)}
            color={agent}
            paused={!visible}
            onStep={step}
          />
        )}

        {list && (
          <View>
            {list.options?.map((value, i) => {
              const selected = value.value === list.currentValue;
              return (
                <View key={value.value}>
                  {i > 0 && <DashedRule />}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={value.name}
                    accessibilityState={{ selected }}
                    onPress={() => pick(list, value.value)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  >
                    <Text style={styles.rowText} numberOfLines={1}>{value.name}</Text>
                    {selected && <Ionicons name="checkmark" size={18} color={agent} />}
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}
      </View>
    </Sheet>
  );
}

interface ModelListProps {
  option: ConfigOption;
  color: string;
  visible: boolean;
  onPick: (value: string) => void;
}

function ModelList({ option, color, visible, onPick }: ModelListProps) {
  const reduceMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  useEffect(() => {
    if (!visible) setQuery("");
  }, [visible]);
  const all = option.options ?? [];
  const needle = query.trim().toLowerCase();
  const shown = needle
    ? all.filter((v) => `${v.name} ${v.value} ${v.description ?? ""}`.toLowerCase().includes(needle))
    : all;
  const selectedIndex = all.findIndex((v) => v.value === option.currentValue);
  // Opens with the current model in view (second row, so there is context above).
  const initialY = Math.max(0, (selectedIndex - 1) * ROW);

  return (
    <View style={styles.modelWrap}>
      {all.length > FILTER_AFTER && (
        <View style={styles.filter}>
          <Led tone="agent" color={color}>/</Led>
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Filter models"
            placeholderTextColor={theme.color.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            clearButtonMode="while-editing"
            accessibilityLabel="Filter models"
            style={styles.filterInput}
          />
        </View>
      )}
      <StageScroll
        style={styles.modelList}
        contentOffset={{ x: 0, y: needle ? 0 : initialY }}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
      >
        {shown.length === 0 && <Text style={styles.sub}>No model matches.</Text>}
        {shown.map((value, i) => {
          const selected = value.value === option.currentValue;
          const row = (
            <View>
              {i > 0 && <DashedRule />}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={value.name}
                accessibilityState={{ selected }}
                onPress={() => onPick(value.value)}
                style={({ pressed }) => [styles.modelRow, pressed && styles.pressed]}
              >
                <View style={styles.modelText}>
                  <Text style={[styles.modelName, selected && { color }]} numberOfLines={1}>{value.name}</Text>
                  {!!value.description && (
                    <Text style={styles.modelDetail} numberOfLines={1}>{value.description}</Text>
                  )}
                </View>
                {selected && <Ionicons name="checkmark" size={18} color={color} />}
              </Pressable>
            </View>
          );
          return reduceMotion || i >= 6 ? (
            <View key={value.value}>{row}</View>
          ) : (
            <Dissolve key={value.value} kind="row" delay={i * 40}>{row}</Dissolve>
          );
        })}
      </StageScroll>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { gap: theme.space(4), paddingBottom: theme.space(2) },
  sub: { color: theme.color.textDim, fontSize: theme.font.small },
  modelWrap: { gap: theme.space(2) },
  filter: {
    ...dashedOutline,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    height: 40,
  },
  filterInput: { flex: 1, color: theme.color.text, fontSize: theme.font.small, paddingVertical: 0 },
  modelList: { maxHeight: LIST_MAX, flexGrow: 0 },
  modelRow: { flexDirection: "row", alignItems: "center", height: ROW - 1, gap: theme.space(3) },
  modelText: { flex: 1, minWidth: 0 },
  modelName: { color: theme.color.text, fontSize: theme.font.body, fontWeight: "600" },
  modelDetail: { color: theme.color.textDim, fontSize: theme.font.small },
  pressed: { opacity: 0.7 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: theme.size.touch,
  },
  rowText: { color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body },
});

// Memoized: a streamed chunk re-renders the screen many times a second, and
// none of those chunks change anything here.
export const ConfigPicker = memo(ConfigPickerView);
