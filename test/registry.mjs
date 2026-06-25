#!/usr/bin/env node
// Unit tests for the ACP registry catalog parser.
//
// Bundles the pure `src/catalog.ts` module (no `vscode` dependency) and
// exercises parseCatalog/validateEntry against the official registry schema
// (https://github.com/agentclientprotocol/registry), with a fixed platform so
// binary-distribution resolution is deterministic.
//
// Run: node test/registry.mjs

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { build } from "esbuild";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, "..");

const bundle = await build({
  entryPoints: [join(repoRoot, "src", "catalog.ts")],
  bundle: true,
  write: false,
  format: "cjs",
  platform: "node",
  target: "node18",
  logLevel: "silent"
});

const requireFromTest = createRequire(import.meta.url);
const Module = requireFromTest("node:module");
const compiled = eval(Module.wrap(bundle.outputFiles[0].text));
const moduleObj = { exports: {} };
compiled(moduleObj.exports, requireFromTest, moduleObj, "catalog.bundle.js", repoRoot);
const { parseCatalog, validateEntry } = moduleObj.exports;

const MAC = "darwin-aarch64";

let failures = 0;
function check(cond, msg) {
  if (cond) {
    console.log(`OK ${msg}`);
  } else {
    console.error(`FAIL ${msg}`);
    failures++;
  }
}
function throws(fn, msg) {
  try {
    fn();
    console.error(`FAIL ${msg} (expected throw)`);
    failures++;
  } catch {
    console.log(`OK ${msg}`);
  }
}
const parse = (doc, platform = MAC) => parseCatalog(JSON.stringify(doc), platform);

// npx distribution → `npx -y <package> [args]`.
const npx = parse({
  version: "1.0.0",
  agents: [
    {
      id: "claude-acp",
      name: "Claude Agent",
      version: "0.51.0",
      description: "ACP wrapper for Anthropic's Claude",
      distribution: { npx: { package: "@agentclientprotocol/claude-agent-acp@0.51.0" } }
    }
  ]
}).agents[0];
check(npx.command === "npx", "npx → command is npx");
check(
  JSON.stringify(npx.args) ===
    JSON.stringify(["-y", "@agentclientprotocol/claude-agent-acp@0.51.0"]),
  "npx → args use -y + package"
);
check(npx.distribution === "npx" && npx.manualInstall === false, "npx → not manual install");
check(npx.key === "claude-acp" && npx.version === "0.51.0", "carries id and version");

// npx with extra args.
const npxArgs = parse({
  agents: [
    { id: "a", name: "A", distribution: { npx: { package: "pkg@1", args: ["--acp"] } } }
  ]
}).agents[0];
check(
  JSON.stringify(npxArgs.args) === JSON.stringify(["-y", "pkg@1", "--acp"]),
  "npx → appends distribution args"
);

// uvx distribution → `uvx <package> [args]`.
const uvx = parse({
  agents: [
    { id: "fast", name: "Fast", distribution: { uvx: { package: "fast-agent-acp==0.7.22", args: ["-x"] } } }
  ]
}).agents[0];
check(
  uvx.command === "uvx" &&
    JSON.stringify(uvx.args) === JSON.stringify(["fast-agent-acp==0.7.22", "-x"]),
  "uvx → command + package + args"
);

// binary distribution for the current platform → basename cmd + manual install.
const binDoc = {
  agents: [
    {
      id: "amp-acp",
      name: "Amp",
      distribution: {
        binary: {
          "darwin-aarch64": {
            archive: "https://example.com/amp-darwin-aarch64.tar.gz",
            cmd: "./amp-acp"
          }
        }
      }
    }
  ]
};
const bin = parse(binDoc).agents[0];
check(bin.command === "amp-acp", "binary → command is cmd basename (./amp-acp → amp-acp)");
check(bin.distribution === "binary" && bin.manualInstall === true, "binary → manual install");
check(typeof bin.install === "string" && bin.install.includes("example.com"), "binary → install hint with archive URL");

// binary with no target for this platform → dropped (unrunnable here).
check(parse(binDoc, "linux-x86_64").agents.length === 0, "binary → dropped when no platform target");

// binary + npx prefers npx (zero manual steps).
const both = parse({
  agents: [
    {
      id: "dual",
      name: "Dual",
      distribution: {
        npx: { package: "dual@1" },
        binary: { "darwin-aarch64": { archive: "https://x/y.tgz", cmd: "./dual" } }
      }
    }
  ]
}).agents[0];
check(both.command === "npx" && both.distribution === "npx", "binary+npx → prefers npx");

// Invalid / unusable entries are dropped, not fatal.
const filtered = parse({
  agents: [
    { name: "no id", distribution: { npx: { package: "x" } } },
    { id: "Bad-Id", name: "bad", distribution: { npx: { package: "x" } } },
    { id: "nodist", name: "No dist" },
    { id: "emptydist", name: "Empty", distribution: {} },
    { id: "good", name: "Good", distribution: { npx: { package: "good@1" } } }
  ]
});
check(
  filtered.agents.length === 1 && filtered.agents[0].key === "good",
  "drops entries missing id/name/usable distribution"
);

// Duplicate ids: first wins.
const deduped = parse({
  agents: [
    { id: "dup", name: "First", distribution: { npx: { package: "first@1" } } },
    { id: "dup", name: "Second", distribution: { npx: { package: "second@1" } } }
  ]
});
check(deduped.agents.length === 1 && deduped.agents[0].name === "First", "dedupes by id (first wins)");

// validateEntry on its own.
check(
  validateEntry({ id: "k", name: "K", distribution: { npx: { package: "p" } } }, MAC) !== null,
  "validateEntry accepts a valid npx entry"
);
check(validateEntry({ id: "k", name: "K", distribution: {} }, MAC) === null, "validateEntry rejects empty distribution");
check(validateEntry(null, MAC) === null, "validateEntry rejects null");

// Structural failures throw.
throws(() => parseCatalog("not json", MAC), "throws on invalid JSON");
throws(() => parseCatalog("[]", MAC), "throws on non-object top level");
throws(() => parseCatalog(JSON.stringify({ version: "1.0.0" }), MAC), "throws when agents array missing");
throws(() => parseCatalog(JSON.stringify({ version: "2.0.0", agents: [] }), MAC), "throws on unsupported major version");

if (failures > 0) {
  console.error(`\n${failures} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nALL REGISTRY CHECKS PASSED");
