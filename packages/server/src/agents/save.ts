// Saving a profile from the settings screen or the agents tool: the rules that
// span modules (the model must be in the catalog, connectors and skills must exist) checked
// in one place, then the registry writes.
import type { ConnectorInfo, Problem, SkillInfo } from "@jabuti/protocol";
import type { Providers } from "../providers/index.ts";
import type { AgentProfile, AgentRegistry } from "./registry.ts";

export function saveAgent(
  deps: {
    agents: AgentRegistry;
    providers: Providers;
    connectors: readonly ConnectorInfo[];
    skills: readonly SkillInfo[];
  },
  profile: AgentProfile,
  create: boolean,
): Problem | undefined {
  if (!deps.providers.list().some((m) => m.id === profile.model)) {
    return {
      message: `Unknown model "${profile.model}".`,
      nextStep: "Pick a model from the list.",
    };
  }
  const unknown = profile.mcp.find((name) => !deps.connectors.some((c) => c.name === name));
  if (unknown) {
    return {
      message: `Unknown connector "${unknown}".`,
      nextStep: `Pick from: ${deps.connectors.map((c) => c.name).join(", ") || "none"}.`,
    };
  }
  const missing = profile.skills.find((name) => !deps.skills.some((s) => s.name === name));
  if (missing) {
    return {
      message: `Unknown skill "${missing}".`,
      nextStep: `Pick from: ${deps.skills.map((s) => s.name).join(", ") || "none"}.`,
    };
  }
  return deps.agents.save(profile, create);
}
