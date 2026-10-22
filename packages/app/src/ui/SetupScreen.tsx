/**
 * Step one for a new person: put tappy on the computer.
 *
 * One command does the whole computer side — installs, starts it in the
 * background, hooks up the terminal and ends on the QR code — so this screen is
 * only that command, for the kind of computer they have. Typing a long command
 * off a phone screen is where people give up, so it can be sent to the
 * computer instead: share sheet to AirDrop, mail, a chat with yourself.
 */
import { useState } from "react";
import { ScrollView, Share, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Clipboard from "expo-clipboard";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { writeToClipboard } from "./clipboard";
import { CircleButton } from "./controls";
import { Glass } from "./Glass";
import { Led } from "./stage/Led";
import { PressScale } from "./stage/PressScale";
import { StageButton } from "./stage/StageButton";
import { DotGrid } from "./stage/DotGrid";
import { tappyInk } from "../tappy/palette";
import {
  type ComputerKind,
  installCommand,
  PAIR_AGAIN_COMMAND,
  shareText,
  terminalName,
} from "../onboarding";

/** tappy's own coral: nobody has picked an agent yet. */
const TAPPY_CORAL = tappyInk();

const KINDS: { kind: ComputerKind; label: string }[] = [
  { kind: "mac", label: "Mac" },
  { kind: "windows", label: "Windows" },
  { kind: "linux", label: "Linux" },
];

interface Props {
  /** The computer shows its code: go and scan it. */
  onScan: () => void;
  onBack: () => void;
}

export function SetupScreen({ onScan, onBack }: Props) {
  const insets = useSafeAreaInsets();
  const [kind, setKind] = useState<ComputerKind>("mac");
  const [copied, setCopied] = useState(false);
  const command = installCommand(kind);

  const copy = async () => {
    const ok = await writeToClipboard(command, Clipboard.setStringAsync);
    if (ok) {
      haptics.finished();
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } else {
      haptics.failed();
    }
  };

  const send = () => {
    // Dismissing the sheet is not a failure, and a share that throws (no
    // targets) leaves copy right there as the fallback, so neither is reported.
    void Share.share({ message: shareText(kind) }).catch(() => {});
  };

  return (
    <View style={styles.root}>
      <DotGrid />
      <View style={[styles.nav, { paddingTop: insets.top + theme.headerInset }]}>
        <CircleButton label="Back" size={theme.size.touch} onPress={onBack}>
          <Ionicons name="chevron-back" size={24} color={theme.color.text} />
        </CircleButton>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + theme.space(8) }]}
      >
        <Led color={TAPPY_CORAL}>Step 1 of 2</Led>
        <Text style={styles.title} accessibilityRole="header">
          Set up your computer
        </Text>
        <Text style={styles.body}>
          The computer where you use Claude Code, Codex or GG Coder. Which kind is it?
        </Text>

        <View style={styles.kinds} accessibilityRole="radiogroup">
          {KINDS.map((item) => {
            const selected = item.kind === kind;
            return (
              <PressScale
                key={item.kind}
                feel="select"
                onPress={() => {
                  setKind(item.kind);
                  setCopied(false);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={item.label}
                style={[styles.kind, selected && { borderColor: TAPPY_CORAL }]}
              >
                <Text style={[styles.kindText, selected && { color: theme.color.text }]}>
                  {item.label}
                </Text>
              </PressScale>
            );
          })}
        </View>

        <Text style={styles.body}>
          Open <Text style={styles.strong}>{terminalName(kind)}</Text> on it and paste this. It
          installs Tappy, starts it, and shows a QR code.
        </Text>

        <Glass radius={theme.radius.md} tier="control" style={styles.commandBox}>
          <Text
            style={styles.command}
            selectable
            accessibilityLabel={`Install command: ${command}`}
          >
            {command}
          </Text>
          <PressScale
            feel="none"
            onPress={() => void copy()}
            accessibilityLabel={copied ? "Copied" : "Copy the command"}
            style={styles.copy}
            hitSlop={8}
          >
            <Ionicons
              name={copied ? "checkmark" : "copy-outline"}
              size={18}
              color={copied ? theme.color.success : theme.color.textDim}
            />
            <Text style={[styles.copyText, copied && { color: theme.color.success }]}>
              {copied ? "Copied" : "Copy"}
            </Text>
          </PressScale>
        </Glass>

        <StageButton
          color={TAPPY_CORAL}
          label="Send it to my computer"
          icon={<Ionicons name="share-outline" size={18} color={TAPPY_CORAL} />}
          onPress={send}
          accessibilityHint="Opens the share sheet, so you can AirDrop, mail or message the command to yourself"
          style={styles.gap}
        />
        <StageButton
          kind="secondary"
          label="I see the QR code"
          icon={<Ionicons name="qr-code-outline" size={18} color={theme.color.text} />}
          onPress={onScan}
          style={styles.gapSmall}
        />

        <Text style={styles.footnote}>
          Already installed it? Run <Text style={styles.inline}>{PAIR_AGAIN_COMMAND}</Text> for a
          new code.
        </Text>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  nav: { minHeight: theme.size.touch, justifyContent: "center", paddingLeft: theme.gutter },
  scroll: { flex: 1 },
  content: { paddingHorizontal: theme.gutter, paddingTop: theme.space(6) },
  title: {
    color: theme.color.text,
    fontFamily: theme.display.regular,
    fontSize: 28,
    letterSpacing: 0.5,
    marginTop: theme.space(2),
    marginBottom: theme.space(3),
  },
  body: { color: theme.color.textDim, fontSize: 15, lineHeight: 22, marginBottom: theme.space(4) },
  strong: { color: theme.color.text, fontWeight: "600" },
  kinds: { flexDirection: "row", gap: theme.space(2), marginBottom: theme.space(6) },
  kind: {
    flex: 1,
    minHeight: theme.size.touch,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.pill,
    borderWidth: 1,
    borderColor: theme.color.border,
  },
  kindText: { color: theme.color.textDim, fontSize: 15, fontWeight: "600" },
  commandBox: { padding: theme.space(4), gap: theme.space(3) },
  command: { color: theme.color.text, fontFamily: "Menlo", fontSize: 13, lineHeight: 20 },
  copy: {
    alignSelf: "flex-end",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    minHeight: 36,
    paddingHorizontal: theme.space(2),
  },
  copyText: { color: theme.color.textDim, fontSize: 14, fontWeight: "600" },
  gap: { marginTop: theme.space(6) },
  gapSmall: { marginTop: theme.space(3) },
  footnote: {
    color: theme.color.textFaint,
    fontSize: 13,
    lineHeight: 19,
    marginTop: theme.space(6),
  },
  inline: { color: theme.color.textDim, fontFamily: "Menlo", fontSize: 12 },
});
