/**
 * A thin HTTP client for the GG Coder desktop app's local API.
 *
 * Only the routes the bridge needs, each with the header pair the app checks:
 * `x-gg-token` (the per-launch secret) and, for per-conversation routes,
 * `x-gg-session` (which open window's conversation).
 */
import type { AppConnection } from "./discovery.js";

export interface AppWindow {
  sessionId: string;
  mode: string;
  cwd: string;
  sessionPath: string | null;
  busy: boolean;
  viewers: number;
}

export interface HistoryRow {
  role: "user" | "assistant";
  text: string;
}

export interface AppEvent {
  type: string;
  data: Record<string, unknown>;
}

export class AppClient {
  constructor(
    private readonly connection: AppConnection,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(sessionId?: string): Record<string, string> {
    return {
      "x-gg-token": this.connection.token,
      "content-type": "application/json",
      ...(sessionId ? { "x-gg-session": sessionId } : {}),
    };
  }

  private async json<T>(path: string, init: RequestInit = {}, sessionId?: string): Promise<T> {
    const response = await this.fetchImpl(`${this.connection.baseUrl}${path}`, {
      ...init,
      headers: { ...this.headers(sessionId), ...(init.headers as Record<string, string>) },
    });
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? text;
      } catch {
        // Not JSON; the raw body is the most useful thing to report.
      }
      throw new Error(`GG Coder app: ${message || `HTTP ${response.status}`}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** The conversations open in the app's windows; empty on an app without `/windows`. */
  async windows(): Promise<AppWindow[]> {
    const result = await this.json<{ windows?: AppWindow[] }>("/windows");
    return result.windows ?? [];
  }

  /** Open a conversation in the app's engine, as a new window would. */
  async createSession(cwd: string, sessionPath?: string): Promise<string> {
    const result = await this.json<{ sessionId: string }>("/session", {
      method: "POST",
      body: JSON.stringify({ cwd, mode: "code", ...(sessionPath ? { sessionPath } : {}) }),
    });
    return result.sessionId;
  }

  async history(sessionId: string): Promise<HistoryRow[]> {
    const result = await this.json<{ history?: unknown[] }>("/history", {}, sessionId);
    const rows: HistoryRow[] = [];
    for (const raw of result.history ?? []) {
      const row = raw as { role?: unknown; text?: unknown };
      if ((row.role === "user" || row.role === "assistant") && typeof row.text === "string") {
        if (row.text.length > 0) rows.push({ role: row.role, text: row.text });
      }
    }
    return rows;
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    await this.json(
      "/prompt",
      { method: "POST", body: JSON.stringify({ text, meta: { origin: "tappy" } }) },
      sessionId,
    );
  }

  async cancel(sessionId: string): Promise<void> {
    await this.json("/cancel", { method: "POST", body: "{}" }, sessionId);
  }

  async answer(sessionId: string, askId: string, result: unknown): Promise<void> {
    await this.json(
      `/ask/${encodeURIComponent(askId)}`,
      { method: "POST", body: JSON.stringify(result) },
      sessionId,
    );
  }

  /**
   * The conversation's live event stream. Every viewer gets every event, so
   * this runs beside the app's own window, never instead of it.
   */
  async *events(sessionId: string, signal: AbortSignal): AsyncGenerator<AppEvent> {
    const response = await this.fetchImpl(`${this.connection.baseUrl}/events`, {
      headers: this.headers(sessionId),
      signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`GG Coder app: event stream refused (HTTP ${response.status})`);
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\n\n");
        const data = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data) continue;
        try {
          const event = JSON.parse(data) as { type?: unknown; data?: unknown };
          if (typeof event.type === "string") {
            yield {
              type: event.type,
              data: (event.data && typeof event.data === "object" ? event.data : {}) as Record<
                string,
                unknown
              >,
            };
          }
        } catch {
          // A frame that is not JSON is not ours to interpret.
        }
      }
    }
  }
}
