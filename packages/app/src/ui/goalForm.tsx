/**
 * The form pieces a goal is written with: field labels, the Stage text input,
 * the context chips and the length limits. Shared by the new-goal screen and
 * goal settings, so editing a goal looks and limits exactly like writing one.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View, type TextInputProps } from "react-native";
import Reanimated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  useReducedMotion,
  ZoomIn,
  ZoomOut,
} from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { Led } from "./stage/Led";
import { dashedOutline } from "./stage/DashedRule";
import { KEN_COLOR } from "../tappy/palette";
import { EASE_OUT } from "./motion/ease";
import { SPRING } from "../motion";
import type { PendingAttachment } from "../attachments";

export const NAME_MAX = 15;
export const GOAL_MAX = 2000;
export const CONTEXT_MAX = 20;
export const INSTRUCTIONS_MAX = 4000;
export const INSTRUCTIONS_PLACEHOLDER = "Keep the current design. Ask before adding dependencies.";

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <View style={styles.field}>
      <Led tone="dim">{label}</Led>
      {hint ? <Text style={styles.hint} numberOfLines={2}>{hint}</Text> : null}
      {children}
    </View>
  );
}

/** Text input on the surface with the composer border; focus lights it GG Goals purple. */
export function StageInput(props: TextInputProps) {
  const [focused, setFocused] = useState(false);
  return (
    <TextInput
      placeholderTextColor={theme.composer.placeholder}
      {...props}
      editable={props.editable}
      style={[styles.input, focused && styles.inputFocused, props.editable === false && styles.inputOff, props.style]}
      onFocus={(e) => {
        setFocused(true);
        props.onFocus?.(e);
      }}
      onBlur={(e) => {
        setFocused(false);
        props.onBlur?.(e);
      }}
    />
  );
}

/** Chosen context (folders and files) as dashed chips; tap × to remove. */
export function ContextChips({
  chosen,
  onChange,
  disabled,
  phoneFiles = [],
  onRemovePhoneFile,
}: {
  chosen: readonly string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  /** Files picked on this phone, shown in the same row (sent with the goal). */
  phoneFiles?: readonly PendingAttachment[];
  onRemovePhoneFile?: (id: string) => void;
}) {
  const reduce = useReducedMotion();
  if (chosen.length === 0 && phoneFiles.length === 0) return null;
  return (
    // Each chip springs in where it lands and shrinks away when removed; the
    // others slide to close the gap. The row's own height change is animated
    // by the caller's layout transition, so what's under it glides too.
    <Reanimated.View
      style={styles.chips}
      entering={reduce ? undefined : FadeIn.duration(180)}
      exiting={reduce ? undefined : FadeOut.duration(160)}
      layout={reduce ? undefined : CHIP_LAYOUT}
    >
      {chosen.map((path) => (
        <Reanimated.View
          key={path}
          style={[styles.chip, dashedOutline]}
          entering={reduce ? undefined : ZoomIn.duration(SPRING.arrive.duration).easing(EASE_OUT)}
          exiting={reduce ? undefined : ZoomOut.duration(160)}
          layout={reduce ? undefined : CHIP_LAYOUT}
        >
          <Text style={styles.chipText} numberOfLines={1}>{path.split("/").filter(Boolean).pop() ?? path}</Text>
          {disabled ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${path}`}
              hitSlop={10}
              onPress={() => {
                haptics.tap();
                onChange(chosen.filter((entry) => entry !== path));
              }}
            >
              <Ionicons name="close" size={13} color={theme.color.textDim} />
            </Pressable>
          )}
        </Reanimated.View>
      ))}
      {phoneFiles.map((file) => (
        <Reanimated.View
          key={file.id}
          style={[styles.chip, dashedOutline]}
          entering={reduce ? undefined : ZoomIn.duration(SPRING.arrive.duration).easing(EASE_OUT)}
          exiting={reduce ? undefined : ZoomOut.duration(160)}
          layout={reduce ? undefined : CHIP_LAYOUT}
        >
          <Ionicons name="phone-portrait-outline" size={12} color={theme.color.textDim} />
          <Text style={styles.chipText} numberOfLines={1}>{file.name}</Text>
          {disabled || !onRemovePhoneFile ? null : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${file.name}`}
              hitSlop={10}
              onPress={() => {
                haptics.tap();
                onRemovePhoneFile(file.id);
              }}
            >
              <Ionicons name="close" size={13} color={theme.color.textDim} />
            </Pressable>
          )}
        </Reanimated.View>
      ))}
    </Reanimated.View>
  );
}

/** One spring for everything that moves to make room (chips, the list below). */
export const CHIP_LAYOUT = LinearTransition.duration(SPRING.settle.duration).easing(EASE_OUT);

const styles = StyleSheet.create({
  field: { gap: theme.space(2) },
  hint: { color: theme.color.textDim, fontSize: theme.font.small },
  input: {
    minHeight: theme.size.touch,
    borderRadius: theme.composer.radius,
    borderWidth: 1,
    borderColor: theme.composer.border,
    backgroundColor: theme.composer.fill,
    color: theme.color.text,
    fontSize: theme.font.body,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2.5),
  },
  inputFocused: { borderColor: KEN_COLOR },
  inputOff: { opacity: 0.5 },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) },
  chip: { flexDirection: "row", alignItems: "center", gap: theme.space(1.5), maxWidth: "100%", paddingHorizontal: theme.space(3), paddingVertical: theme.space(1.5), borderRadius: theme.radius.pill },
  chipText: { flexShrink: 1, color: theme.color.text, fontSize: theme.font.small },
});
