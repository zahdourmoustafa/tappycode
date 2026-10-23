import { describe, expect, test } from "bun:test";

import { buildCommands, buildConfigOptions, rewriteSkillPrompt } from "./controls.ts";

const models = [
  { id: "claude-sonnet", name: "Sonnet", provider: "anthropic" },
  { id: "claude-fast", name: "Sonnet fast", provider: "anthropic", billing: { paid: true } },
  { id: "local:llama", name: "Llama", provider: "local", local: true, supportsTools: false },
  { id: "gpt", name: "GPT", provider: "openai" },
];

describe("buildConfigOptions", () => {
  test("offers the app's models and thinking levels with live values", () => {
    const [model, thinking] = buildConfigOptions(
      { model: "gpt", thinkingLevel: "high", supportedThinkingLevels: ["low", "high"] },
      models,
    );
    expect(model?.id).toBe("model");
    expect(model?.category).toBe("model");
    expect(model?.currentValue).toBe("gpt");
    // No paid model, no local model that cannot call tools.
    expect(model?.options.map((o) => o.value)).toEqual(["claude-sonnet", "gpt"]);
    expect(thinking?.id).toBe("thinking");
    expect(thinking?.category).toBe("thought_level");
    expect(thinking?.currentValue).toBe("high");
    expect(thinking?.options.map((o) => o.value)).toEqual(["off", "low", "high"]);
  });

  test("keeps a paid model when it is already current", () => {
    const [model] = buildConfigOptions(
      { model: "claude-fast", thinkingLevel: null, supportedThinkingLevels: [] },
      models,
    );
    expect(model?.options.map((o) => o.value)).toContain("claude-fast");
  });

  test("has no thinking picker for a model without thinking", () => {
    const options = buildConfigOptions(
      { model: "gpt", thinkingLevel: null, supportedThinkingLevels: [] },
      models,
    );
    expect(options.map((o) => o.id)).toEqual(["model"]);
  });

  test("still names the current model when its provider is no longer listed", () => {
    const [model] = buildConfigOptions(
      { model: "gone", provider: "x", thinkingLevel: null, supportedThinkingLevels: [] },
      models,
    );
    expect(model?.options[0]?.value).toBe("gone");
  });

  test("reports thinking off when the level is not one the model supports", () => {
    const [, thinking] = buildConfigOptions(
      { model: "gpt", thinkingLevel: "max", supportedThinkingLevels: ["low"] },
      models,
    );
    expect(thinking?.currentValue).toBe("off");
  });
});

describe("buildCommands", () => {
  test("lists commands, then skills, and a command name beats a skill", () => {
    const list = buildCommands(
      [
        { name: "review", description: "Review the diff", aliases: ["rv"] },
        { name: "add-dir", description: "Add a folder" },
      ],
      [
        { name: "tdd", description: "Test first" },
        { name: "review", description: "A skill with a command's name" },
        { name: "rv", description: "A skill with a command's alias" },
      ],
    );
    expect(list.map((c) => c.name)).toEqual(["review", "add-dir", "tdd"]);
    expect(list[2]?.description).toBe("Skill: Test first");
  });
});

describe("rewriteSkillPrompt", () => {
  const commands = [{ name: "review", description: "", aliases: ["rv"] }];
  const skills = [{ name: "tdd", description: "" }];

  test("turns /skill into a request to use it, keeping the rest", () => {
    expect(rewriteSkillPrompt("/tdd add a test for login", commands, skills)).toBe(
      'Use the "tdd" skill.\n\nadd a test for login',
    );
    expect(rewriteSkillPrompt("/TDD", commands, skills)).toBe('Use the "tdd" skill.');
  });

  test("leaves commands, unknown names and ordinary messages alone", () => {
    expect(rewriteSkillPrompt("/review now", commands, skills)).toBe("/review now");
    expect(rewriteSkillPrompt("/rv", commands, skills)).toBe("/rv");
    expect(rewriteSkillPrompt("/nope", commands, skills)).toBe("/nope");
    expect(rewriteSkillPrompt("use tdd please", commands, skills)).toBe("use tdd please");
    expect(rewriteSkillPrompt("/usr/bin is a path", commands, skills)).toBe("/usr/bin is a path");
  });
});
