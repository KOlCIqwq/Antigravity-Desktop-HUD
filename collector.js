'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { readDirParts } = require('./scripts/build-renderer');
const cdp = require('./cdp');
const asar = require('./asar');
const core = require('./core');

function safeReadJsonSync(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, data: fallback, unreadable: false };
    return { exists: true, data: JSON.parse(fs.readFileSync(filePath, 'utf8')), unreadable: false };
  } catch (error) {
    return { exists: true, data: fallback, unreadable: true, error };
  }
}

function safeWriteJsonSync(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
  return { ok: true, filePath };
}

function withFileLockSync(_filePath, fn) {
  return fn();
}

const localShims = {
  './meter-core': core,
  './asar-engine': { ...asar, isIsolatedTestPath: () => false },
  './local-api': { ...cdp, connect: cdp.connectLocalServer },
  './meter-storage': { safeReadJsonSync, safeWriteJsonSync, withFileLockSync },
  './modules-config': { PROJECT_VERSION: '0.8.8' },
  './meter-proxy': {
    applyProxyEnvironment: () => {},
    detectProxyConfig: () => ({ enabled: false }),
    normalizeProxyUrl: u => String(u || '').trim()
  },
  './meter-cli-launcher': {
    launchAntigravityCli: async () => ({ ok: false, error: 'CLI launcher removed in context-bar' }),
    checkCliAvailable: () => ({ available: false })
  },
  './meter-context-unlock': {
    AUTHOR_INFO: {},
    DEFAULT_CHECKPOINT_TOKENS: 100000,
    validateContextLimit: (raw) => {
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1000 || n > 10000000) {
        return { ok: false, error: 'Context limit must be between 1,000 and 10,000,000 tokens' };
      }
      return { ok: true, limitTokens: Math.round(n) };
    },
    getDefaultAppPath: () => '',
    analyzeBinary: () => ({ ok: false }),
    analyzeBinaryAsync: async () => ({ ok: false }),
    applyUnlock: () => ({ ok: false }),
    restoreUnlock: () => ({ ok: false }),
    parseUnlockModeInput: v => v,
    getPresetByMode: () => null,
    UNLOCK_PRESETS: {}
  }
};

const code = readDirParts(path.join(__dirname, 'src', 'collector'));
const filename = path.join(__dirname, 'src', 'collector', 'index.js');
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(__dirname);

const origRequire = mod.require.bind(mod);
mod.require = function (id) {
  if (Object.prototype.hasOwnProperty.call(localShims, id)) return localShims[id];
  return origRequire(id);
};

mod._compile(code, filename);
module.exports = mod.exports;
