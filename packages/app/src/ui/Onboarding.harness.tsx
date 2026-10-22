/**
 * The first-launch screens, one at a time, with no daemon and no pairing.
 *
 * `EXPO_PUBLIC_HARNESS=Onboarding bun run harness`, then
 * `EXPO_PUBLIC_ONBOARDING_STEP` picks the screen: `install`, `scan`,
 * `notifications`, `try`, `try-found` or `try-offline` (default `install`). One screen per launch
 * rather than buttons to switch, so a screenshot is never of a screen caught
 * mid-transition. The data in `try` is a fixture: three agents and a terminal
 * that "arrives" after three seconds.
 */
import { useEffect, useState } from "react";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { useFonts } from "expo-font";
import { BitcountPropSingle_400Regular } from "@expo-google-fonts/bitcount-prop-single/400Regular";
import { BitcountPropSingle_600SemiBold } from "@expo-google-fonts/bitcount-prop-single/600SemiBold";
import { BitcountPropSingle_700Bold } from "@expo-google-fonts/bitcount-prop-single/700Bold";
import { theme } from "../theme";
import { SetupScreen } from "./SetupScreen";
import { PairingScreen } from "./PairingScreen";
import { NotificationsScreen } from "./NotificationsScreen";
import { TryItOverlay } from "./TryItOverlay";

const STEP = process.env.EXPO_PUBLIC_ONBOARDING_STEP ?? "install";

/** Fixture: what a Mac with all three agents reports. */
const PROVIDERS = [{ id: "claude-code" }, { id: "codex" }, { id: "ggcoder" }];
const FOUND = { id: "t1", agent: "claude", folder: "my-app" };

function TryFixture({ found, online }: { found: boolean; online: boolean }) {
  const [terminals, setTerminals] = useState(found ? [FOUND] : []);
  useEffect(() => {
    if (found || !online) return;
    const t = setTimeout(() => setTerminals([FOUND]), 20_000);
    return () => clearTimeout(t);
  }, [found, online]);
  return (
    <TryItOverlay
      online={online}
      providers={PROVIDERS}
      terminals={terminals}
      terminalsKnown={online}
      onDone={() => {}}
    />
  );
}

export default function OnboardingHarness() {
  const [loaded, error] = useFonts({
    BitcountPropSingle_400Regular,
    BitcountPropSingle_600SemiBold,
    BitcountPropSingle_700Bold,
  });
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => undefined);
  }, []);
  if (!loaded && !error) return <View style={{ flex: 1, backgroundColor: theme.color.bg }} />;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
          {STEP === "scan" ? (
            <PairingScreen onPaired={() => {}} onBack={() => {}} />
          ) : STEP === "notifications" ? (
            <NotificationsScreen onDone={() => {}} />
          ) : STEP === "try" ? (
            <TryFixture found={false} online />
          ) : STEP === "try-found" ? (
            <TryFixture found online />
          ) : STEP === "try-offline" ? (
            <TryFixture found={false} online={false} />
          ) : (
            <SetupScreen onScan={() => {}} onBack={() => {}} />
          )}
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
