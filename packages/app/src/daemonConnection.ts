/**
 * The socket behind `useDaemon`: connect, hello, reconnect with backoff, the
 * connect deadline, the outbox flush, and the teardown.
 *
 * This is the body of the hook's connection effect, unchanged; the effect
 * calls `openConnection` and returns its cleanup. Sealed frames go to
 * `handleSealedFrame` (`daemonFrame.ts`).
 */
import { SecureChannel, e2e, envelopeHeader, wire } from "@tappy/protocol";
import { createStreamBatch, foldStreamBatch } from "./streamBatch";
import { dropPendingSessions, isPendingSession } from "./pendingSession";
import { markSent, partitionOutbox, queuedPendingSessions } from "./outbox";
import { beginActivity } from "./activity";
import { CONNECT_TIMEOUT, STALLED_ATTEMPTS, WEBSOCKET_CONNECTING } from "./daemonState";
import type { DaemonRefs } from "./daemonContext";
import { handleSealedFrame, type FrameRefs } from "./daemonFrame";

const { WIRE_VERSION } = wire;

/** The hook's refs and setters the connection reads and writes. */
export type ConnectionRefs = FrameRefs &
  Pick<
    DaemonRefs,
    | "alive"
    | "attempts"
    | "awaitingResume"
    | "channel"
    | "clearImages"
    | "cursors"
    | "fatal"
    | "liveSessions"
    | "optionsRef"
    | "outbox"
    | "pendingProjectSessions"
    | "pendingStart"
    | "pushRegistered"
    | "resume"
    | "retry"
    | "sessionsRef"
    | "setState"
    | "socket"
    | "streamBoundary"
    | "streamGeneration"
  >;

/** Open the socket for one pairing. Returns the effect cleanup. */
export function openConnection(
  refs: ConnectionRefs,
  url: string,
  deviceId: string,
  pairingKey: string,
): () => void {
  const {
    alive,
    attempts,
    awaitingResume,
    channel,
    clearImages,
    cursors,
    fatal,
    liveSessions,
    optionsRef,
    outbox,
    pendingProjectSessions,
    pendingStart,
    pushRegistered,
    resume,
    retry,
    sessionsRef,
    setState,
    socket,
    streamBoundary,
    streamGeneration,
  } = refs;
  alive.current = true;
  const batch = createStreamBatch(
    (events) => {
      const generation = streamGeneration.current;
      setState((prev) => foldStreamBatch(prev, events, generation));
    },
    (callback, ms) => setTimeout(callback, ms),
    clearTimeout,
  );
  const resetStream = () => {
    batch.boundary();
    streamGeneration.current += 1;
    setState((prev) => prev.activeStream ? { ...prev, activeStream: undefined } : prev);
  };
  streamBoundary.current = resetStream;

  // A different pairing deserves a fresh attempt: this effect re-runs when the
  // url changes, which is exactly when someone has scanned a new code.
  fatal.current = false;
  // The attempt counter and the verdict it produced belong to the pairing that
  // failed. Carried into a newly scanned one, they would leave "Can't reach
  // your machine" sitting over a connection that is only just starting — and
  // one already past the threshold would show it before the first try.
  attempts.current = 0;
  setState((s) => (s.unreachable ? { ...s, unreachable: false } : s));

  const connect = () => {
    if (!alive.current) return;
    resetStream();
    setState((s) => ({ ...s, status: "connecting" }));

    const ws = new WebSocket(url);
    socket.current = ws;
    // A new socket has told nobody anything yet, and the daemon on the far
    // end may be a restarted process holding no tokens at all. Until it
    // accepts one, the local banner is the only route there is.
    pushRegistered.current = false;
    optionsRef.current.onPushRegistered?.(false);
    // Fresh per connection: the counters that make replay detectable are only
    // meaningful within one socket, so carrying them across a reconnect would
    // make the new connection's first frames look like replays.
    const secure = new SecureChannel(e2e.fromHex(pairingKey), "app");
    channel.current = secure;

    /**
     * Deliver everything typed while there was nowhere to send it.
     *
     * Called once the channel is proven — the first sealed frame back, not
     * merely an open socket — and again whenever a conversation gains the id
     * its waiting messages are addressed to. See `outbox.ts`.
     */
    const flushOutbox = () => {
      if (outbox.current.length === 0) return;
      // At most one conversation may be starting at a time: `pendingStart`
      // holds a single request id, and a second `session.start` sent beside
      // it could never be adopted — leaving a row that outlives its own
      // answer, and prompts addressed to a pending key nothing will rename.
      // The `session.started` that answers this one flushes the next.
      let starting = pendingStart.current !== undefined;
      const { ready, held } = partitionOutbox(outbox.current, (entry) => {
        if (entry.kind === "start") {
          if (starting) return false;
          starting = true;
          return true;
        }
        // A conversation with no id yet is early rather than undeliverable:
        // `session.started` re-addresses this entry the moment it is named.
        if (isPendingSession(entry.sessionId)) return false;
        // An undefined `activeSessions` is an older daemon saying nothing,
        // which `needsResume` reads as live.
        if (liveSessions.current === undefined || liveSessions.current.has(entry.sessionId))
          return true;
        // The session died with a previous daemon. Held only while reopening
        // the conversation can still re-address it — the resume carries the
        // agent's own id, which is what `session.started` remaps on. Without
        // one, nothing will ever rename this entry, so it goes and is refused
        // out loud rather than waiting in a queue nobody can see.
        const row = sessionsRef.current.find((entry2) => entry2.id === entry.sessionId);
        return !row?.agentSessionId;
      });
      if (ready.length === 0) return;
      outbox.current = held;

      // Which turns stop saying they are waiting. Collected here and applied
      // in one update below, rather than a state pass per message. The turns
      // are also what says which conversations start pulsing: a row is
      // working exactly when one of these bubbles is in it, which stays true
      // through the renaming `session.started` is about to do to it.
      const sent = new Set<string>();
      for (let i = 0; i < ready.length; i++) {
        const entry = ready[i]!;
        // The socket can die between two writes of the same batch. What is
        // left goes back to the front of the queue, ahead of what was held,
        // so the conversation keeps the order it was typed in.
        if (socket.current !== ws || ws.readyState !== WebSocket.OPEN) {
          outbox.current = [...ready.slice(i), ...outbox.current];
          break;
        }
        const message =
          entry.kind === "start"
            ? {
                t: "session.start",
                requestId: entry.requestId,
                providerId: entry.providerId,
                cwd: entry.cwd,
              }
            : {
                t: "session.prompt",
                sessionId: entry.sessionId,
                text: entry.text,
                attachments: entry.attachments,
              };
        ws.send(JSON.stringify(secure.seal(message, envelopeHeader(message))));
        if (entry.kind === "start") {
          // Reinstated here, not when the message was queued: `onopen` clears
          // it, and without this the answer would find no row to adopt and
          // prepend a second one beside the prompt already on screen.
          pendingStart.current = entry.requestId;
        }
        // A request alone marks nothing: the conversation is not working
        // until the message it was started for has actually gone, which is a
        // separate entry addressed to it.
        if (entry.kind === "prompt") sent.add(entry.turnKey);
      }
      if (sent.size === 0) return;

      const started = Date.now();
      setState((s) => {
        const turns = markSent(s.turns, sent);
        // A delivered bubble in the open transcript is what makes this the
        // conversation on screen — asked of the turns rather than of a session
        // id, because the row carrying them may still be a `pending:` request
        // that `session.started` renames a moment from now.
        const onScreen = turns !== s.turns;
        return {
          ...s,
          busy: onScreen ? true : s.busy,
          // The clock starts when the message actually leaves the phone. It
          // would be a lie about the agent otherwise — it measures how long
          // the answer took, not how long the tunnel lasted.
          activity: onScreen ? beginActivity(started) : s.activity,
          receipt: onScreen ? undefined : s.receipt,
          turns,
          sessions: s.sessions.map((session) => {
            const owned = markSent(session.turns, sent);
            if (owned === session.turns) return session;
            // Marked working here rather than on the first streamed chunk, for
            // the same reason `deliverPrompt` does: an agent can think for a
            // long time before it says anything.
            return { ...session, turns: owned, busy: true };
          }),
        };
      });
    };

    ws.onopen = () => {
      clearTimeout(deadline);
      attempts.current = 0;
      // A request written to the socket that died is never answered, and its
      // entry would hold the drawer in a skeleton forever. Dropping them here
      // also lets the open project be asked for again.
      pendingProjectSessions.current.clear();
      // Same reasoning for a `session.start` or `session.resume` written to
      // the socket that died: their answer is broadcast once and stored
      // nowhere, so waiting for it across a reconnect is waiting forever. See
      // `dropPendingSessions`.
      pendingStart.current = undefined;
      awaitingResume.current = false;
      setState((s) => ({
        ...s,
        status: "online",
        // Whatever it was, it is reachable now.
        unreachable: false,
        // Turns end while the phone is asleep and the socket is dead, and
        // `session.idle` is not replayed — only `session.event` is persisted.
        // So anything believed to be working across a drop is a guess, and
        // the pulsing dot would never stop. Clear it: a session still running
        // announces itself the moment it finishes, which is the signal that
        // matters.
        // Except the ones whose request never reached a socket at all: they
        // are still in the outbox, and this reconnect is what sends them.
        sessions: dropPendingSessions(
          s.sessions,
          queuedPendingSessions(outbox.current),
        ).map((session) => (session.busy ? { ...session, busy: false } : session)),
      }));
      // Cleartext, because it is what establishes the connection — and carries
      // a sealed proof beside it, so the daemon can tell a paired phone from
      // anyone who merely learned the relay room id.
      ws.send(
        JSON.stringify({
          t: "hello",
          wire: WIRE_VERSION,
          role: "app",
          deviceId,
          // "Everything after this, please." Empty on a first connection.
          cursors: cursors.current,
          proof: secure.proof(deviceId),
        }),
      );
    };

    ws.onmessage = (event) => {
      let frame: unknown;
      try {
        frame = JSON.parse(event.data as string);
      } catch {
        return;
      }

      // A cleartext frame from the daemon or the relay. Only two are acted on,
      // and neither carries user content: a version mismatch, and the refusal
      // that follows a proof the daemon would not accept. Both have to be
      // readable *before* anything can be decrypted, which is exactly why they
      // are the ones left in the open.
      const kind = (frame as { t?: unknown } | null)?.t;
      if (kind === "error") {
        const code = (frame as { code?: unknown }).code;
        // `device-refused` joins these: the pairing is already claimed by
        // another device, which is fatal in exactly the same way — retrying
        // cannot fix it, and the message names the rotation that can.
        //
        // But only when it is addressed to this device. The relay forwards
        // cleartext to every app in the room, so a refusal aimed at someone
        // else — an attacker probing with a leaked link — arrives here too.
        // Acting on it would let one frame from that attacker put the phone
        // that actually owns the pairing into a permanent, un-retried failure.
        const refusedDevice = (frame as { deviceId?: unknown }).deviceId;
        if (
          code === "device-refused" &&
          typeof refusedDevice === "string" &&
          refusedDevice !== deviceId
        ) {
          return;
        }
        if (code === "wire-version" || code === "unpaired" || code === "device-refused") {
          const detail = (frame as { message?: unknown }).message;
          resetStream();
          fatal.current = true;
          // Nothing will ever be fetched from that machine again, and these
          // are pictures of its filesystem. Forget them with the pairing.
          clearImages();
          setState((s) => ({
            ...s,
            status: "offline",
            fatal: typeof detail === "string" ? detail : "This device is no longer paired.",
          }));
        }
        return;
      }
      if (kind !== "e") return;

      handleSealedFrame(
          refs,
        { ws, secure, resetStream, batch, flushOutbox },
        frame,
      );
    };

    const scheduleReconnect = () => {
      // Only the current socket may drive reconnection. On Fast Refresh or a
      // url change, the previous socket's onclose fires after the new one is
      // already open; without this guard it would mark us offline and open a
      // duplicate connection that keeps dispatching state updates.
      if (!alive.current || socket.current !== ws) return;
      resetStream();
      // A refusal the daemon explained is not a blip. Retrying a rotated key
      // or a version mismatch every few seconds forever would never succeed,
      // would keep the radio awake, and would bury the explanation under a
      // status line that says the opposite.
      if (fatal.current) {
        setState((s) => ({ ...s, status: "offline" }));
        return;
      }
      // Past this many tries the socket is not coming up on its own schedule,
      // and calling it "connecting" is no longer true. Roughly fifteen seconds
      // of backoff: long enough to ride out a network switch or a daemon
      // restart, short enough that nobody is left reading a spinner.
      const stalled = attempts.current + 1 >= STALLED_ATTEMPTS;
      setState((s) =>
        s.status === "offline" && Boolean(s.unreachable) === stalled
          ? s
          : { ...s, status: "offline", unreachable: stalled },
      );
      // Exponential backoff, capped, so a sleeping laptop does not get hammered.
      const delay = Math.min(1000 * 2 ** attempts.current, 10_000);
      attempts.current += 1;
      retry.current = setTimeout(connect, delay);
    };

    // A socket that never finishes connecting, and never fails either.
    //
    // The handshake reaches out over whatever the phone last had, and a
    // network that changed underneath it — wifi to cellular, a captive
    // portal, a VPN coming up — leaves the TCP connection half open: nothing
    // is coming back, but nothing has been refused, so `onclose` and
    // `onerror` are never called and the backoff below never runs. iOS will
    // eventually time it out on its own schedule, which is measured in
    // minutes and looks exactly like the app having given up silently. This
    // is the deadline the platform does not give.
    //
    // Closing it is enough to start recovery: `onclose` follows, which is the
    // same path a refused connection takes, so the attempt counts towards the
    // backoff and towards `unreachable` like any other failure.
    const deadline = setTimeout(() => {
      if (socket.current !== ws || ws.readyState !== WEBSOCKET_CONNECTING) return;
      ws.close();
    }, CONNECT_TIMEOUT);

    ws.onclose = () => {
      clearTimeout(deadline);
      scheduleReconnect();
    };
    ws.onerror = () => {
      resetStream();
      ws.close();
    };
  };

  connect();

  // Published for `resumeNow` below, which cannot reach `connect` itself: the
  // socket and its backoff are scoped to this effect.
  resume.current = () => {
    if (!alive.current) return;
    // A refusal the daemon explained is still a refusal after a trip to the
    // home screen; retrying it here would defeat the whole point of `fatal`.
    if (fatal.current) return;
    const ws = socket.current;
    // A live socket needs nothing. `CONNECTING` is left alone too: an attempt
    // is already in flight, and replacing it would abandon a connection that
    // may be one frame from opening.
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    if (retry.current) {
      clearTimeout(retry.current);
      retry.current = null;
    }
    // Deliberately back to zero. The attempts behind us were made against a
    // backgrounded app, and carrying their count forward would both stretch
    // the next delay and let one more failure trip the "can't reach your
    // machine" threshold on what is, for the user, the first try.
    attempts.current = 0;
    // And the verdict those attempts produced goes with them. The UI checks
    // `unreachable` before `status`, so leaving it set would keep "Can't reach
    // your machine" on screen over a connection that is only just starting —
    // the pessimistic message this whole path exists to get rid of. Guarded so
    // a resume with nothing to correct does not re-render the tree.
    setState((s) => (s.unreachable ? { ...s, unreachable: false } : s));
    connect();
  };

  return () => {
    resetStream();
    batch.dispose();
    streamBoundary.current = undefined;
    alive.current = false;
    resume.current = undefined;
    if (retry.current) clearTimeout(retry.current);
    const ws = socket.current;
    socket.current = null;
    // Drop the handlers before closing so the outgoing socket cannot mutate
    // state or schedule a reconnect after teardown.
    channel.current = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
    }
  };
}
