import { ChildProcessWithoutNullStreams, spawn } from "child_process";
import { EventEmitter } from "events";
import { delimiter } from "path";
import { Connection } from "./connection";
import { augmentedPath, defaultModelCacheEnv, resolveExecutable } from "./resolveCommand";

/** Thrown when the agent executable cannot be located on the (augmented) PATH. */
export class AgentNotFoundError extends Error {
  readonly code = "AGENT_NOT_FOUND";
  constructor(readonly command: string) {
    super(
      `Could not find the "${command}" executable. Install the agent from ` +
        `https://code.sigit.si and make sure it is on your PATH, or set an ` +
        `absolute "command" path in the "sigit.agents" setting.`
    );
    this.name = "AgentNotFoundError";
  }
}

/**
 * AcpClient — spawns an Agent Client Protocol agent over stdio and drives the
 * ACP handshake and prompt turns.
 *
 * Protocol reference: https://agentclientprotocol.com
 */

export interface AgentSpawnConfig {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface PermissionRequest {
  sessionId: string;
  toolCall?: unknown;
  options?: Array<{ optionId: string; name: string; kind?: string }>;
  [key: string]: unknown;
}

export interface PermissionResponse {
  outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" };
}

/** Callbacks the host injects so the agent can act on the workspace. */
export interface AcpCallbacks {
  requestPermission: (request: PermissionRequest) => Promise<PermissionResponse>;
  readTextFile: (params: { path: string; line?: number; limit?: number }) => Promise<string>;
  writeTextFile: (params: { path: string; content: string }) => Promise<void>;
}

export interface SessionUpdate {
  sessionId: string;
  update: {
    sessionUpdate: string;
    [key: string]: unknown;
  };
}

const PROTOCOL_VERSION = 1;

export class AcpClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | undefined;
  private connection: Connection | undefined;
  private callbacks: AcpCallbacks;
  private sessionId: string | undefined;
  private disposed = false;

  constructor(callbacks: AcpCallbacks) {
    super();
    this.callbacks = callbacks;
  }

  get currentSessionId(): string | undefined {
    return this.sessionId;
  }

  /** Spawn the agent process and wire up the JSON-RPC connection. */
  spawn(config: AgentSpawnConfig): void {
    // GUI-launched VS Code inherits a minimal PATH; augment it so the agent
    // (and any subprocess it spawns) can be found and can find its own tools.
    // Model-cache defaults sit *under* the inherited env and the agent config so
    // a real HF_HOME/HF_HUB_CACHE (or an agent `env` entry) always wins; they
    // only fill in a writable cache dir when nothing else is set, avoiding the
    // EPERM that the App Group container would otherwise cause.
    const path = augmentedPath();
    const env = {
      ...defaultModelCacheEnv(),
      ...process.env,
      ...(config.env ?? {}),
      PATH: path
    };
    if (config.env?.PATH) {
      env.PATH = `${config.env.PATH}${delimiter}${path}`;
    }

    const resolved = resolveExecutable(config.command, env.PATH);
    if (!resolved) {
      throw new AgentNotFoundError(config.command);
    }

    const child = spawn(resolved, config.args ?? [], {
      cwd: config.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });

    child.on("error", (err) => {
      this.emit("error", err);
      // Unblock any in-flight request (e.g. initialize) instead of hanging.
      this.connection?.dispose();
    });
    child.on("exit", (code, signal) => this.emit("exit", code, signal));
    child.stderr.on("data", (chunk: Buffer) => this.emit("stderr", chunk.toString()));

    const connection = new Connection(child.stdout, child.stdin);
    connection.on("error", (err) => this.emit("error", err));

    connection.onNotification("session/update", (params) => {
      this.emit("update", params as SessionUpdate);
    });

    connection.onRequest("session/request_permission", async (params) => {
      return this.callbacks.requestPermission(params as PermissionRequest);
    });

    connection.onRequest("fs/read_text_file", async (params) => {
      const p = params as { path: string; line?: number; limit?: number };
      const content = await this.callbacks.readTextFile(p);
      return { content };
    });

    connection.onRequest("fs/write_text_file", async (params) => {
      const p = params as { path: string; content: string };
      await this.callbacks.writeTextFile(p);
      return null;
    });

    this.child = child;
    this.connection = connection;
  }

  /** Run the ACP handshake: initialize → session/new. Returns the session id. */
  async initialize(cwd: string): Promise<string> {
    const connection = this.requireConnection();

    await connection.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: {
          readTextFile: true,
          writeTextFile: true
        }
      }
    });

    const session = await connection.request<{ sessionId: string }>("session/new", {
      cwd,
      mcpServers: []
    });

    this.sessionId = session.sessionId;
    return session.sessionId;
  }

  /** Send a text prompt and resolve with the stop reason for the turn. */
  async prompt(text: string): Promise<string> {
    const connection = this.requireConnection();
    if (!this.sessionId) {
      throw new Error("No active session; call initialize() first");
    }
    const result = await connection.request<{ stopReason: string }>("session/prompt", {
      sessionId: this.sessionId,
      prompt: [{ type: "text", text }]
    });
    return result.stopReason;
  }

  /** Ask the agent to cancel the current turn. */
  cancel(): void {
    if (!this.connection || !this.sessionId) {
      return;
    }
    this.connection.notify("session/cancel", { sessionId: this.sessionId });
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.connection?.dispose();
    this.connection = undefined;
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // ignore
      }
      this.child = undefined;
    }
    this.sessionId = undefined;
    this.removeAllListeners();
  }

  private requireConnection(): Connection {
    if (!this.connection) {
      throw new Error("Agent not spawned; call spawn() first");
    }
    return this.connection;
  }
}
