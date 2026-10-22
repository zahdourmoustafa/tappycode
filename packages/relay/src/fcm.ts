/**
 * Sending Android notifications through Firebase, for apps built without any
 * Expo account.
 *
 * The relay is the one piece of Tappy its operator controls, so it is the only
 * place the Firebase service-account key can live: a laptop program goes to
 * every user, and a key inside it is a key anyone can pull out and use to send
 * notifications to every phone with the app. The key is a Worker secret
 * (`wrangler secret put FCM_SERVICE_ACCOUNT`), never in the repository.
 *
 * Messages go as data, in the shape Expo's own push service uses — `title`,
 * `message`, `body` (the payload as JSON), `channelId`, `categoryId` — so the
 * app's notification library presents them exactly as it presents Expo pushes:
 * same channel, same reply box, same tap handling.
 */

/** What the daemon sends on its relay socket to have a notification delivered. */
export interface PushFrame {
  t: "push";
  messages: Array<{ token: string; title: string; body: string; sessionId: string }>;
}

/** The fields of a Google service-account key file this needs. */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}

/** The Android channel the app creates; restated, as the daemon restates it. */
const ANDROID_CHANNEL = "agent-turns";
/** The notification category that carries the reply box. */
const CATEGORY = "agentTurn";
/** Per frame: one per paired phone, and a pairing has one. */
const MAX_MESSAGES = 4;
const FCM_TOKEN = /^[A-Za-z0-9:_-]{20,4096}$/;

/** The frame, if it is a well-formed push; undefined for anything else. */
export function readPushFrame(value: unknown): PushFrame | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const frame = value as { t?: unknown; messages?: unknown };
  if (frame.t !== "push" || !Array.isArray(frame.messages)) return undefined;
  if (frame.messages.length === 0 || frame.messages.length > MAX_MESSAGES) return undefined;
  const messages: PushFrame["messages"] = [];
  for (const raw of frame.messages) {
    const m = raw as Record<string, unknown>;
    const ok =
      typeof m.token === "string" &&
      FCM_TOKEN.test(m.token) &&
      typeof m.title === "string" &&
      m.title.length <= 200 &&
      typeof m.body === "string" &&
      m.body.length <= 1000 &&
      typeof m.sessionId === "string" &&
      m.sessionId.length <= 200;
    if (!ok) return undefined;
    messages.push({
      token: m.token as string,
      title: m.title as string,
      body: m.body as string,
      sessionId: m.sessionId as string,
    });
  }
  return { t: "push", messages };
}

/** The key file, if the secret holds one. */
export function readServiceAccount(secret: string | undefined): ServiceAccount | undefined {
  if (!secret) return undefined;
  try {
    const key = JSON.parse(secret) as Partial<ServiceAccount>;
    if (typeof key.project_id !== "string" || typeof key.client_email !== "string") return undefined;
    if (typeof key.private_key !== "string" || !key.private_key.includes("PRIVATE KEY")) return undefined;
    return { project_id: key.project_id, client_email: key.client_email, private_key: key.private_key };
  } catch {
    return undefined;
  }
}

/** One message in Firebase's HTTP v1 shape, laid out the way Expo lays out its own. */
export function fcmMessage(push: PushFrame["messages"][number]) {
  return {
    message: {
      token: push.token,
      android: { priority: "HIGH" },
      data: {
        title: push.title,
        message: push.body,
        body: JSON.stringify({ sessionId: push.sessionId }),
        channelId: ANDROID_CHANNEL,
        categoryId: CATEGORY,
        sound: "default",
      },
    },
  };
}

function base64url(bytes: ArrayBuffer | Uint8Array | string): string {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  let text = "";
  for (const byte of data) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** The PEM private key as the bytes WebCrypto imports. */
function pkcs8(pem: string): Uint8Array {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const raw = atob(body);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** A signed assertion Google exchanges for an access token (RFC 7523). */
export async function signedAssertion(key: ServiceAccount, nowSeconds: number): Promise<string> {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: key.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSeconds,
      exp: nowSeconds + 3600,
    }),
  );
  const signingKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8(key.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    signingKey,
    new TextEncoder().encode(`${header}.${claims}`),
  );
  return `${header}.${claims}.${base64url(signature)}`;
}

/**
 * Sends to Firebase, keeping the access token between calls: one is good for
 * an hour, and asking Google for a new one per notification is a round trip
 * and a rate limit nobody needs.
 */
export class FcmSender {
  private token?: { value: string; until: number };

  constructor(
    private readonly key: ServiceAccount,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  private async accessToken(): Promise<string | undefined> {
    if (this.token && this.token.until > this.now()) return this.token.value;
    const assertion = await signedAssertion(this.key, Math.floor(this.now() / 1000));
    const response = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    });
    if (!response.ok) return undefined;
    const answer = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof answer.access_token !== "string") return undefined;
    const lifetime = typeof answer.expires_in === "number" ? answer.expires_in : 3600;
    // Renewed five minutes early, so a token never expires mid-send.
    this.token = { value: answer.access_token, until: this.now() + (lifetime - 300) * 1000 };
    return answer.access_token;
  }

  /** Deliver each message; resolves how many Firebase accepted. Never throws. */
  async send(frame: PushFrame): Promise<number> {
    let delivered = 0;
    try {
      const token = await this.accessToken();
      if (!token) return 0;
      for (const push of frame.messages) {
        const response = await this.fetcher(
          `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.key.project_id)}/messages:send`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(fcmMessage(push)),
          },
        );
        if (response.ok) delivered++;
        // A rejected token (the app was uninstalled) costs nothing to keep
        // trying: the phone sends a fresh one the next time it connects.
      }
    } catch {
      // Google unreachable: this notification is lost, nothing else is.
    }
    return delivered;
  }
}
