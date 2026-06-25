#!/usr/bin/env node
// A minimal Agent Client Protocol agent used by the smoke test.
// Reads newline-delimited JSON-RPC 2.0 from stdin and writes the same on stdout.
// Implements just enough of the protocol to exercise the extension's client:
//   - initialize        → returns protocolVersion + agent capabilities
//   - session/new       → returns a session id
//   - session/prompt    → streams two agent_message_chunk updates, then a
//                         tool_call update, then resolves with stopReason
//   - session/cancel    → no-op (notification)
// Also exercises inbound agent→client calls: fs/read_text_file before responding.

import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

let sessionCounter = 0;
let nextId = 1;
const pending = new Map();

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
  });
}

async function handlePrompt(params) {
  const { sessionId, prompt } = params;
  const userText = (prompt?.[0]?.text ?? "").trim();

  // Demonstrate an inbound agent→client request (fs/read_text_file).
  try {
    await request("fs/read_text_file", { path: "package.json" });
  } catch {
    // ignore — smoke test cares about the round-trip, not the contents
  }

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `echo: ${userText}` }
    }
  });

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: " (done)" }
    }
  });

  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "tc_1",
      title: "noop_tool",
      status: "completed"
    }
  });

  return { stopReason: "end_turn" };
}

const requestHandlers = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { promptCapabilities: { embeddedContext: true } }
  }),
  "session/new": () => {
    sessionCounter += 1;
    return { sessionId: `sess_${sessionCounter}` };
  },
  "session/prompt": handlePrompt
};

const notificationHandlers = {
  "session/cancel": () => {
    // accepted; no-op for the smoke test
  }
};

rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) {
    return;
  }
  let msg;
  try {
    msg = JSON.parse(text);
  } catch {
    return;
  }

  // Response to one of our outbound requests
  if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
    const pendingEntry = pending.get(msg.id);
    if (pendingEntry) {
      pending.delete(msg.id);
      if (msg.error) {
        pendingEntry.reject(new Error(msg.error.message));
      } else {
        pendingEntry.resolve(msg.result);
      }
    }
    return;
  }

  // Inbound request
  if (msg.id !== undefined && msg.method) {
    const handler = requestHandlers[msg.method];
    if (!handler) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32601, message: `Method not found: ${msg.method}` }
      });
      return;
    }
    try {
      const result = await handler(msg.params);
      send({ jsonrpc: "2.0", id: msg.id, result });
    } catch (err) {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        error: { code: -32603, message: err.message ?? "Internal error" }
      });
    }
    return;
  }

  // Inbound notification
  if (msg.method) {
    notificationHandlers[msg.method]?.(msg.params);
  }
});
