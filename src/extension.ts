import * as vscode from "vscode";
import { listAgents } from "./agents";
import { ChatViewProvider } from "./chatView";
import { RegistryAgent } from "./catalog";
import {
  fetchCatalog,
  installAgent,
  installedKeys,
  setDefaultAgent,
  uninstallAgent
} from "./registry";

/** The always-available on-device agent; never removable. */
const FALLBACK_AGENT_KEY = "sigit";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("sigit.openChat", async () => {
      await vscode.commands.executeCommand("sigit.chat.focus");
      provider.reveal();
    }),
    vscode.commands.registerCommand("sigit.newSession", () => provider.newSession()),
    vscode.commands.registerCommand("sigit.selectAgent", () => provider.selectAgent()),
    vscode.commands.registerCommand("sigit.restartAgent", () => provider.restart()),
    vscode.commands.registerCommand("sigit.browseRegistry", () => browseRegistry(context, provider)),
    vscode.commands.registerCommand("sigit.refreshRegistry", () => refreshRegistry(context)),
    vscode.commands.registerCommand("sigit.removeAgent", () => removeAgent(provider))
  );
}

export function deactivate(): void {
  // Resources are tied to context.subscriptions and disposed automatically.
}

/** Fetch the catalog, let the user pick an agent, and install it. */
async function browseRegistry(
  context: vscode.ExtensionContext,
  provider: ChatViewProvider
): Promise<void> {
  let agents: RegistryAgent[];
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Fetching ACP registry…" },
      () => fetchCatalog(context)
    );
    agents = result.agents;
    if (result.fromCache) {
      void vscode.window.showWarningMessage(
        `Showing cached registry — fetch failed: ${result.error}`
      );
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not load the ACP registry: ${(err as Error).message}`);
    return;
  }

  if (agents.length === 0) {
    void vscode.window.showInformationMessage("The ACP registry is empty.");
    return;
  }

  const installed = installedKeys();
  const tag = (agent: RegistryAgent): string => {
    const parts: string[] = [agent.distribution];
    if (agent.version) {
      parts.unshift(`v${agent.version}`);
    }
    if (agent.manualInstall) {
      parts.push("manual install");
    }
    if (installed.has(agent.key)) {
      parts.push("installed");
    }
    return parts.join(" · ");
  };
  const picked = await vscode.window.showQuickPick(
    agents.map((agent) => ({
      label: installed.has(agent.key) ? `$(check) ${agent.name}` : agent.name,
      description: `${agent.key} · ${tag(agent)}`,
      detail: agent.description ?? `${agent.command} ${agent.args.join(" ")}`.trim(),
      agent
    })),
    { placeHolder: "Select an ACP agent to install", matchOnDescription: true, matchOnDetail: true }
  );
  if (!picked) {
    return;
  }

  const agent = picked.agent;
  if (!installed.has(agent.key)) {
    const added = await installAgent(agent);
    if (added && agent.manualInstall && agent.install) {
      void vscode.window.showWarningMessage(`Installed "${agent.name}". ${agent.install}`);
    } else if (added) {
      void vscode.window.showInformationMessage(
        `Installed "${agent.name}" — launches via ${agent.distribution}.`
      );
    }
  } else {
    const update = "Update";
    const choice = await vscode.window.showInformationMessage(
      `"${agent.name}" is already installed. Update its launch command from the registry?`,
      update
    );
    if (choice === update) {
      await installAgent(agent, { overwrite: true });
      void vscode.window.showInformationMessage(
        `Updated "${agent.name}"${agent.version ? ` to v${agent.version}` : ""}.`
      );
      // A running client may hold the stale command; restart if it's the active one.
      if (provider.currentAgentKey === agent.key) {
        await provider.useAgent(agent.key);
      }
    }
  }

  await offerToUse(agent, provider);
}

/** After install, offer to switch to the agent and/or make it the default. */
async function offerToUse(agent: RegistryAgent, provider: ChatViewProvider): Promise<void> {
  const useNow = "Use now";
  const setDefault = "Set as default";
  const choice = await vscode.window.showInformationMessage(
    `Use "${agent.name}"?`,
    useNow,
    setDefault
  );
  if (choice === setDefault) {
    await setDefaultAgent(agent.key);
  }
  if (choice === useNow || choice === setDefault) {
    await provider.useAgent(agent.key);
  }
}

/** Pick an installed agent and remove it from `sigit.agents`. */
async function removeAgent(provider: ChatViewProvider): Promise<void> {
  const removable = listAgents().filter((agent) => agent.key !== FALLBACK_AGENT_KEY);
  if (removable.length === 0) {
    void vscode.window.showInformationMessage(
      "No removable agents — only the on-device siGit agent is registered."
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    removable.map((agent) => ({
      label: agent.name,
      description: agent.key,
      detail: `${agent.command} ${agent.args.join(" ")}`.trim(),
      key: agent.key
    })),
    { placeHolder: "Select an agent to remove from your configuration" }
  );
  if (!picked) {
    return;
  }

  const confirm = "Remove";
  const choice = await vscode.window.showWarningMessage(
    `Remove "${picked.label}" from your agent registry? This only unregisters it; no files are deleted.`,
    { modal: true },
    confirm
  );
  if (choice !== confirm) {
    return;
  }

  const wasActive = provider.currentAgentKey === picked.key;
  const removed = await uninstallAgent(picked.key);
  if (!removed) {
    void vscode.window.showWarningMessage(`"${picked.label}" was not in the registry.`);
    return;
  }
  void vscode.window.showInformationMessage(`Removed "${picked.label}".`);
  // If the removed agent was the one running, fall back to the on-device default.
  if (wasActive) {
    await provider.useAgent(FALLBACK_AGENT_KEY);
  }
}

/** Force a fresh fetch of the registry and report how many agents are available. */
async function refreshRegistry(context: vscode.ExtensionContext): Promise<void> {
  try {
    const result = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Refreshing ACP registry…" },
      () => fetchCatalog(context)
    );
    if (result.fromCache) {
      void vscode.window.showWarningMessage(`Registry refresh failed: ${result.error}`);
    } else {
      void vscode.window.showInformationMessage(
        `ACP registry refreshed — ${result.agents.length} agent(s) available.`
      );
    }
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not refresh the ACP registry: ${(err as Error).message}`);
  }
}
