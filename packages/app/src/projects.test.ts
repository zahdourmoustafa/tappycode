import { describe, expect, test } from "bun:test";
import {
  projectTabItems,
  projectLabel,
  projectsForProvider,
  projectSourceKey,
  sessionsInProject,
} from "./projects";
import type { Session } from "./useDaemon";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    providerId: "claude-code",
    title: "A conversation",
    startedAt: 0,
    turns: [],
    configOptions: [],
    ...partial,
  };
}

test("the daemon's list is used as announced, newest project first", () => {
  const projects = projectsForProvider(
    [
      { path: "/a/site", name: "site", sessions: 2, updatedAt: "2026-07-01T00:00:00Z" },
      { path: "/a/tappy", name: "tappy", sessions: 9, updatedAt: "2026-08-01T00:00:00Z" },
    ],
    [],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["tappy", "site"]);
  expect(projects[0]!.sessions).toBe(9);
});

test("a project seen only in the sessions on screen is still offered", () => {
  const projects = projectsForProvider(
    [],
    [session({ id: "1", cwd: "/a/fresh" })],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["fresh"]);
});

test("a project used a minute ago sorts above the agent's dated ones", () => {
  // It has no announced stamp of its own, and undated would put the most
  // recent work last in a menu that promises newest first.
  const projects = projectsForProvider(
    [{ path: "/a/old", name: "old", updatedAt: "2020-01-01T00:00:00Z" }],
    [session({ id: "1", cwd: "/a/fresh", startedAt: Date.now() })],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["fresh", "old"]);
});

test("another agent's projects are never offered under this one", () => {
  const projects = projectsForProvider(
    [],
    [session({ id: "1", cwd: "/a/other", providerId: "codex" })],
    "claude-code",
  );

  expect(projects).toEqual([]);
});

test("a project in both sources is listed once, keeping the daemon's count", () => {
  const projects = projectsForProvider(
    [{ path: "/a/tappy", name: "tappy", sessions: 12 }],
    [session({ id: "1", cwd: "/a/tappy" })],
    "claude-code",
  );

  expect(projects).toHaveLength(1);
  expect(projects[0]!.sessions).toBe(12);
});

test("choosing a project keeps only its conversations", () => {
  const sessions = [
    session({ id: "1", cwd: "/a/tappy" }),
    session({ id: "2", cwd: "/a/site" }),
  ];

  const kept = sessionsInProject(sessions, { path: "/a/tappy", name: "tappy" });
  expect(kept.map((s) => s.id)).toEqual(["1"]);
});

test("a conversation started on this phone matches by the folder the daemon stamped", () => {
  // It never had a `cwd` of its own; without this fallback it would vanish out
  // of the very project it was started in.
  const local = session({ id: "1", folder: "tappy" });

  expect(sessionsInProject([local], { path: "/a/tappy", name: "tappy" })).toHaveLength(1);
  expect(sessionsInProject([local], { path: "/a/site", name: "site" })).toHaveLength(0);
});

test("a session with neither path nor folder is not claimed by a project", () => {
  expect(sessionsInProject([session({ id: "1" })], { path: "/a/tappy", name: "tappy" })).toEqual([]);
});

test("no choice shows everything", () => {
  const sessions = [session({ id: "1", cwd: "/a/tappy" }), session({ id: "2" })];
  expect(sessionsInProject(sessions, undefined)).toHaveLength(2);
});

test("the control always has a label", () => {
  expect(projectLabel(undefined)).toBe("All projects");
  expect(projectLabel({ path: "/a/tappy", name: "tappy" })).toBe("tappy");
});

test("the memo key ignores a streamed chunk landing on a session's turns", () => {
  // The exact case this exists for: a chunk arrives, the sessions array is
  // rebuilt with new turns on the active session, and the project list is
  // unaffected. A changed key here would put the sort back on every chunk.
  const before = [session({ id: "1", cwd: "/a/tappy" })];
  const after = [session({ id: "1", cwd: "/a/tappy", turns: [{ id: "t1" }] as never })];

  expect(projectSourceKey(after, "claude-code")).toBe(projectSourceKey(before, "claude-code"));
});

test("the memo key changes when a session introduces a new project", () => {
  const before = [session({ id: "1", cwd: "/a/tappy" })];
  const after = [...before, session({ id: "2", cwd: "/a/site" })];

  expect(projectSourceKey(after, "claude-code")).not.toBe(
    projectSourceKey(before, "claude-code"),
  );
});

test("the memo key is scoped to one agent", () => {
  // Another agent's conversations cannot change this agent's project list, so
  // they must not invalidate it either.
  const sessions = [
    session({ id: "1", cwd: "/a/tappy" }),
    session({ id: "2", cwd: "/a/site", providerId: "codex" }),
  ];

  expect(projectSourceKey(sessions, "claude-code")).toBe(
    projectSourceKey([sessions[0]!], "claude-code"),
  );
});

test("the memo key separates fields so neighbouring values cannot merge", () => {
  // Without a separator, {cwd:"/a", startedAt:11} and {cwd:"/a1", startedAt:1}
  // would produce the same key and one would be silently skipped.
  const a = [session({ id: "1", cwd: "/a", startedAt: 11 })];
  const b = [session({ id: "1", cwd: "/a1", startedAt: 1 })];

  expect(projectSourceKey(a, "claude-code")).not.toBe(projectSourceKey(b, "claude-code"));
});

describe("projectTabItems", () => {
  test("All first, then one chip per project in order", () => {
    const items = projectTabItems([
      { path: "/a/one", name: "one" },
      { path: "/b/two", name: "two" },
    ]);
    expect(items).toEqual([
      { label: "All", a11y: "All projects" },
      { path: "/a/one", label: "one", a11y: "Project one" },
      { path: "/b/two", label: "two", a11y: "Project two" },
    ]);
  });

  test("scales linearly to a GG Coder-sized list", () => {
    const projects = Array.from({ length: 1000 }, (_, i) => ({ path: `/p/${i}`, name: `p${i}` }));
    const items = projectTabItems(projects);
    expect(items).toHaveLength(1001);
    expect(items[1000]?.path).toBe("/p/999");
  });
});

describe("projects open in a terminal", () => {
  const terminal = (cwd: string, agent: "claude" | "codex" | "ggcoder" = "claude", startedAt = Date.parse("2026-10-16T20:00:00Z")) => ({
    id: `t-${cwd}`,
    agent,
    cwd,
    folder: cwd.split("/").pop() ?? cwd,
    startedAt,
  });

  test("a project with no history appears the moment claude is opened in it", () => {
    const projects = projectsForProvider([], [], "claude-code", [terminal("/Users/me/brand-new")]);
    expect(projects).toEqual([
      { path: "/Users/me/brand-new", name: "brand-new", live: true, updatedAt: "2026-10-16T20:00:00.000Z" },
    ]);
  });

  test("a project already in the list is marked live, not duplicated, and comes first", () => {
    const projects = projectsForProvider(
      [
        { path: "/p/new", name: "new", updatedAt: "2026-10-16T21:00:00.000Z" },
        { path: "/p/old", name: "old", updatedAt: "2026-01-01T00:00:00.000Z" },
      ],
      [],
      "claude-code",
      [terminal("/p/old")],
    );
    expect(projects.map((p) => [p.name, p.live ?? false])).toEqual([
      ["old", true],
      ["new", false],
    ]);
  });

  test("only the agent on screen counts: codex open in a folder is not a claude project", () => {
    expect(projectsForProvider([], [], "claude-code", [terminal("/p/site", "codex")])).toEqual([]);
    expect(projectsForProvider([], [], "codex", [terminal("/p/site", "codex")]).map((p) => p.name)).toEqual(["site"]);
  });

  test("a live project is marked in the strip, for the eye and for VoiceOver", () => {
    const items = projectTabItems(projectsForProvider([], [], "claude-code", [terminal("/p/app")]));
    expect(items[1]).toEqual({ path: "/p/app", label: "● app", a11y: "Project app, open in a terminal" });
  });
});
