import * as vscode from "vscode";
import { AcpClient, PermissionRequest, PermissionResponse, SessionUpdate } from "./acp/client";
import { defaultAgentKey, listAgents, permissionMode, resolveAgent } from "./agents";

/**
 * The siGit chat webview. Owns a single AcpClient at a time, streams agent
 * output into the webview, and bridges file reads/writes and permission
 * requests back to VS Code.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "sigit.chat";

  private view: vscode.WebviewView | undefined;
  private client: AcpClient | undefined;
  private activeAgentKey: string;
  private starting: Promise<void> | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.activeAgentKey = defaultAgentKey();
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")]
    };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      switch (message?.type) {
        case "prompt":
          void this.handlePrompt(String(message.text ?? ""));
          break;
        case "cancel":
          this.client?.cancel();
          break;
        case "ready":
          this.postStatus(`Agent: ${this.activeAgentKey}`);
          break;
        default:
          break;
      }
    });

    webviewView.onDidDispose(() => {
      this.disposeClient();
      this.view = undefined;
    });
  }

  reveal(): void {
    this.view?.show?.(true);
  }

  /** Start a fresh session, discarding any existing client. */
  async newSession(): Promise<void> {
    this.disposeClient();
    this.post({ type: "clear" });
    await this.ensureClient();
    this.postStatus("New session started");
  }

  /** Restart the active agent process. */
  async restart(): Promise<void> {
    this.disposeClient();
    this.postStatus("Restarting agent…");
    await this.ensureClient();
    this.postStatus(`Agent restarted: ${this.activeAgentKey}`);
  }

  /** Pick an agent from the registry and switch to it. */
  async selectAgent(): Promise<void> {
    const agents = listAgents();
    const picked = await vscode.window.showQuickPick(
      agents.map((agent) => ({
        label: agent.name,
        description: agent.key,
        detail: `${agent.command} ${agent.args.join(" ")}`.trim(),
        agent
      })),
      { placeHolder: "Select an ACP agent" }
    );
    if (!picked) {
      return;
    }
    this.activeAgentKey = picked.agent.key;
    this.disposeClient();
    this.post({ type: "clear" });
    await this.ensureClient();
    this.postStatus(`Agent: ${picked.agent.name}`);
  }

  private async handlePrompt(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    try {
      await this.ensureClient();
    } catch (err) {
      this.postError(`Failed to start agent: ${(err as Error).message}`);
      return;
    }
    if (!this.client) {
      this.postError("No agent available.");
      return;
    }
    this.post({ type: "user", text: trimmed });
    this.post({ type: "busy", busy: true });
    try {
      const stopReason = await this.client.prompt(trimmed);
      this.post({ type: "turnEnd", stopReason });
    } catch (err) {
      this.postError(`Prompt failed: ${(err as Error).message}`);
    } finally {
      this.post({ type: "busy", busy: false });
    }
  }

  /** Spawn the active agent and open a session if not already running. */
  private ensureClient(): Promise<void> {
    if (this.client) {
      return Promise.resolve();
    }
    if (this.starting) {
      return this.starting;
    }
    this.starting = this.startClient().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async startClient(): Promise<void> {
    const agent = resolveAgent(this.activeAgentKey);
    this.activeAgentKey = agent.key;
    const cwd = this.workspaceFolder();

    const client = new AcpClient({
      requestPermission: (request) => this.handlePermission(request),
      readTextFile: (params) => this.readFile(params),
      writeTextFile: (params) => this.writeFile(params)
    });

    client.on("update", (update: SessionUpdate) => this.handleUpdate(update));
    client.on("stderr", (chunk: string) => this.post({ type: "log", text: chunk }));
    client.on("error", (err: Error) => this.postError(`Agent error: ${err.message}`));
    client.on("exit", (code: number | null) => {
      this.postStatus(`Agent exited${code === null ? "" : ` (code ${code})`}`);
      if (this.client === client) {
        this.client = undefined;
      }
    });

    try {
      client.spawn({ command: agent.command, args: agent.args, cwd, env: agent.env });
      await client.initialize(cwd);
    } catch (err) {
      client.dispose();
      throw err;
    }

    this.client = client;
    this.postStatus(`Connected to ${agent.name}`);
  }

  private handleUpdate(update: SessionUpdate): void {
    const inner = update.update;
    if (!inner || typeof inner.sessionUpdate !== "string") {
      return;
    }
    switch (inner.sessionUpdate) {
      case "agent_message_chunk":
        this.post({ type: "assistant", text: this.contentText(inner.content) });
        break;
      case "agent_thought_chunk":
        this.post({ type: "thought", text: this.contentText(inner.content) });
        break;
      case "tool_call":
      case "tool_call_update":
        this.post({
          type: "tool",
          title: (inner.title as string) ?? (inner.kind as string) ?? "tool",
          status: (inner.status as string) ?? "",
          toolCallId: inner.toolCallId as string | undefined
        });
        break;
      default:
        break;
    }
  }

  private async handlePermission(request: PermissionRequest): Promise<PermissionResponse> {
    const mode = permissionMode();
    const options = request.options ?? [];
    const allowOption = options.find((o) => /allow|yes|approve/i.test(o.name ?? o.optionId));
    const denyOption = options.find((o) => /deny|no|reject|cancel/i.test(o.name ?? o.optionId));

    if (mode === "allow" && allowOption) {
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
    }
    if (mode === "deny") {
      return denyOption
        ? { outcome: { outcome: "selected", optionId: denyOption.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    // prompt mode → ask the user
    const label = this.permissionLabel(request);
    if (options.length > 0) {
      const choice = await vscode.window.showInformationMessage(
        label,
        { modal: true },
        ...options.map((o) => o.name ?? o.optionId)
      );
      if (!choice) {
        return { outcome: { outcome: "cancelled" } };
      }
      const selected = options.find((o) => (o.name ?? o.optionId) === choice);
      return selected
        ? { outcome: { outcome: "selected", optionId: selected.optionId } }
        : { outcome: { outcome: "cancelled" } };
    }

    const choice = await vscode.window.showInformationMessage(
      label,
      { modal: true },
      "Allow",
      "Deny"
    );
    if (choice === "Allow" && allowOption) {
      return { outcome: { outcome: "selected", optionId: allowOption.optionId } };
    }
    return { outcome: { outcome: "cancelled" } };
  }

  private permissionLabel(request: PermissionRequest): string {
    const tc = request.toolCall as { title?: string; kind?: string } | undefined;
    const what = tc?.title ?? tc?.kind ?? "perform an action";
    return `The agent wants to ${what}. Allow?`;
  }

  private async readFile(params: { path: string }): Promise<string> {
    const uri = this.resolveUri(params.path);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  }

  private async writeFile(params: { path: string; content: string }): Promise<void> {
    const uri = this.resolveUri(params.path);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(params.content, "utf8"));
  }

  private resolveUri(p: string): vscode.Uri {
    if (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p)) {
      return vscode.Uri.file(p);
    }
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder) {
      return vscode.Uri.joinPath(folder.uri, p);
    }
    return vscode.Uri.file(p);
  }

  private workspaceFolder(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  private contentText(content: unknown): string {
    if (typeof content === "string") {
      return content;
    }
    if (content && typeof content === "object") {
      const c = content as { type?: string; text?: string };
      if (c.type === "text" && typeof c.text === "string") {
        return c.text;
      }
    }
    return "";
  }

  private post(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }

  private postStatus(text: string): void {
    this.post({ type: "status", text });
  }

  private postError(text: string): void {
    this.post({ type: "error", text });
  }

  private disposeClient(): void {
    this.client?.dispose();
    this.client = undefined;
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css")
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>siGit Chat</title>
</head>
<body>
  <div id="messages" class="messages"></div>
  <div id="status" class="status"></div>
  <form id="composer" class="composer">
    <textarea id="input" class="input" rows="2" placeholder="Ask the on-device agent…"></textarea>
    <button id="send" class="send" type="submit">Send</button>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
