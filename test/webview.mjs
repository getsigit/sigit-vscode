#!/usr/bin/env node
// Headless test for the webview's tool-call rendering (media/main.js).
//
// Loads the real webview script against a minimal fake DOM and replays a
// tool_call -> tool_call_update sequence (the model-download flow), asserting
// that updates sharing a toolCallId mutate ONE row in place (with a progress
// bar) instead of stacking new bubbles.
//
// Run: node test/webview.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dirname, "..", "media", "main.js"), "utf8");

function makeEl() {
  return {
    className: "",
    hidden: false,
    style: {},
    textContent: "",
    children: [],
    value: "",
    disabled: false,
    scrollTop: 0,
    scrollHeight: 0,
    appendChild(c) {
      this.children.push(c);
      return c;
    },
    addEventListener() {},
    _innerHTML: "",
    set innerHTML(v) {
      this._innerHTML = v;
      if (!v) {
        this.children = [];
      }
    },
    get innerHTML() {
      return this._innerHTML;
    }
  };
}

const messagesEl = makeEl();
const byId = {
  messages: messagesEl,
  status: makeEl(),
  composer: makeEl(),
  input: makeEl(),
  send: makeEl()
};

let messageHandler = null;
globalThis.acquireVsCodeApi = () => ({ postMessage() {}, getState() {}, setState() {} });
globalThis.document = {
  getElementById: (id) => byId[id],
  createElement: () => makeEl()
};
globalThis.window = {
  addEventListener: (type, fn) => {
    if (type === "message") {
      messageHandler = fn;
    }
  }
};

// Run the real webview IIFE in this faked global context.
(0, eval)(src);

function send(msg) {
  messageHandler({ data: msg });
}
function toolRows() {
  return messagesEl.children.filter((c) => c.className.includes("message-tool"));
}
function assert(cond, msg) {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
}

assert(typeof messageHandler === "function", "webview registered a message handler");

// Same toolCallId across four updates -> exactly one row.
send({ type: "tool", toolCallId: "tc1", title: "Downloading Qwen 2.5 3B", status: "in_progress" });
send({ type: "tool", toolCallId: "tc1", title: "Downloading Qwen 2.5 3B (~1.80 GB) (0%)", status: "in_progress" });
send({ type: "tool", toolCallId: "tc1", title: "Downloading Qwen 2.5 3B (~1.80 GB) (50%)", status: "in_progress" });
send({ type: "tool", toolCallId: "tc1", status: "failed" }); // no title -> keep prior label

assert(toolRows().length === 1, `4 updates should yield 1 row, got ${toolRows().length}`);
console.log(`OK in-place: 4 updates -> ${toolRows().length} row`);

const row = toolRows()[0];
assert(row.className.includes("tool-failed"), `final status class was "${row.className}"`);
console.log("OK final status -> tool-failed");

const bubble = row.children[0];
const labelEl = bubble.children[0];
const bar = bubble.children[1].children[0];
assert(
  labelEl.textContent === "Downloading Qwen 2.5 3B (~1.80 GB) — failed",
  `label was "${labelEl.textContent}"`
);
console.log(`OK label updated in place: "${labelEl.textContent}"`);
assert(bar.style.width === "50%", `progress width was "${bar.style.width}"`);
console.log(`OK progress bar at ${bar.style.width}`);

// A different toolCallId makes a new row.
send({ type: "tool", toolCallId: "tc2", title: "Reading file", status: "completed" });
assert(toolRows().length === 2, `distinct id should add a row, got ${toolRows().length}`);
console.log("OK distinct toolCallId -> new row");

// clear() resets tracking so ids can be reused cleanly.
send({ type: "clear" });
send({ type: "tool", toolCallId: "tc1", title: "Again", status: "in_progress" });
assert(toolRows().length === 1, `after clear expected 1 row, got ${toolRows().length}`);
console.log("OK clear resets tool tracking");

console.log("\nALL WEBVIEW CHECKS PASSED");
