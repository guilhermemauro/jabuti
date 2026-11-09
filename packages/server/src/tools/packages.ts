// System packages (C17). On by default with the shell (templates and new agents):
// an owner who is not a sysadmin should not have to set anything up for an agent
// to get git or ffmpeg. The owner can switch it off per agent.
// The shell itself never runs as root (deployed); this tool is the only way in, and
// it takes package names, never a command. The user approves every install.
import { z } from "zod";
import { PACKAGE_NAME } from "../sandbox/docker.ts";
import type { Tool } from "./types.ts";

const Input = z.strictObject({
  packages: z
    .array(z.string().regex(PACKAGE_NAME, "A Debian package name, such as git or ffmpeg."))
    .min(1)
    .max(20)
    .describe("Debian package names, as for apt-get install."),
});

export const packagesTool: Tool<z.infer<typeof Input>> = {
  name: "packages",
  description: () =>
    "Install Debian system packages (apt) for your shell, such as git, ffmpeg or " +
    "poppler-utils, when a command is missing. The user approves each install. They " +
    "stay installed, and other agents may get them too. For Python or Node libraries " +
    "use pip or npm in the shell instead: those need no approval.",
  input: Input,
  async execute(input, ctx) {
    if (ctx.shellPermission() === "deny") {
      return { content: "The shell is disabled for this agent.", isError: true };
    }
    const packages = [...new Set(input.packages)];
    const approved = await ctx.requestApproval({ kind: "packages", packages });
    if (!approved) return { content: "The user did not approve this install.", isError: true };
    if (ctx.signal.aborted) return { content: "Cancelled by the user.", isError: true };
    const result = await ctx.sandbox.install(ctx.workspace, packages, ctx.signal);
    if (result.exitCode === 0) {
      return { content: `Installed ${packages.join(", ")}.`, isError: false };
    }
    return {
      content: `apt-get failed (exit ${String(result.exitCode)}):\n${result.output.slice(-4000)}`,
      isError: true,
    };
  },
};
