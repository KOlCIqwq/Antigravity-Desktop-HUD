# Antigravity HUD (`antigravity-hud`)

A HUD toolbar for Google Antigravity that shows live context window usage, generation speed (TTFT and streaming tok/s), model quota, and local token history.

## Let an agent install it for you

Paste this prompt into your AI coding agent (Antigravity, Claude Code, Cursor, or Codex):

```text
Install Antigravity HUD (`antigravity-hud`) for me:
1. Check `node -v` and confirm Node.js is >= 22.4.0 (stop and tell me if it isn't).
2. If you're not already inside the repo, clone https://github.com/KOlCIqwq/Antigravity-HUD.git and `cd` into it.
3. Run `node cli.js check` to locate Antigravity's `app.asar` (if not found automatically, locate it and pass `--path <path-to-app.asar>`).
4. Run `node cli.js install` to back up and patch `app.asar`. If it fails because `app.asar` is locked by a running Antigravity process:
   - If you are an external agent (Claude Code, Cursor, Codex), ask me to close Antigravity and retry.
   - If you are running inside Antigravity itself, give me the exact `node "<repo-path>/cli.js" install` command to run in my terminal after I close Antigravity.
5. Once installed, run `node cli.js status` to verify and summarize the result so I know when to restart Antigravity.
```

> [!TIP]
> Prefer not to modify files on disk? Tell the agent to launch Antigravity with `--remote-debugging-port=9222` and run `node cli.js live` instead of `install`.

## Requirements

- Node.js `>= 22.4.0` (uses built-in `node:sqlite`, `node:test`, and native WebSocket/fetch APIs)
- Google Antigravity desktop app

## Installation

Clone the repository:

```bash
git clone https://github.com/<owner>/antigravity-context-viewer.git
cd antigravity-context-viewer
```

Choose between permanent patching or live injection over CDP.

### Option 1: Permanent install (patches `app.asar`)

1. Close Antigravity completely.
2. Verify path detection:

```bash
node cli.js check
```

If Antigravity is in a custom path, pass `--path <path-to-app.asar>`.

3. Install the toolbar:

```bash
node cli.js install
```

The installer automatically backs up the original `app.asar` to `~/.antigravity-context-bar/backups/app.asar.bak`.

4. Reopen Antigravity.

To uninstall and restore the original `app.asar`:

```bash
node cli.js restore
```

### Option 2: Live injection (CDP, no files modified)

1. Launch Antigravity with debugging enabled:

```bash
antigravity --remote-debugging-port=9222
```

2. Start the live injector bridge:

```bash
node cli.js live
```

Pass `--port <cdpPort>` if using a non-default port. Press `Ctrl+C` to detach.

### Global CLI (optional)

Link the command globally:

```bash
npm link
```

Then run `antigravity-hud <command>` from any directory.

## CLI commands

| Command | Description |
|---|---|
| `node cli.js check [--path <path>]` | Verify Antigravity `app.asar` path |
| `node cli.js status [--path <path>] [--port <port>]` | Show patch status, backup file, and active CDP windows |
| `node cli.js install [--path <path>]` | Back up and patch `app.asar` |
| `node cli.js restore [--path <path>]` | Restore original `app.asar` from backup |
| `node cli.js live [--port <port>]` | Inject via CDP without disk modifications |

## Development and testing

Rebuild the renderer bundle and run the test suite:

```bash
npm test
```

## License

MIT
