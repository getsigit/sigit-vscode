import { EventEmitter } from "events";
import { Readable, Writable } from "stream";

/**
 * A generic JSON-RPC 2.0 peer over newline-delimited JSON (ndjson).
 *
 * Reads from a readable stream (the agent's stdout) and writes to a writable
 * stream (the agent's stdin). Both incoming requests/notifications and our own
 * outbound requests/notifications are supported, so this is a symmetric peer
 * rather than a one-directional client.
 */

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: JsonRpcError;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

type RequestHandler = (params: unknown) => unknown | Promise<unknown>;
type NotificationHandler = (params: unknown) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class Connection extends EventEmitter {
  private readonly writable: Writable;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private readonly notificationHandlers = new Map<string, NotificationHandler>();
  private buffer = "";
  private nextId = 1;
  private disposed = false;

  constructor(readable: Readable, writable: Writable) {
    super();
    this.writable = writable;
    readable.on("data", (chunk: Buffer | string) => this.onData(chunk.toString()));
    readable.on("error", (err) => this.emit("error", err));
    readable.on("close", () => this.emit("close"));
  }

  /** Send a request and resolve with its result (or reject on error). */
  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error("Connection disposed"));
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject
      });
      this.send(payload);
    });
  }

  /** Send a fire-and-forget notification. */
  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    const payload: JsonRpcNotification = { jsonrpc: "2.0", method, params };
    this.send(payload);
  }

  /** Register a handler for inbound requests of a given method. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Register a handler for inbound notifications of a given method. */
  onNotification(method: string, handler: NotificationHandler): void {
    this.notificationHandlers.set(method, handler);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    const err = new Error("Connection disposed");
    for (const { reject } of this.pending.values()) {
      reject(err);
    }
    this.pending.clear();
    this.requestHandlers.clear();
    this.notificationHandlers.clear();
    this.removeAllListeners();
  }

  private send(message: JsonValue | JsonRpcRequest | JsonRpcNotification | JsonRpcResponse): void {
    try {
      this.writable.write(JSON.stringify(message) + "\n");
    } catch (err) {
      this.emit("error", err);
    }
  }

  private onData(text: string): void {
    this.buffer += text;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.length === 0) {
        continue;
      }
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let message: JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;
    try {
      message = JSON.parse(line);
    } catch (err) {
      this.emit("error", new Error(`Failed to parse message: ${line}`));
      return;
    }

    if ("id" in message && ("result" in message || "error" in message)) {
      this.handleResponse(message as JsonRpcResponse);
    } else if ("method" in message && "id" in message) {
      void this.handleRequest(message as JsonRpcRequest);
    } else if ("method" in message) {
      this.handleNotification(message as JsonRpcNotification);
    } else {
      this.emit("error", new Error(`Unrecognized message: ${line}`));
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    this.pending.delete(message.id);
    if (message.error) {
      const err = new Error(message.error.message);
      (err as Error & { code?: number; data?: unknown }).code = message.error.code;
      (err as Error & { code?: number; data?: unknown }).data = message.error.data;
      pending.reject(err);
    } else {
      pending.resolve(message.result);
    }
  }

  private async handleRequest(message: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(message.method);
    if (!handler) {
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `Method not found: ${message.method}` }
      });
      return;
    }
    try {
      const result = await handler(message.params);
      this.send({ jsonrpc: "2.0", id: message.id, result: (result ?? null) as JsonValue });
    } catch (err) {
      const error = err as Error & { code?: number; data?: unknown };
      this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: {
          code: typeof error.code === "number" ? error.code : -32603,
          message: error.message ?? "Internal error",
          data: error.data
        }
      });
    }
  }

  private handleNotification(message: JsonRpcNotification): void {
    const handler = this.notificationHandlers.get(message.method);
    if (handler) {
      try {
        handler(message.params);
      } catch (err) {
        this.emit("error", err);
      }
    }
  }
}
