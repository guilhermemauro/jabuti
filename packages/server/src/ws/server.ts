// The WebSocket boundary: validates every client message against @jabuti/protocol
// and fans runtime events out to the clients watching each conversation.
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import {
  ClientMessage,
  type AgentPlan,
  type ConversationInfo,
  type LoopEvent,
  type MemoryProposal,
  type Problem,
  type ServerMessage,
} from "@jabuti/protocol";
import { WebSocketServer, type WebSocket } from "ws";
import { z } from "zod";
import type { AgentRegistry } from "../agents/registry.ts";
import type { ConversationStore } from "../conversations/store.ts";
import type { Providers } from "../providers/index.ts";
import type { Runtime, RuntimeListener } from "../loop/runtime.ts";
import type { Autopilot, AutopilotListener } from "../autopilot/index.ts";
import type { Capture, CaptureListener } from "../memory/capture.ts";
import { handleSettings, snapshot, type SettingsDeps } from "./settings.ts";

interface Deps {
  agents: AgentRegistry;
  providers: Providers;
  store: ConversationStore;
  /** Absent in tests that do not exercise the settings screen. */
  settings?: SettingsDeps;
  /** Absent in tests that do not exercise memory capture. */
  capture?: Capture;
  /** Plans, routines and the inbox (C19). */
  autopilot?: Autopilot;
}

export class Hub implements RuntimeListener, CaptureListener, AutopilotListener {
  private readonly wss = new WebSocketServer({ noServer: true });
  /** Each client and the login session it was accepted under. */
  private readonly clients = new Map<WebSocket, string>();
  /** Which conversation each client has open. */
  private readonly watching = new Map<WebSocket, string>();
  /** The address each client loaded the UI from: where an OAuth login returns. */
  private readonly origins = new Map<WebSocket, string>();
  private wired: { deps: Deps; runtime: Runtime } | undefined;

  event(conversationId: string, event: LoopEvent) {
    for (const [client, id] of this.watching) {
      if (id === conversationId) send(client, { type: "event", conversationId, event });
    }
  }

  conversationUpdated(conversation: ConversationInfo) {
    for (const client of this.clients.keys()) {
      send(client, { type: "conversation.updated", conversation });
    }
  }

  /** Proposals changed: every client shows the same list (C18). */
  memoryChanged(proposals: MemoryProposal[], problem: Problem | undefined) {
    for (const client of this.clients.keys()) {
      send(client, { type: "memory", proposals, ...(problem ? { problem } : {}) });
    }
  }

  /** A plan changed: every client shows the same plans and inbox (C19). */
  plansChanged(plans: AgentPlan[]) {
    for (const client of this.clients.keys()) send(client, { type: "plans", plans });
  }

  /** The runtime is built with this hub as its listener, so it is wired in after. */
  wire(deps: Deps, runtime: Runtime) {
    this.wired = { deps, runtime };
  }

  /** Takes over an upgrade the HTTP layer has already authenticated (C15). */
  accept(req: IncomingMessage, socket: Duplex, head: Buffer, session: string) {
    const wired = this.wired;
    if (!wired) {
      socket.destroy();
      return;
    }
    const { deps, runtime } = wired;
    this.wss.handleUpgrade(req, socket, head, (client) => {
      this.clients.set(client, session);
      // The HTTP layer checked it is this server's own origin (C15).
      this.origins.set(client, req.headers.origin ?? `http://${req.headers.host ?? "localhost"}`);
      client.on("close", () => {
        this.clients.delete(client);
        this.watching.delete(client);
        this.origins.delete(client);
      });
      send(client, {
        type: "init",
        agents: deps.agents.list(),
        models: deps.providers.list(),
        conversations: deps.store.list().map((c) => runtime.info(c)),
        problems: deps.agents.problems,
      });
      if (deps.capture) {
        const problem = deps.capture.lastProblem();
        send(client, {
          type: "memory",
          proposals: deps.capture.proposals(),
          ...(problem ? { problem } : {}),
        });
      }
      if (deps.autopilot) send(client, { type: "plans", plans: deps.autopilot.plans() });
      client.on("message", (data: Buffer) => {
        this.handle(client, data, deps, runtime);
      });
    });
  }

  /** Agents or model availability changed: every client gets the new lists. */
  catalogChanged() {
    if (this.wired) this.broadcastCatalog(this.wired.deps);
  }

  private broadcastCatalog(deps: Deps) {
    for (const client of this.clients.keys()) {
      send(client, {
        type: "catalog.updated",
        agents: deps.agents.list(),
        models: deps.providers.list(),
        problems: deps.agents.problems,
      });
    }
  }

  /** Settings changed outside a client's request (an OAuth login): every client gets them. */
  settingsChanged(message: string) {
    const settings = this.wired?.deps.settings;
    if (!settings) return;
    for (const client of this.clients.keys()) {
      send(client, { type: "settings.saved", message });
      send(client, { type: "settings", settings: snapshot(settings) });
    }
  }

  /** Lists a server's tools, or starts its OAuth login (C5). */
  private async mcp(
    client: WebSocket,
    message: Extract<ClientMessage, { type: "mcp.list" | "mcp.connect" }>,
    settings: SettingsDeps,
  ) {
    const servers = settings.mcpServers;
    if (!servers || !settings.discover) return;
    if (message.type === "mcp.list") {
      const users = settings.agents
        .profiles()
        .filter((a) => a.mcp.includes(message.name))
        .map((a) => a.name);
      const tools = await settings.discover(message.name, users);
      servers.recordTools(message.name, tools);
      settings.mcpChanged?.(message.name);
      send(client, {
        type: "settings.saved",
        message: `${message.name} lists ${String(tools.length)} tools. Choose which agents get.`,
      });
    } else {
      const origin = this.origins.get(client) ?? "";
      const started = await servers.startLogin(message.name, `${origin}/api/mcp/oauth/callback`);
      if ("url" in started) {
        send(client, { type: "mcp.authorize", name: message.name, url: started.url });
        return;
      }
      settings.mcpChanged?.(message.name);
      send(client, { type: "settings.saved", message: `${message.name} is connected.` });
    }
    send(client, { type: "settings", settings: snapshot(settings) });
  }

  /** Logging out ends the session's open connections too. */
  closeSession(session: string) {
    for (const [client, id] of this.clients) {
      if (id === session) client.close(4401, "Logged out");
    }
  }

  private handle(client: WebSocket, data: Buffer, deps: Deps, runtime: Runtime) {
    let json: unknown;
    try {
      json = JSON.parse(data.toString());
    } catch {
      json = undefined;
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) {
      send(client, {
        type: "problem",
        problem: {
          message: `The server did not understand a message: ${z.prettifyError(parsed.error)}`,
          nextStep: "Reload the page. If it keeps happening, the UI and server are out of sync.",
        },
      });
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "conversation.create": {
        const result = runtime.create(message.agent);
        if ("id" in result) {
          this.open(client, result.id, deps, runtime);
          this.conversationUpdated(runtime.info(result));
        } else {
          send(client, { type: "problem", problem: result });
        }
        return;
      }
      case "conversation.open":
        this.open(client, message.conversationId, deps, runtime);
        return;
      case "conversation.selectModel":
        report(client, runtime.selectModel(message.conversationId, message.model));
        return;
      case "conversation.selectShellMode":
        report(client, runtime.selectShellMode(message.conversationId, message.mode));
        return;
      case "message.send":
        report(
          client,
          runtime.send(message.conversationId, message.text, {
            owner: true,
            ...(message.attachments ? { attachments: message.attachments } : {}),
          }),
        );
        return;
      case "approval.respond":
        report(client, runtime.respondApproval(message.approvalId, message.approved));
        return;
      case "memory.capture": {
        const capture = deps.capture;
        if (!capture) return;
        void capture.now(message.conversationId).then((result) => {
          if ("problem" in result) report(client, result.problem);
          else send(client, { type: "settings.saved", message: result.saved });
        });
        return;
      }
      case "memory.decide":
        if (deps.capture) report(client, deps.capture.decide(message.proposalId, message.accept));
        return;
      case "memory.save":
      case "note.save":
      case "note.delete":
      case "settings.open":
      case "variable.save":
      case "variable.delete":
      case "providerKey.save":
      case "agent.save":
      case "agent.delete":
      case "agents.reload":
      case "skill.save":
      case "skill.delete":
      case "mcp.save":
      case "mcp.delete":
      case "mcp.tools":
      case "mcp.disconnect": {
        const settings = deps.settings;
        if (!settings) {
          report(client, { message: "Settings are not available.", nextStep: "Restart." });
          return;
        }
        const result = handleSettings(message, settings);
        if (result.problem) report(client, result.problem);
        if (result.saved) send(client, { type: "settings.saved", message: result.saved });
        if (result.catalogChanged) this.broadcastCatalog(deps);
        send(client, { type: "settings", settings: snapshot(settings) });
        return;
      }
      case "mcp.list":
      case "mcp.connect": {
        const settings = deps.settings;
        if (!settings?.mcpServers || !settings.discover) {
          report(client, { message: "MCP servers are not available.", nextStep: "Restart." });
          return;
        }
        void this.mcp(client, message, settings).catch((error: unknown) => {
          report(client, {
            message: `${message.name}: ${error instanceof Error ? error.message : String(error)}`,
            nextStep:
              message.type === "mcp.list"
                ? "Check its address, headers and variables, then list again."
                : "Check its address, then connect again.",
          });
        });
        return;
      }
      case "domain.save": {
        const settings = deps.settings;
        if (!settings?.domain) {
          report(client, { message: "The domain is not available.", nextStep: "Restart." });
          return;
        }
        // The HTTP layer checked the origin is this server's own (C15).
        const host = new URL(this.origins.get(client) ?? "http://localhost").host;
        void settings.domain.save(message.domain, host).then((problem) => {
          report(client, problem);
          if (!problem) {
            send(client, {
              type: "settings.saved",
              message: message.domain
                ? `Saved. Jabuti also answers on https://${settings.domain?.get() ?? ""} now.`
                : "Domain removed. Jabuti answers on its sslip.io name.",
            });
          }
          send(client, { type: "settings", settings: snapshot(settings) });
        });
        return;
      }
      case "turn.cancel":
        runtime.cancel(message.conversationId);
        return;
      case "conversation.compact":
        report(client, runtime.compact(message.conversationId, message.focus));
        return;
      case "plan.action": {
        const autopilot = deps.autopilot;
        if (!autopilot) return;
        void autopilot.act(message.agent, message.action).then((result) => {
          report(client, result.problem);
          if (result.saved) send(client, { type: "settings.saved", message: result.saved });
          if (result.conversationId) {
            this.open(client, result.conversationId, deps, runtime);
            send(client, { type: "conversation.started", conversationId: result.conversationId });
          }
        });
        return;
      }
    }
  }

  private open(client: WebSocket, conversationId: string, deps: Deps, runtime: Runtime) {
    const conversation = deps.store.get(conversationId);
    if (!conversation) {
      send(client, {
        type: "problem",
        problem: {
          message: "That conversation does not exist.",
          nextStep: "Pick one from the list or start a new one.",
        },
      });
      return;
    }
    this.watching.set(client, conversationId);
    const history = deps.store.history(conversationId).map(({ raw: _, ...m }) => m);
    send(client, {
      type: "conversation.opened",
      conversation: runtime.info(conversation),
      history,
    });
    for (const event of runtime.pendingEvents(conversationId)) {
      send(client, { type: "event", conversationId, event });
    }
  }
}

function report(client: WebSocket, problem: Problem | undefined) {
  if (problem) send(client, { type: "problem", problem });
}

function send(client: WebSocket, message: ServerMessage) {
  if (client.readyState === client.OPEN) client.send(JSON.stringify(message));
}
