/**
 * The tappy mark.
 *
 * Tappy, the same living mascot that stands for an agent everywhere else in
 * the app, in tappy's own coral rather than a provider colour, because at
 * launch no agent has been chosen yet.
 *
 * The wordmark is lowercase to match how the command is typed.
 */
import { StyleSheet, Text, View } from "react-native";
import { Tappy } from "../tappy/Tappy";
import { theme } from "../theme";

interface LogoProps {
  /** Visual size of the mark. The wordmark scales with it. */
  size?: number;
}

export function Logo({ size = 72 }: LogoProps) {
  return (
    <View
      style={styles.root}
      accessible
      accessibilityRole="image"
      accessibilityLabel="tappy"
    >
      {/* Tappy, tappy's own living mark, in its own coral. Its box has room
          for bounce and shadow around the globe, so it is drawn larger than
          the old orb's diameter to read at the same size. */}
      <Tappy size={Math.round(size * 1.7)} style={styles.mark} />
      <Text
        style={[
          styles.word,
          {
            fontSize: size * 0.5,
            letterSpacing: size * 0.02,
            // Bitcount's side bearings are asymmetric: the glyph run sits left
            // of its own text box, so centring the box leaves the wordmark
            // visibly off the orb above it. Measured at 4.3pt on a 72pt mark.
            //
            // A margin on a centred child shifts it by half its value, hence
            // double the correction. Expressed as a ratio because bearings
            // scale with font size.
            marginLeft: size * 0.12,
          },
        ]}
        // The mark is already labelled, so the text must not be read twice.
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        tappy
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: "center", gap: theme.space(2) },
  mark: { marginVertical: -theme.space(4) },
  word: {
    color: theme.color.text,
    // The wordmark is the purest expression of the display face, so it uses the
    // same family as every other title rather than a bespoke treatment.
    fontFamily: theme.display.semibold,
  },
});
