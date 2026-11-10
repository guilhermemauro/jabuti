import { z } from "zod";
import type { Tool } from "./types.ts";

const Input = z.strictObject({
  command: z.string().min(1).describe("The command, run with sh -c in /workspace."),
  timeout_seconds: z
    .number()
    .int()
    .min(1)
    .max(600)
    .optional()
    .describe("Kill the command after this many seconds. Default 60."),
});

export const shellTool: Tool<z.infer<typeof Input>> = {
  name: "shell",
  description: () =>
    "Run a shell command in this conversation's sandbox: a Linux container with Python 3, " +
    "where /workspace persists between commands. Returns combined stdout and stderr " +
    "and the exit code. Use it to write and run scripts. Install Python or Node " +
    "libraries with pip or npm here; for a missing system command, use the packages tool. " +
    "When you analyze data, report medians and ranges with the sample size, not averages " +
    "alone, and treat a correlation as a hypothesis, not a cause. To show the user an " +
    "image you made, put ![short description](path/relative/to/workspace.png) in your " +
    "reply: it appears in their chat (you do not see it; view_images shows it to you).",
  input: Input,
  async execute(input, ctx) {
    // Read the permission now, at execution, not when the call was proposed (C9).
    const permission = ctx.shellPermission();
    if (permission === "deny") {
      return { content: "The shell is disabled for this agent.", isError: true };
    }
    // Auto runs every command: the agent reaches only its own workspace, without secrets (C3).
    if (permission === "ask") {
      const approved = await ctx.requestApproval({ kind: "shell", command: input.command });
      if (!approved) return { content: "The user denied this command.", isError: true };
    }
    if (ctx.signal.aborted) return { content: "Cancelled by the user.", isError: true };

    const timeout = input.timeout_seconds ?? 60;
    let result;
    try {
      result = await ctx.sandbox.exec(ctx.workspace, input.command, {
        timeoutSeconds: timeout,
        env: ctx.shellEnv(),
        signal: ctx.signal,
      });
    } catch (error) {
      // Stop pressed while the command ran: the sandbox call was aborted.
      if (error instanceof Error && error.name === "AbortError") {
        return { content: "Cancelled by the user.", isError: true };
      }
      return {
        content: `The sandbox could not run the command: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    if (result.timedOut) {
      return {
        content: `${result.output}\n[killed after ${String(timeout)}s, or out of memory]`,
        isError: true,
      };
    }
    return {
      content: `${result.output}\n[exit code ${String(result.exitCode)}]`,
      isError: result.exitCode !== 0,
    };
  },
};
