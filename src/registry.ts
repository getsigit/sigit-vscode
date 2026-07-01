import * as vscode from "vscode";
import { Catalog, RegistryAgent, parseCatalog } from "./catalog";

/**
 * The remote ACP agent registry: fetches a curated catalog of ACP-compatible
 * agents, caches the last good copy for offline use, and installs a chosen
 * agent by writing its definition into the user's `sigit.agents` configuration.
 *
 * "Install" here means *register* — siGit never downloads or runs an agent
 * binary on the user's behalf. Each catalog entry may carry a human-readable
 * `install` hint that we surface but never execute.
 */

const DEFAULT_REGISTRY_URL =
  "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
const CACHE_KEY = "sigit.registry.cache";
const FETCH_TIMEOUT_MS = 10_000;

interface CacheEntry {
  url: string;
  fetchedAt: number;
  agents: RegistryAgent[];
}

export interface FetchResult {
  agents: RegistryAgent[];
  /** True when the network fetch failed and cached data was served instead. */
  fromCache: boolean;
  /** The network error, present only when `fromCache` is true. */
  error?: string;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("sigit");
}

/** The configured registry URL, or the default Agent Client Protocol catalog. */
export function registryUrl(): string {
  const configured = config().get<string>("registry.url");
  return configured && configured.trim() !== "" ? configured.trim() : DEFAULT_REGISTRY_URL;
}

/** Keys of agents already present in the `sigit.agents` configuration. */
export function installedKeys(): Set<string> {
  const registry = config().get<Record<string, unknown>>("agents") ?? {};
  return new Set(Object.keys(registry));
}

async function fetchFromNetwork(url: string): Promise<Catalog> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return parseCatalog(await response.text());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch the agent catalog. On success the result is cached in global state. On
 * failure the last cached catalog (for the same URL) is served when available,
 * with `fromCache: true`; otherwise the error is re-thrown.
 */
export async function fetchCatalog(context: vscode.ExtensionContext): Promise<FetchResult> {
  const url = registryUrl();
  try {
    const catalog = await fetchFromNetwork(url);
    const entry: CacheEntry = { url, fetchedAt: Date.now(), agents: catalog.agents };
    await context.globalState.update(CACHE_KEY, entry);
    return { agents: catalog.agents, fromCache: false };
  } catch (err) {
    const cached = context.globalState.get<CacheEntry>(CACHE_KEY);
    if (cached && cached.url === url) {
      return {
        agents: cached.agents,
        fromCache: true,
        error: (err as Error).message
      };
    }
    throw err;
  }
}

/**
 * Register a catalog agent into the user's `sigit.agents` configuration. By
 * default this is install-only: it returns `false` without writing when an
 * agent with the same key is already present. Pass `overwrite: true` to update
 * an existing entry in place (e.g. to pick up a newer catalog version).
 */
export async function installAgent(
  agent: RegistryAgent,
  options: { overwrite?: boolean } = {}
): Promise<boolean> {
  const cfg = config();
  const registry = { ...(cfg.get<Record<string, unknown>>("agents") ?? {}) };
  if (!options.overwrite && Object.prototype.hasOwnProperty.call(registry, agent.key)) {
    return false;
  }
  registry[agent.key] = {
    name: agent.name,
    command: agent.command,
    args: agent.args,
    env: agent.env
  };
  await cfg.update("agents", registry, vscode.ConfigurationTarget.Global);
  return true;
}

/**
 * Remove an agent from the user's `sigit.agents` configuration. Returns `false`
 * when no entry with that key exists. When the removed agent was the configured
 * default, the default is cleared so it falls back to the on-device `sigit`.
 */
export async function uninstallAgent(key: string): Promise<boolean> {
  const cfg = config();
  const registry = { ...(cfg.get<Record<string, unknown>>("agents") ?? {}) };
  if (!Object.prototype.hasOwnProperty.call(registry, key)) {
    return false;
  }
  delete registry[key];
  await cfg.update("agents", registry, vscode.ConfigurationTarget.Global);
  if (cfg.get<string>("agent.default") === key) {
    await cfg.update("agent.default", undefined, vscode.ConfigurationTarget.Global);
  }
  return true;
}

/** Make `key` the default agent (`sigit.agent.default`), user-wide. */
export async function setDefaultAgent(key: string): Promise<void> {
  await config().update("agent.default", key, vscode.ConfigurationTarget.Global);
}
