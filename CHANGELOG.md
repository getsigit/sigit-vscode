# Changelog

All notable changes to the **siGit Code** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
