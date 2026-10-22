#!/usr/bin/env bun
/**
 * A test-only ACP agent that speaks GG Coder's `_gg/*` extensions.
 *
 * Not a shipped provider: tests point a `ggcoder` LoadedProvider at this file.
 * It advertises `agentCapabilities._meta.gg` (unless `TAPPY_TEST_GG_OLD=1`,
 * which plays an older ggcoder) and implements just enough of the contract to
 * exercise the daemon: a mid-run queue, ask_user, and a goals store kept in
 * memory with folders under `TAPPY_TEST_GOALS_ROOT`.
 *
 * Prompt words that drive it:
 *  - `steer`: runs ~300ms, folding queued messages in at every beat (`drained`).
 *  - `hold`: runs ~300ms, never steers; leftovers come back with `turnEnded`.
 *  - `ask`: asks one question over `_gg/ask_user` and says what it heard.
 * Every turn ends by saying `heard: <prompt text>` so tests can see what ran.
 */
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";

const old = process.env.TAPPY_TEST_GG_OLD === "1";
const goalsRoot = process.env.TAPPY_TEST_GOALS_ROOT ?? join(tmpdir(), "tappy-test-goals");

interface Goal {
  id: string;
  name: string;
  goal: string;
  context: { kind: "folder"; path: string }[];
  path: string;
  createdAt: string;
  lastActiveMs: number;
  status: "briefing" | "paused" | "idle";
  kickedOff: boolean;
  paused: boolean;
  critterModel: string | null;
}
// On disk, because the daemon talks to goals through one process and opens a
// goal's session in another — exactly as real ggcoder shares `~/.gg/goals`.
const storeFile = join(goalsRoot, "goals.json");
function load(): Map<string, Goal> {
  try {
    return new Map((JSON.parse(readFileSync(storeFile, "utf8")) as Goal[]).map((g) => [g.id, g]));
  } catch {
    return new Map();
  }
}
function save(goals: Map<string, Goal>) {
  mkdirSync(goalsRoot, { recursive: true });
  writeFileSync(storeFile, JSON.stringify([...goals.values()]));
}
/** Read-modify-write one goal. */
function withGoal(id: string | undefined, change: (goal: Goal) => void) {
  const goals = load();
  const goal = goals.get(id ?? "");
  if (!goal) return;
  change(goal);
  save(goals);
}
let sessionCounter = 0;
let queueCounter = 0;
const sessionGoal = new Map<string, string>();
const queues = new Map<string, { id: string; text: string }[]>();
const running = new Set<string>();
const cancelled = new Set<string>();

const summary = (goal: Goal) => ({
  id: goal.id,
  name: goal.name,
  goal: goal.goal,
  context: goal.context,
  path: goal.path,
  createdAt: goal.createdAt,
  lastActiveMs: goal.lastActiveMs,
  // Exactly as real ggcoder sends it: a goal whose coordinator has never run
  // has no conversation yet, and ggcoder says so with null rather than
  // leaving the field out. tappy once rejected every new goal over this.
  agentSessionId: null,
  status: goal.paused ? "paused" : goal.status,
});

function openSession(sessionId: string, cwd: string) {
  const goal = [...load().values()].find((g) => g.path === cwd);
  if (!goal) return {};
  sessionGoal.set(sessionId, goal.id);
  return {
    _meta: {
      gg: {
        goal: { id: goal.id, phase: "briefing", paused: goal.paused, needsKickoff: !goal.kickedOff },
      },
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const invalid = (message: string) => Object.assign(new Error(message), { code: -32602 });

const app = agent({ name: "tappy-gg-test" })
  .onRequest("initialize", async () => ({
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { list: {}, resume: {} },
      ...(old ? {} : { _meta: { gg: { queue: 1, askUser: 1, goals: 1, planReview: 1, autopilot: 1, checklist: 1 } } }),
    },
    agentInfo: { name: "tappy-gg-test", version: "0.0.0" },
    authMethods: [],
  }))
  .onRequest("session/new", async (ctx) => {
    const sessionId = `gg_${++sessionCounter}`;
    return { sessionId, ...openSession(sessionId, ctx.params?.cwd ?? "") };
  })
  .onRequest("session/list", async () => ({
    // With GG_AGENT_DIR set: one goal-folder session and one normal session.
    sessions: process.env.GG_AGENT_DIR
      ? [
          { sessionId: "goal_1", cwd: `${process.env.GG_AGENT_DIR}/goals/ship-it`, title: "coordinator" },
          { sessionId: "plain_1", cwd: process.env.GG_AGENT_DIR, title: "plain" },
        ]
      : [],
  }))
  .onRequest("session/resume", async (ctx) => openSession(ctx.params.sessionId, ctx.params.cwd))
  .onRequest("session/load", async (ctx) => openSession(ctx.params.sessionId, ctx.params.cwd))
  .onNotification("session/cancel", async (ctx) => {
    const sessionId = ctx.params?.sessionId as string;
    cancelled.add(sessionId);
    const returned = queues.get(sessionId)?.splice(0) ?? [];
    if (returned.length > 0) {
      await ctx.client.notify("_gg/queue_update", { sessionId, queued: [], returned });
    }
  })
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId, prompt, _meta } = ctx.params as {
      sessionId: string;
      prompt: { type: string; text?: string }[];
      _meta?: { gg?: { goalTurn?: string; planDecision?: { action: string; generation: number; feedback?: string } } };
    };
    const say = (text: string) =>
      ctx.client.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
      });
    cancelled.delete(sessionId);
    const decision = _meta?.gg?.planDecision;
    if (decision) {
      if (decision.generation !== 1) throw invalid("Stale plan generation.");
      await ctx.client.notify("_gg/plan_state", { sessionId, planMode: false, pending: null });
      if (decision.action === "accept") {
        await ctx.client.notify("_gg/session_reset", { sessionId, agentSessionId: `${sessionId}_impl`, planTotal: 3 });
      }
      await say(`decided: ${decision.action}`);
      return { stopReason: "end_turn" };
    }
    const goalTurn = _meta?.gg?.goalTurn;
    if (goalTurn) {
      withGoal(sessionGoal.get(sessionId), (goal) => {
        if (goalTurn === "kickoff") goal.kickedOff = true;
        goal.paused = false;
      });
      const goal = load().get(sessionGoal.get(sessionId) ?? "");
      if (goal) {
        await ctx.client.notify("_gg/goal_state", {
          sessionId,
          goalId: goal.id,
          phase: "active",
          paused: false,
          critterModel: goal.critterModel,
          workers: [{ id: "w1", name: "scout the repo", agent: "scout", state: "running" }],
        });
      }
      await say(`goalTurn: ${goalTurn}`);
      return { stopReason: "end_turn" };
    }
    const text = prompt.map((block) => block.text ?? "").join(" ").trim();
    running.add(sessionId);
    queues.set(sessionId, []);
    try {
      if (text.includes("steer") || text.includes("hold")) {
        for (let beat = 0; beat < 10; beat++) {
          await sleep(30);
          if (cancelled.has(sessionId)) return { stopReason: "cancelled" };
          const queue = queues.get(sessionId) ?? [];
          if (text.includes("steer") && queue.length > 0) {
            const drained = queue.splice(0);
            await ctx.client.notify("_gg/queue_update", { sessionId, queued: [], drained });
            for (const item of drained) await say(`steered: ${item.text} `);
          }
        }
      }
      if (text.includes("plan")) {
        await ctx.client.notify("_gg/plan_state", {
          sessionId,
          planMode: true,
          pending: { planPath: "/tmp/plan.md", content: "# Plan", generation: 1 },
        });
      }
      if (text.includes("ken")) {
        await ctx.client.notify("_gg/autopilot_event", { sessionId, phase: "review_start", round: 1 });
        await ctx.client.notify("_gg/autopilot_event", { sessionId, phase: "human", reason: "pick a db" });
        await ctx.client.notify("_gg/checklist_changed", { sessionId });
      }
      if (text.includes("ask")) {
        const answer = await ctx.client.request("_gg/ask_user", {
          sessionId,
          questions: [{ id: "color", question: "Which colour?", kind: "choice", options: [{ label: "Red" }] }],
        });
        await say(`answer: ${JSON.stringify(answer)} `);
      }
      await say(`heard: ${text}`);
      return { stopReason: "end_turn" };
    } finally {
      running.delete(sessionId);
      const left = queues.get(sessionId)?.splice(0) ?? [];
      if (left.length > 0) {
        await ctx.client.notify("_gg/queue_update", {
          sessionId,
          queued: [],
          returned: left,
          turnEnded: true,
        });
      }
    }
  })
  .onRequest("_gg/autopilot/set", (p: unknown) => p, async (ctx) => {
    const { sessionId, enabled } = ctx.params as { sessionId: string; enabled: boolean };
    await ctx.client.notify("_gg/autopilot_state", { sessionId, enabled, reviewing: false });
    return { enabled };
  })
  .onRequest("_gg/checklist", (p: unknown) => p, async () => ({
    staleAfterDays: 30,
    detectionWarnings: [],
    items: [
      {
        id: "tests", group: "Foundations", title: "Tests", description: "Has tests",
        status: "passed", checkedAt: null, result: "pass", summary: null, findings: [],
        evidence: [], changedSinceCheck: false, detection: null, runPrompt: "check tests",
      },
    ],
  }))
  .onRequest("_gg/queue", (p: unknown) => p, async (ctx) => {
    const { sessionId, text } = ctx.params as { sessionId: string; text: string };
    if (!running.has(sessionId)) throw invalid("No turn is running.");
    const id = `agent_${++queueCounter}`;
    const queue = queues.get(sessionId) ?? [];
    queue.push({ id, text });
    return { id, queued: queue };
  })
  .onRequest("_gg/queue/cancel", (p: unknown) => p, async (ctx) => {
    const { sessionId, id } = ctx.params as { sessionId: string; id: string };
    const queue = queues.get(sessionId) ?? [];
    const index = queue.findIndex((item) => item.id === id);
    if (index >= 0) queue.splice(index, 1);
    return { cancelled: index >= 0, queued: queue };
  })
  .onRequest("_gg/goals/list", (p: unknown) => p, async () => ({
    goals: [...load().values()].map(summary),
  }))
  .onRequest("_gg/goals/create", (p: unknown) => p, async (ctx) => {
    const { name, goal, context } = ctx.params as { name: string; goal: string; context: string[] };
    if (!name.trim()) throw invalid("A goal needs a name.");
    const goals = load();
    const id = `goal_${goals.size + 1}`;
    const path = join(goalsRoot, id);
    mkdirSync(path, { recursive: true });
    const created: Goal = {
      id,
      name,
      goal,
      context: context.map((folder) => ({ kind: "folder" as const, path: folder })),
      path,
      createdAt: "2026-10-13T00:00:00.000Z",
      lastActiveMs: 0,
      status: "briefing",
      kickedOff: false,
      paused: false,
      critterModel: null,
    };
    goals.set(id, created);
    save(goals);
    return { goal: summary(created) };
  })
  .onRequest("_gg/goals/delete", (p: unknown) => p, async (ctx) => {
    const goals = load();
    goals.delete((ctx.params as { id: string }).id);
    save(goals);
    return { ok: true };
  })
  .onRequest("_gg/goal/pause", (p: unknown) => p, async (ctx) => {
    const { sessionId } = ctx.params as { sessionId: string };
    withGoal(sessionGoal.get(sessionId), (goal) => {
      goal.paused = true;
    });
    return { paused: true };
  })
  .onRequest("_gg/goal/critter_model", (p: unknown) => p, async (ctx) => {
    const { sessionId, model } = ctx.params as { sessionId: string; model: string | null };
    withGoal(sessionGoal.get(sessionId), (goal) => {
      goal.critterModel = model;
    });
    return { critterModel: model };
  });

app.connect(
  ndJsonStream(
    Writable.toWeb(process.stdout) as unknown as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>,
  ),
);
