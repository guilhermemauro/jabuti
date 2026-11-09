// Composition root: wires agent registry, database, access control, providers,
// loop, shell sandbox and tracer, then serves the UI and the WebSocket.
import { join } from "node:path";
import { styleText } from "node:util";
import { AgentRegistry } from "./agents/registry.ts";
import { AgentState } from "./agents/state.ts";
import { Auth } from "./auth/index.ts";
import { Autopilot } from "./autopilot/index.ts";
import { loadConfig } from "./config/index.ts";
import { ConversationStore } from "./conversations/store.ts";
import { openDatabase } from "./db/index.ts";
import { createApp } from "./http/app.ts";
import { Runtime } from "./loop/runtime.ts";
import { CONNECTORS } from "./mcp/catalog.ts";
import { Mcp } from "./mcp/index.ts";
import { Capture } from "./memory/capture.ts";
import { Settings } from "./settings/index.ts";
import { loadSecretKey } from "./settings/key.ts";
import { CATALOG } from "./providers/catalog.ts";
import { Providers } from "./providers/index.ts";
import { DockerSandbox, type Sandbox } from "./sandbox/docker.ts";
import { RunnerSandbox } from "./sandbox/runner.ts";
import { Skills } from "./skills/index.ts";
import { McpServers } from "./mcp/servers.ts";
import { Domain } from "./domain/index.ts";
import { JsonlTracer } from "./tracer/index.ts";
import { Hub } from "./ws/server.ts";

const config = loadConfig();
const agents = AgentRegistry.load(config.agentsDir, config.templatesDir);
const db = openDatabase(join(config.dataDir, "jabuti.db"));
const secretKey = loadSecretKey(config.secretKey, config.dataDir);
const settings = new Settings(db, secretKey.key, config.providerKeys);
const providers = Providers.fromKeys(CATALOG, (provider) => settings.providerKey(provider));
const store = new ConversationStore(db);
const auth = new Auth(db);
const state = new AgentState(config.agentsDir, join(config.dataDir, "user.md"));
const sandbox: Sandbox = config.runner
  ? new RunnerSandbox(config.runner.url, config.runner.tokenFile)
  : new DockerSandbox(config.sandboxImage, (agent) => state.workspace(agent));
const mcpServers = new McpServers(
  db,
  settings,
  CONNECTORS.map((c) => c.name),
);
const mcp = new Mcp(
  CONNECTORS,
  (agent, name) => settings.value(agent, name),
  join(config.dataDir, "connectors"),
  mcpServers,
);
const tracer = new JsonlTracer(join(config.dataDir, "traces"));
const skills = new Skills([], config.skillsDirs);
const domain = new Domain(db);

const hub = new Hub();
const autopilot = new Autopilot(
  {
    state,
    agents,
    sandbox,
  },
  hub,
);
// Built before the runtime, which tells it when turns end; it asks the runtime back
// whether a conversation is mid-turn.
let runtime: Runtime | undefined = undefined;
const capture = new Capture(
  {
    db,
    store,
    state,
    agents,
    providers,
    tracer,
    model: "anthropic/claude-haiku-5-5",
    isRunning: (id) => runtime?.busy(id) ?? false,
  },
  hub,
);
runtime = new Runtime(
  {
    agents,
    providers,
    store,
    sandbox,
    state,
    settings,
    mcp,
    connectors: CONNECTORS,
    mcpServers,
    skills,
    tracer,
    capture,
    autopilot,
  },
  hub,
);
autopilot.wire(runtime);
const warnings = secretKey.warning ? [secretKey.warning] : [];
hub.wire(
  {
    agents,
    providers,
    store,
    settings: {
      agents,
      providers,
      settings,
      connectors: CONNECTORS,
      mcpServers,
      mcpChanged: (name) => void mcp.forget(name),
      discover: (name, users) => mcp.discover(name, users),
      domain,
      skills,
      warnings,
      state,
    },
    capture,
    autopilot,
  },
  runtime,
);
capture.start();
autopilot.start();
const server = createApp({
  auth,
  hub,
  uiDir: config.uiDir,
  domain,
  oauthCallback: async (state, code) => {
    const { name } = await mcpServers.finishLogin(state, code);
    await mcp.forget(name);
    hub.settingsChanged(`${name} is connected.`);
    return name;
  },
  // Only agents that exist: a removed agent's workspace stays on disk, unseen.
  files: {
    read: async (workspace, path) =>
      agents.get(workspace)
        ? await sandbox.readFile(workspace, path, AbortSignal.timeout(30_000))
        : undefined,
    write: async (workspace, path, bytes) => {
      if (!agents.get(workspace)) return false;
      await sandbox.writeFile(workspace, path, bytes, AbortSignal.timeout(60_000));
      return true;
    },
  },
});

server.listen(config.port, config.host, () => {
  const available = providers.list().filter((m) => m.available).length;
  const out = (line: string) => process.stdout.write(`${line}\n`);
  out(
    `Jabuti on http://${config.host}:${String(config.port)} — ` +
      `${String(agents.list().length)} agents, ${String(available)} models available`,
  );
  if (auth.setupCode) {
    // Forced on: in a container stdout is not a TTY, yet docker logs shows colors.
    const highlight = (text: string) =>
      config.color ? styleText(["bold", "yellow"], text, { validateStream: false }) : text;
    const code = config.color
      ? styleText(["bold", "black", "bgYellow"], ` ${auth.setupCode} `, { validateStream: false })
      : auth.setupCode;
    out("");
    out(highlight(`First run: open the UI and set the owner password with setup code ${code}`));
    out("");
  }
  for (const problem of agents.problems) {
    process.stderr.write(`! ${problem.message}\n  → ${problem.nextStep}\n`);
  }
  for (const warning of warnings) {
    process.stderr.write(`! ${warning.message}\n  → ${warning.nextStep}\n`);
  }
  if (available === 0) {
    process.stderr.write(
      "! No model provider has credentials.\n  → Add a key in Settings → Model keys.\n",
    );
  }
});
