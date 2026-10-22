/**
 * Android notifications sent through Firebase by the relay. A throwaway RSA key
 * stands in for the service-account key, so the signature is checked for real
 * rather than assumed; Google itself is a stub.
 */
import { expect, test } from "bun:test";
import { FcmSender, fcmMessage, readPushFrame, readServiceAccount, signedAssertion } from "./fcm.js";

const FCM = "dQw4w9WgXcQ:APA91bH-example_token-shape_0123456789abcdefghijklmnopqrstuvwxyz";
const push = { token: FCM, title: "my-app · Claude", body: "All green.", sessionId: "term:term_abc" };

async function testKey() {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const b64 = btoa(String.fromCharCode(...der)).replace(/(.{64})/g, "$1\n");
  const key = {
    project_id: "tappy-test",
    client_email: "push@tappy-test.iam.gserviceaccount.com",
    private_key: `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`,
  };
  return { key, publicKey: pair.publicKey };
}

const fromB64url = (part: string) =>
  Uint8Array.from(atob(part.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));

test("the assertion is signed with the key and asks only to send messages", async () => {
  const { key, publicKey } = await testKey();
  const jwt = await signedAssertion(key, 1_800_000_000);
  const [header, claims, signature] = jwt.split(".") as [string, string, string];
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    publicKey,
    fromB64url(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  expect(valid).toBe(true);
  expect(JSON.parse(new TextDecoder().decode(fromB64url(claims)))).toEqual({
    iss: key.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: 1_800_000_000,
    exp: 1_800_003_600,
  });
});

test("a message is laid out as Expo lays out its own, so the app shows it the same way", () => {
  expect(fcmMessage(push)).toEqual({
    message: {
      token: FCM,
      android: { priority: "HIGH" },
      data: {
        title: "my-app · Claude",
        message: "All green.",
        body: '{"sessionId":"term:term_abc"}',
        channelId: "agent-turns",
        categoryId: "agentTurn",
        sound: "default",
      },
    },
  });
});

test("one access token serves many notifications until it is close to expiring", async () => {
  const { key } = await testKey();
  let now = 1_800_000_000_000;
  const calls: string[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push(url);
    if (url.includes("oauth2")) {
      return Response.json({ access_token: "ya29.test", expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ya29.test");
    return Response.json({ name: "projects/tappy-test/messages/1" });
  }) as typeof fetch;
  const sender = new FcmSender(key, fetcher, () => now);
  expect(await sender.send({ t: "push", messages: [push] })).toBe(1);
  expect(await sender.send({ t: "push", messages: [push] })).toBe(1);
  expect(calls.filter((url) => url.includes("oauth2")).length).toBe(1);
  expect(calls.at(-1)).toBe("https://fcm.googleapis.com/v1/projects/tappy-test/messages:send");
  now += 56 * 60_000;
  await sender.send({ t: "push", messages: [push] });
  expect(calls.filter((url) => url.includes("oauth2")).length).toBe(2);
});

test("Google refusing or unreachable loses that notification and nothing else", async () => {
  const { key } = await testKey();
  const refused = new FcmSender(key, (async () => new Response("no", { status: 401 })) as unknown as typeof fetch);
  expect(await refused.send({ t: "push", messages: [push] })).toBe(0);
  const down = new FcmSender(key, (async () => {
    throw new Error("offline");
  }) as unknown as typeof fetch);
  expect(await down.send({ t: "push", messages: [push] })).toBe(0);
});

test("only a well-formed push frame is acted on", () => {
  expect(readPushFrame({ t: "push", messages: [push] })).toEqual({ t: "push", messages: [push] });
  expect(readPushFrame({ t: "push", messages: [] })).toBeUndefined();
  expect(readPushFrame({ t: "push", messages: Array(5).fill(push) })).toBeUndefined();
  expect(readPushFrame({ t: "push", messages: [{ ...push, token: "x" }] })).toBeUndefined();
  expect(readPushFrame({ t: "push", messages: [{ ...push, body: "x".repeat(1001) }] })).toBeUndefined();
  expect(readPushFrame({ t: "e", messages: [push] })).toBeUndefined();
  expect(readPushFrame("push")).toBeUndefined();
});

test("a missing or malformed key means no notifications, not an error", () => {
  expect(readServiceAccount(undefined)).toBeUndefined();
  expect(readServiceAccount("not json")).toBeUndefined();
  expect(readServiceAccount(JSON.stringify({ project_id: "p", client_email: "e" }))).toBeUndefined();
  expect(
    readServiceAccount(
      JSON.stringify({ type: "service_account", project_id: "p", client_email: "e", private_key: "-----BEGIN PRIVATE KEY-----x" }),
    ),
  ).toMatchObject({ project_id: "p" });
});
