/**
 * tappy — mobile remote for coding agents.
 *
 * One screen. The provider list, the greeting and the conversation are states
 * of the same surface rather than separate pages, so the composer never moves
 * and a prompt can be typed before an agent is even chosen.
 *
 * The approval sheet is the reason this app exists, so it is a blocking,
 * unmissable surface rather than an inline row that can scroll away.
 */
import { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { theme } from "./src/theme";
import { Tappy } from "./src/TappyScreen";
import { ErrorBoundary } from "./src/ui/ErrorBoundary";
import { PairingScreen } from "./src/ui/PairingScreen";
import { LaunchScreen } from "./src/ui/LaunchScreen";
import { SetupScreen } from "./src/ui/SetupScreen";
import { NotificationsScreen } from "./src/ui/NotificationsScreen";
import { notificationPermissionState } from "./src/ui/notifier";
import { afterPairing, type OnboardingStep } from "./src/onboarding";
import { clearPairing, loadPairing, savePairing, type Pairing } from "./src/pairing";
import { clearCachedProviders } from "./src/preferences";
import * as SplashScreen from "expo-splash-screen";
import { clearCrash, readCrash } from "./src/crashLog";
import * as Clipboard from "expo-clipboard";
// `useFonts` from expo-font rather than the one the google-fonts package ships.
// They look identical, but that one always starts at `false` and waits for an
// effect, while this one seeds its state from `isLoaded` synchronously — so a
// face already registered from an earlier mount is reported ready on the first
// render instead of costing another frame.
import { useFonts } from "expo-font";
// The faces themselves come from their own subpaths rather than the package
// root. The root barrel re-exports all nine weights, and because each one
// `require`s its own .ttf, importing three through it bundled 3MB of font — six
// faces the app never asks for. Deep imports bring in only what is named here.
import { BitcountPropSingle_400Regular } from "@expo-google-fonts/bitcount-prop-single/400Regular";
import { BitcountPropSingle_600SemiBold } from "@expo-google-fonts/bitcount-prop-single/600SemiBold";
import { BitcountPropSingle_700Bold } from "@expo-google-fonts/bitcount-prop-single/700Bold";

export default function App() {
  const [fontsLoaded, fontError] = useFonts({
    BitcountPropSingle_400Regular,
    BitcountPropSingle_600SemiBold,
    BitcountPropSingle_700Bold,
  });

  // An error counts as settled. The faces load from the app bundle rather than
  // the network, so this is quick, but the display font is not worth never
  // opening the app over and the fallback is only a metrics difference. Without
  // this a failed load holds the tree forever behind a splash that never lifts.
  const fontsSettled = fontsLoaded || fontError != null;

  // What killed the app last time, if anything did.
  //
  // A crash outside a render has no boundary to catch it: the process ends, the
  // app relaunches looking perfectly healthy, and the only account anyone can
  // give is "it closed itself". The record is written on the way down and read
  // here, on the way back up — on this device only, because a stack trace from
  // this app routinely contains prompts and file paths.
  useEffect(() => {
    const crash = readCrash();
    if (!crash) return;
    clearCrash();
    const detail = `${crash.at}\n${crash.message}${crash.stack ? `\n\n${crash.stack}` : ""}`;
    Alert.alert(
      "tappy closed unexpectedly",
      `${crash.message}\n\nThis was not sent anywhere. Copy it if you want to report it.`,
      [
        { text: "Copy details", onPress: () => void Clipboard.setStringAsync(detail) },
        { text: "Dismiss", style: "cancel" },
      ],
    );
  }, []);

  // Hold on the canvas colour rather than rendering with the fallback face:
  // the two have different metrics, so titles would visibly reflow the moment
  // the display font arrives. The native splash is still up over this, so what
  // the user sees is the splash rather than an empty rectangle.
  if (!fontsSettled) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: theme.color.bg }} />
      </SafeAreaProvider>
    );
  }

  return (
    // Outermost, so it catches a throw from anything below including the
    // providers themselves. Without it React unmounts the whole tree and the
    // app becomes a blank rectangle — no message, and nothing a tester on a
    // TestFlight build can put in a report.
    <ErrorBoundary>
      {/* Required for any gesture in the app to be recognised at all: it is the
          native touch target every GestureDetector attaches under, and without
          it a sheet's drag-to-dismiss silently does nothing. Inside the
          boundary, like every other provider, so a throw from it still reaches
          a screen with a message on it. */}
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* Every keyboard-driven element in this app moves on the keyboard's own
            frame-by-frame position rather than a JS animation started alongside
            it. Coordinating two animation systems made the thread land twice. */}
        <KeyboardProvider>
          <SafeAreaProvider>
            <Root />
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </ErrorBoundary>
  );
}

/**
 * Pairing gate.
 *
 * The daemon's address is a secret held in the keychain, so it is not known
 * until an async read completes. Rendering the conversation before then would
 * open a socket to nowhere, so this holds a neutral screen for the frame it
 * takes, and shows the pairing screen when nothing is stored.
 */
function Root() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [checked, setChecked] = useState(false);
  // Where first launch has got to. Not persisted: it only exists between
  // opening the app and finishing setup, and a stored pairing skips it all —
  // except that a pairing made just now carries on to the last two steps.
  const [step, setStep] = useState<OnboardingStep>("welcome");

  useEffect(() => {
    let alive = true;
    void loadPairing()
      .catch(() => {
        // The same reasoning `pair` uses below, which already guards the write
        // side: a locked or unavailable keychain has to read as "not paired",
        // not as a rejection. Without this the promise rejects, `setChecked`
        // never runs, and the app sits on its loading screen with no way out.
        return null;
      })
      .then((stored) => {
        if (!alive) return;
        setPairing(stored);
        setChecked(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Lift the splash only once there is a real screen behind it.
  //
  // This is the first moment the app knows which screen it is: the conversation
  // for a paired device, the launch screen otherwise. `index.ts` holds the
  // splash from launch, and every path that sets `checked` — including the
  // keychain failures above, which resolve to "not paired" rather than
  // rejecting — arrives here, so there is no route that leaves it up.
  //
  // One frame later, not immediately: `hideAsync` takes effect straight away,
  // and calling it during the commit that renders the first screen can uncover
  // the window before that screen has been drawn into it — a flash of empty
  // canvas, which is the exact thing the splash is being held to prevent.
  useEffect(() => {
    if (!checked) return;
    const frame = requestAnimationFrame(() => {
      void SplashScreen.hideAsync().catch(() => {});
    });
    return () => cancelAnimationFrame(frame);
  }, [checked]);

  const pair = useCallback((next: Pairing) => {
    // Connect regardless of whether the keychain accepted it. A locked or
    // unavailable keychain costs the user a re-pair next launch; blocking on it
    // would strand them on this screen with a spinner and no way forward.
    void Promise.all([savePairing(next).catch(() => {}), notificationPermissionState()]).then(
      ([, permission]) => {
        setStep(afterPairing(permission));
        setPairing(next);
      },
    );
  }, []);

  const unpair = useCallback(() => {
    // Same reasoning inverted: forget it locally even if the delete failed, or
    // the confirmed "Forget" action would appear to do nothing.
    //
    // The remembered agent list goes with it. It describes one specific machine,
    // so keeping it would offer the next computer agents it may not have — and
    // "Forget this computer" ought to mean it.
    void Promise.all([clearPairing(), clearCachedProviders()])
      .catch(() => {})
      .then(() => {
        setPairing(null);
        // Back to the launch screen rather than straight to the form, so
        // disconnecting lands somewhere deliberate.
        setStep("welcome");
      });
  }, []);

  if (!checked) return <View style={{ flex: 1, backgroundColor: theme.color.bg }} />;
  // A paired device never sees the launch screen: it has a machine already, and
  // an extra tap on every cold start would be pure friction.
  if (pairing) {
    if (step === "notifications") {
      return <NotificationsScreen onDone={() => setStep("try")} />;
    }
    return (
      <Tappy
        pairing={pairing}
        onUnpair={unpair}
        firstRun={step === "try"}
        onFirstRunDone={() => setStep("welcome")}
      />
    );
  }
  if (step === "install") {
    return <SetupScreen onScan={() => setStep("scan")} onBack={() => setStep("welcome")} />;
  }
  if (step === "scan") return <PairingScreen onPaired={pair} onBack={() => setStep("install")} />;
  return <LaunchScreen onConnect={() => setStep("install")} />;
}
