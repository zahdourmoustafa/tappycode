/**
 * The empty state: Tappy, the greeting or the reason there is none, and the
 * agent's recent chats. Centred in what the keyboard leaves of the screen.
 */
import type { ComponentProps } from "react";
import { Keyboard, Pressable } from "react-native";
import Reanimated, { FadeIn } from "react-native-reanimated";
import { styles } from "../appStyles";
import type { Provider, useDaemon } from "../useDaemon";
import type { useKeyboardLift } from "./useKeyboardLift";
import { HomeGreeting } from "./HomeGreeting";

export function HomeView({
  daemon,
  keyboard,
  active,
  homeWaited,
  reduceMotion,
  homeStatus,
  openCarousel,
  tappySmiling,
  homeChats,
  openSession,
  greeting,
  emptyReason,
}: {
  daemon: ReturnType<typeof useDaemon>;
  keyboard: ReturnType<typeof useKeyboardLift>;
  active: Provider | undefined;
  homeWaited: boolean;
  reduceMotion: boolean;
  homeStatus: string;
  openCarousel: () => void;
  tappySmiling: boolean;
  homeChats: ComponentProps<typeof HomeGreeting>["chats"];
  openSession: (id: string) => void;
  greeting: string;
  emptyReason: (providerCount: number) => string;
}) {
  return (
          // Cancels half the pane's lift, so the greeting settles in the middle
          // of the shrunken screen instead of riding the composer all the way up.
          <Reanimated.View style={[styles.greetingLift, keyboard.centred]}>
            {/* Tapping the empty state dismisses the keyboard, which collapses
                the composer. Without this the greeting is inert and the only way
                out of the expanded state is the keyboard's own dismiss control. */}
            <Pressable
              style={styles.greeting}
              accessibilityRole="button"
              accessibilityLabel="Dismiss keyboard"
              onPress={Keyboard.dismiss}
            >
              {/* Not scaled as a whole any more: HomeGreeting dissolves its text
                  away and shrinks only Tappy while the keyboard is up.

                  Mounted only once an agent is known (from the machine or the
                  last-known list), and then all at once with a fade: before
                  that, Tappy burst in coral, with "Ready" and no greeting, then
                  recoloured and the greeting arrived beneath it a beat later.
                  A launch with no agent at all (a fresh pairing, a machine
                  with none turned on) still shows after a short wait. */}
              {(active || homeWaited) && (
              <Reanimated.View entering={reduceMotion ? undefined : FadeIn.duration(260)}>
                <HomeGreeting
                  typing={keyboard.progress}
                  providerId={active?.id}
                  color={active?.color}
                  busy={daemon.busy}
                  online={daemon.status === "online" && !daemon.unreachable}
                  failed={Boolean(daemon.fatal)}
                  status={homeStatus}
                  onPressTappy={active ? openCarousel : undefined}
                  smiling={tappySmiling}
                  chats={homeChats}
                  onOpenChat={openSession}
                  /* A refusal the daemon explained outranks the connecting
                    state: reconnecting cannot fix a rotated key or a version
                    mismatch, so "Connecting..." would loop forever while
                    telling the one person who can act nothing at all.

                    Then the quieter version of the same failure. A pairing the
                    machine rejects below the socket — 401 from the daemon, 409
                    from a relay room with no machine in it — sends no frame to
                    explain itself, so retrying continues in the background
                    while the words stop pretending it is nearly there.

                    Deliberately not a checklist. By far the commonest reason
                    this shows is that the phone has no signal, and the machine
                    is fine — so instructions to go and inspect it are wrong
                    advice most of the times they are read, and unfollowable
                    anyway from wherever the user is standing. What can be done
                    from here is keep typing, which the composer now says. */
                  text={daemon.fatal
                  ? daemon.fatal
                  : daemon.unreachable
                    ? "Can't reach your machine."
                    : daemon.status !== "online"
                      ? "Connecting to your machine..."
                      : active
                        ? greeting
                        : emptyReason(daemon.providers.length)}
                />
              </Reanimated.View>
              )}
            </Pressable>
          </Reanimated.View>
  );
}
