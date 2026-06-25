import * as vscode from "vscode";

/**
 * Reads the siGit agent registry and permission settings from the workspace
 * configuration. Falls back to the on-device `sigit` binary when the registry
 * is empty — local-first is always the default.
 */

export interface AgentDefinition {
  key: string;
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type PermissionMode = "prompt" | "allow" | "deny";

const FALLBACK_AGENT: AgentDefinition = {
  key: "sigit",
  name: "siGit (on-device)",
  command: "sigit",
  args: [],
  env: {}
};

interface RawAgent {
  name?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("sigit");
}

function normalize(key: string, raw: RawAgent): AgentDefinition {
  return {
    key,
    name: raw.name ?? key,
    command: raw.command,
    args: raw.args ?? [],
    env: raw.env ?? {}
  };
}

/** All configured agents, never empty (falls back to on-device `sigit`). */
export function listAgents(): AgentDefinition[] {
  const registry = config().get<Record<string, RawAgent>>("agents") ?? {};
  const entries = Object.entries(registry).filter(([, raw]) => raw && raw.command);
  if (entries.length === 0) {
    return [FALLBACK_AGENT];
  }
  return entries.map(([key, raw]) => normalize(key, raw));
}

/** Resolve a specific agent by key, or the configured default when omitted. */
export function resolveAgent(key?: string): AgentDefinition {
  const agents = listAgents();
  const wanted = key ?? config().get<string>("agent.default") ?? FALLBACK_AGENT.key;
  return agents.find((agent) => agent.key === wanted) ?? agents[0];
}

/** The key of the default agent. */
export function defaultAgentKey(): string {
  return config().get<string>("agent.default") ?? FALLBACK_AGENT.key;
}

/** Current permission handling mode. */
export function permissionMode(): PermissionMode {
  return config().get<PermissionMode>("permission.mode") ?? "prompt";
}
