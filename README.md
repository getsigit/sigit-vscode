# siGit Code — On-device AI Coding Agent

**Your code never has to leave your machine.** siGit Code is a local-first AI
coding agent for VS Code. It runs the on-device [`sigit`](https://code.sigit.si)
agent, a quantized (GGUF) model that executes entirely on your hardware and
works offline, and brings it into the editor as a chat-driven pair programmer.

There are no cloud round-trips and no API keys for the default agent. The model
lives on your device, and so does your code.

siGit Code also speaks the open [Agent Client
Protocol](https://agentclientprotocol.com) (ACP), so it can drive other
ACP-compatible agents over stdio. The on-device agent is still the point.

## Why local-first

- Your prompts and file contents stay on your machine.
- It works offline, including on a plane or behind an air gap.
- There is no per-token billing, so you can run it as much as your hardware allows.
- You choose the model and the weights, and they do not change underneath you.

ACP and multi-agent support are there for when you need a hosted agent. They are
not the headline.

## Requirements

- VS Code `^1.90.0`
- The `sigit` binary on your `PATH`.
  Install it from [code.sigit.si](https://code.sigit.si).

> siGit Code only *spawns* the `sigit` binary over ACP, so it has no build-time
> dependency on the agent. Install the agent separately.

## Getting started

1. Install the `sigit` agent (see [code.sigit.si](https://code.sigit.si)) and
   confirm `sigit` runs from your terminal.
2. Install this extension.
3. Click the **siGit Code** icon in the Activity Bar to open the chat view.
4. Type a prompt and press **Enter**. The extension spawns the agent, opens a
   session in your workspace folder, and streams the response.

Commands (Command Palette):

| Command | Description |
| --- | --- |
| `siGit: Open Chat` | Reveal the chat view. |
| `siGit: New Session` | Start a fresh session with the active agent. |
| `siGit: Select Agent` | Pick an agent from the registry. |
| `siGit: Restart Agent` | Restart the active agent process. |

## Configuration

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `sigit.agent.default` | string | `"sigit"` | Key of the agent used by default, looked up in `sigit.agents`. |
| `sigit.agents` | object | on-device `sigit` | Registry of ACP agents (`{ name, command, args, env }`). |
| `sigit.permission.mode` | enum | `"prompt"` | `prompt`, `allow`, or `deny` for agent-requested actions. |

### Add another ACP agent

The default registry contains only the on-device agent. To add another
ACP-compatible agent, extend `sigit.agents` in your `settings.json`:

```jsonc
{
  "sigit.agents": {
    "sigit": {
      "name": "siGit (on-device)",
      "command": "sigit",
      "args": [],
      "env": {}
    },
    "claude-code": {
      "name": "Claude Code (ACP)",
      "command": "claude-code-acp",
      "args": [],
      "env": {}
    },
    "gemini": {
      "name": "Gemini CLI (ACP)",
      "command": "gemini",
      "args": ["--experimental-acp"],
      "env": {}
    }
  },
  "sigit.agent.default": "sigit"
}
```

Then run **`siGit: Select Agent`** to switch between them.

## Development

This project uses [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm run watch       # esbuild in watch mode
# Press F5 to launch the Extension Development Host
```

Other scripts:

```bash
pnpm run compile     # tsc --noEmit type check
pnpm run lint        # eslint
pnpm run build       # production bundle (esbuild)
pnpm run test:smoke  # ACP round-trip against a mock agent
pnpm run package     # vsce package (.vsix)
```

## Releasing

Publishing is automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml).
It runs the test suite, packages one `.vsix`, and publishes that same file to the
VS Code Marketplace (`vsce`) and Open VSX (`ovsx`).

One-time setup, stored as repository secrets:

- `VSCE_PAT`: an Azure DevOps personal access token for the `getsigit`
  Marketplace publisher (Marketplace > Manage scope).
- `OVSX_PAT`: an access token for the `getsigit` namespace on
  [open-vsx.org](https://open-vsx.org). The workflow creates the namespace on
  first publish if it does not exist.

To cut a release:

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Push to `main`, then create a GitHub Release whose tag is `v<version>` (for
   example `v1.0.1`). The workflow checks the tag against `package.json` and
   fails on a mismatch.
3. The release publishes to both registries and attaches the `.vsix` to the
   GitHub Release.

To test packaging without publishing, run the workflow manually from the Actions
tab with **publish** left unchecked. It uploads the `.vsix` as a build artifact.

## License

[MIT](./LICENSE) © 2026 siGit Code & Deploy
