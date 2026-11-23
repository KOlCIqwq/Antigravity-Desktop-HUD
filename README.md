<div align="center">

# Antigravity HUD (`antigravity-hud`)

**A status bar for Google Antigravity that tracks live context usage, generation speed, model quota, and local token history.**

![Node.js >= 22.4.0](https://img.shields.io/badge/node-%3E%3D22.4.0-339933?style=flat-square&logo=nodedotjs&logoColor=white)
![Platform: Windows | macOS | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)
![Zero Dependencies](https://img.shields.io/badge/dependencies-zero-2ea44f?style=flat-square)
![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)

<br />

<img src="assets/images/hero-showcase.png" alt="Antigravity HUD toolbar pills and Quota, Live, and History panels" width="100%" />

</div>

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
git clone https://github.com/KOlCIqwq/Antigravity-HUD.git
cd Antigravity-HUD
```

Choose between permanent patching or live injection over CDP.

### Option 1: Permanent install (patches `app.asar`)

1. Close Antigravity completely.
2. Verify path detection (pass `--path <path-to-app.asar>` if Antigravity is in a custom location):

   ```bash
   node cli.js check
   ```

3. Install Antigravity HUD (automatically backs up the original `app.asar` before patching):

   ```bash
   node cli.js install
   ```

4. Reopen Antigravity.

#### Auto-repatch after Antigravity updates

Antigravity updates overwrite `app.asar` and drop the HUD patch. To handle this without manual terminal commands, `node cli.js install` also installs a small Antigravity plugin at `~/.gemini/config/plugins/antigravity-hud-watcher/` (with a `hooks.json` entry and a local copy of the HUD files).

`SessionStart` and `PreInvocation` hooks when a session runs:
- If `app.asar` is still patched, the hook exits right away and does nothing.
- If an Antigravity update replaced `app.asar`, it sends a system notification (`Antigravity updated. Restart Antigravity to reload HUD.`) and starts a background helper that tracks the running Antigravity PIDs, waits for them to exit, refreshes `app.asar.bak`, and re-patches `app.asar` for the next launch (logging to `~/.antigravity-context-bar/watcher.log`).

Running `node cli.js restore` restores the original `app.asar` from backup and deletes `~/.gemini/config/plugins/antigravity-hud-watcher/`.

To uninstall and restore the original `app.asar` and remove the watcher plugin:

```bash
node cli.js restore
```

### Option 2: Live injection (CDP, no files modified)

1. Launch Antigravity with debugging enabled:

   ```bash
   antigravity --remote-debugging-port=9222
   ```

2. Start the live injector bridge (pass `--port <cdpPort>` for a non-default port; press `Ctrl+C` to detach):

   ```bash
   node cli.js live
   ```

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
| `node cli.js status [--path <path>] [--port <port>]` | Show patch status, backup file, watcher plugin status, and active CDP windows |
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
