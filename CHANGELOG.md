# Changelog

All notable changes to the **siGit Code** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-06-26

### Added

- Agent registry browser. **siGit: Browse Agent Registry** and **siGit: Refresh
  Agent Registry** fetch an ACP agent catalog (set the source with
  `sigit.registry.url`), keep the last good copy for offline use, and install a
  chosen agent by writing its launch command into `sigit.agents`. Install here
  means register the command; siGit does not download or run agent binaries for
  you.

### Fixed

- Agent failed to launch with `spawn sigit ENOENT` when VS Code was started from
  the GUI (Dock, Finder, Spotlight). GUI launches inherit a minimal system PATH
  that omits common install dirs (Homebrew, Cargo, `~/.local/bin`, and so on), so
  the
  `sigit` binary couldn't be found even when installed. The agent command is now
  resolved against an augmented PATH that adds those dirs plus the user's
  login-shell PATH.
- A missing agent binary now shows an actionable error with **Open Settings** and
  **Install Guide** actions instead of a raw `ENOENT`, and no longer leaves the
  chat stuck on a hanging request.
- Model load failed with `Operation not permitted (os error 1)` (EPERM) when the
  agent ran outside the Onde Inference app. The `sigit` agent redirects its
  HuggingFace cache into a macOS App Group container that only entitled,
  app-sandboxed processes may write to; a `sigit` spawned by VS Code has no such
  entitlement. The extension now passes writable `HF_HOME` / `HF_HUB_CACHE`
  defaults (`~/.cache/huggingface`) so model downloads land in a directory the
  editor's child process can write to. A real `HF_HOME`/`HF_HUB_CACHE` env var or
  an agent `env` entry still takes precedence.

### Changed

- Tool calls now stream in place. A `tool_call` and its `tool_call_update`s share
  a `toolCallId` and update one row with a progress bar, instead of adding a new
  bubble per update. Model-download progress used to stack as separate
  "Downloading 0%", "50%", and "failed" lines; now it stays on one row.
- Packaging excludes `.claude/` and lockfiles from the VSIX, so the bundle is
  smaller and stray worktree copies no longer get shipped.

## [1.0.0] - 2026-06-25

### Added

- Initial release: ACP (Agent Client Protocol) client extension for siGit Code.
- On-device `sigit` agent as the local-first default.
- JSON-RPC 2.0 peer over newline-delimited JSON for ACP transport.
- ACP handshake (`initialize` → `session/new` → `session/prompt`) with streaming
  `session/update` notifications (message, thought, and tool-call chunks).
- Inbound agent requests: `session/request_permission`, `fs/read_text_file`,
  `fs/write_text_file`.
- Webview chat view in the Activity Bar with streaming output.
- Agent registry (`sigit.agents`) and permission modes (`prompt`/`allow`/`deny`).
- Commands: open chat, new session, select agent, restart agent.
