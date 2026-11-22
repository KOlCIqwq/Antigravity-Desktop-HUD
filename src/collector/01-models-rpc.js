'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { normalizeLoopbackOrigin } = require('./local-api');
const { fileURLToPath } = require('url');
const { spawn, spawnSync } = require('child_process');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const origDateNow = Date.now;
const origFsMethods = {
  readFileSync: fs.readFileSync,
  writeFileSync: fs.writeFileSync,
  copyFileSync: fs.copyFileSync,
  renameSync: fs.renameSync,
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  existsSync: fs.existsSync
};
const { safeWriteJsonSync, safeReadJsonSync, withFileLockSync } = require('./meter-storage');
const {
  buildCliProxyEnv,
  detectProxyConfig,
  parseAndValidateProxyUrl,
  matchesNoProxy,
  redactProxyUrl,
  openSocks5Tunnel,
  openHttpConnectTunnel,
  classifyRequestTimeoutPhase,
  sanitizeDiagnosticErrorText
} = require('./meter-proxy');
const {
  conversationWorkspaces,
  extractWorkspacePathFromUri,
  extractWorkspaceFromTrajectory,
  extractWorkspaceFromTranscriptFile,
  resolveCliExecutable,
  resolveCliWorkspace,
  launchCliSession
} = require('./meter-cli-launcher');
const {
  analyzeBinaryAsync: getContextUnlockStatus,
  analyzeBinary,
  analyzeBinaryAsync,
  applyUnlock: applyContextUnlock,
  applyUnlockAsync: applyContextUnlockAsync,
  restoreUnlock: restoreContextUnlock,
  restoreUnlockAsync: restoreContextUnlockAsync,
  validateContextLimit,
  DEFAULT_CHECKPOINT_TOKENS,
  AUTHOR_INFO: CONTEXT_UNLOCK_AUTHOR
} = require('./meter-context-unlock');
const {
  analyzeSteps,
  summarize,
  add,
  empty,
  measure,
  summarizeApiCost,
  calculateReferenceModelCost,
  resolveEffectivePlanStatus,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  CURRENCY_SYMBOLS,
  parseUserPlanStatus,
  buildModelQuotaSnapshot,
  isDecorativeBadgeTagTitle,
  getModelPoolKey,
  getSharedQuotaGroupKey,
  extractCallId,
  parseGeneratorCall,
  extractModelString,
  normalizeModelId,
  resolveStableModelId,
  UNATTRIBUTED_MODEL_KEY,
  resolveModelUsageBucket,
  computeCacheReadStats,
  summarizeCacheReadStats,
  summarizeDailyMapCacheStats,
  normalizeSessionCallRecord,
  sanitizeTurnPreviewText,
  groupSessionCallsByTurns,
  isValidSpeedSample,
  MAX_SPEED_SAMPLES_PER_MODEL,
  calculateRequestApiCost,
  filterReleases,
  findReleaseAsset,
  compareVersions
} = require('./meter-core');
const { PROJECT_VERSION } = require('./modules-config');

let cachedPython = undefined;
function resolvePython() {
  if (cachedPython !== undefined) return cachedPython;
  const home = os.homedir();
  const candidates = [];
  if (process.env.AG_METER_PYTHON) candidates.push(process.env.AG_METER_PYTHON);
  candidates.push(
    path.join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
  );
  if (process.platform === 'win32') {
    const localPrograms = path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Programs', 'Python');
    if (fs.existsSync(localPrograms)) {
      for (const dir of fs.readdirSync(localPrograms).sort().reverse()) {
        candidates.push(path.join(localPrograms, dir, 'python.exe'));
      }
    }
  }
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p) && fs.statSync(p).size > 0) {
        cachedPython = p;
        return cachedPython;
      }
    } catch { }
  }
  for (const cmd of process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']) {
    try {
      const check = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
      if (check.status === 0 && check.stdout.trim()) {
        cachedPython = check.stdout.trim().split(/\r?\n/)[0];
        return cachedPython;
      }
    } catch { }
  }
  cachedPython = null;
  return null;
}

/**
 * 规范化模型标识符（小写且去掉 proto 常见 MODEL_ 前缀）
 * @param {string} raw
 * @returns {string}
 */
function normalizeModelKeyForCap(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw).trim().toLowerCase().replace(/^model_/, '');
}

/**
 * 读取正整数能力数值；非正数或非法值统一返回 null
 * @param {unknown} v
 * @returns {number|null}
 */
function toPositiveIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * 读取非负整数能力数值（如 minThinkingBudget/maxOutputTokens 为 0）
 * @param {unknown} v
 * @returns {number|null}
 */
function toNonNegativeIntOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/**
 * 解析 LanguageServerService.GetAvailableModels 响应为安全能力映射表
 * 仅提取数值/枚举/标签元数据，绝不保留敏感或无关负载
 * @param {object|null|undefined} raw
 * @returns {Record<string, object>}
 */
function parseAvailableModelsResponse(raw) {
  const out = Object.create(null);
  const modelsObj = raw?.response?.models || raw?.models || (raw && typeof raw === 'object' && !Array.isArray(raw) && !raw.userStatus ? raw : null);
  if (!modelsObj || typeof modelsObj !== 'object') return out;

  const entries = Array.isArray(modelsObj)
    ? modelsObj.map(item => [item?.model || item?.modelId || item?.id || '', item])
    : Object.entries(modelsObj);

  for (const [entryKey, d] of entries) {
    if (!d || typeof d !== 'object') continue;
    const rawId = String(d.model || d.modelId || entryKey || '').trim();
    if (!rawId) continue;
    const normKey = normalizeModelKeyForCap(rawId);
    const entry = {
      modelId: rawId,
      normalizedId: normKey,
      displayName: typeof d.displayName === 'string' && d.displayName.trim() ? d.displayName.trim() : null,
      maxTokens: toPositiveIntOrNull(d.maxTokens ?? d.max_tokens),
      maxOutputTokens: toNonNegativeIntOrNull(d.maxOutputTokens ?? d.max_output_tokens),
      thinkingBudget: toNonNegativeIntOrNull(d.thinkingBudget ?? d.thinking_budget),
      minThinkingBudget: toNonNegativeIntOrNull(d.minThinkingBudget ?? d.min_thinking_budget),
      thinkingLevel: typeof (d.thinkingLevel ?? d.thinking_level) === 'string' ? (d.thinkingLevel ?? d.thinking_level) : null,
      supportsModelInfoOverride: typeof (d.supportsModelInfoOverride ?? d.supports_model_info_override) === 'boolean'
        ? Boolean(d.supportsModelInfoOverride ?? d.supports_model_info_override)
        : null,
      modelProvider: typeof (d.modelProvider ?? d.model_provider) === 'string' ? (d.modelProvider ?? d.model_provider) : null,
      disabled: typeof d.disabled === 'boolean' ? d.disabled : null,
      recommended: typeof d.recommended === 'boolean' ? d.recommended : null,
      tagTitle: typeof (d.tagTitle ?? d.tag_title) === 'string' ? (d.tagTitle ?? d.tag_title).trim() : null,
      tagDescription: typeof (d.tagDescription ?? d.tag_description) === 'string' ? (d.tagDescription ?? d.tag_description).trim() : null,
      capabilitySource: 'get_available_models'
    };
    if (normKey) out[normKey] = entry;
    if (entryKey && normalizeModelKeyForCap(entryKey) && !out[normalizeModelKeyForCap(entryKey)]) {
      out[normalizeModelKeyForCap(entryKey)] = entry;
    }
  }
  return out;
}

/**
 * 从会话 steps[].metadata.modelInfo 中提取实测上报的模型能力元数据
 * 严格隐私边界：仅提取 ModelInfo 数值与枚举标识，绝不读取/存储任何用户消息文本或令牌
 * @param {Array<object>} steps
 * @returns {Record<string, object>}
 */
function extractObservedModelInfoFromSteps(steps) {
  const out = Object.create(null);
  if (!Array.isArray(steps)) return out;
  for (const s of steps) {
    const md = s?.metadata;
    const mi = md?.modelInfo || md?.model_info;
    if (!mi || typeof mi !== 'object') continue;
    const rawId = String(
      mi.modelId || mi.model_id || md.requestedModel?.model || md.generatorModel?.model || ''
    ).trim();
    const normKey = normalizeModelKeyForCap(rawId);
    const maxTokens = toPositiveIntOrNull(mi.maxTokens ?? mi.max_tokens);
    const maxOutputTokens = toNonNegativeIntOrNull(mi.maxOutputTokens ?? mi.max_output_tokens);
    if (!normKey || (!maxTokens && maxOutputTokens === null)) continue;
    out[normKey] = {
      modelId: rawId,
      normalizedId: normKey,
      displayName: typeof (mi.displayName ?? mi.display_name) === 'string' ? (mi.displayName ?? mi.display_name).trim() : null,
      maxTokens,
      maxOutputTokens,
      thinkingBudget: toNonNegativeIntOrNull(mi.thinkingBudget ?? mi.thinking_budget),
      minThinkingBudget: toNonNegativeIntOrNull(mi.minThinkingBudget ?? mi.min_thinking_budget),
      thinkingLevel: typeof (mi.thinkingLevel ?? mi.thinking_level) === 'string' ? (mi.thinkingLevel ?? mi.thinking_level) : null,
      capabilitySource: 'step_model_info'
    };
  }
  return out;
}

/**
 * 将 GetAvailableModels 与 Step.metadata.modelInfo 的能力字段安全合并到 cascadeModelConfigs
 * 不做按模型名称猜上限；缺失能力保持 null
 */
function mergeModelCapabilitiesIntoConfigs(configs, availableMap = null, stepCapsMap = null) {
  const list = Array.isArray(configs) ? configs.slice() : [];
  const availEntries = availableMap && typeof availableMap === 'object' ? Object.values(availableMap) : [];
  const stepEntries = stepCapsMap && typeof stepCapsMap === 'object' ? Object.values(stepCapsMap) : [];

  const lookupCap = (candidates, label) => {
    for (const c of candidates) {
      const k = normalizeModelKeyForCap(c);
      if (!k) continue;
      if (availableMap?.[k]) return availableMap[k];
      if (stepCapsMap?.[k]) return stepCapsMap[k];
    }
    const cleanLbl = typeof label === 'string' ? label.trim().toLowerCase() : '';
    if (cleanLbl) {
      const aMatches = availEntries.filter(e => e?.displayName && e.displayName.toLowerCase() === cleanLbl);
      if (aMatches.length === 1) return aMatches[0];
      const sMatches = stepEntries.filter(e => e?.displayName && e.displayName.toLowerCase() === cleanLbl);
      if (sMatches.length === 1) return sMatches[0];
    }
    return null;
  };

  const merged = list.map(cfg => {
    if (!cfg || typeof cfg !== 'object') return cfg;
    const cap = lookupCap([cfg.modelId, cfg.model, cfg.modelOrAlias?.model, cfg.modelOrAlias?.alias], cfg.label || cfg.modelDisplayName);
    if (!cap) return cfg;
    const next = { ...cfg };
    if (next.maxTokens == null && cap.maxTokens != null) next.maxTokens = cap.maxTokens;
    if (next.maxOutputTokens == null && cap.maxOutputTokens != null) next.maxOutputTokens = cap.maxOutputTokens;
    if (next.thinkingBudget == null && cap.thinkingBudget != null) next.thinkingBudget = cap.thinkingBudget;
    if (next.minThinkingBudget == null && cap.minThinkingBudget != null) next.minThinkingBudget = cap.minThinkingBudget;
    if (!next.thinkingLevel && cap.thinkingLevel) next.thinkingLevel = cap.thinkingLevel;
    if (next.supportsModelInfoOverride == null && cap.supportsModelInfoOverride != null) {
      next.supportsModelInfoOverride = cap.supportsModelInfoOverride;
    }
    if (!next.modelProvider && cap.modelProvider) next.modelProvider = cap.modelProvider;
    if (!next.capabilitySource && cap.capabilitySource) next.capabilitySource = cap.capabilitySource;
    if (next.disabled === undefined && cap.disabled !== null) next.disabled = cap.disabled;
    if (!next.tagTitle && cap.tagTitle) next.tagTitle = cap.tagTitle;
    if (!next.tagDescription && cap.tagDescription) next.tagDescription = cap.tagDescription;
    return next;
  });

  return merged;
}

function sanitizeCascadeModelConfig(c) {
  if (!c || typeof c !== 'object') return null;
  const tagTitle = typeof c.tagTitle === 'string' ? c.tagTitle.trim() : '';
  const tagDesc = typeof c.tagDescription === 'string' ? c.tagDescription.trim() : '';
  const isTagUnavailable = /unavailable|disabled|不可用|无权限|無權限/i.test(tagTitle);
  const isDecoTag = isDecorativeBadgeTagTitle(tagTitle);
  const isUnavail = Boolean(
    c.unavailable === true ||
    c.isUnavailable === true ||
    c.status === 'unavailable' ||
    c.disabled === true ||
    c.enabled === false ||
    isTagUnavailable
  );
  const isHist = Boolean(
    c.isHistorical === true ||
    c.historical === true ||
    c.deprecated === true ||
    c.isDeprecated === true ||
    (typeof c.label === 'string' && /\(legacy\)|\(deprecated\)|\(old\)/i.test(c.label))
  );
  const rawReason = String(c.unavailabilityReason || c.disabledReason || c.reason || '').trim();
  const safeReason = (rawReason && !isDecorativeBadgeTagTitle(rawReason)) ? rawReason : null;
  const fallbackTagReason = isUnavail ? (tagDesc || (!isDecoTag && tagTitle ? tagTitle : null)) : null;
  return {
    modelId: c.modelId || c.model || '',
    label: c.label || c.modelDisplayName || c.modelId || '',
    modelOrAlias: c.modelOrAlias || null,
    value: c.value !== undefined ? c.value : undefined,
    modelAlias: c.modelAlias !== undefined ? c.modelAlias : undefined,
    quotaInfo: c.quotaInfo ? {
      remainingFraction: typeof c.quotaInfo.remainingFraction === 'number' ? c.quotaInfo.remainingFraction : null,
      resetTime: c.quotaInfo.resetTime || null
    } : null,
    tagTitle: tagTitle || null,
    tagDescription: tagDesc || null,
    contextWindowOptions: Array.isArray(c.contextWindowOptions) ? c.contextWindowOptions : undefined,
    maxTokens: toPositiveIntOrNull(c.maxTokens ?? c.max_tokens),
    maxOutputTokens: toNonNegativeIntOrNull(c.maxOutputTokens ?? c.max_output_tokens),
    thinkingBudget: toNonNegativeIntOrNull(c.thinkingBudget ?? c.thinking_budget),
    minThinkingBudget: toNonNegativeIntOrNull(c.minThinkingBudget ?? c.min_thinking_budget),
    thinkingLevel: typeof (c.thinkingLevel ?? c.thinking_level) === 'string' ? (c.thinkingLevel ?? c.thinking_level) : null,
    supportsModelInfoOverride: typeof (c.supportsModelInfoOverride ?? c.supports_model_info_override) === 'boolean'
      ? Boolean(c.supportsModelInfoOverride ?? c.supports_model_info_override)
      : null,
    modelProvider: typeof (c.modelProvider ?? c.model_provider) === 'string' ? (c.modelProvider ?? c.model_provider) : null,
    capabilitySource: typeof c.capabilitySource === 'string' ? c.capabilitySource : null,
    disabled: c.disabled === true,
    allowedTiers: Array.isArray(c.allowedTiers) ? c.allowedTiers.slice() : undefined,
    unavailable: isUnavail,
    unavailabilityReason: safeReason || fallbackTagReason || null,
    notice: c.notice || c.clientNotice || c.warning || (!isUnavail && tagTitle && (!isDecoTag || tagDesc) ? `${tagTitle}${tagDesc ? `：${tagDesc}` : ''}` : null),
    isHistorical: isHist,
    releaseDate: c.releaseDate || null,
    family: c.family || null,
    effort: c.effort || null
  };
}

const FILES_CACHE_MAX_ENTRIES = 512;
const CONVERSATIONS_CACHE_MAX_ENTRIES = 32;
const filesCache = new Map();
const conversations = new Map();
const csrfTokenByOrigin = new Map();
let pythonQueue = Promise.resolve();

function setBoundedMap(map, key, val, maxEntries) {
  if (map.has(key)) map.delete(key);
  map.set(key, val);
  while (map.size > maxEntries) {
    const oldest = map.keys().next().value;
    map.delete(oldest);
  }
}

function request(origin, method, body, token, signal = null) {
  const url = method ? `${origin}/exa.language_server_pb.LanguageServerService/${method}` : origin + '/';
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('请求已取消');
      err.name = 'AbortError';
      reject(err);
      return;
    }
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.request(url, {
      agent: false,
      rejectUnauthorized: false,
      method: method ? 'POST' : 'GET',
      headers: method ? { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': token } : {},
      ...(signal ? { signal } : {})
    }, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 96 * 1024 * 1024) {
          req.destroy(new Error('本地响应过大，扫描不完整'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (signal?.aborted) {
          const err = new Error('请求已取消');
          err.name = 'AbortError';
          reject(err);
          return;
        }
        const text = Buffer.concat(chunks).toString();
        if (response.statusCode !== 200) reject(new Error(`本机接口 HTTP ${response.statusCode}`));
        else { try { resolve(method ? JSON.parse(text) : text); } catch (e) { reject(e); } }
      });
    });
    req.setTimeout(20000, () => req.destroy(new Error('本机接口读取超时')));
    req.on('error', reject);
    req.end(method ? JSON.stringify(body) : undefined);
  });
}

function pythonScan(items, signal = null) {
  const task = pythonQueue.then(() => {
    if (signal?.aborted) return items.map(item => ({ key: item.key, ...empty(), status: 'unknown', unknownParts: ['扫描已切换会话取消'] }));
    return runPythonScan(items, signal);
  });
  pythonQueue = task.catch(() => { });
  return task;
}

function runPythonScan(items, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve(items.map(item => ({ key: item.key, ...empty(), status: 'unknown', unknownParts: ['扫描已切换会话取消'] })));
    const py = resolvePython();
    if (!py) return reject(new Error('本地 Python 解析环境不可用'));
    const source = fs.readFileSync(path.join(__dirname, 'attachment_scan.py'), 'utf8');
    const child = spawn(py, ['-I', '-c', source, '--json-lines'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', errors = '', timedOut = false, aborted = false;
    const completed = [];
    const onAbort = () => { aborted = true; try { child.kill(); } catch { } };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120000);
    child.stdout.on('data', chunk => { output += chunk; let at; while ((at = output.indexOf('\n')) >= 0) { const line = output.slice(0, at).trim(); output = output.slice(at + 1); if (line) { try { completed.push(JSON.parse(line)); } catch { } } } }); child.stderr.on('data', chunk => { if (errors.length < 1000) errors += chunk; });
    child.on('error', e => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); reject(e); });
    child.on('close', code => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); const reason = aborted ? '扫描已切换会话取消' : timedOut ? '扫描超时，未完成部分不计为零' : code !== 0 ? '解析进程失败：' + errors.slice(0, 160) : '附件没有返回解析结果'; const done = new Set(completed.map(v => v.key)); for (const item of items) if (!done.has(item.key)) completed.push({ key: item.key, ...empty(), status: 'unknown', unknownParts: [reason] }); resolve(completed); });
    child.stdin.on('error', () => { }); child.stdin.end(JSON.stringify(items));
  });
}

function getImageDimensions(buf) {
  try {
    if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (buf.length >= 10 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if (buf.length >= 26 && buf[0] === 0x42 && buf[1] === 0x4D) {
      return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
    }
    if (buf.length >= 4 && buf[0] === 0xFF && buf[1] === 0xD8) {
      let offset = 2;
      while (offset < buf.length - 8) {
        if (buf[offset] === 0xFF && [0xC0, 0xC1, 0xC2, 0xC3].includes(buf[offset + 1])) {
          return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
        } else if (buf[offset] === 0xFF) {
          const len = buf.readUInt16BE(offset + 2);
          offset += 2 + len;
        } else {
          offset++;
        }
      }
    }
  } catch { }
  return { width: null, height: null };
}

function calcImageTokens(w, h) {
  if (!w || !h) return [258, 1120];
  if (w <= 384 && h <= 384) return [258, 258];
  const tiles = Math.ceil(w / 768) * Math.ceil(h / 768);
  const tok = tiles * 258;
  return [tok, Math.max(tok, (w > 384 || h > 384) ? 1120 : 258)];
}

async function scanFiles(media, scanOptions = {}) {
  const signal = scanOptions?.signal || null;
  const results = new Map(), work = [];
  for (const item of media) {
    if (signal?.aborted) break;
    try {
      if (item.inlineData) {
        const mime = String(item.mime || '').toLowerCase();
        const buf = Buffer.from(item.inlineData, 'base64');
        if (mime.startsWith('image/')) {
          const dims = getImageDimensions(buf);
          const [low, high] = calcImageTokens(dims.width, dims.height);
          results.set(item.uri, {
            status: 'parsed',
            width: dims.width,
            height: dims.height,
            chars: 0,
            dimensions: dims.width ? `${dims.width}×${dims.height}` : null,
            bytes: buf.length,
            low,
            high,
            unknownParts: []
          });
          continue;
        } else if (mime.startsWith('text/') || mime === 'application/json' || mime === 'text/csv') {
          const text = buf.toString('utf8');
          const m = measure(text);
          results.set(item.uri, {
            status: 'parsed',
            chars: text.length,
            bytes: buf.length,
            low: m.low,
            high: m.high,
            unknownParts: []
          });
          continue;
        } else {
          const est = Math.ceil(buf.length / 4);
          results.set(item.uri, {
            status: 'parsed',
            chars: buf.length,
            bytes: buf.length,
            low: Math.ceil(est * 0.7),
            high: Math.ceil(est * 1.4),
            unknownParts: []
          });
          continue;
        }
      }
      if (!item.uri || /^https?:/i.test(item.uri)) throw new Error('无可用本地附件，内容未知');
      const targetPath = item.uri.startsWith('file:') ? fileURLToPath(item.uri) : item.uri;
      let target;
      let stat;
      try {
        target = await fs.promises.realpath(targetPath);
        stat = await fs.promises.stat(target);
      } catch (fsErr) {
        if (fsErr && (fsErr.code === 'ENOENT' || fsErr.code === 'ENOTDIR')) {
          throw new Error('附件文件不存在或已移动');
        }
        throw fsErr;
      }
      if (!stat.isFile()) throw new Error('附件不是普通文件');
      const key = `${target.toLowerCase()}|${stat.size}|${stat.mtimeMs}`;
      if (filesCache.has(key)) {
        const hit = filesCache.get(key);
        setBoundedMap(filesCache, key, hit, FILES_CACHE_MAX_ENTRIES);
        results.set(item.uri, hit);
      } else {
        work.push({ key: item.uri, path: target, cacheKey: key });
      }
    } catch (e) { results.set(item.uri, { ...empty(), status: 'unknown', unknownParts: [item.reason || e.message] }); }
  }
  if (work.length && !signal?.aborted) {
    try {
      const parsed = await pythonScan(work.map(({ key, path }) => ({ key, path })), signal);
      for (const result of parsed) {
        const job = work.find(w => w.key === result.key);
        if (job) {
          if (result && result.status !== 'unknown') {
            setBoundedMap(filesCache, job.cacheKey, result, FILES_CACHE_MAX_ENTRIES);
          }
          results.set(job.key, result);
        }
      }
    } catch (e) { for (const job of work) results.set(job.key, { ...empty(), status: 'unknown', unknownParts: [e.message] }); }
  }
  return media.map(item => ({ ...item, ...(results.get(item.uri) || { ...empty(), status: 'unknown', unknownParts: ['未返回附件统计'] }), uri: undefined, key: undefined }));
}

let collectSeqCounter = 0;
const latestCollectSeqByOrigin = new Map();

async function collect(origin, id, options = {}) {
  const safeOrigin = normalizeLoopbackOrigin(origin);
  if (!safeOrigin || !/^[a-f\d-]{36}$/i.test(id)) throw new Error('无效本机会话');
  origin = safeOrigin;
  const key = `${origin}/${id}`;
  const supersede = options.supersedePrevious === true;
  const mySeq = supersede ? (++collectSeqCounter) : 0;
  const abortController = supersede ? new AbortController() : null;
  if (supersede) {
    const prevLatest = latestCollectSeqByOrigin.get(origin);
    if (prevLatest && prevLatest.id !== id && prevLatest.abortController) {
      try { prevLatest.abortController.abort(); } catch { }
    }
    latestCollectSeqByOrigin.set(origin, { seq: mySeq, id, abortController });
  }
  const isSuperseded = () => {
    if (!supersede) return false;
    const latest = latestCollectSeqByOrigin.get(origin);
    return Boolean((latest && latest.seq > mySeq && latest.id !== id) || abortController?.signal?.aborted);
  };
  const previous = conversations.get(key);
  if (previous?.pending) return previous.pending;
  if (options.force) filesCache.clear();
  if (!options.force && previous?.result && Date.now() - previous.at < 12000) return previous.result;
  const task = (async () => {
    const signal = abortController?.signal || null;
    try {
      const resolveOriginCsrfToken = (html) => {
        const matched =
          (typeof html === 'string' && (html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s) || html.match(/window\.__APP_CONFIG__ = (.*?);/))) ||
          null;
        let resolved = '';
        if (matched) {
          try {
            resolved = JSON.parse(matched[1]).csrfToken || '';
          } catch {}
        }
        if (!resolved) {
          resolved = require('./local-api').discoverDaemonHubTokenForOrigin(origin, options);
        }
        return resolved;
      };
      let token = !options.force ? csrfTokenByOrigin.get(origin) : null;
      if (!token) {
        const html = await request(origin, null, null, null, signal);
        if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
        token = resolveOriginCsrfToken(html);
        if (token) csrfTokenByOrigin.set(origin, token);
      }
      const call = async (method, body) => {
        try {
          return await request(origin, method, body, token, signal);
        } catch (err) {
          if (err && /HTTP 40[13]/.test(String(err.message || '')) && !signal?.aborted) {
            csrfTokenByOrigin.delete(origin);
            const html = await request(origin, null, null, null, signal);
            token = resolveOriginCsrfToken(html);
            if (token) csrfTokenByOrigin.set(origin, token);
            return await request(origin, method, body, token, signal);
          }
          throw err;
        }
      };
      const full = await call('GetCascadeTrajectory', { cascadeId: id, trajectoryVerbosity: 3 });
      if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      const trajectory = full.trajectory;
      if (!trajectory) throw new Error('未取得会话历史，无法完整统计');
      const wsPath = extractWorkspaceFromTrajectory(trajectory);
      if (wsPath) conversationWorkspaces.set(id.toLowerCase(), wsPath);
      const steps = trajectory.steps || [];
      const expected = Number(full.numTotalSteps ?? steps.length);
      while (steps.length < expected) {
        if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
        const page = await call('GetCascadeTrajectorySteps', { cascadeId: id, stepOffset: steps.length, trajectoryVerbosity: 3 });
        if (!page.steps?.length) throw new Error(`历史仅取得 ${steps.length}/${expected} 步，扫描未完成`);
        steps.push(...page.steps);
      }
      if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      const session = analyzeSteps(steps);
      const stepCapabilities = extractObservedModelInfoFromSteps(steps);
      const attachments = await scanFiles(session.media, { signal });
      if (isSuperseded()) return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      const attachmentTotal = empty();
      for (const a of attachments) { const n = a.references || 1; add(attachmentTotal, Object.fromEntries(['chars', 'bytes', 'low', 'high'].map(k => [k, (a[k] || 0) * n]))); }
      const total = add({ ...session.total }, attachmentTotal);
      let latest = null;
      const count = Number(full.numTotalGeneratorMetadata ?? trajectory.generatorMetadata?.length ?? 0);
      const tail = await call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: id, generatorMetadataOffset: Math.max(0, count - 3), includeMessages: false });
      let cachedHostUserStatus = cachedUserStatusByOrigin.get(normalizeQuotaOriginScope({ origin }))?.status || null;
      let knownCascadeConfigs = Array.isArray(cachedHostUserStatus?.cascadeModelConfigs) ? cachedHostUserStatus.cascadeModelConfigs : [];
      const hasAnyCap = knownCascadeConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      if (!knownCascadeConfigs.length || !hasAnyCap) {
        try {
          const freshStatus = await fetchUserStatusFromHost({ origin });
          if (freshStatus) cachedHostUserStatus = freshStatus;
          if (Array.isArray(freshStatus?.cascadeModelConfigs) && freshStatus.cascadeModelConfigs.length) {
            knownCascadeConfigs = freshStatus.cascadeModelConfigs;
          }
        } catch { }
      }
      const mergedCascadeConfigs = mergeModelCapabilitiesIntoConfigs(
        knownCascadeConfigs,
        cachedHostUserStatus?.availableModelDetails || null,
        stepCapabilities
      );
      let latestModel = null;
      let latestCallId = null;
      let latestCallRecord = null;
      const recentGeneratorCalls = [];
      for (const m of (tail.generatorMetadata || [])) {
        const callMeta = parseGeneratorCall(m, id, 'desktop', { cascadeModelConfigs: mergedCascadeConfigs });
        if (callMeta) {
          const normCall = normalizeSessionCallRecord(callMeta, { cascadeId: id, cascadeModelConfigs: mergedCascadeConfigs });
          if (normCall) recentGeneratorCalls.push(normCall);
        }
      }
      for (const m of (tail.generatorMetadata || []).slice().reverse()) {
        latest = summarize(m, { cascadeModelConfigs: mergedCascadeConfigs });
        if (latest) {
          latestModel = m.chatModel;
          const callMeta = parseGeneratorCall(m, id, 'desktop', { cascadeModelConfigs: mergedCascadeConfigs });
          latestCallId = callMeta?.callId || null;
          if (callMeta) {
            latestCallRecord = normalizeSessionCallRecord(callMeta, { cascadeId: id, cascadeModelConfigs: mergedCascadeConfigs });
          }
          break;
        }
      }
      const system = latestModel ? measure((latestModel.promptSections || []).map(p => p.content || '').join('\n') || latestModel.systemPrompt || '') : empty();
      const definitions = latestModel ? measure(JSON.stringify(latestModel.tools || [])) : empty();
      session.groups.system = system; session.groups.definitions = definitions;
      add(total, system); add(total, definitions);
      if (session.currentError) {
        const fromStep = summarize({ chatModel: { retryInfos: [{ error: session.currentError.text }] } }, {
          currentModel: latest?.model || latestModel?.modelDisplayName || latestModel?.model || '',
          cascadeModelConfigs: mergedCascadeConfigs,
          previousValidContext: latest
        });
        if (fromStep?.error) {
          latest = {
            ...(latest || {}),
            error: fromStep.error,
            errorClassification: fromStep.errorClassification,
            exceeded: fromStep.exceeded,
            network: fromStep.network,
            serviceLimit: fromStep.serviceLimit || latest?.serviceLimit || null,
            status: fromStep.status,
            actual: fromStep.exceeded ? null : (latest?.actual ?? null),
            percent: fromStep.exceeded ? null : (latest?.percent ?? null),
            estimated: latest?.actual == null
          };
        }
      }
    const unknownFiles = attachments.filter(a => a.status !== 'parsed').length;
    const compactCascadeConfigs = mergedCascadeConfigs.map(sanitizeCascadeModelConfig).filter(Boolean);
    const modelCapabilitiesById = {
      ...(cachedHostUserStatus?.availableModelDetails || {}),
      ...stepCapabilities
    };
    const result = { version: PROJECT_VERSION, conversation: id, workspacePath: wsPath || null, latest, latestCallId, latestCallRecord, recentGeneratorCalls, generatorCount: count, cascadeModelConfigs: compactCascadeConfigs, modelCapabilitiesById, session: { ...session, media: undefined, attachmentTotal, total, attachments, unknownFiles, complete: unknownFiles === 0, scope: '全量可读取历史 + 上传附件 + 当前系统提示与工具定义；不将每轮重复输入累加；非服务端分词结果' }, scannedAt: Date.now(), errors: [] };
    if (isSuperseded()) {
      conversations.delete(key);
      return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
    }
    setBoundedMap(conversations, key, { result, at: Date.now() }, CONVERSATIONS_CACHE_MAX_ENTRIES);
    return result;
    } catch (err) {
      if (isSuperseded() || (err && err.name === 'AbortError' && signal?.aborted)) {
        return { version: PROJECT_VERSION, conversation: id, abortedStale: true, scannedAt: Date.now(), errors: [] };
      }
      throw err;
    }
  })();
  setBoundedMap(conversations, key, { ...previous, pending: task }, CONVERSATIONS_CACHE_MAX_ENTRIES);
  try { return await task; } catch (e) { conversations.delete(key); throw e; }
}

let cachedTokenHistory = null;
let cachedTokenHistoryAt = 0;
