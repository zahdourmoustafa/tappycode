/**
 * The privacy policy, reachable from inside the app.
 *
 * App Review asks for this in two places, not one: the URL in App Store Connect
 * metadata, and a link within the app itself. Only the metadata half existed, and
 * a missing in-app link is a routine 5.1.1 rejection — days of round trip for a
 * text button.
 *
 * It is rendered on the pairing screen as well as in the drawer because the
 * drawer is behind a pairing. A reviewer with no computer running the daemon
 * never gets past the first screen, so a link that lives only in the drawer is,
 * from where the review sits, not in the app at all.
 *
 * Opens in the in-app browser for the same reason message links do: leaving for
 * Safari backgrounds the app, which drops the socket and strands any permission
 * request waiting on an answer.
 */
import { Alert, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";
import * as WebBrowser from "expo-web-browser";
import { theme } from "../theme";
import { touchSlop } from "./controls";
import { haptics } from "./haptics";

/**
 * Where the policy is published. The same URL as `privacyPolicyUrl` in
 * `store.config.json`, restated because the app bundle cannot read that file —
 * they have to be changed together, and a drift means the store and the app
 * disagree about what the app does.
 */
const PRIVACY_URL = "https://github.com/zahdourmoustafa/tappycode/blob/main/PRIVACY.md";

/** The rendered height of one line of this label, which the slop grows to 44. */
const LINE = 19;

export function PrivacyLink({ style }: { style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel="Privacy policy"
      hitSlop={touchSlop(LINE)}
      onPress={() => {
        haptics.tap();
        void WebBrowser.openBrowserAsync(PRIVACY_URL, {
          toolbarColor: theme.color.surface,
          controlsColor: theme.color.accent,
        }).catch(() => {
          Alert.alert(
            "Could not open privacy policy",
            "Please try again. You can also find the privacy policy on tappy's App Store page.",
          );
        });
      }}
      style={({ pressed }) => [style, pressed && styles.pressed]}
    >
      <Text style={styles.text}>Privacy policy</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  text: {
    color: theme.color.textFaint,
    fontSize: 13,
    lineHeight: LINE,
    textDecorationLine: "underline",
  },
  pressed: { opacity: 0.6 },
});
