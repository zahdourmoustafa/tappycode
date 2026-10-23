/**
 * The GG Coder app's model picker, thinking switch, slash commands and skills,
 * as the ACP selectors and command list tappy already shows for every agent.
 *
 * Ids and categories match GG Coder's own ACP mode (`model`, `thinking`), so
 * the phone treats the app exactly like the GG Coder CLI: same pills, same
 * remembered picks. Pure, so all of it is testable without an app.
 */

/** A row of the app's `GET /models`. */
export interface AppModel {
  id: string;
  name: string;
  provider: string;
  local?: boolean;
  /** False for a local model that cannot call tools, so cannot run the agent. */
  supportsTools?: boolean;
  billing?: { paid?: boolean };
}

/** The part of the app's `GET /state` the selectors are built from. */
export interface AppControlState {
  model: string;
  provider?: string;
  thinkingLevel: string | null;
  supportedThinkingLevels: string[];
}

/** A row of the app's `GET /commands`. */
export interface AppCommand {
  name: string;
  description: string;
  aliases?: string[];
}

/** Every name a typed `/name` runs as one of the app's own commands. */
function commandNames(commands: AppCommand[]): Set<string> {
  return new Set(commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
}

/** A row of the app's `GET /skills`. */
export interface AppSkill {
  name: string;
  description: string;
}

export const MODEL_OPTION_ID = "model";
export const THINKING_OPTION_ID = "thinking";
export const THINKING_OFF = "off";

/** The shape tappy's daemon reads from `configOptions`. */
export interface BridgeConfigOption {
  id: string;
  name: string;
  description?: string;
  category: string;
  type: "select";
  currentValue: string;
  options: { value: string; name: string; description?: string }[];
}

/** One entry of ACP's `available_commands_update`. */
export interface BridgeCommand {
  name: string;
  description: string;
  input?: { hint: string };
}

/**
 * Model and thinking selectors, exactly as the app's footer offers them.
 *
 * Two kinds of model are left out, as the GG Coder CLI does for the phone:
 * one that spends real money (the app asks for a confirmation the phone has no
 * screen for) unless it is already current, and a local model that cannot call
 * tools (the app shows it disabled). Thinking appears only for a model that
 * supports it, so the phone never offers a level the model would ignore.
 */
export function buildConfigOptions(
  state: AppControlState,
  models: AppModel[],
): BridgeConfigOption[] {
  const offered = models.filter(
    (m) => m.id === state.model || (m.billing?.paid !== true && m.supportsTools !== false),
  );
  if (!offered.some((m) => m.id === state.model)) {
    // Current but no longer listed (its provider was signed out): still the
    // truth about what the next prompt runs on.
    offered.unshift({ id: state.model, name: state.model, provider: state.provider ?? "" });
  }
  const options: BridgeConfigOption[] = [
    {
      id: MODEL_OPTION_ID,
      name: "Model",
      category: "model",
      type: "select",
      currentValue: state.model,
      options: offered.map((m) => ({
        value: m.id,
        name: m.name,
        ...(m.provider ? { description: m.provider } : {}),
      })),
    },
  ];
  if (state.supportedThinkingLevels.length > 0) {
    const current =
      state.thinkingLevel && state.supportedThinkingLevels.includes(state.thinkingLevel)
        ? state.thinkingLevel
        : THINKING_OFF;
    options.push({
      id: THINKING_OPTION_ID,
      name: "Thinking",
      description: "Extended reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: current,
      options: [
        { value: THINKING_OFF, name: "Off", description: "No extended reasoning" },
        ...state.supportedThinkingLevels.map((level) => ({ value: level, name: level })),
      ],
    });
  }
  return options;
}

/** What the trailing text after a command or skill name is for. */
const ARG_HINT = "extra instructions (optional)";

/**
 * The app's slash commands, then its skills, as one list. Skills come second
 * and lose any name a command already has, because the app runs a typed
 * `/name` as its command — a skill listed under that name would never run.
 */
export function buildCommands(commands: AppCommand[], skills: AppSkill[]): BridgeCommand[] {
  const out: BridgeCommand[] = [];
  const listed = new Set<string>();
  for (const command of commands) {
    if (listed.has(command.name)) continue;
    listed.add(command.name);
    out.push({ name: command.name, description: command.description, input: { hint: ARG_HINT } });
  }
  const taken = commandNames(commands);
  for (const skill of skills) {
    if (taken.has(skill.name) || listed.has(skill.name)) continue;
    listed.add(skill.name);
    out.push({
      name: skill.name,
      description: skill.description ? `Skill: ${skill.description}` : "Skill",
      input: { hint: ARG_HINT },
    });
  }
  return out;
}

/**
 * A `/skill-name ...` prompt, rewritten into a request the agent acts on.
 *
 * The app has no `/skill` command: its agent loads a skill through its own
 * `skill` tool when asked to. Sent as-is, `/tdd add a test` would be refused
 * as an unknown command, so it becomes "Use the "tdd" skill." plus the rest.
 * Anything else — an ordinary message, a real command, an unknown name — is
 * returned untouched.
 */
export function rewriteSkillPrompt(
  text: string,
  commands: AppCommand[],
  skills: AppSkill[],
): string {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match?.[1]) return text;
  const name = match[1];
  if (commandNames(commands).has(name)) return text;
  const skill = skills.find((s) => s.name.toLowerCase() === name.toLowerCase());
  if (!skill) return text;
  const rest = match[2]?.trim();
  return rest ? `Use the "${skill.name}" skill.\n\n${rest}` : `Use the "${skill.name}" skill.`;
}
