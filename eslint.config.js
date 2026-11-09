// @ts-check
import js from "@eslint/js";
import comments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

// Hard constraint from AGENTS.md: the loop, tool registry, context management,
// permissions, skills loader and agent switching are written here, by hand.
const AGENT_FRAMEWORKS = [
  "langchain",
  "@langchain/*",
  "@langchain/langgraph",
  "crewai",
  "mastra",
  "@mastra/*",
  "ai",
  "@ai-sdk/*",
  "@anthropic-ai/claude-agent-sdk",
  "@openai/agents",
  "llamaindex",
  "autogen",
];

const forbiddenFrameworks = {
  group: AGENT_FRAMEWORKS,
  message: "No agent frameworks (AGENTS.md, Hard constraints). Write it by hand.",
};

// The SDK's tool runner is an agent loop. We own the loop.
const forbiddenSdkHelpers = {
  group: ["@anthropic-ai/sdk/helpers/*", "@anthropic-ai/sdk/lib/tools/*"],
  message: "The SDK's tool runner is an agent loop. Use the API client only; the loop is ours.",
};

// C13: the loop is provider-neutral. Each provider SDK lives in providers/<name>/.
const providerSdks = {
  group: ["@anthropic-ai/*", "openai", "openai/*"],
  message: "Provider SDKs are imported only by their adapter in src/providers/<name>/ (C13).",
};

const toolRunnerSyntax = {
  selector: "MemberExpression[property.name=/^(toolRunner|tool_runner)$/]",
  message: "The SDK's tool runner is an agent loop. The loop lives in packages/server/src/loop.",
};

export default defineConfig(
  globalIgnores(["**/node_modules/", "**/dist/", "**/coverage/", "data/"]),

  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  comments.recommended,

  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      // "No `any` without a comment explaining why": every disable needs a reason.
      "@eslint-community/eslint-comments/require-description": "error",
      "@eslint-community/eslint-comments/no-unlimited-disable": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      // Failures surface in the UI or the trace, never only in a console.
      "no-console": "error",
      "no-restricted-imports": ["error", { patterns: [forbiddenFrameworks, forbiddenSdkHelpers] }],
      "no-restricted-syntax": ["error", toolRunnerSyntax],
    },
  },

  // Server: secrets and the shell each have exactly one owner.
  {
    files: ["packages/server/**/*.ts"],
    ignores: ["packages/server/src/config/**", "packages/server/src/sandbox/**"],
    languageOptions: { globals: globals.node },
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message:
            "Secrets live in the server process only. Read the environment in src/config, nowhere else.",
        },
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "node:child_process",
              message: "Shell commands run inside the Docker sandbox (C3). Use src/sandbox.",
            },
            {
              name: "child_process",
              message: "Shell commands run inside the Docker sandbox (C3). Use src/sandbox.",
            },
          ],
          patterns: [
            forbiddenFrameworks,
            forbiddenSdkHelpers,
            providerSdks,
            { group: ["@jabuti/ui", "@jabuti/ui/*"], message: "The server never imports the UI." },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/server/src/providers/anthropic/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [forbiddenFrameworks, forbiddenSdkHelpers] }],
    },
  },

  // UI: talks to the server over WebSocket only, never imports it or the model SDK.
  {
    files: ["packages/ui/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            forbiddenFrameworks,
            {
              group: ["@jabuti/server", "@jabuti/server/*"],
              message:
                "The UI talks to the server over WebSocket. Shared types go in @jabuti/protocol.",
            },
            {
              group: ["@anthropic-ai/*", "@modelcontextprotocol/*"],
              message: "Model and MCP clients live in the server, which holds the credentials.",
            },
          ],
        },
      ],
    },
  },

  // Config files and scripts at the root run on Node.
  {
    files: ["*.{js,ts}", "scripts/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["**/*.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },

  prettier,
);
