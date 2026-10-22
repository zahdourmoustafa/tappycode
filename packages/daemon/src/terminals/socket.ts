/**
 * The local socket `tappy wrap` processes connect to.
 *
 * One connection per wrapped agent. The wrapper sends a single `register` line
 * naming its agent and project; from then on the daemon only ever writes to it
 * (`input` lines carrying the phone's keystrokes) and the connection closing is
 * the signal that the agent has gone.
 *
 * Lives in `~/.tappy`, which is forced to 0700 and the socket to 0600: only the
 * user who runs the daemon can reach it. Anything already running as that user
 * owns everything this protects, so that is the boundary that matters. On
 * Windows it is a named pipe whose name is a secret kept in that folder (see
 * `terminalSocketPath`); a pipe's default security already refuses other
 * accounts the write access registering needs.
 */
import { chmod, mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  RegisterLine,
  StatusLine,
  isPipePath,
  parseLine,
  takeLines,
  terminalSocketPath,
} from "./link.js";
import type { TerminalRegistry } from "./registry.js";

export interface TerminalSocket {
  path: string;
  stop(): Promise<void>;
}

/**
 * One wrapper's connection. `node:net` rather than `Bun.listen`, because it is
 * the one that also serves a Windows named pipe — the same code then runs on
 * every platform and is tested on each.
 */
function serve(socket: Socket, registry: TerminalRegistry): void {
  const decoder = new TextDecoder();
  let buffer = "";
  /** Set once registered; a second `register` after that is a protocol violation. */
  let id: string | undefined;
  let closed = false;

  const sendLine = (message: unknown): boolean => {
    if (closed || socket.destroyed) return false;
    // Node queues what the kernel does not take yet and writes it on drain.
    socket.write(`${JSON.stringify(message)}\n`);
    return true;
  };
  const cut = () => {
    closed = true;
    socket.end();
  };

  socket.on("data", (chunk: Buffer) => {
    if (closed) return;
    const taken = takeLines(buffer, decoder.decode(chunk, { stream: true }));
    if (!taken) {
      cut();
      return;
    }
    buffer = taken.rest;
    for (const line of taken.lines) {
      if (id !== undefined) {
        // After registering, a wrapper only ever reports what its agent's
        // screen shows. Anything else is not a wrapper.
        const status = parseLine(StatusLine, line);
        if (!status) {
          cut();
          return;
        }
        if (status.mode) registry.setMode(id, status.mode);
        if (status.prompt !== undefined) registry.setPrompt(id, status.prompt ?? undefined);
        if (status.question !== undefined) registry.setQuestion(id, status.question ?? undefined);
        // Activity before the turn: a new run's first report carries both,
        // and the turn is judged against whether it is running.
        if (status.activity) registry.reportActivity(id, status.activity);
        if (status.live) registry.reportLive(id, status.live);
        continue;
      }
      const register = parseLine(RegisterLine, line);
      if (!register) {
        // Anything but one well-formed `register` line first is not a wrapper.
        cut();
        return;
      }
      id = registry.register({
        agent: register.agent,
        cwd: register.cwd,
        pid: register.pid,
        app: register.app,
        since: register.since,
        deliver: (data) => sendLine({ t: "input", data }),
      });
      sendLine({ t: "registered", id });
    }
  });
  const gone = () => {
    closed = true;
    if (id) registry.remove(id);
    id = undefined;
  };
  socket.on("close", gone);
  // Always followed by `close`; handled so a peer resetting is not an
  // unhandled error that takes the daemon down.
  socket.on("error", () => {});
}

export async function startTerminalSocket(
  registry: TerminalRegistry,
  path: string = terminalSocketPath(),
): Promise<TerminalSocket> {
  const pipe = isPipePath(path);
  if (!pipe) {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // `mkdir` leaves an existing directory's mode alone, and `~/.tappy` predates
    // this socket on every machine that has paired before.
    await chmod(dir, 0o700);
    // A socket file left by a daemon that was killed refuses the bind otherwise.
    // A pipe has no such leftover: Windows removes it with its last handle.
    await rm(path, { force: true });
  }

  const open = new Set<Socket>();
  const server = createServer((socket) => {
    open.add(socket);
    socket.on("close", () => open.delete(socket));
    serve(socket, registry);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  // Errors after listening are per-connection and handled there.
  server.on("error", () => {});
  if (!pipe) await chmod(path, 0o600);

  return {
    path,
    async stop() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // `close` waits for every connection; the wrappers' go with the daemon.
        for (const socket of open) socket.destroy();
      });
      if (!pipe) await rm(path, { force: true });
    },
  };
}
