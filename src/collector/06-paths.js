function dedupeScanPaths(paths = [], platform = process.platform) {
  const out = [];
  const seen = new Set();
  for (const raw of paths) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const pathMod = (platform === 'win32' || trimmed.startsWith('\\\\')) ? path.win32 : path;
    const resolved = pathMod.resolve(trimmed);
    const key = (platform === 'win32' || resolved.startsWith('\\\\')) ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/**
 * 解析 Windows 注册表 Lxss 导出内容，提取已安装且可用的 WSL 发行版
 * @param {string} rawText
 */
function parseLxssRegistryOutput(rawText = '') {
  if (typeof rawText !== 'string' || !rawText.trim()) return [];
  const distros = [];
  const seenNames = new Set();
  let current = null;

  const flush = () => {
    if (!current || !current.name) return;
    const name = current.name.trim();
    if (!name || IGNORED_WSL_DISTRO_RE.test(name)) return;
    if (current.state !== null && current.state !== 1) return;
    const key = name.toLowerCase();
    if (seenNames.has(key)) return;
    seenNames.add(key);
    distros.push({
      name,
      state: current.state,
      version: current.version,
      defaultUid: current.defaultUid
    });
  };

  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:HKEY_CURRENT_USER|HKCU)\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss\\/i.test(trimmed)) {
      flush();
      current = { name: '', state: null, version: null, defaultUid: null };
      continue;
    }
    if (!current) continue;
    const nameMatch = trimmed.match(/^DistributionName\s+REG_SZ\s+(.+)$/i);
    if (nameMatch) {
      current.name = nameMatch[1].trim();
      continue;
    }
    const stateMatch = trimmed.match(/^State\s+REG_DWORD\s+(?:0x([0-9a-f]+)|(\d+))$/i);
    if (stateMatch) {
      current.state = stateMatch[1] ? parseInt(stateMatch[1], 16) : parseInt(stateMatch[2], 10);
      continue;
    }
    const verMatch = trimmed.match(/^Version\s+REG_DWORD\s+(?:0x([0-9a-f]+)|(\d+))$/i);
    if (verMatch) {
      current.version = verMatch[1] ? parseInt(verMatch[1], 16) : parseInt(verMatch[2], 10);
      continue;
    }
    const uidMatch = trimmed.match(/^DefaultUid\s+REG_DWORD\s+(?:0x([0-9a-f]+)|(\d+))$/i);
    if (uidMatch) {
      current.defaultUid = uidMatch[1] ? parseInt(uidMatch[1], 16) : parseInt(uidMatch[2], 10);
    }
  }
  flush();
  return distros;
}

function listRegisteredWslDistros(options = {}) {
  if (Array.isArray(options.wslDistros)) {
    const out = [];
    const seen = new Set();
    for (const item of options.wslDistros) {
      const rawName = typeof item === 'string' ? item : item?.name;
      const name = typeof rawName === 'string' ? rawName.trim() : '';
      if (!name || IGNORED_WSL_DISTRO_RE.test(name)) continue;
      const state = typeof item === 'object' && item && item.state !== undefined ? Number(item.state) : null;
      if (state !== null && Number.isFinite(state) && state !== 1) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name,
        state: Number.isFinite(state) ? state : null,
        version: typeof item === 'object' && item ? (item.version ?? null) : null,
        defaultUid: typeof item === 'object' && item ? (item.defaultUid ?? null) : null
      });
    }
    return out;
  }
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return [];
  try {
    const res = spawnSync('reg.exe', ['query', WSL_LXSS_REG_KEY, '/s'], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true
    });
    if (res.error || res.status !== 0 || !res.stdout) return [];
    return parseLxssRegistryOutput(res.stdout);
  } catch {
    return [];
  }
}

function resolveWslDistroUncRoot(distroName, options = {}) {
  const fsApi = options.fs || fs;
  const name = typeof distroName === 'string' ? distroName.trim() : '';
  if (!name) return null;
  for (const prefix of ['\\\\wsl.localhost', '\\\\wsl$']) {
    const candidate = `${prefix}\\${name}`;
    try {
      if (fsApi.existsSync(path.win32.join(candidate, 'root')) || fsApi.existsSync(path.win32.join(candidate, 'home'))) {
        return candidate;
      }
    } catch { }
  }
  return null;
}

function collectGeminiDirsFromLinuxRoot(rootDir, options = {}) {
  const fsApi = options.fs || fs;
  const platform = options.platform || process.platform;
  const desktopDirs = [];
  const cliDirs = [];
  if (typeof rootDir !== 'string' || !rootDir.trim()) return { desktopDirs, cliDirs };
  const pathMod = (platform === 'win32' || rootDir.startsWith('\\\\')) ? path.win32 : path;

  const candidateHomes = [];
  const rootHome = pathMod.join(rootDir, 'root');
  try {
    if (fsApi.existsSync(rootHome)) candidateHomes.push(rootHome);
  } catch { }

  const homeParent = pathMod.join(rootDir, 'home');
  try {
    if (fsApi.existsSync(homeParent)) {
      for (const entry of fsApi.readdirSync(homeParent, { withFileTypes: true })) {
        const sub = pathMod.join(homeParent, entry.name);
        if (entry.isDirectory()) {
          candidateHomes.push(sub);
        } else if (entry.isSymbolicLink()) {
          try {
            if (fsApi.statSync(sub).isDirectory()) candidateHomes.push(sub);
          } catch { }
        }
      }
    }
  } catch { }

  const uniqueHomes = dedupeScanPaths(candidateHomes.map((h) => {
    try {
      return typeof fsApi.realpathSync === 'function' ? fsApi.realpathSync(h) : h;
    } catch {
      return h;
    }
  }), platform);

  for (const h of uniqueHomes) {
    const ag = pathMod.join(h, '.gemini', 'antigravity');
    const cli = pathMod.join(h, '.gemini', 'antigravity-cli');
    try {
      if (fsApi.existsSync(ag)) desktopDirs.push(ag);
    } catch { }
    try {
      if (fsApi.existsSync(cli)) cliDirs.push(cli);
    } catch { }
  }
  return {
    desktopDirs: dedupeScanPaths(desktopDirs, platform),
    cliDirs: dedupeScanPaths(cliDirs, platform)
  };
}

const WSL_DISCOVERY_CACHE_TTL_MS = 45000;
let wslDiscoveryCache = { scopeKey: '', at: 0, value: null };

function discoverWslGeminiDirs(options = {}) {
  const platform = options.platform || process.platform;
  if (options.includeWsl === false || process.env.AG_DISABLE_WSL_SCAN === '1') {
    return { distros: [], roots: [], desktopDirs: [], cliDirs: [], skippedRoots: [] };
  }
  const hasExplicitPrimary = Boolean(options.agDir || options.agCliDir || process.env.AG_DIR || process.env.AG_CLI_DIR);
  const allowAutoDistros = options.includeWsl === true ||
    (platform === 'win32' && !hasExplicitPrimary && process.env.AG_METER_TEST_MODE !== '1');

  const distros = allowAutoDistros ? listRegisteredWslDistros(options) : [];
  const discoveredRoots = [];
  const skippedRoots = [];
  for (const d of distros) {
    try {
      const uncRoot = resolveWslDistroUncRoot(d.name, options);
      if (uncRoot) discoveredRoots.push(uncRoot);
      else skippedRoots.push({ target: d.name, reason: 'unreachable' });
    } catch (e) {
      skippedRoots.push({ target: d.name, reason: e?.code || e?.message || 'error' });
    }
  }
  const explicitRoots = Array.isArray(options.wslRoots) ? options.wslRoots : [];
  const roots = dedupeScanPaths([...discoveredRoots, ...explicitRoots], platform);

  const desktopDirs = [];
  const cliDirs = [];
  for (const r of roots) {
    try {
      const found = collectGeminiDirsFromLinuxRoot(r, options);
      desktopDirs.push(...found.desktopDirs);
      cliDirs.push(...found.cliDirs);
    } catch (e) {
      skippedRoots.push({ target: r, reason: e?.code || e?.message || 'error' });
    }
  }
  return {
    distros: distros.map(d => d.name),
    roots,
    desktopDirs: dedupeScanPaths(desktopDirs, platform),
    cliDirs: dedupeScanPaths(cliDirs, platform),
    skippedRoots
  };
}

/**
 * 带超时保护与缓存的异步 WSL 目录发现：
 * - 对慢 UNC/休眠发行版施加有界超时（默认 1500ms），不阻塞主循环或拖慢 UI；
 * - 不执行任何写入或主动拉起未运行发行版，权限不足/不可达时记录 skippedRoots 并安全跳过。
 */
async function discoverWslGeminiDirsAsync(options = {}) {
  const platform = options.platform || process.platform;
  if (options.includeWsl === false || process.env.AG_DISABLE_WSL_SCAN === '1') {
    return { distros: [], roots: [], desktopDirs: [], cliDirs: [], skippedRoots: [] };
  }
  const hasCustomOverride = Boolean(options.fs || options.wslDistros || options.wslProbeFn || options.wslProbeTimeoutMs);
  const scopeKey = getEffectiveScanScopeKey(options);
  if (!hasCustomOverride && !options.force && wslDiscoveryCache.value && wslDiscoveryCache.scopeKey === scopeKey && (Date.now() - wslDiscoveryCache.at) < WSL_DISCOVERY_CACHE_TTL_MS) {
    return wslDiscoveryCache.value;
  }

  const hasExplicitPrimary = Boolean(options.agDir || options.agCliDir || process.env.AG_DIR || process.env.AG_CLI_DIR);
  const allowAutoDistros = options.includeWsl === true ||
    (platform === 'win32' && !hasExplicitPrimary && process.env.AG_METER_TEST_MODE !== '1');

  const distros = allowAutoDistros ? listRegisteredWslDistros(options) : [];
  const timeoutMs = Number.isFinite(Number(options.wslProbeTimeoutMs)) && Number(options.wslProbeTimeoutMs) > 0
    ? Number(options.wslProbeTimeoutMs)
    : 1500;
  const fsPromises = options.fs?.promises || fs.promises;
  const pathMod = platform === 'win32' ? path.win32 : path;

  const runWithBoundedTimeout = async (promiseFactory, targetLabel) => {
    let timer = null;
    try {
      const timeoutPromise = new Promise((_, reject) => {
        timer = setTimeout(() => {
          const err = new Error(`WSL 探测超时 (${timeoutMs}ms): ${targetLabel}`);
          err.code = 'ETIMEDOUT';
          reject(err);
        }, timeoutMs);
        if (typeof timer.unref === 'function') timer.unref();
      });
      return await Promise.race([promiseFactory(), timeoutPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const probeDistroAsync = async (d) => {
    if (typeof options.wslProbeFn === 'function') {
      return await runWithBoundedTimeout(() => Promise.resolve(options.wslProbeFn(d)), d.name);
    }
    if (options.fs && !options.fs.promises) {
      return resolveWslDistroUncRoot(d.name, options);
    }
    return await runWithBoundedTimeout(async () => {
      for (const prefix of ['\\\\wsl.localhost', '\\\\wsl$']) {
        const candidate = `${prefix}\\${d.name}`;
        for (const sub of ['root', 'home']) {
          try {
            await fsPromises.access(pathMod.join(candidate, sub));
            return candidate;
          } catch { }
        }
      }
      return null;
    }, d.name);
  };

  const discoveredRoots = [];
  const skippedRoots = [];
  const probeResults = await Promise.all(distros.map(async (d) => {
    try {
      const root = await probeDistroAsync(d);
      return { name: d.name, root, error: null };
    } catch (e) {
      return { name: d.name, root: null, error: e };
    }
  }));

  for (const r of probeResults) {
    if (r.error) {
      skippedRoots.push({ target: r.name, reason: r.error.code === 'ETIMEDOUT' ? 'timeout' : (r.error.code || r.error.message || 'error') });
    } else if (r.root) {
      discoveredRoots.push(r.root);
    } else {
      skippedRoots.push({ target: r.name, reason: 'unreachable' });
    }
  }

  const explicitRoots = Array.isArray(options.wslRoots) ? options.wslRoots : [];
  const roots = dedupeScanPaths([...discoveredRoots, ...explicitRoots], platform);

  const desktopDirs = [];
  const cliDirs = [];
  for (const r of roots) {
    try {
      const found = await runWithBoundedTimeout(
        () => Promise.resolve(collectGeminiDirsFromLinuxRoot(r, options)),
        r
      );
      desktopDirs.push(...found.desktopDirs);
      cliDirs.push(...found.cliDirs);
    } catch (e) {
      skippedRoots.push({ target: r, reason: e?.code === 'ETIMEDOUT' ? 'timeout' : (e?.code || e?.message || 'error') });
    }
  }

  const result = {
    distros: distros.map(d => d.name),
    roots,
    desktopDirs: dedupeScanPaths(desktopDirs, platform),
    cliDirs: dedupeScanPaths(cliDirs, platform),
    skippedRoots
  };
  if (!hasCustomOverride) {
    wslDiscoveryCache = { scopeKey, at: Date.now(), value: result };
  }
  return result;
}

function resolvePrimaryGeminiDirs(options = {}) {
  const home = process.env.USERPROFILE || os.homedir();
  const explicitAg = options.agDir || process.env.AG_DIR || null;
  const agDir = explicitAg || path.join(home, '.gemini', 'antigravity');
  const agCliDir = options.agCliDir || process.env.AG_CLI_DIR || (
    explicitAg
      ? path.join(path.dirname(path.resolve(explicitAg)), 'antigravity-cli')
      : path.join(home, '.gemini', 'antigravity-cli')
  );
  return { home, agDir, agCliDir };
}

function getEffectiveScanScopeKey(options = {}) {
  const resolved = resolvePrimaryGeminiDirs(options);
  const agDir = path.resolve(resolved.agDir);
  const agCliDir = path.resolve(resolved.agCliDir);
  const extraDesk = dedupeScanPaths(Array.isArray(options.extraAgDirs) ? options.extraAgDirs : []);
  const extraCli = dedupeScanPaths(Array.isArray(options.extraAgCliDirs) ? options.extraAgCliDirs : []);
  const wslRoots = dedupeScanPaths(Array.isArray(options.wslRoots) ? options.wslRoots : []);
  const wslFlag = options.includeWsl === false || process.env.AG_DISABLE_WSL_SCAN === '1'
    ? 'wsl=0'
    : (options.includeWsl === true ? 'wsl=1' : 'wsl=auto');
  const parts = [agDir, agCliDir, wslFlag, ...extraDesk, ...extraCli, ...wslRoots];
  return process.platform === 'win32'
    ? parts.map(p => p.toLowerCase()).join('|')
    : parts.join('|');
}

function isFsMonkeyPatched() {
  return fs.readFileSync !== origFsMethods.readFileSync ||
    fs.writeFileSync !== origFsMethods.writeFileSync ||
    fs.copyFileSync !== origFsMethods.copyFileSync ||
    fs.renameSync !== origFsMethods.renameSync ||
    fs.readdirSync !== origFsMethods.readdirSync ||
    fs.statSync !== origFsMethods.statSync ||
    fs.existsSync !== origFsMethods.existsSync;
}

function captureCollectorEnvSnapshot() {
  const snap = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') snap[k] = v;
  }
  return snap;
}

function cloneCollectorOptionsForWorker(options = {}) {
  const out = {};
  if (!options || typeof options !== 'object') return out;
  for (const [k, v] of Object.entries(options)) {
    if (k === '_inWorker' || k === 'fs' || k === 'hostFetcher') continue;
    if (typeof v === 'function' || typeof v === 'symbol' || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function canUseHistoryWorker(options = {}) {
  if (!isMainThread || typeof Worker !== 'function') return false;
  if (historyWorkerDisabled || options.useWorker === false || options._inWorker) return false;
  if (options.fs || options.hostFetcher) return false;
  if (Date.now !== origDateNow || isFsMonkeyPatched()) return false;
  return true;
}

let historyWorkerDisabled = false;
let historyWorkerConsecutiveErrors = 0;
let historyWorkerInstance = null;
let historyWorkerScriptPath = __filename;
let historyWorkerIdleTimer = null;
let historyWorkerReqId = 1;
const historyWorkerPending = new Map();
const HISTORY_WORKER_IDLE_MS = 45000;
const DEFAULT_HISTORY_WORKER_TIMEOUT_MS = 45000;

function clearAllHistoryWorkerPending(targetWorker = null, errReason = null) {
  for (const [id, entry] of historyWorkerPending.entries()) {
    if (targetWorker && entry.worker !== targetWorker) continue;
    historyWorkerPending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(errReason ? { _workerHandled: false, error: errReason } : null);
  }
}

function scheduleHistoryWorkerIdleCleanup() {
  if (historyWorkerIdleTimer) {
    clearTimeout(historyWorkerIdleTimer);
    historyWorkerIdleTimer = null;
  }
  if (!historyWorkerInstance || historyWorkerPending.size > 0) return;
  const idleMs = process.env.NODE_TEST_CONTEXT ? 120 : HISTORY_WORKER_IDLE_MS;
  historyWorkerIdleTimer = setTimeout(() => {
    historyWorkerIdleTimer = null;
    if (historyWorkerInstance && historyWorkerPending.size === 0) {
      const w = historyWorkerInstance;
      historyWorkerInstance = null;
      try { w.terminate(); } catch { }
    }
  }, idleMs);
  if (typeof historyWorkerIdleTimer.unref === 'function') historyWorkerIdleTimer.unref();
}

function getOrStartHistoryWorker(workerEntry = __filename) {
  const targetScript = workerEntry || __filename;
  if (historyWorkerInstance && historyWorkerScriptPath === targetScript) return historyWorkerInstance;
  if (historyWorkerInstance && historyWorkerScriptPath !== targetScript) {
    const oldW = historyWorkerInstance;
    historyWorkerInstance = null;
    clearAllHistoryWorkerPending(oldW, 'worker_replaced');
    try { oldW.terminate(); } catch { }
  }
  historyWorkerScriptPath = targetScript;
  const w = new Worker(targetScript, {
    workerData: { agCollectorHistoryWorker: true }
  });
  w.on('message', (msg) => {
    if (!msg || !msg.id) return;
    const entry = historyWorkerPending.get(msg.id);
    if (!entry) return;
    historyWorkerPending.delete(msg.id);
    if (entry.timer) clearTimeout(entry.timer);
    historyWorkerConsecutiveErrors = 0;
    if (historyWorkerPending.size === 0) {
      try { w.unref(); } catch { }
    }
    scheduleHistoryWorkerIdleCleanup();
    if (msg.ok) entry.resolve({ _workerHandled: true, result: msg.result });
    else entry.resolve({ _workerHandled: false, error: msg.error || 'Worker 执行失败' });
  });
  w.on('error', (err) => {
    historyWorkerConsecutiveErrors++;
    if (historyWorkerConsecutiveErrors >= 3) {
      historyWorkerDisabled = true;
    }
    if (historyWorkerInstance === w) historyWorkerInstance = null;
    clearAllHistoryWorkerPending(w, err?.message || 'worker_error');
    try { w.terminate(); } catch { }
  });
  w.on('exit', (code) => {
    if (code !== 0) {
      let hadPending = false;
      for (const entry of historyWorkerPending.values()) {
        if (entry.worker === w) { hadPending = true; break; }
      }
      if (hadPending) {
        historyWorkerConsecutiveErrors++;
        if (historyWorkerConsecutiveErrors >= 3) {
          historyWorkerDisabled = true;
        }
      }
    }
    if (historyWorkerInstance === w) historyWorkerInstance = null;
    clearAllHistoryWorkerPending(w, code !== 0 ? `worker_exit_${code}` : null);
  });
  // Node.js v24 注册 message 监听会隐式 ref 底层 MessagePort，必须在全部监听绑定之后再 unref
  try { w.unref(); } catch { }
  historyWorkerInstance = w;
  return w;
}

let recordCallsAsyncQueue = Promise.resolve();

function invalidateHostLedgerAndHistoryCaches() {
  ledgerCacheByPath.clear();
  cachedTokenHistory = null;
  cachedTokenHistoryAt = 0;
}

/**
 * 异步入账模型调用记录（优先交由后台 Worker 线程执行大账本读写与合并，保持串行无竞态并零阻塞主进程事件循环）
 * @param {Array<object>} newCalls
 * @param {object|string} options
 */
async function recordModelCallsAsync(newCalls = [], options = {}) {
  if (!Array.isArray(newCalls) || !newCalls.length) return { ok: true, changed: false };
  const optsObj = typeof options === 'string' ? { agDir: options } : (options && typeof options === 'object' ? options : {});
  const task = recordCallsAsyncQueue.then(async () => {
    if (canUseHistoryWorker(optsObj)) {
      const workerResp = await runHistoryWorkerTask({
        newCalls,
        options: cloneCollectorOptionsForWorker(optsObj)
      }, 'recordModelCalls', optsObj);
      if (workerResp && workerResp._workerHandled) {
        const res = workerResp.result;
        if (res && res.changed) {
          invalidateHostLedgerAndHistoryCaches();
        }
        return res;
      }
    }
    const res = recordModelCalls(newCalls, optsObj);
    if (res && res.changed) {
      invalidateHostLedgerAndHistoryCaches();
    }
    return res;
  });
  recordCallsAsyncQueue = task.catch(() => { });
  return task;
}

async function runHistoryWorkerTask(payload, cmd = 'collectTokenHistory', taskOptions = {}) {
  try {
    if (historyWorkerIdleTimer) {
      clearTimeout(historyWorkerIdleTimer);
      historyWorkerIdleTimer = null;
    }
    const workerEntry = (taskOptions && taskOptions._historyWorkerScript) || __filename;
    const timeoutMs = Number.isFinite(Number(taskOptions?.workerTimeoutMs)) && Number(taskOptions.workerTimeoutMs) > 0
      ? Number(taskOptions.workerTimeoutMs)
      : DEFAULT_HISTORY_WORKER_TIMEOUT_MS;
    const w = getOrStartHistoryWorker(workerEntry);
    const id = historyWorkerReqId++;
    return await new Promise((resolve) => {
      const entry = { resolve, timer: null, worker: w };
      entry.timer = setTimeout(() => {
        if (!historyWorkerPending.has(id)) return;
        historyWorkerPending.delete(id);
        if (historyWorkerInstance === w) historyWorkerInstance = null;
        clearAllHistoryWorkerPending(w, `Worker 任务超时 (${timeoutMs}ms)`);
        try { w.terminate(); } catch { }
        resolve({ _workerHandled: false, error: `Worker 任务超时 (${timeoutMs}ms)`, timedOut: true });
      }, timeoutMs);
      if (typeof entry.timer.unref === 'function') entry.timer.unref();
      historyWorkerPending.set(id, entry);
      try {
        try { w.ref(); } catch { }
        w.postMessage({ id, cmd, payload, env: captureCollectorEnvSnapshot() });
      } catch {
        historyWorkerPending.delete(id);
        if (historyWorkerPending.size === 0) {
          try { w.unref(); } catch { }
        }
        if (entry.timer) clearTimeout(entry.timer);
        resolve(null);
      }
    });
  } catch {
    return null;
  }
}

let cachedNodeDatabaseSync;
