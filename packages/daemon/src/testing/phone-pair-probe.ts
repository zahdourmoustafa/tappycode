/**
 * Pair the way a phone does, against a daemon that is already running.
 *
 *   bun run packages/daemon/src/testing/phone-pair-probe.ts
 *
 * Reads the daemon's pairing (TAPPY_HOME), builds the same link `tappy pair`
 * prints, and runs the app's own `verifyPairing` over the relay — the exact
 * check the phone's "That code did not connect" comes from — plus a raw trace
 * of every frame the relay returns, with timings. Used by the Windows CI job to
 * reproduce pairing failures on a real Windows machine.
 */
import { SecureChannel, e2e, wire } from "@tappy/protocol";

import { parsePairing } from "../../../app/src/pairingLink.js";
import { verifyPairing } from "../../../app/src/verifyPairing.js";
import { loadPairing, pairingUrl } from "../pairing.js";

const deviceId = process.env.PROBE_DEVICE ?? "phone-ci-probe";
/** Also ask for this provider's chats, as the phone's drawer does. */
const askProvider = process.env.PROBE_PROVIDER;
let providerOk = !askProvider;
const pairing = await loadPairing();
if (!pairing.relay) throw new Error("this daemon has no relay; nothing to probe");
const link = pairingUrl({ token: pairing.token, key: pairing.key, port: 0, relay: pairing.relay });
const parsed = parsePairing(link, deviceId);
if (!parsed.ok) throw new Error(`link did not parse: ${parsed.error}`);

// Raw trace first, so a failure shows what did and did not arrive.
const started = Date.now();
const at = () => `${String(Date.now() - started).padStart(6)}ms`;
const channel = new SecureChannel(e2e.fromHex(parsed.pairing.key), "app");
const trace = await new Promise<string[]>((resolve) => {
  const lines: string[] = [];
  const socket = new WebSocket(parsed.pairing.url);
  const done = () => {
    try {
      socket.close();
    } catch {}
    resolve(lines);
  };
  const timer = setTimeout(() => {
    lines.push(`${at()} gave up after 30s`);
    done();
  }, 30_000);
  socket.onopen = () => {
    lines.push(`${at()} socket open`);
    socket.send(
      JSON.stringify({
        t: "hello",
        wire: wire.WIRE_VERSION,
        role: "app",
        deviceId,
        proof: channel.proof(deviceId),
      }),
    );
    lines.push(`${at()} hello sent`);
  };
  socket.onmessage = (event) => {
    let frame: { t?: string; code?: string; message?: string };
    try {
      frame = JSON.parse(String(event.data));
    } catch {
      lines.push(`${at()} non-JSON frame`);
      return;
    }
    if (frame.t === "e") {
      const opened = channel.open(frame) as { t?: string } | undefined;
      lines.push(`${at()} sealed frame: ${opened ? opened.t : "UNREADABLE (wrong key)"}`);
      if (opened?.t === "device.joined") {
        if (!askProvider) {
          clearTimeout(timer);
          done();
          return;
        }
        socket.send(JSON.stringify(channel.seal({ t: "provider.capabilities", providerId: askProvider })));
        lines.push(`${at()} asked ${askProvider} for its chats`);
        return;
      }
      if (opened?.t === "providers" && askProvider) {
        const list = (opened as unknown as { providers?: { id?: string }[] }).providers ?? [];
        const entry = list.find((p) => p.id === askProvider);
        lines.push(`${at()} announced ${askProvider}: ${entry ? JSON.stringify(entry).slice(0, 400) : "NOT ANNOUNCED"}`);
      }
      if (opened?.t === "provider.capabilities") {
        const caps = opened as unknown as { providerId?: string; sessions?: { title?: string | null }[]; projects?: unknown[] };
        if (caps.providerId === askProvider) {
          const count = caps.sessions?.length ?? 0;
          lines.push(
            `${at()} ${askProvider}: ${count} chats, ${caps.projects?.length ?? 0} projects` +
              (count ? ` (first: ${JSON.stringify(caps.sessions?.[0]?.title ?? null)})` : ""),
          );
          providerOk = count > 0;
          clearTimeout(timer);
          done();
        }
      }
      return;
    }
    lines.push(`${at()} cleartext ${frame.t}${frame.code ? ` ${frame.code}: ${frame.message}` : ""}`);
  };
  socket.onerror = () => lines.push(`${at()} socket error`);
  socket.onclose = (event) => {
    lines.push(`${at()} socket closed (code ${event.code})`);
    clearTimeout(timer);
    resolve(lines);
  };
});
for (const line of trace) console.log(line);

const t0 = Date.now();
const result = await verifyPairing(parsed.pairing);
console.log(`verifyPairing: ${JSON.stringify(result)} in ${Date.now() - t0}ms`);
if (askProvider && !providerOk) console.log(`FAIL: ${askProvider} returned no chats`);
process.exit(result.ok && providerOk ? 0 : 1);
