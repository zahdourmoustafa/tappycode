/**
 * The colour of the agent on screen, for everything Stage lights up: LED
 * labels, sheet headers, the Tappy in a sheet, a selected card's outline.
 *
 * A context rather than a prop because it reaches every sheet and strip in the
 * app, and none of them otherwise know which agent they belong to. App.tsx
 * provides the selected agent's manifest colour; outside a provider it is the
 * app's own accent.
 */
import { createContext, useContext } from "react";
import { theme } from "../../theme";

const AgentColorContext = createContext<string>(theme.color.accent);

export const AgentColorProvider = AgentColorContext.Provider;

export function useAgentColor(): string {
  return useContext(AgentColorContext);
}
