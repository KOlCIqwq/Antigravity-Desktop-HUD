# Antigravity HUD (`antigravity-hud`)

A zero-dependency HUD toolbar for Google Antigravity that shows live context window usage, generation speed (TTFT and streaming tok/s), model quota, and local token history.

## Requirements

- Node.js `>= 22.4.0` (uses the built-in `node:sqlite`, `node:test`, and WebSocket/fetch APIs)
- Google Antigravity desktop app

No `npm install` is needed. There are no external npm dependencies.

## Installation

Clone the repository:

```bash
git clone <your-repo-url>
cd antigravity-context-viewer
```

You can either patch Antigravity's `app.asar` permanently (survives restarts until Antigravity updates) or inject live over Chrome DevTools Protocol (CDP) without modifying files on disk.

### Option 1: Permanent install (patches `app.asar`)

1. Close Antigravity completely.
2. Check that `app.asar` is detected:

```bash
node cli.js check
```

If Antigravity is installed in a non-standard location, pass `--path <path-to-app.asar>`.

3. Install the toolbar (automatically backs up the original `app.asar` to `~/.antigravity-context-bar/backups/app.asar.bak`):

```bash
node cli.js install
```

4. Reopen Antigravity.

To uninstall and restore the original `app.asar`:

```bash
node cli.js restore
```

### Option 2: Live injection (no disk patch, via CDP)

1. Launch Antigravity with remote debugging enabled:

```bash
antigravity --remote-debugging-port=9222
```

2. Run the live injector and keep the terminal open (it runs a local HTTP bridge on `127.0.0.1`):

```bash
node cli.js live
```

Pass `--port <cdpPort>` if Antigravity is listening on a different CDP port. Press `Ctrl+C` to stop the bridge.

### Global CLI (optional)

Link the `antigravity-hud` binary globally:

```bash
npm link
```

Then run `antigravity-hud check`, `antigravity-hud install`, `antigravity-hud status`, `antigravity-hud live`, or `antigravity-hud restore` from any directory.

## CLI commands

| Command | Description |
|---|---|
| `node cli.js check [--path <app.asar>]` | Verify `app.asar` path detection |
| `node cli.js status [--path <app.asar>] [--port <cdpPort>]` | Show patch status, backup status, and active CDP pages |
| `node cli.js install [--path <app.asar>]` | Back up and patch `app.asar` |
| `node cli.js restore [--path <app.asar>]` | Restore `app.asar` from backup (or strip injected blocks in-place) |
| `node cli.js live [--port <cdpPort>]` | Inject into running Antigravity windows over CDP and start the local bridge |

## Project layout

- `cli.js` - CLI entry point (`check`, `status`, `install`, `live`, `restore`)
- `installer.js` - `app.asar` patching, backup/restore, and CDP live injection
- `asar.js` - Zero-dependency ASAR reader/writer
- `cdp.js` - CDP discovery, WebSocket client, and daemon hub discovery
- `main-hook.js` - Electron main-process IPC handlers and window injection
- `live-server.js` - Local HTTP bridge used by `live` mode
- `core.js`, `collector.js`, `insights.js` - CommonJS loaders for `src/core`, `src/collector`, and `src/insights`
- `scripts/build-renderer.js` - Assembles `src/core` and `src/renderer` into the injected bundle
- `src/core/` - Pure domain logic (token counting, model resolution, pricing, plans, scales, quota, experience score)
- `src/collector/` - Local data collection (RPC, pricing ledger, account attribution, settings, quota host, WSL/local paths, SQLite metadata, history/timeline scanners, updater)
- `src/insights/` - Session deep-dive and cross-session analytics
- `src/renderer/` - Shadow-DOM UI (`styles.css`, `template.html`, `i18n.js`, `colors.js`, `budget.js`, `dropdown.js`, `heatmap.js`, `inspector.js`, and `main/`)

## Development and testing

Verify bundle assembly and run the test suite:

```bash
npm test
```

## License

MIT
