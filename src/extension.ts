import * as vscode from "vscode";
import { ChatViewProvider } from "./chatView";

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
    vscode.commands.registerCommand("sigit.restartAgent", () => provider.restart())
  );
}

export function deactivate(): void {
  // Resources are tied to context.subscriptions and disposed automatically.
}
