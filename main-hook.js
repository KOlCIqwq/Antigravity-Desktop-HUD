'use strict';
const { assembleCore, assembleRenderer } = require('./scripts/build-renderer');
const collector = require('./collector');
const insights = require('./insights');
const { isValidExternalUrl } = require('./core');

let ipcRegistered = false;
const installedWindows = new WeakSet();
let cachedBundle = null;

function getBundle() {
  if (!cachedBundle) {
    cachedBundle = `${assembleCore(__dirname)}\n${assembleRenderer(__dirname)}`;
  }
  return cachedBundle;
}

function getOriginFromEvent(event) {
  try {
    const url = event?.sender?.getURL?.() || '';
    return url ? new URL(url).origin : '';
  } catch {
    return '';
  }
}

function registerIpc() {
  if (ipcRegistered) return;
  const { ipcMain, shell } = require('electron');
  if (!ipcMain) return;
  ipcRegistered = true;

  const disabled = async () => ({ ok: false, disabled: true });

  ipcMain.handle('context-meter:runtime-info', async () => ({
    ok: true,
    backendVersion: '0.8.8',
    backendSource: 'electron-ipc',
    capabilities: { scan: true, tokenHistory: true, sessionTimeline: true, quota: true, recordCalls: true, settings: true }
  }));

  ipcMain.handle('context-meter:scan', async (event, id, force) => {
    try {
      const data = await collector.collect(getOriginFromEvent(event), id, { force: force === true, supersedePrevious: true });
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:token-history', async (_event, force) => {
    try {
      const data = await collector.collectTokenHistoryAsync({ force: force === true });
      return { ok: true, data };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:session-timeline', async (event, id, opts = {}) => {
    try {
      const data = await collector.collectSessionTimelineAsync(id, { ...(opts || {}), origin: getOriginFromEvent(event) });
      return { ok: true, data: { ...(data || {}), backendVersion: '0.8.8', backendSource: 'electron-ipc' } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:session-deep-dive', async (event, id, opts = {}) => {
    try {
      const data = await insights.collectSessionDeepDive(getOriginFromEvent(event), id, {
        force: opts?.force === true,
        ...(Array.isArray(opts?.cascadeModelConfigs) ? { cascadeModelConfigs: opts.cascadeModelConfigs } : {})
      });
      return { ok: true, data: { ...(data || {}), backendVersion: '0.8.8', backendSource: 'electron-ipc' } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:cross-session-insights', async (event, opts = {}) => {
    try {
      const data = await insights.collectCrossSessionInsights(getOriginFromEvent(event), {
        force: opts?.force === true
      });
      return { ok: true, data: { ...(data || {}), backendVersion: '0.8.8', backendSource: 'electron-ipc' } };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:get-quota', async (event, options) => {
    try {
      const opts = typeof options === 'boolean'
        ? { force: options }
        : (options && typeof options === 'object' ? { ...options } : {});
      if (!opts.origin) opts.origin = getOriginFromEvent(event);
      opts.backendSource = 'electron-ipc';
      const resData = await collector.fetchQuotaSnapshotFromHost(opts);
      const { _raw, ...safeData } = resData || {};
      return { ok: true, data: safeData };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('context-meter:record-calls', async (_event, calls) => {
    try {
      const res = await collector.recordModelCallsAsync(calls);
      return { ok: true, changed: Boolean(res && typeof res === 'object' ? res.changed : res) };
    } catch (e) {
      return { ok: false, error: e.message, changed: false };
    }
  });

  ipcMain.handle('context-meter:get-settings', async (_event, opts) => {
    return collector.getPluginSettings(opts);
  });

  ipcMain.handle('context-meter:save-settings', async (_event, payload) => {
    return collector.savePluginSettings(payload);
  });

  ipcMain.handle('context-meter:sync-overlay', async () => ({ ok: true }));

  ipcMain.handle('context-meter:open-external', async (_event, targetUrl) => {
    if (typeof isValidExternalUrl === 'function' && !isValidExternalUrl(targetUrl)) return false;
    await shell?.openExternal?.(targetUrl);
    return true;
  });

  for (const ch of [
    'launch-cli', 'check-update', 'apply-update',
    'context-unlock-status', 'context-unlock-apply', 'context-unlock-restore',
    'restart-host', 'enhance-status', 'enhance-apply', 'enhance-restore',
    'restart-language-servers', 'modules-status', 'toggle-module', 'test-proxy',
    'accounts-overview', 'accounts-action'
  ]) {
    ipcMain.handle(`context-meter:${ch}`, disabled);
  }
}

function injectRenderer(win, attempt = 0) {
  if (!win || win.isDestroyed?.()) return;
  const wc = win.webContents;
  if (!wc || wc.isDestroyed?.()) return;
  const url = wc.getURL?.() || '';
  const isWorkbench = !url || url === 'about:blank' ? false : (/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\//.test(url) || url.startsWith('vscode-file://') || url.includes('workbench'));
  if (!isWorkbench) {
    const delays = [300, 600, 1200, 2500];
    if (attempt < delays.length) {
      setTimeout(() => injectRenderer(win, attempt + 1), delays[attempt]);
    }
    return;
  }
  try {
    wc.executeJavaScript(`if (!document.getElementById('ag-context-meter')) {\n${getBundle()}\n}`).catch(() => {});
  } catch {}
}

function installContextBar(win) {
  registerIpc();
  if (!win || installedWindows.has(win)) return;
  installedWindows.add(win);
  win.webContents.on('did-finish-load', () => injectRenderer(win, 0));
  win.webContents.on('dom-ready', () => injectRenderer(win, 0));
  if (!win.webContents.isLoadingMainFrame?.()) injectRenderer(win, 0);
}

module.exports = { installContextBar, injectRenderer };
