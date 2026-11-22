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

function install(opts = {}) {
  const asarPath = findAsarPath(opts.path);
  const rawFs = getRawFs();
  const rootDir = opts.rootDir || __dirname;

  const backupDir = path.join(getStateDir(), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  const backupPath = path.join(backupDir, 'app.asar.bak');
  const alreadyPatched = isAsarPatched(asarPath);

  if (!alreadyPatched && !fs.existsSync(backupPath)) {
    rawFs.copyFileSync(asarPath, backupPath);
    fs.writeFileSync(path.join(getStateDir(), 'backup.json'), JSON.stringify({
      asarPath,
      backupPath,
      originalSha256: sha256File(asarPath),
      createdAt: new Date().toISOString()
    }, null, 2));
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

    const copies = [
      ['main-hook.js', 'context-bar-main.js'],
      ['core.js', 'core.js'],
      ['collector.js', 'collector.js'],
      ['insights.js', 'insights.js'],
      ['cdp.js', 'cdp.js'],
      ['asar.js', 'asar.js'],
      ['package.json', 'package.json']
    ];
    for (const [srcName, destName] of copies) {
      fs.copyFileSync(path.join(rootDir, srcName), path.join(staging, 'dist', destName));
    }
    fs.mkdirSync(path.join(staging, 'dist', 'scripts'), { recursive: true });
    fs.copyFileSync(path.join(rootDir, 'scripts', 'build-renderer.js'), path.join(staging, 'dist', 'scripts', 'build-renderer.js'));
    copyDirRecursive(path.join(rootDir, 'src'), path.join(staging, 'dist', 'src'));

    const tmpOut = path.join(path.dirname(asarPath), `app.asar.tmp.${process.pid}`);
    createPackage(staging, tmpOut, unpacked);
    rawFs.renameSync(tmpOut, asarPath);
    return { ok: true, asarPath, backupPath };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function restore(opts = {}) {
  const asarPath = findAsarPath(opts.path);
  const rawFs = getRawFs();
  const backupPath = path.join(getStateDir(), 'backups', 'app.asar.bak');
  if (fs.existsSync(backupPath)) {
    rawFs.copyFileSync(backupPath, asarPath);
    return { ok: true, method: 'backup', asarPath };
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
    return { ok: true, method: 'in-place', asarPath };
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
  const cdp = await discoverCdp(opts.port);
  return {
    asarPath,
    asarPatched,
    backupExists,
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
  validateSyntax,
  stripTaggedBlock,
  isAsarPatched,
  install,
  restore,
  getStatus,
  liveInject
};
