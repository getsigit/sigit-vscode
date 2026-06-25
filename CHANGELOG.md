# Changelog

All notable changes to the **siGit Code** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] - 2026-06-25

### Fixed

- Agent failed to launch with `spawn sigit ENOENT` when VS Code was started from
  the GUI (Dock, Finder, Spotlight). GUI launches inherit a minimal system PATH
  that omits common install dirs (Homebrew, Cargo, `~/.local/bin`, …), so the
  `sigit` binary couldn't be found even when installed. The agent command is now
  resolved against an augmented PATH that adds those dirs plus the user's
  login-shell PATH.
- A missing agent binary now shows an actionable error with **Open Settings** and
  **Install Guide** actions instead of a raw `ENOENT`, and no longer leaves the
  chat stuck on a hanging request.

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
