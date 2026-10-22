/**
 * The build label shown on screen, so a tester can tell at a glance which APK
 * is installed. Bump BUILD with every APK handed out; it is the number to ask
 * for when someone reports a problem.
 *
 * Expo-free on purpose (see CLAUDE.md: pure modules stay testable).
 */
export const APP_VERSION = "1.0.1";
export const APP_BUILD = 2;
export const APP_VERSION_LABEL = `tappy code v${APP_VERSION} (build ${APP_BUILD})`;
