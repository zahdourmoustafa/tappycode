import { expect, test } from "bun:test";

import { runningDaemon } from "./daemon-health.js";

const answer = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("reports the version a running daemon answers with", async () => {
  expect(await runningDaemon(1, answer({ ok: true, version: "0.9.29" }))).toEqual({ version: "0.9.29" });
});

test("an older daemon without a version is still a running daemon", async () => {
  expect(await runningDaemon(1, answer({ ok: true }))).toEqual({ version: undefined });
});

test("nothing listening, or something that is not tappy, is no daemon", async () => {
  const refused = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  expect(await runningDaemon(1, refused)).toBeUndefined();
  expect(await runningDaemon(1, answer({ hello: "world" }))).toBeUndefined();
  expect(await runningDaemon(1, answer({ ok: true }, 500))).toBeUndefined();
});
