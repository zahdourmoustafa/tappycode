/** Neutral provider controls retain the same native Glass press response. */
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { agentChipColors } from "../agentChipColors";
import { Glass } from "./Glass";
import { Tappy } from "../tappy/Tappy";
import { haptics } from "./haptics";
import type { Provider } from "../useDaemon";

interface AgentChipProps {
  provider: Provider;
  selected: boolean;
  onPress: (providerId: string) => void;
}
function AgentChipView({ provider, selected, onPress }: AgentChipProps) {
  const enabled = provider.available;
  const colors = agentChipColors(provider.color, selected, enabled, theme.color);
  return <Glass radius={theme.radius.pill} interactive={enabled} style={styles.chip}>
    <Pressable
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={enabled ? provider.name : `${provider.name}, unavailable. ${provider.unavailableReason ?? ""}`}
      accessibilityState={{ selected, disabled: !enabled }}
      onPress={() => { haptics.select(); onPress(provider.id); }}
      style={[styles.body, { backgroundColor: colors.background }]}
    >
      {/* Each agent's own Tappy, in its brand colour. Picking an agent wakes it;
          the others doze and breathe, and an unavailable one lies still. */}
      <View style={!enabled && styles.unavailable}>
        <Tappy size={28} style={styles.tappy} color={provider.color} mood={selected ? "idle" : "sleepy"} paused={!enabled} />
      </View>
      <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>{provider.name}</Text>
    </Pressable>
  </Glass>;
}
const styles = StyleSheet.create({
  chip: { borderRadius: theme.radius.pill, overflow: "hidden" },
  body: { flexDirection: "row", alignItems: "center", justifyContent: "center", minHeight: theme.size.touch, paddingHorizontal: theme.space(4), paddingVertical: theme.space(1), gap: theme.space(2) },
  unavailable: { opacity: 0.4 },
  // The globe fills the middle of its box; the rest is room to bounce.
  tappy: { margin: -theme.space(1) },
  label: { fontSize: theme.font.small, fontWeight: "700", lineHeight: theme.font.small + 4, maxWidth: 160 },
});
export const AgentChip = memo(AgentChipView, (before, after) =>
  before.selected === after.selected &&
  before.provider.id === after.provider.id &&
  before.provider.name === after.provider.name &&
  before.provider.color === after.provider.color &&
  before.provider.available === after.provider.available &&
  before.provider.unavailableReason === after.provider.unavailableReason &&
  before.onPress === after.onPress,
);
