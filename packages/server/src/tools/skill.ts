// The skill tool (C4): loads the body of one of the skills the agent's profile names.
// Offered only to an agent with skills; the system prompt lists them. Its definition
// never changes with the skills, so the request prefix stays the same (C7).
import { z } from "zod";
import type { Tool } from "./types.ts";

const Input = z.strictObject({
  name: z.string().min(1).max(64).describe("The skill's name, as listed under Skills."),
});

export const skillTool: Tool<z.infer<typeof Input>> = {
  name: "skill",
  description: () =>
    "Load a skill listed under Skills in your instructions: its full method. Load it " +
    "before starting a task it covers, then follow it. Once loaded it stays in the " +
    "conversation: do not load it again.",
  input: Input,
  execute(input, ctx) {
    const skill = ctx.skill(input.name);
    if (!skill) {
      const names = ctx.agent.skills.join(", ") || "none";
      return Promise.resolve({
        content: `No skill "${input.name}" for you. Your skills: ${names}.`,
        isError: true,
      });
    }
    return Promise.resolve({
      content: `# Skill: ${skill.name}\n\n${skill.body}`,
      isError: false,
    });
  },
};
