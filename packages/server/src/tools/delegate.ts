import { z } from "zod";
import type { Tool } from "./types.ts";

const Input = z.strictObject({
  agent: z.string().describe("Name of the subagent."),
  task: z
    .string()
    .min(1)
    .describe(
      "Everything the subagent needs: it does not see this conversation. Say what to return.",
    ),
});

export const delegateTool: Tool<z.infer<typeof Input>> = {
  name: "delegate",
  description(agent, findAgent) {
    const list = agent.subagents
      .map((name) => `- ${name}: ${findAgent(name)?.description ?? "(missing)"}`)
      .join("\n");
    return (
      "Hand a self-contained task to a subagent. It starts with a fresh context, uses its " +
      "own tools and permissions, shares this conversation's /workspace, and returns only " +
      `its final answer. Available subagents:\n${list}`
    );
  },
  input: Input,
  async execute(input, ctx) {
    // Capabilities belong to the current agent (C6): only listed subagents.
    if (!ctx.agent.subagents.includes(input.agent)) {
      return {
        content: `"${input.agent}" is not a subagent of ${ctx.agent.name}. Available: ${ctx.agent.subagents.join(", ") || "none"}.`,
        isError: true,
      };
    }
    const subagent = ctx.findAgent(input.agent);
    if (!subagent) {
      return { content: `Agent "${input.agent}" is not loaded.`, isError: true };
    }
    return ctx.runSubagent(subagent, input.task);
  },
};
