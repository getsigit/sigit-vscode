#!/usr/bin/env node
// End-to-end smoke test for the ACP client.
//
// Spawns the mock ACP agent and drives the real AcpClient through the full
// handshake → session → prompt round-trip. Verifies that streaming updates
// reach the host, the inbound fs/read_text_file call is honored, and the
// prompt resolves with the agent's stop reason.
//
// Run: node test/smoke.mjs

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");
const mockAgent = join(__dirname, "mock-agent", "mock-agent.mjs");

// Bundle the AcpClient on the fly so we can import the TypeScript source
// without a separate build step.
const bundle = await build({
  entryPoints: [join(repoRoot, "src", "acp", "client.ts")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "node18",
  external: ["vscode"],
  logLevel: "silent"
});

const code = bundle.outputFiles[0].text;
const requireFromTest = createRequire(import.meta.url);

// Evaluate the bundle in a fresh module context.
const Module = requireFromTest("node:module");
const wrapped = Module.wrap(code);
const compiled = eval(wrapped);
const moduleObj = { exports: {} };
compiled(moduleObj.exports, requireFromTest, moduleObj, "client.bundle.js", repoRoot);
const { AcpClient } = moduleObj.exports;

function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

const events = [];
let fsReadCalled = false;

const client = new AcpClient({
  requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  readTextFile: async (params) => {
    fsReadCalled = true;
    return `// pretend contents of ${params.path}\n`;
  },
  writeTextFile: async () => {
    // no writes in this scenario
  }
});

client.on("update", (u) => events.push(u));
client.on("error", (err) => {
  console.error("client error:", err.message);
  process.exit(1);
});

client.spawn({ command: process.execPath, args: [mockAgent], cwd: repoRoot, env: {} });

try {
  const sessionId = await client.initialize(repoRoot);
  assert(typeof sessionId === "string" && sessionId.startsWith("sess_"), "got sessionId");
  console.log(`OK initialize → session ${sessionId}`);

  const stopReason = await client.prompt("hello world");
  assert(stopReason === "end_turn", `stopReason was "${stopReason}"`);
  console.log(`OK prompt → stopReason ${stopReason}`);

  assert(fsReadCalled, "agent's fs/read_text_file request reached the host");
  console.log("OK inbound fs/read_text_file round-tripped");

  const chunks = events.filter((e) => e.update?.sessionUpdate === "agent_message_chunk");
  const text = chunks.map((c) => c.update.content.text).join("");
  assert(text === "echo: hello world (done)", `streamed text was "${text}"`);
  console.log(`OK streamed ${chunks.length} message chunks → "${text}"`);

  const tools = events.filter((e) => e.update?.sessionUpdate === "tool_call");
  assert(tools.length === 1, `expected 1 tool_call update, got ${tools.length}`);
  console.log(`OK received tool_call update`);

  console.log("\nALL SMOKE CHECKS PASSED");
} finally {
  client.dispose();
}
