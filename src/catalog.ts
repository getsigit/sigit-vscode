/**
 * The ACP agent catalog: parsing for the official Agent Client Protocol
 * registry (https://github.com/agentclientprotocol/registry) and the logic that
 * resolves a registry entry's distribution into a runnable launch command.
 *
 * This module deliberately has no `vscode` dependency so it can be unit-tested
 * in isolation (see `test/registry.mjs`). All network, configuration, and
 * installation concerns live in `registry.ts`.
 *
 * Registry documents follow the published schema:
 *   https://cdn.agentclientprotocol.com/registry/v1/latest/agent.schema.json
 * Each agent declares one or more distribution methods (`npx`, `uvx`, or
 * per-platform `binary`). siGit "installs" an agent by registering a launch
 * command derived from that distribution — it never downloads or runs a binary
 * on the user's behalf. `npx`/`uvx` agents are fetched on demand by the package
 * runner at spawn time; `binary` agents are registered with a manual-install
 * hint so the user can place the binary on their PATH.
 */

export type DistributionKind = "npx" | "uvx" | "binary";

export interface RegistryAgent {
  /** Stable registry id (used as the `sigit.agents` key). */
  key: string;
  name: string;
  /** Resolved launch command (e.g. `npx`). */
  command: string;
  args: string[];
  env: Record<string, string>;
  description?: string;
  version?: string;
  website?: string;
  repository?: string;
  /** Which distribution method the launch command was resolved from. */
  distribution: DistributionKind;
  /** True when the user must install a binary themselves before first use. */
  manualInstall: boolean;
  /** Human-readable install hint (download URL, etc.); never executed. */
  install?: string;
}

export interface Catalog {
  version: string;
  agents: RegistryAgent[];
}

/** Platform keys used by the registry's `binary` distribution targets. */
export type PlatformKey =
  | "darwin-aarch64"
  | "darwin-x86_64"
  | "linux-aarch64"
  | "linux-x86_64"
  | "windows-aarch64"
  | "windows-x86_64";

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** The registry platform key for the host running this process. */
export function currentPlatformKey(): PlatformKey | undefined {
  const os =
    process.platform === "darwin"
      ? "darwin"
      : process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : undefined;
  const arch =
    process.arch === "arm64" ? "aarch64" : process.arch === "x64" ? "x86_64" : undefined;
  if (!os || !arch) {
    return undefined;
  }
  return `${os}-${arch}` as PlatformKey;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface PackageDistribution {
  package: string;
  args: string[];
  env: Record<string, string>;
}

function readPackage(raw: unknown): PackageDistribution | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const obj = raw as { package?: unknown; args?: unknown; env?: unknown };
  if (typeof obj.package !== "string" || obj.package.trim() === "") {
    return null;
  }
  if (obj.args !== undefined && !isStringArray(obj.args)) {
    return null;
  }
  if (obj.env !== undefined && !isStringRecord(obj.env)) {
    return null;
  }
  return {
    package: obj.package,
    args: isStringArray(obj.args) ? obj.args : [],
    env: isStringRecord(obj.env) ? obj.env : {}
  };
}

/** The launch fields resolved from a distribution method. */
interface ResolvedLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
  distribution: DistributionKind;
  manualInstall: boolean;
  install?: string;
}

/** Strip any directory prefix from a binary `cmd` (`./amp-acp` → `amp-acp`). */
function commandBasename(cmd: string): string {
  const cleaned = cmd.replace(/^\.\//, "");
  const parts = cleaned.split(/[\\/]/);
  return parts[parts.length - 1] || cleaned;
}

/**
 * Resolve a `distribution` object into a runnable launch, preferring the
 * zero-manual-step package runners (`npx`, then `uvx`) and falling back to the
 * platform `binary` target. Returns `null` when nothing is usable on this
 * platform.
 */
function resolveDistribution(
  distribution: unknown,
  platform: PlatformKey | undefined
): ResolvedLaunch | null {
  if (typeof distribution !== "object" || distribution === null) {
    return null;
  }
  const dist = distribution as { npx?: unknown; uvx?: unknown; binary?: unknown };

  const npx = readPackage(dist.npx);
  if (npx) {
    return {
      command: "npx",
      args: ["-y", npx.package, ...npx.args],
      env: npx.env,
      distribution: "npx",
      manualInstall: false
    };
  }

  const uvx = readPackage(dist.uvx);
  if (uvx) {
    return {
      command: "uvx",
      args: [uvx.package, ...uvx.args],
      env: uvx.env,
      distribution: "uvx",
      manualInstall: false
    };
  }

  if (platform && typeof dist.binary === "object" && dist.binary !== null) {
    const target = (dist.binary as Record<string, unknown>)[platform];
    if (typeof target === "object" && target !== null) {
      const t = target as { archive?: unknown; cmd?: unknown; args?: unknown; env?: unknown };
      if (typeof t.cmd === "string" && t.cmd.trim() !== "") {
        const archive = optionalString(t.archive);
        return {
          command: commandBasename(t.cmd),
          args: isStringArray(t.args) ? t.args : [],
          env: isStringRecord(t.env) ? t.env : {},
          distribution: "binary",
          manualInstall: true,
          install: archive
            ? `Manual install required: download ${archive} and ensure "${commandBasename(
                t.cmd
              )}" is on your PATH.`
            : undefined
        };
      }
    }
  }

  return null;
}

/**
 * Validate and resolve a single raw registry entry. Returns a normalized
 * {@link RegistryAgent}, or `null` when required fields are missing or no
 * distribution is usable on the given platform. Invalid entries are skipped
 * rather than failing the whole catalog.
 */
export function validateEntry(raw: unknown, platform = currentPlatformKey()): RegistryAgent | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const entry = raw as { id?: unknown; name?: unknown; distribution?: unknown } & Record<
    string,
    unknown
  >;
  if (typeof entry.id !== "string" || !ID_PATTERN.test(entry.id)) {
    return null;
  }
  if (typeof entry.name !== "string" || entry.name.trim() === "") {
    return null;
  }
  const launch = resolveDistribution(entry.distribution, platform);
  if (!launch) {
    return null;
  }

  return {
    key: entry.id,
    name: entry.name,
    command: launch.command,
    args: launch.args,
    env: launch.env,
    description: optionalString(entry.description),
    version: optionalString(entry.version),
    website: optionalString(entry.website),
    repository: optionalString(entry.repository),
    distribution: launch.distribution,
    manualInstall: launch.manualInstall,
    install: launch.install
  };
}

/**
 * Parse the raw registry document text into a {@link Catalog}. Throws when the
 * document is not valid JSON, has the wrong top-level shape, or declares an
 * unsupported major version; individual unresolvable entries are dropped (see
 * {@link validateEntry}).
 */
export function parseCatalog(text: string, platform = currentPlatformKey()): Catalog {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw new Error(`Registry is not valid JSON: ${(err as Error).message}`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new Error("Registry must be a JSON object with an `agents` array.");
  }
  const obj = doc as { version?: unknown; agents?: unknown };
  if (!Array.isArray(obj.agents)) {
    throw new Error("Registry is missing the `agents` array.");
  }
  const version = typeof obj.version === "string" ? obj.version : "1.0.0";
  if (!/^1\b|^1\./.test(version)) {
    throw new Error(`Unsupported registry version "${version}"; expected 1.x.`);
  }

  const seen = new Set<string>();
  const agents: RegistryAgent[] = [];
  for (const raw of obj.agents) {
    const agent = validateEntry(raw, platform);
    if (agent && !seen.has(agent.key)) {
      seen.add(agent.key);
      agents.push(agent);
    }
  }
  return { version, agents };
}
