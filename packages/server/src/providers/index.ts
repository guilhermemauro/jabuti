// Resolves a catalog model id ("anthropic/claude-opus-5-5") to a provider client.
// Adding a provider: write providers/<name>/, list its models in catalog.ts, wire it here.
import type { ModelInfo, Problem } from "@jabuti/protocol";
import { createAnthropicProvider } from "./anthropic/index.ts";
import { costUsd, type CatalogModel } from "./catalog.ts";
import type { ModelProvider, Usage } from "./types.ts";

const FACTORIES: Record<string, (apiKey: string) => ModelProvider> = {
  anthropic: createAnthropicProvider,
};

export type ResolvedModel =
  { ok: true; model: CatalogModel; provider: ModelProvider } | { ok: false; problem: Problem };

export class Providers {
  private readonly catalog: readonly CatalogModel[];
  private readonly clientFor: (provider: string) => ModelProvider | undefined;

  constructor(
    catalog: readonly CatalogModel[],
    clientFor: (provider: string) => ModelProvider | undefined,
  ) {
    this.catalog = catalog;
    this.clientFor = clientFor;
  }

  /** Fixed clients: the Contract tests' fake model. */
  static withClients(catalog: readonly CatalogModel[], clients: ModelProvider[]) {
    const byId = new Map(clients.map((c) => [c.id, c]));
    return new Providers(catalog, (provider) => byId.get(provider));
  }

  /**
   * Clients built from keys read on each use, so a key saved in settings applies
   * without a restart. A client is rebuilt only when its key changes.
   */
  static fromKeys(
    catalog: readonly CatalogModel[],
    keyFor: (provider: string) => string | undefined,
  ) {
    const cache = new Map<string, { key: string; client: ModelProvider }>();
    return new Providers(catalog, (provider) => {
      const key = keyFor(provider);
      const create = FACTORIES[provider];
      if (!key || !create) return undefined;
      const cached = cache.get(provider);
      if (cached?.key === key) return cached.client;
      const client = create(key);
      cache.set(provider, { key, client });
      return client;
    });
  }

  /** Every provider the catalog lists, for the settings screen. */
  providerIds(): string[] {
    return [...new Set(this.catalog.map((m) => m.provider))];
  }

  list(): ModelInfo[] {
    return this.catalog.map((m) => ({
      id: m.id,
      label: m.label,
      available: this.clientFor(m.provider) !== undefined,
    }));
  }

  resolve(id: string): ResolvedModel {
    const model = this.catalog.find((m) => m.id === id);
    if (!model) {
      return {
        ok: false,
        problem: {
          message: `Unknown model "${id}".`,
          nextStep: "Pick a model from the list, or fix the model in the agent's agent.json.",
        },
      };
    }
    const provider = this.clientFor(model.provider);
    if (!provider) {
      return {
        ok: false,
        problem: {
          message: `No credentials for provider "${model.provider}".`,
          nextStep: `Add the ${model.provider} API key in Settings → Model keys.`,
        },
      };
    }
    return { ok: true, model, provider };
  }

  cost(model: CatalogModel, usage: Usage): number {
    return costUsd(model, usage);
  }
}
