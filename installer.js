'use strict';
const fs = require('fs');
const os = require('os');
const vm = require('vm');
const path = require('path');
const crypto = require('crypto');
const {
  getRawFs,
  getStateDir,
  extractFile,
  collectUnpackedPaths,
  extractAll,
  createPackage,
  findAsarPath
} = require('./asar');
const { discoverCdp, createCdpClient } = require('./cdp');
const { startLiveServer } = require('./live-server');
const { assembleCore, assembleRenderer } = require('./scripts/build-renderer');

const TAGS = {
  UTILS_START: '/* __CONTEXT_BAR_UTILS_START__ */',
  UTILS_END: '/* __CONTEXT_BAR_UTILS_END__ */',
  PRELOAD_START: '/* __CONTEXT_BAR_PRELOAD_START__ */',
  PRELOAD_END: '/* __CONTEXT_BAR_PRELOAD_END__ */'
};

const LOAD_URL_MARKERS = [
  'await win.loadURL(url);',
  'win.loadURL(url);',
  'win.loadURL(targetUrl);'
];

function validateSyntax(code, filename) {
  try {
    new vm.Script(code, { filename });
    return true;
  } catch {
    return false;
  }
}

function stripTaggedBlock(src, startTag, endTag) {
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return src.replace(new RegExp(`\\r?\\n?${esc(startTag)}[\\s\\S]*?${esc(endTag)}\\r?\\n?`, 'g'), '');
}

function findLoadUrlMarker(utilsCode) {
  for (const m of LOAD_URL_MARKERS) {
    if (utilsCode.includes(m)) return m;
  }
  return null;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(getRawFs().readFileSync(filePath)).digest('hex');
}

function isAsarPatched(asarPath) {
  try {
    const utils = extractFile(asarPath, 'dist/utils.js').toString('utf8');
    const preload = extractFile(asarPath, 'dist/preload.js').toString('utf8');
    return utils.includes(TAGS.UTILS_START) && preload.includes(TAGS.PRELOAD_START);
  } catch {
    return false;
  }
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

function getPluginsDir(opts = {}) {
  if (opts.pluginsDir) return path.resolve(opts.pluginsDir);
  if (process.env.ANTIGRAVITY_PLUGINS_DIR) return path.resolve(process.env.ANTIGRAVITY_PLUGINS_DIR);
  return path.join(os.homedir(), '.gemini', 'config', 'plugins');
}

function getWatcherPluginDir(opts = {}) {
  return path.join(getPluginsDir(opts), 'antigravity-hud-watcher');
}

function copyHudRuntime(rootDir, destDir) {
  const copies = [
    ['main-hook.js', 'context-bar-main.js'],
    ['core.js', 'core.js'],
    ['collector.js', 'collector.js'],
    ['insights.js', 'insights.js'],
    ['cdp.js', 'cdp.js'],
    ['asar.js', 'asar.js'],
    ['package.json', 'package.json']
  ];
  fs.mkdirSync(destDir, { recursive: true });
  for (const [srcName, destName] of copies) {
    fs.copyFileSync(path.join(rootDir, srcName), path.join(destDir, destName));
  }
  fs.mkdirSync(path.join(destDir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(rootDir, 'scripts', 'build-renderer.js'), path.join(destDir, 'scripts', 'build-renderer.js'));
  copyDirRecursive(path.join(rootDir, 'src'), path.join(destDir, 'src'));
}

function buildWatcherCheckSource() {
  return `'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isAsarPatched, findAsarPath, getStateDir } = require('./hud/installer');

function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function main() {
  let asarPath;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
    asarPath = cfg.asarPath && fs.existsSync(cfg.asarPath) ? cfg.asarPath : findAsarPath();
  } catch {
    try { asarPath = findAsarPath(); } catch { return; }
  }
  if (!asarPath || isAsarPatched(asarPath)) return;

  const lockPath = path.join(getStateDir(), 'watcher.pid');
  try {
    const existingPid = Number(fs.readFileSync(lockPath, 'utf8').trim());
    if (isPidAlive(existingPid)) return;
  } catch {}

  const child = spawn(process.execPath, [
    path.join(__dirname, 'worker.js'),
    asarPath,
    path.join(__dirname, 'hud')
  ], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
}

main();
`;
}

function buildWatcherWorkerSource() {
  return `'use strict';
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { install, isAsarPatched, getStateDir } = require('./hud/installer');

const args = process.argv.slice(2);
const noNotify = args.includes('--no-notify') || args.includes('--no-prompt');
const noWait = args.includes('--no-wait');
const [asarPath, hudDir] = args.filter(a => !a.startsWith('--'));
const stateDir = getStateDir();
const lockPath = path.join(stateDir, 'watcher.pid');
const logPath = path.join(stateDir, 'watcher.log');

function log(msg) {
  try { fs.appendFileSync(logPath, '[' + new Date().toISOString() + '] ' + msg + '\\n', 'utf8'); } catch {}
}

function getAntigravityPids() {
  if (process.platform === 'win32') {
    const res = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Antigravity.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const pids = [];
    for (const line of (res.stdout || '').split(/\\r?\\n/)) {
      const m = line.match(/^"Antigravity\\.exe","(\\d+)"/i);
      if (m) pids.push(Number(m[1]));
    }
    return pids;
  }
  const res = spawnSync('pgrep', ['-ix', 'antigravity'], { encoding: 'utf8' });
  return (res.stdout || '').split(/\\r?\\n/).map(Number).filter(Boolean);
}

function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sendNotification() {
  if (noNotify) return;
  let child;
  if (process.platform === 'win32') {
    const ps = "$appId = (Get-StartApps | Where-Object { $_.Name -eq 'Antigravity' } | Select-Object -First 1 -ExpandProperty AppID); if (-not $appId) { $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe' }; [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null; $tpl = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02); $nodes = $tpl.GetElementsByTagName('text'); $nodes.Item(0).AppendChild($tpl.CreateTextNode('Antigravity HUD')) | Out-Null; $nodes.Item(1).AppendChild($tpl.CreateTextNode('Antigravity updated. Restart Antigravity to reload HUD.')) | Out-Null; [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($tpl))";
    child = spawn('powershell', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true });
  } else if (process.platform === 'darwin') {
    child = spawn('osascript', ['-e', 'display notification "Antigravity updated. Restart Antigravity to reload HUD." with title "Antigravity HUD"'], { stdio: 'ignore' });
  } else {
    child = spawn('notify-send', ['Antigravity HUD', 'Antigravity updated. Restart Antigravity to reload HUD.'], { stdio: 'ignore' });
  }
  child.on('error', () => {});
  child.unref();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function run() {
  try { fs.writeFileSync(logPath, '', 'utf8'); } catch {}
  fs.writeFileSync(lockPath, String(process.pid), 'utf8');
  const cleanup = () => { try { fs.unlinkSync(lockPath); } catch {} };
  process.on('exit', cleanup);

  const initialPids = noWait ? [] : getAntigravityPids();
  log('started pid=' + process.pid + ' watching=' + JSON.stringify(initialPids));
  sendNotification();

  if (!noWait && initialPids.length > 0) {
    const deadline = Date.now() + 24 * 60 * 60 * 1000;
    while (initialPids.some(isPidAlive) && Date.now() < deadline) {
      await sleep(150);
    }
    log('all watched pids exited');
  }

  if (!isAsarPatched(asarPath)) {
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        install({ path: asarPath, rootDir: hudDir, skipWatcher: true });
        log('install() succeeded');
        break;
      } catch (err) {
        log('attempt ' + (attempt + 1) + ' failed: ' + (err.code || err.message));
        if (attempt === 19) throw err;
        await sleep(300);
      }
    }
  } else {
    log('already patched');
  }

  cleanup();
}

run().catch(err => {
  log('fatal: ' + (err && err.stack ? err.stack : err));
  process.exit(1);
});
`;
}

function installWatcherPlugin(rootDir, asarPath, opts = {}) {
  const pluginDir = getWatcherPluginDir(opts);
  const hudDir = path.join(pluginDir, 'hud');
  fs.mkdirSync(hudDir, { recursive: true });

  const checkPath = path.join(pluginDir, 'check.js');
  const hookCmd = `"${process.execPath}" "${checkPath}"`;

  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
    name: 'antigravity-hud-watcher',
    displayName: 'Antigravity HUD Watcher',
    version: '1.0.0',
    description: 'Re-applies Antigravity HUD to app.asar after Antigravity updates.'
  }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'hooks.json'), JSON.stringify({
    'antigravity-hud-watcher': {
      SessionStart: [{ type: 'command', command: hookCmd, timeout: 10 }],
      PreInvocation: [{ type: 'command', command: hookCmd, timeout: 10 }]
    }
  }, null, 2));
  fs.writeFileSync(path.join(pluginDir, 'config.json'), JSON.stringify({ asarPath }, null, 2));
  fs.writeFileSync(checkPath, buildWatcherCheckSource(), 'utf8');
  fs.writeFileSync(path.join(pluginDir, 'worker.js'), buildWatcherWorkerSource(), 'utf8');

  copyHudRuntime(rootDir, hudDir);
  fs.copyFileSync(path.join(rootDir, 'installer.js'), path.join(hudDir, 'installer.js'));
  fs.copyFileSync(path.join(rootDir, 'live-server.js'), path.join(hudDir, 'live-server.js'));
  fs.copyFileSync(path.join(rootDir, 'main-hook.js'), path.join(hudDir, 'main-hook.js'));
  return pluginDir;
}

function removeWatcherPlugin(opts = {}) {
  const pluginDir = getWatcherPluginDir(opts);
  if (fs.existsSync(pluginDir)) {
    fs.rmSync(pluginDir, { recursive: true, force: true });
    return true;
  }
  return false;
}

function install(opts = {}) {
  const asarPath = findAsarPath(opts.path);
  const rawFs = getRawFs();
  const rootDir = opts.rootDir || __dirname;

  const backupDir = path.join(getStateDir(), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, 'app.asar.bak');
  const backupMetaPath = path.join(getStateDir(), 'backup.json');
  const alreadyPatched = isAsarPatched(asarPath);

  if (!alreadyPatched) {
    const currentSha256 = sha256File(asarPath);
    let prevSha256 = null;
    try {
      prevSha256 = JSON.parse(fs.readFileSync(backupMetaPath, 'utf8')).originalSha256;
    } catch {}
    if (!fs.existsSync(backupPath) || prevSha256 !== currentSha256) {
      rawFs.copyFileSync(asarPath, backupPath);
      fs.writeFileSync(backupMetaPath, JSON.stringify({
        asarPath,
        backupPath,
        originalSha256: currentSha256,
        createdAt: new Date().toISOString()
      }, null, 2));
    }
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'context-bar-asar-'));
  try {
    const unpacked = collectUnpackedPaths(asarPath);
    extractAll(asarPath, staging);

    const utilsPath = path.join(staging, 'dist', 'utils.js');
    const preloadPath = path.join(staging, 'dist', 'preload.js');
    let utils = stripTaggedBlock(fs.readFileSync(utilsPath, 'utf8'), TAGS.UTILS_START, TAGS.UTILS_END);
    let preload = stripTaggedBlock(fs.readFileSync(preloadPath, 'utf8'), TAGS.PRELOAD_START, TAGS.PRELOAD_END);

    const marker = findLoadUrlMarker(utils);
    if (!marker) throw new Error('Could not find win.loadURL(...) anchor in dist/utils.js');

    utils = utils.replace(marker, `${TAGS.UTILS_START}\n    require("./context-bar-main").installContextBar(win);\n${TAGS.UTILS_END}\n${marker}`);

    preload += `\n${TAGS.PRELOAD_START}
electron_1.contextBridge.exposeInMainWorld("contextMeterAPI", {
  getRuntimeInfo: () => electron_1.ipcRenderer.invoke("context-meter:runtime-info"),
  scan: (id, force) => electron_1.ipcRenderer.invoke("context-meter:scan", id, force === true),
  getTokenHistory: (force) => electron_1.ipcRenderer.invoke("context-meter:token-history", force === true),
  getSessionTimeline: (id, opts) => electron_1.ipcRenderer.invoke("context-meter:session-timeline", id, opts),
  getSessionDeepDive: (id, opts) => electron_1.ipcRenderer.invoke("context-meter:session-deep-dive", id, opts),
  getCrossSessionInsights: (opts) => electron_1.ipcRenderer.invoke("context-meter:cross-session-insights", opts),
  getQuota: (opts) => electron_1.ipcRenderer.invoke("context-meter:get-quota", opts),
  syncOverlay: (opts) => electron_1.ipcRenderer.invoke("context-meter:sync-overlay", opts),
  recordCalls: (calls) => electron_1.ipcRenderer.invoke("context-meter:record-calls", calls),
  getSettings: (opts) => electron_1.ipcRenderer.invoke("context-meter:get-settings", opts),
  saveSettings: (payload) => electron_1.ipcRenderer.invoke("context-meter:save-settings", payload),
  openExternal: (url) => electron_1.ipcRenderer.invoke("context-meter:open-external", url)
});
${TAGS.PRELOAD_END}\n`;

    if (!validateSyntax(utils, 'dist/utils.js') || !validateSyntax(preload, 'dist/preload.js')) {
      throw new Error('Patched JS failed syntax validation');
    }

    fs.writeFileSync(utilsPath, utils, 'utf8');
    fs.writeFileSync(preloadPath, preload, 'utf8');

    copyHudRuntime(rootDir, path.join(staging, 'dist'));

    const tmpOut = path.join(path.dirname(asarPath), `app.asar.tmp.${process.pid}`);
    createPackage(staging, tmpOut, unpacked);
    rawFs.renameSync(tmpOut, asarPath);
    const watcherPluginDir = opts.skipWatcher ? null : installWatcherPlugin(rootDir, asarPath, opts);
    return { ok: true, asarPath, backupPath, watcherPluginDir };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function restore(opts = {}) {
  const asarPath = findAsarPath(opts.path);
  const rawFs = getRawFs();
  const backupPath = path.join(getStateDir(), 'backups', 'app.asar.bak');
  const watcherRemoved = removeWatcherPlugin(opts);
  if (fs.existsSync(backupPath)) {
    rawFs.copyFileSync(backupPath, asarPath);
    return { ok: true, method: 'backup', asarPath, watcherRemoved };
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'context-bar-restore-'));
  try {
    const unpacked = collectUnpackedPaths(asarPath);
    extractAll(asarPath, staging);
    const utilsPath = path.join(staging, 'dist', 'utils.js');
    const preloadPath = path.join(staging, 'dist', 'preload.js');
    fs.writeFileSync(utilsPath, stripTaggedBlock(fs.readFileSync(utilsPath, 'utf8'), TAGS.UTILS_START, TAGS.UTILS_END), 'utf8');
    fs.writeFileSync(preloadPath, stripTaggedBlock(fs.readFileSync(preloadPath, 'utf8'), TAGS.PRELOAD_START, TAGS.PRELOAD_END), 'utf8');
    for (const f of ['context-bar-main.js', 'core.js', 'collector.js', 'insights.js', 'cdp.js', 'asar.js', 'scripts', 'src']) {
      const p = path.join(staging, 'dist', f);
      if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
    }
    const tmpOut = path.join(path.dirname(asarPath), `app.asar.tmp.${process.pid}`);
    createPackage(staging, tmpOut, unpacked);
    rawFs.renameSync(tmpOut, asarPath);
    return { ok: true, method: 'in-place', asarPath, watcherRemoved };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

async function getStatus(opts = {}) {
  let asarPath = null;
  let asarPatched = false;
  try {
    asarPath = findAsarPath(opts.path);
    asarPatched = isAsarPatched(asarPath);
  } catch {}
  const backupExists = fs.existsSync(path.join(getStateDir(), 'backups', 'app.asar.bak'));
  const watcherPluginInstalled = fs.existsSync(path.join(getWatcherPluginDir(opts), 'hooks.json'));
  const cdp = await discoverCdp(opts.port);
  return {
    asarPath,
    asarPatched,
    backupExists,
    watcherPluginInstalled,
    cdpPort: cdp?.port || null,
    cdpPages: cdp?.pages?.length || 0
  };
}

async function liveInject(opts = {}) {
  const rootDir = opts.rootDir || __dirname;
  const cdp = await discoverCdp(opts.port);
  if (!cdp || !cdp.pages.length) {
    throw new Error('No Antigravity CDP page found. Launch Antigravity with --remote-debugging-port=9222');
  }

  const live = await startLiveServer();
  const bundle = `${assembleCore(rootDir)}\n${assembleRenderer(rootDir)}`;
  const liveMeta = {
    port: live.port,
    token: live.token,
    version: '0.8.8',
    capabilities: { scan: true, tokenHistory: true, sessionTimeline: true, quota: true, recordCalls: true, settings: true }
  };
  const bootCode = `window.__AGContextMeterLive__ = ${JSON.stringify(liveMeta)};\n${bundle}`;

  let injected = 0;
  for (const page of cdp.pages) {
    const client = await createCdpClient(page.webSocketDebuggerUrl);
    try {
      await client.evaluate(bootCode);
      injected++;
    } finally {
      client.close();
    }
  }
  return { ok: true, port: live.port, cdpPort: cdp.port, injected, server: live };
}

module.exports = {
  TAGS,
  findAsarPath,
  getStateDir,
  getWatcherPluginDir,
  installWatcherPlugin,
  removeWatcherPlugin,
  validateSyntax,
  stripTaggedBlock,
  isAsarPatched,
  install,
  restore,
  getStatus,
  liveInject
};
