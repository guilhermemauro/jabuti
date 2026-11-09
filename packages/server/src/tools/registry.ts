// The tools an agent may call, in a fixed order. The definitions sent to the model
// depend only on the agent profile, so they are byte-identical across steps (C7).
import { z } from "zod";
import type { AgentProfile } from "../agents/registry.ts";
import type { ToolSpec } from "../providers/types.ts";
import { agentsTool } from "./agents.ts";
import { delegateTool } from "./delegate.ts";
import { memoryTool } from "./memory.ts";
import { packagesTool } from "./packages.ts";
import { planTool } from "./plan.ts";
import { shellTool } from "./shell.ts";
import { skillTool } from "./skill.ts";
import { viewImagesTool } from "./images.ts";
import { pageStructureTool, siteCrawlTool, webReadTool } from "./web.ts";
import type { Tool, ToolContext, ToolOutput } from "./types.ts";

// The cast erases each tool's input type; execute() validates input against `input` first.
const BUILT_IN = [
  shellTool,
  packagesTool,
  webReadTool,
  pageStructureTool,
  siteCrawlTool,
  viewImagesTool,
  delegateTool,
  memoryTool,
  planTool,
  agentsTool,
  skillTool,
] as unknown as Tool[];

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** Tools a subagent never gets, whatever its profile says. */
const PARENT_ONLY = new Set([
  // Delegation is one level deep (C12).
  "delegate",
  // A subagent runs a task, not a conversation: no brief or memory of its own (C14).
  "memory",
  // A subagent runs a task for its parent; changing agents is the conversation's call.
  "agents",
  // The plan is its agent's; a subagent reports back to it instead (C19).
  "plan",
]);

/**
 * Whether an agent has a tool. `packages` also needs a usable shell (C17), and the page
 * readers, the crawler and the image viewer a sandbox to run in (C20, C21); `memory`
 * comes with user memory too, for user.md only (C18).
 */
function has(agent: AgentProfile, tool: string): boolean {
  const listed = (name: string) => agent.tools.includes(name as AgentProfile["tools"][number]);
  if (tool === "packages") {
    return listed("packages") && listed("shell") && agent.permissions.shell !== "deny";
  }
  if (["web_read", "page_structure", "site_crawl", "view_images"].includes(tool)) {
    return listed(tool) && agent.permissions.shell !== "deny";
  }
  // Not a switch: an agent with skills can load them (C4).
  if (tool === "skill") return agent.skills.length > 0;
  // Also for user memory alone: "remember this" must work for every agent (C18).
  if (tool === "memory") return listed("memory") || agent.userMemory;
  return listed(tool);
}

/** Tools for one run of an agent. */
export function toolsFor(agent: AgentProfile, isSubagent: boolean): Tool[] {
  return BUILT_IN.filter(
    (tool) => has(agent, tool.name) && !(isSubagent && PARENT_ONLY.has(tool.name)),
  );
}

export function toSpecs(
  tools: Tool[],
  agent: AgentProfile,
  findAgent: (name: string) => AgentProfile | undefined,
): ToolSpec[] {
  return tools.map((tool) => {
    const { $schema: _, ...schema } = tool.inputSchema ?? z.toJSONSchema(tool.input);
    return {
      name: tool.name,
      description: tool.description(agent, findAgent),
      inputSchema: schema,
    };
  });
}

/** Always resolves with exactly one result for the call (C2), whatever happens. */
export async function execute(
  tools: Tool[],
  call: ToolCall,
  ctx: ToolContext,
): Promise<ToolOutput> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) {
    return { content: `Tool "${call.name}" is not available to this agent.`, isError: true };
  }
  // Model output is untrusted: validate here, at the boundary.
  const parsed = tool.input.safeParse(call.input);
  if (!parsed.success) {
    return { content: `Invalid input: ${z.prettifyError(parsed.error)}`, isError: true };
  }
  try {
    return await tool.execute(parsed.data, ctx);
  } catch (error) {
    return {
      content: `Tool failed: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
    };
  }
}
