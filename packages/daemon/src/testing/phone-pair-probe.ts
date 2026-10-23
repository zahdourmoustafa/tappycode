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
/**
 * Also check what the composer gets: the model/thinking pickers and the `/`
 * list, before a chat (the capability reply) and inside one (a started chat).
 * Set to the project folder to start the chat in.
 */
const controlsCwd = process.env.PROBE_CONTROLS_CWD;
let controlsOk = !controlsCwd;
let startedId: string | undefined;
const sessionCommands = new Set<string>();
const describeConfig = (raw: unknown) => {
  const list = Array.isArray(raw)
    ? (raw as { id?: string; currentValue?: unknown; options?: unknown[] }[])
    : [];
  return list.length
    ? list
        .map((o) => `${o.id}=${String(o.currentValue)} (${o.options?.length ?? 0} choices)`)
        .join(", ")
    : "NONE";
};
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
    } catch {
      // Already closed.
    }
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
        socket.send(
          JSON.stringify(channel.seal({ t: "provider.capabilities", providerId: askProvider })),
        );
        lines.push(`${at()} asked ${askProvider} for its chats`);
        return;
      }
      if (opened?.t === "providers" && askProvider) {
        const list = (opened as unknown as { providers?: { id?: string }[] }).providers ?? [];
        const entry = list.find((p) => p.id === askProvider);
        lines.push(
          `${at()} announced ${askProvider}: ${entry ? JSON.stringify(entry).slice(0, 400) : "NOT ANNOUNCED"}`,
        );
      }
      if (opened?.t === "provider.capabilities") {
        const caps = opened as unknown as {
          providerId?: string;
          sessions?: { title?: string | null }[];
          projects?: unknown[];
        };
        if (caps.providerId === askProvider) {
          const count = caps.sessions?.length ?? 0;
          lines.push(
            `${at()} ${askProvider}: ${count} chats, ${caps.projects?.length ?? 0} projects` +
              (count ? ` (first: ${JSON.stringify(caps.sessions?.[0]?.title ?? null)})` : ""),
          );
          providerOk = count > 0;
          const raw = opened as unknown as { configOptions?: unknown; commands?: unknown[] };
          lines.push(
            `${at()} ${askProvider} pickers before a chat: ${describeConfig(raw.configOptions)}`,
          );
          lines.push(`${at()} ${askProvider} commands before a chat: ${raw.commands?.length ?? 0}`);
          if (controlsCwd) {
            socket.send(
              JSON.stringify(
                channel.seal({
                  t: "session.start",
                  requestId: "probe-1",
                  providerId: askProvider,
                  cwd: controlsCwd,
                }),
              ),
            );
            lines.push(`${at()} started a chat in ${controlsCwd}`);
            return;
          }
          clearTimeout(timer);
          done();
        }
      }
      if (controlsCwd && opened?.t === "session.started") {
        const st = opened as unknown as {
          sessionId?: string;
          requestId?: string;
          configOptions?: unknown;
        };
        if (st.requestId === "probe-1") {
          startedId = st.sessionId;
          lines.push(`${at()} chat started; its pickers: ${describeConfig(st.configOptions)}`);
          controlsOk = describeConfig(st.configOptions) !== "NONE";
          // Commands arrive as a session event a moment later.
          setTimeout(() => {
            lines.push(
              `${at()} chat commands: ${sessionCommands.size} (${[...sessionCommands].slice(0, 8).join(", ")})`,
            );
            if (sessionCommands.size === 0) controlsOk = false;
            clearTimeout(timer);
            done();
          }, 6000);
        }
      }
      if (controlsCwd && opened?.t === "session.event") {
        const ev = opened as unknown as {
          sessionId?: string;
          payload?: {
            update?: { sessionUpdate?: string; availableCommands?: { name?: string }[] };
          };
        };
        const update = ev.payload?.update;
        if (ev.sessionId === startedId && update?.sessionUpdate === "available_commands_update") {
          for (const c of update.availableCommands ?? []) if (c.name) sessionCommands.add(c.name);
        }
      }
      return;
    }
    lines.push(
      `${at()} cleartext ${frame.t}${frame.code ? ` ${frame.code}: ${frame.message}` : ""}`,
    );
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
if (!controlsOk) console.log(`FAIL: ${askProvider} chat had no pickers or no commands`);
process.exit(result.ok && providerOk && controlsOk ? 0 : 1);
