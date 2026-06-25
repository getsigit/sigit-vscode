import { execFileSync } from "child_process";
import { accessSync, constants, statSync } from "fs";
import { homedir } from "os";
import { delimiter, isAbsolute, join } from "path";

/**
 * Locating the agent binary across launch contexts.
 *
 * When VS Code is launched from a GUI (Dock, Finder, Spotlight) rather than a
 * terminal, the process inherits a minimal system PATH that omits the dirs
 * where developer tools are usually installed (Homebrew, Cargo, ~/.local/bin,
 * etc.). A `command` like `sigit` then fails to spawn with ENOENT even though
 * it runs fine from the user's terminal. We work around this by resolving the
 * command against an *augmented* PATH that adds the common install locations
 * and, on macOS/Linux, the user's real login-shell PATH.
 */

let cachedLoginPath: string | null | undefined;

/** Common install directories that GUI launches frequently miss. */
function commonBinDirs(): string[] {
  const home = homedir();
  if (process.platform === "win32") {
    return [];
  }
  return [
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    join(home, ".local", "bin"),
    join(home, "bin"),
    join(home, ".cargo", "bin"),
    join(home, ".bun", "bin"),
    join(home, ".deno", "bin"),
    join(home, "go", "bin"),
    join(home, ".sigit", "bin")
  ];
}

/**
 * The PATH exported by the user's interactive login shell. GUI-launched apps on
 * macOS don't inherit this, so we ask the shell directly. Cached after the
 * first (best-effort, time-boxed) lookup.
 */
function loginShellPath(): string | undefined {
  if (cachedLoginPath !== undefined) {
    return cachedLoginPath ?? undefined;
  }
  cachedLoginPath = null;
  if (process.platform === "win32") {
    return undefined;
  }
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    // `-ilc` → interactive login shell running one command. We echo a sentinel
    // around PATH so noisy rc-file output doesn't corrupt the value.
    const out = execFileSync(shell, ["-ilc", 'printf "__SIGIT_PATH__%s__SIGIT_END__" "$PATH"'], {
      encoding: "utf8",
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    const match = /__SIGIT_PATH__([\s\S]*?)__SIGIT_END__/.exec(out);
    if (match && match[1]) {
      cachedLoginPath = match[1];
    }
  } catch {
    // Shell missing, slow, or non-interactive — fall back to common dirs only.
  }
  return cachedLoginPath ?? undefined;
}

/**
 * A PATH string combining the current process PATH, the login-shell PATH, and
 * the common install dirs — de-duplicated, original order preserved.
 */
export function augmentedPath(): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const push = (value: string | undefined) => {
    if (!value) {
      return;
    }
    for (const dir of value.split(delimiter)) {
      if (dir && !seen.has(dir)) {
        seen.add(dir);
        parts.push(dir);
      }
    }
  };
  push(process.env.PATH);
  push(loginShellPath());
  for (const dir of commonBinDirs()) {
    push(dir);
  }
  return parts.join(delimiter);
}

function isExecutableFile(p: string): boolean {
  try {
    if (!statSync(p).isFile()) {
      return false;
    }
    if (process.platform === "win32") {
      return true;
    }
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** On Windows, the suffixes that make a bare command name executable. */
function windowsExts(): string[] {
  const pathext = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD";
  return pathext.split(";").filter(Boolean);
}

/**
 * Resolve `command` to an absolute executable path, searching `pathString`
 * (defaults to the augmented PATH). Returns undefined when nothing matches.
 *
 * An absolute or path-qualified command is returned as-is when it points at an
 * executable file, so explicit user configuration always wins.
 */
export function resolveExecutable(command: string, pathString = augmentedPath()): string | undefined {
  if (!command) {
    return undefined;
  }

  const hasPathSep = command.includes("/") || command.includes("\\");
  if (isAbsolute(command) || hasPathSep) {
    if (isExecutableFile(command)) {
      return command;
    }
    if (process.platform === "win32") {
      for (const ext of windowsExts()) {
        const candidate = command + ext;
        if (isExecutableFile(candidate)) {
          return candidate;
        }
      }
    }
    return undefined;
  }

  for (const dir of pathString.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const base = join(dir, command);
    if (isExecutableFile(base)) {
      return base;
    }
    if (process.platform === "win32") {
      for (const ext of windowsExts()) {
        const candidate = base + ext;
        if (isExecutableFile(candidate)) {
          return candidate;
        }
      }
    }
  }
  return undefined;
}
