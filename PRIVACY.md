# Privacy Policy

Last updated: 20 September 2026

tappy is an app for controlling coding agents that run on your own computer. This
policy covers the tappy iOS app and the tappy command line tool.

The short version: tappy has no accounts, advertising, or analytics. Conversation
traffic between the phone and your computer is encrypted end to end. Optional
push notifications take a separate path through Expo and Apple, which can read
their contents. The coding agents you choose have their own data practices.

## What the developer collects

tappy does not maintain a developer-operated database of users or conversations.
There is no account to create, analytics SDK, crash reporter, or advertising
identifier in the app. The transport and notification services described below
handle data needed to deliver the service.

If you enable notifications, your computer holds a push delivery address for
your phone in memory. The daemon does not write it to disk. It is cleared when
the daemon stops, and the app can register it again when reconnecting.

## Where your data lives

Your computer runs the agent and holds its conversation history, project files,
and agent credentials. The app receives conversation text and images to display
them, and holds session state and unsent messages in memory. It does not save a
persistent conversation archive on the phone.

The app stores pairing details, a device identifier, the last selected agent,
and cached agent information in the iOS Keychain. Keychain entries can survive
uninstalling the app. Use **Forget** in the app to remove its saved pairing and
cached agent list; this does not remove agent history on your computer or all
Keychain preferences. To invalidate an old pairing, rotate the pairing token on
your computer using `tappy pair --rotate`.

Images you attach, share, or save can create temporary files on your phone.
Images you choose to save to Photos remain there until you delete them. Data
shared with another app is subject to that app's handling. Agent history and
files on your computer remain under your control and the agent's own retention
settings.

## How the connection works

The app can connect directly to your computer or through a relay. A relay may
still be used on the same Wi-Fi, depending on the pairing address. Session
frames are encrypted end to end using XChaCha20-Poly1305, with a pairing key
held by your devices. The key is carried in the fragment of the pairing link,
which is not included in the connection request sent to the relay. Keep the
complete pairing link and QR code private: anyone with them can pair.

The relay cannot read encrypted session messages. It can observe connection IP
addresses, frame sizes and timing, device and session identifiers, message
counters, and a room identifier derived from the pairing token. The relay application does not persist messages
or conversation history. The hosted relay runs on Cloudflare; infrastructure
metadata handling is subject to Cloudflare's policies. You can also run your own
relay.

## Permissions the app asks for

- **Camera.** To scan the pairing code and take a photo to send to an agent.
- **Photos.** To attach an image or save one an agent sends you.
- **Microphone and speech recognition.** To dictate a message while holding the
  microphone button. On iOS, the app requires on-device recognition rather than
  sending audio to Apple for transcription. The resulting text is sent to your
  chosen agent when you send the message.
- **Notifications.** To alert you about agent activity. See below for the
  separate push-delivery path.

You can refuse these permissions and continue using the app's other features.

## Notifications

When remote notifications are enabled and registered, your computer sends
finished-turn notifications to Expo's push service, which passes them to Apple
Push Notification service (APNs). This happens even while the app is open;
the phone decides whether to show a banner. Local alerts can also be generated
from events received over the encrypted session connection.

Remote notification payloads are not end-to-end encrypted. Expo and Apple can
read the project or agent name, a short excerpt from the agent's final message,
a session identifier used to open the conversation, and the device's push
delivery address. The excerpt can contain private information from that
conversation. The full conversation is not sent as a push payload.

Expo states that notification contents are held in memory and queues only as
needed for delivery, not in databases, and may be visible to staff during
active debugging. Apple's delivery handling is subject to its own policies.

Turning notifications off in iOS stops banners, but does not immediately remove
a push address already registered with your computer. To stop the daemon from
sending further push payloads for that phone, disable notifications and restart
the daemon (`tappy service restart`). The app will not register a new push address while
notification permission is denied.

## Third parties

tappy has no analytics, advertising, or crash reporting SDKs. Delivery services
include [Expo](https://expo.dev/privacy), [Apple](https://www.apple.com/legal/privacy/),
and [Cloudflare](https://www.cloudflare.com/privacypolicy/), as described above.
Opening the privacy policy or support links contacts GitHub in your browser;
[GitHub's privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
applies to that visit. Do not post private conversations, credentials, or other
sensitive information in public issues.

The coding agents you connect to tappy are separate programs under their own
terms and privacy policies. They may send your prompts, code, or attachments to
their providers. tappy passes your messages to the agent you choose; it does not
make those providers' processing local-only.

## Children

tappy is a developer tool and is not directed at children.

## Changes

If this policy changes, the updated version will appear at this address and the
date at the top will change with it.

## Contact

Questions, or anything that looks wrong, at
<https://github.com/zahdourmoustafa/tappycode/issues>.
