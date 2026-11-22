function formatLocalDateKey(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Check whether a file is a SQLite companion or temporary file
function isCompanionOrTempFile(fileName) {
  const lower = fileName.toLowerCase();
  return lower.endsWith('-wal') ||
    lower.endsWith('-shm') ||
    lower.endsWith('-journal') ||
    lower.endsWith('.tmp') ||
    lower.endsWith('.lock') ||
    lower.endsWith('.bak');
}

// Safely attempt to read GetUserStatus from LanguageServer

// ============================================================================
// Per-request priced ledger persistence, synthetic data isolation, and idempotent recording
// ============================================================================
const ledgerCacheByPath = new Map();

function normalizeLedgerKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isSyntheticCall(callId, call = {}) {
  if (!callId) return false;
  const sId = String(callId).toLowerCase();
  const cId = String(call?.cascadeId || '').toLowerCase();
  return sId.startsWith('test_') ||
    sId.startsWith('fixture_') ||
    sId.startsWith('synthetic_') ||
    sId.includes('desktop_response_001') ||
    cId.includes('verify') ||
    cId.includes('test') ||
    cId.includes('mock');
}

function getPricingLedgerPath(overridePathOrDir) {
  if (overridePathOrDir) {
    if (overridePathOrDir.endsWith('.json')) return overridePathOrDir;
    return path.join(overridePathOrDir, 'pricing_ledger_v1.json');
  }
  if (process.env.AG_DIR) {
    return path.join(process.env.AG_DIR, 'pricing_ledger_v1.json');
  }
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini', 'antigravity', 'pricing_ledger_v1.json');
}

function createUnreadableLedger(filePath, error, isCorrupted = false, phase = 'unreadable_guard', code = undefined) {
  return {
    version: '1.0.0',
    updatedAt: '',
    calls: {},
    ...(isCorrupted ? { __corrupted: true } : {}),
    __unreadable: true,
    __guardPhase: phase,
    ...(code ? { __code: code } : {}),
    __corruptedPath: filePath,
    __error: error || '账本文件当前不可读'
  };
}

function quarantineSyntheticCalls(overridePathOrDir, options = {}) {
  const fsImpl = (options && options.fs) || fs;
  const p = path.resolve(getPricingLedgerPath(overridePathOrDir));
  const cacheKey = normalizeLedgerKey(p);
  const qPath = p.replace('pricing_ledger_v1.json', 'pricing_ledger_quarantine.json');

  try {
    const readRes = safeReadJsonSync(p, null, { fs: fsImpl });
    if (!readRes.exists || !readRes.ok || !readRes.data || typeof readRes.data !== 'object') {
      return { quarantinedCount: 0 };
    }
    const raw = readRes.data;
    const calls = raw.calls || {};
    const quarantined = {};
    const kept = {};

    for (const [id, call] of Object.entries(calls)) {
      if (isSyntheticCall(id, call)) {
        quarantined[id] = call;
      } else {
        kept[id] = call;
      }
    }

    const qCount = Object.keys(quarantined).length;
    if (qCount > 0) {
      let qData = { version: '1.0.0', quarantinedAt: new Date().toISOString(), calls: {} };
      const qRead = safeReadJsonSync(qPath, null, { fs: fsImpl });
      if (qRead.exists && qRead.ok && qRead.data && typeof qRead.data === 'object') {
        qData = qRead.data;
      }
      qData.calls = { ...qData.calls, ...quarantined };
      safeWriteJsonSync(qPath, qData, { fs: fsImpl });

      raw.calls = kept;
      raw.updatedAt = new Date().toISOString();
      const saveRes = safeWriteJsonSync(p, raw, { fs: fsImpl });
      if (saveRes.ok) {
        ledgerCacheByPath.delete(cacheKey);
      }
    }
    return { quarantinedCount: qCount };
  } catch {
    return { quarantinedCount: 0 };
  }
}

function loadPricingLedger(overridePathOrDir, options = {}) {
  const fsImpl = (options && options.fs) || fs;
  const p = path.resolve(getPricingLedgerPath(overridePathOrDir));
  const cacheKey = normalizeLedgerKey(p);
  const def = { version: '1.0.0', updatedAt: '', calls: {} };

  let st = null;
  try {
    st = fsImpl.statSync(p);
  } catch (statErr) {
    ledgerCacheByPath.delete(cacheKey);
    if (statErr && statErr.code === 'ENOENT') {
      return def;
    }
    return createUnreadableLedger(p, statErr?.message || '检查账本文件状态失败', false, 'unreadable_guard', statErr?.code);
  }

  if (!st || typeof st.isFile !== 'function' || !st.isFile()) {
    ledgerCacheByPath.delete(cacheKey);
    const nonFileCode = (st && typeof st.isDirectory === 'function' && st.isDirectory()) ? 'EISDIR' : 'EINVAL';
    return createUnreadableLedger(p, '账本目标路径不是普通文件', false, 'unreadable_guard', nonFileCode);
  }

  if (!options?.fs) {
    const cached = ledgerCacheByPath.get(cacheKey);
    if (cached && !cached.ledger?.__corrupted && !cached.ledger?.__unreadable && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.ledger;
    }
  }

  const bakPath = p.replace(/\.json$/i, '') + '.bak.json';
  const readRes = safeReadJsonSync(p, null, {
    fs: fsImpl,
    backupPath: bakPath,
    validate: (data) => data && typeof data === 'object' && typeof data.calls === 'object'
  });

  if (!readRes.exists) {
    ledgerCacheByPath.delete(cacheKey);
    // Block writes if statSync confirmed the file exists but subsequent read returned exists: false, preventing transient errors from wiping the ledger
    return createUnreadableLedger(p, readRes.error || '账本文件状态不一致（stat 存在但读取返回不存在）', false, 'unreadable_guard', readRes.code || 'ENOENT');
  }

  if (readRes.corrupted && !readRes.recoveredFromBackup) {
    ledgerCacheByPath.delete(cacheKey);
    // File exists but is corrupted with no recoverable backup; never overwrite it as normal empty data
    return createUnreadableLedger(p, readRes.error, true, 'corrupted_guard', readRes.code);
  }

  if (!readRes.ok || !readRes.data || typeof readRes.data !== 'object') {
    ledgerCacheByPath.delete(cacheKey);
    return createUnreadableLedger(p, readRes.error || '读取账本文件失败', false, 'unreadable_guard', readRes.code);
  }

  const raw = readRes.data;
  const ledger = { version: raw.version || '1.0.0', updatedAt: raw.updatedAt || '', calls: { ...(raw.calls || {}) } };
  let hasSynthetic = false;
  for (const [id, call] of Object.entries(ledger.calls)) {
    if (isSyntheticCall(id, call)) {
      hasSynthetic = true;
      break;
    }
  }
  if (hasSynthetic) {
    quarantineSyntheticCalls(overridePathOrDir, options);
    const cleanedRes = safeReadJsonSync(p, null, { fs: fsImpl });
    if (cleanedRes.exists && cleanedRes.ok && cleanedRes.data && typeof cleanedRes.data === 'object') {
      ledger.calls = { ...(cleanedRes.data.calls || {}) };
      ledger.updatedAt = cleanedRes.data.updatedAt || '';
    }
  }

  // During read, automatically resolve historical dual keys (responseId + cascadeId#stepIndex) confirmed to be the same call in memory, without writing to disk on read-only paths
  if (reconcileConfirmableDuplicateStepCalls(ledger.calls)) {
    Object.defineProperty(ledger, '__hadDuplicateStepKeys', { value: true, configurable: true });
  }

  // Create automatic rolling backup for valid persisted data for corruption recovery
  if (!readRes.corrupted) {
    try {
      if (!fsImpl.existsSync(bakPath) || Math.random() < 0.1) {
        fsImpl.copyFileSync(p, bakPath);
      }
    } catch { }
  }

  if (readRes.ok && !hasSynthetic && !options?.fs) {
    try {
      const stAfter = fsImpl.statSync(p);
      if (stAfter.isFile() && stAfter.mtimeMs === st.mtimeMs && stAfter.size === st.size) {
        ledgerCacheByPath.set(cacheKey, { ledger, mtimeMs: stAfter.mtimeMs, size: stAfter.size });
      } else {
        ledgerCacheByPath.delete(cacheKey);
      }
    } catch {
      ledgerCacheByPath.delete(cacheKey);
    }
  }
  return ledger;
}

function savePricingLedger(ledger, overridePathOrDir, options = {}) {
  const fsImpl = (options && options.fs) || fs;
  if (ledger && (ledger.__corrupted || ledger.__unreadable)) {
    const errMsg = ledger.__corrupted
      ? '原账本数据已损坏且未从备份恢复，已阻止以空数据覆盖原有历史'
      : `原账本当前不可读 (${ledger.__error || 'I/O 异常'})，已阻止写入覆盖原有历史`;
    return {
      ok: false,
      phase: ledger.__guardPhase || (ledger.__corrupted ? 'corrupted_guard' : 'unreadable_guard'),
      ...(ledger.__code ? { code: ledger.__code } : {}),
      error: errMsg
    };
  }
  const p = path.resolve(getPricingLedgerPath(overridePathOrDir));
  const cacheKey = normalizeLedgerKey(p);
  const res = safeWriteJsonSync(p, ledger, {
    fs: fsImpl,
    validate: (data) => data && typeof data === 'object' && typeof data.calls === 'object'
  });
  if (res.ok && !options?.fs) {
    try {
      const st = fsImpl.statSync(p);
      if (st.isFile()) {
        const cachedCopy = {
          version: ledger.version || '1.0.0',
          updatedAt: ledger.updatedAt || '',
          calls: { ...(ledger.calls || {}) }
        };
        if (reconcileConfirmableDuplicateStepCalls(cachedCopy.calls)) {
          Object.defineProperty(cachedCopy, '__hadDuplicateStepKeys', { value: true, configurable: true });
        }
        ledgerCacheByPath.set(cacheKey, { ledger: cachedCopy, mtimeMs: st.mtimeMs, size: st.size });
      }
    } catch { }
  }
  return res;
}

function createRecordResult(ok, changed, error, phase, code) {
  return {
    ok: !!ok,
    changed: !!changed,
    error: error || undefined,
    phase: phase || undefined,
    ...(code ? { code } : {}),
    valueOf() { return this.changed; }
  };
}

function hasSpeedMetrics(rec) {
  if (!rec || typeof rec !== 'object') return false;
  return rec.durationSec != null || rec.tps != null || rec.ttftSec != null || rec.streamingSec != null;
}

function getCallSortTimestamp(rec) {
  if (!rec) return 0;
  if (Number.isFinite(Number(rec.timestamp)) && Number(rec.timestamp) > 0) return Number(rec.timestamp);
  if (rec.created_at) {
    const t = Date.parse(rec.created_at);
    if (Number.isFinite(t) && t > 0) return t;
  }
  if (rec.date) {
    const t = Date.parse(rec.date);
    if (Number.isFinite(t) && t > 0) return t;
  }
  return Number(rec.updatedAt) || 0;
}

/**
 * Retain at most the latest 200 speed samples per exact model ID; for excess entries, clear only speed fields while keeping billing and token data intact
 */
function pruneExcessSpeedSamples(draftCalls, limit = MAX_SPEED_SAMPLES_PER_MODEL || 200) {
  if (!draftCalls || typeof draftCalls !== 'object') return false;
  const byModel = new Map();
  for (const [callId, rec] of Object.entries(draftCalls)) {
    if (!rec || !hasSpeedMetrics(rec)) continue;
    const exactId = String(rec.modelExactId || resolveStableModelId(rec) || rec.model || '').trim().toLowerCase();
    if (!exactId) continue;
    if (!byModel.has(exactId)) byModel.set(exactId, []);
    byModel.get(exactId).push({ callId, ts: getCallSortTimestamp(rec) });
  }
  let pruned = false;
  for (const entries of byModel.values()) {
    if (entries.length <= limit) continue;
    entries.sort((a, b) => b.ts - a.ts);
    for (let i = limit; i < entries.length; i++) {
      const rec = draftCalls[entries[i].callId];
      if (!rec) continue;
      const copy = { ...rec };
      delete copy.ttftSec;
      delete copy.streamingSec;
      delete copy.durationSec;
      delete copy.tps;
      delete copy.origin;
      draftCalls[entries[i].callId] = copy;
      pruned = true;
    }
  }
  return pruned;
}

function parseStepFallbackKey(callId, cascadeId) {
  if (typeof callId !== 'string' || !callId.includes('#')) return null;
  const hashIdx = callId.lastIndexOf('#');
  if (hashIdx <= 0) return null;
  const idPart = callId.slice(0, hashIdx);
  const stepPart = callId.slice(hashIdx + 1);
  if (!/^\d+$/.test(stepPart)) return null;
  if (cascadeId && idPart.toLowerCase() !== String(cascadeId).toLowerCase()) return null;
  return { cascadeId: cascadeId ? String(cascadeId) : idPart, stepIndex: Number(stepPart) };
}

function isStepFallbackCallId(callId, cascadeId) {
  return parseStepFallbackKey(callId, cascadeId) !== null;
}

function extractCallStepNumbers(c, fallbackKey = null) {
  const steps = [];
  if (!c) return steps;
  if (c.stepIndex !== null && c.stepIndex !== undefined && c.stepIndex !== '' && Number.isInteger(Number(c.stepIndex)) && Number(c.stepIndex) >= 0) {
    steps.push(Number(c.stepIndex));
  }
  if (Array.isArray(c.stepIndices)) {
    for (const s of c.stepIndices) {
      if (s !== null && s !== undefined && s !== '' && Number.isInteger(Number(s)) && Number(s) >= 0 && !steps.includes(Number(s))) {
        steps.push(Number(s));
      }
    }
  }
  if (!steps.length) {
    const parsed = parseStepFallbackKey(c.callId || fallbackKey, c.cascadeId);
    if (parsed) steps.push(parsed.stepIndex);
  }
  return steps;
}

function getCallTokenBreakdown(c) {
  if (!c || typeof c !== 'object') return { inp: 0, cap: 0, out: 0, think: 0, tot: 0 };
  const inp = Number(c.inputTokens ?? c.input_tokens ?? c.input ?? 0) || 0;
  const cap = Number(c.cacheTokens ?? c.cacheReadTokens ?? c.cache_read_tokens ?? c.cached ?? 0) || 0;
  const out = Number(c.outputTokens ?? c.output_tokens ?? c.output ?? 0) || 0;
  const think = Number(c.thinkingTokens ?? c.thinking_output_tokens ?? c.thinking ?? 0) || 0;
  const computedTot = inp + cap + out;
  const rawTot = Number(c.totalTokens ?? 0) || 0;
  return { inp, cap, out, think, tot: computedTot > 0 ? computedTot : rawTot };
}

function isPlaceholderModel(raw) {
  if (!raw || typeof raw !== 'string') return false;
  return /^model_placeholder_/i.test(raw.trim());
}

function getCollectorModelRank(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 0;
  if (isPlaceholderModel(s)) return 1;
  if (!normalizeModelId(s)) return 2;
  return 3;
}

function areModelsCompatible(mA, mB) {
  const a = typeof mA === 'string' ? mA.trim() : '';
  const b = typeof mB === 'string' ? mB.trim() : '';
  if (!a || !b || isPlaceholderModel(a) || isPlaceholderModel(b)) return true;
  if (a.toLowerCase() === b.toLowerCase()) return true;
  const normA = normalizeModelId(a);
  const normB = normalizeModelId(b);
  if (normA && normB) return normA === normB;
  return false;
}

function pickRicherModel(primaryModel, secondaryModel) {
  const a = typeof primaryModel === 'string' ? primaryModel.trim() : '';
  const b = typeof secondaryModel === 'string' ? secondaryModel.trim() : '';
  if (!a) return b;
  if (!b) return a;
  const rankA = getCollectorModelRank(a);
  const rankB = getCollectorModelRank(b);
  if (rankB > rankA) return b;
  if (rankA > rankB) return a;
  return a;
}

function extractNormalizedDateInfo(e) {
  if (!e || typeof e !== 'object') {
    return { rank: 0, date: null, created_at: null, dateSource: null, dateIsProvisional: true };
  }
  const rawDate = (e.date && /^\d{4}-\d{2}-\d{2}/.test(String(e.date))) ? String(e.date).slice(0, 10) : null;
  const isProv = e.dateIsProvisional === true || e.dateSource === 'provisional';
  if (isProv) {
    return {
      rank: rawDate ? 1 : 0,
      date: rawDate,
      created_at: null,
      dateSource: rawDate ? 'provisional' : null,
      dateIsProvisional: true
    };
  }
  let parsedLocalFromCreated = null;
  if (e.created_at) {
    const dt = new Date(e.created_at);
    if (!Number.isNaN(dt.getTime())) {
      parsedLocalFromCreated = formatLocalDateKey(dt);
    }
  }
  if (e.dateSource === 'transcript' && (rawDate || parsedLocalFromCreated)) {
    return {
      rank: 4,
      date: parsedLocalFromCreated || rawDate,
      created_at: e.created_at ? String(e.created_at) : null,
      dateSource: 'transcript',
      dateIsProvisional: false
    };
  }
  if (parsedLocalFromCreated) {
    return {
      rank: 3,
      date: parsedLocalFromCreated,
      created_at: String(e.created_at),
      dateSource: e.dateSource || 'created_at',
      dateIsProvisional: false
    };
  }
  if (rawDate) {
    return {
      rank: 2,
      date: rawDate,
      created_at: null,
      dateSource: e.dateSource || 'explicit_date',
      dateIsProvisional: false
    };
  }
  return { rank: 0, date: null, created_at: null, dateSource: null, dateIsProvisional: true };
}

function compareCallUsage(uA, uB) {
  if (uA.tot !== uB.tot) return uA.tot - uB.tot;
  return uA.out - uB.out;
}

function extractSourceRevision(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = entry.sourceRevision ?? entry.revision ?? entry.metadataRevision;
  if (raw !== undefined && raw !== null && raw !== '') {
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  const rawUpdated = entry.updated_at ?? entry.sourceUpdatedAt;
  if (rawUpdated !== undefined && rawUpdated !== null && rawUpdated !== '') {
    const ts = typeof rawUpdated === 'number' ? rawUpdated : Date.parse(String(rawUpdated));
    if (Number.isFinite(ts)) return ts;
  }
  return null;
}

function compareSourceRevision(incRev, baseRev) {
  const a = typeof incRev === 'number' && Number.isFinite(incRev) ? incRev : null;
  const b = typeof baseRev === 'number' && Number.isFinite(baseRev) ? baseRev : null;
  if (a === null && b === null) return 0;
  if (a !== null && b === null) return 1;
  if (a === null && b !== null) return -1;
  if (a === b) return 0;
  return a > b ? 1 : -1;
}

function shouldAdoptSameRankAuthDate(baseEntry, incomingEntry, baseDateInfo, incDateInfo, usageCmp, revCmp, forceIncomingDate = false) {
  const incomingIsStaleStatus = baseEntry.status === 'final' && Boolean(incomingEntry.status) && incomingEntry.status !== 'final';
  if (incomingIsStaleStatus || !incDateInfo.date) return false;
  if (!baseDateInfo.date) return true;
  if (forceIncomingDate) return true;
  if (baseEntry.status !== 'final' && incomingEntry.status === 'final' && usageCmp >= 0 && revCmp >= 0) return true;
  if (revCmp > 0 && usageCmp >= 0) return true;
  if (usageCmp > 0 && revCmp >= 0) return true;
  return false;
}

function mergeSameCallRecords(baseEntry, incomingEntry, canonicalKey, explicitStep = null, preferIncomingModel = false, preferIncomingDate = false) {
  const uBase = getCallTokenBreakdown(baseEntry);
  const uInc = getCallTokenBreakdown(incomingEntry);
  const baseRev = extractSourceRevision(baseEntry);
  const incRev = extractSourceRevision(incomingEntry);
  const usageCmp = compareCallUsage(uInc, uBase);
  const revCmp = compareSourceRevision(incRev, baseRev);
  const incomingIsStaleStatus = baseEntry.status === 'final' && Boolean(incomingEntry.status) && incomingEntry.status !== 'final';
  const takeIncUsage = !incomingIsStaleStatus && (usageCmp > 0 || (usageCmp === 0 && revCmp > 0));

  const inp = takeIncUsage ? uInc.inp : uBase.inp;
  const cap = takeIncUsage ? uInc.cap : uBase.cap;
  const out = takeIncUsage ? uInc.out : uBase.out;
  const think = takeIncUsage ? (uInc.out < uBase.out ? Math.min(uInc.out, uInc.think) : Math.max(uBase.think, uInc.think)) : uBase.think;
  const tot = takeIncUsage ? uInc.tot : uBase.tot;

  const mergedModel = preferIncomingModel && !incomingIsStaleStatus
    ? pickRicherModel(incomingEntry.model, baseEntry.model)
    : pickRicherModel(baseEntry.model, incomingEntry.model);

  const resolvedStep = explicitStep
    ?? baseEntry.stepIndex
    ?? incomingEntry.stepIndex
    ?? extractCallStepNumbers(baseEntry)[0]
    ?? extractCallStepNumbers(incomingEntry)[0]
    ?? null;

  const resolvedCascadeId = baseEntry.cascadeId
    || incomingEntry.cascadeId
    || parseStepFallbackKey(baseEntry.callId, null)?.cascadeId
    || parseStepFallbackKey(incomingEntry.callId, null)?.cascadeId
    || undefined;

  const baseDateInfo = extractNormalizedDateInfo(baseEntry);
  const incDateInfo = extractNormalizedDateInfo(incomingEntry);
  const adoptSameRankDate = incDateInfo.rank >= 2 &&
    incDateInfo.rank === baseDateInfo.rank &&
    shouldAdoptSameRankAuthDate(baseEntry, incomingEntry, baseDateInfo, incDateInfo, usageCmp, revCmp, preferIncomingDate);
  let chosenDateInfo;
  if (incDateInfo.rank > baseDateInfo.rank) {
    chosenDateInfo = incDateInfo;
  } else if (baseDateInfo.rank > incDateInfo.rank) {
    chosenDateInfo = baseDateInfo;
  } else if (adoptSameRankDate) {
    chosenDateInfo = incDateInfo;
  } else if (incDateInfo.rank === 1 && baseDateInfo.date && incDateInfo.date) {
    chosenDateInfo = baseDateInfo.date <= incDateInfo.date ? baseDateInfo : incDateInfo;
  } else {
    chosenDateInfo = baseDateInfo.date ? baseDateInfo : incDateInfo;
  }

  const mergedStatus = (baseEntry.status === 'final' || incomingEntry.status === 'final')
    ? 'final'
    : (incomingEntry.status || baseEntry.status || 'final');
  const mergedRev = !incomingIsStaleStatus && revCmp >= 0 ? (incRev ?? baseRev) : baseRev;

  // Protect existing speed metrics and exact model metadata from being overwritten by subsequent calibrations without speed data
  const preservedExactId = incomingEntry.modelExactId || baseEntry.modelExactId;
  const preservedLabel = incomingEntry.modelLabel || baseEntry.modelLabel;
  const preservedEffort = incomingEntry.effort || baseEntry.effort;
  const keepSpeed = (!hasSpeedMetrics(baseEntry) && hasSpeedMetrics(incomingEntry) && isValidSpeedSample(incomingEntry))
    ? {
      ...(incomingEntry.ttftSec != null ? { ttftSec: incomingEntry.ttftSec } : {}),
      ...(incomingEntry.streamingSec != null ? { streamingSec: incomingEntry.streamingSec } : {}),
      ...(incomingEntry.durationSec != null ? { durationSec: incomingEntry.durationSec } : {}),
      ...(incomingEntry.tps != null ? { tps: incomingEntry.tps } : {}),
      ...(incomingEntry.origin ? { origin: incomingEntry.origin } : {})
    }
    : (hasSpeedMetrics(baseEntry)
      ? {
        ...(baseEntry.ttftSec != null ? { ttftSec: baseEntry.ttftSec } : {}),
        ...(baseEntry.streamingSec != null ? { streamingSec: baseEntry.streamingSec } : {}),
        ...(baseEntry.durationSec != null ? { durationSec: baseEntry.durationSec } : {}),
        ...(baseEntry.tps != null ? { tps: baseEntry.tps } : {}),
        ...(baseEntry.origin ? { origin: baseEntry.origin } : {})
      }
      : {});

  // Preserve account attribution metadata so subsequent accountless scan enrichments do not erase confirmed account ownership
  const attributionMerged = mergeAccountAttributionFields(baseEntry, incomingEntry);

  const merged = {
    ...baseEntry,
    ...(!incomingIsStaleStatus && takeIncUsage ? incomingEntry : {}),
    ...(chosenDateInfo === incDateInfo && incomingEntry.timestamp !== undefined ? { timestamp: incomingEntry.timestamp } : {}),
    callId: canonicalKey,
    source: baseEntry.source || incomingEntry.source || 'desktop',
    ...(resolvedCascadeId ? { cascadeId: resolvedCascadeId } : {}),
    stepIndex: resolvedStep,
    model: mergedModel,
    ...(preservedExactId ? { modelExactId: preservedExactId } : {}),
    ...(preservedLabel ? { modelLabel: preservedLabel } : {}),
    ...(preservedEffort ? { effort: preservedEffort } : {}),
    inputTokens: inp,
    cacheTokens: cap,
    cacheReadTokens: cap,
    outputTokens: out,
    thinkingTokens: think,
    totalTokens: tot,
    status: mergedStatus,
    date: chosenDateInfo.date,
    created_at: chosenDateInfo.created_at,
    ...(chosenDateInfo.dateSource ? { dateSource: chosenDateInfo.dateSource } : {}),
    dateIsProvisional: Boolean(chosenDateInfo.dateIsProvisional),
    ...(mergedRev !== null ? { sourceRevision: mergedRev } : {}),
    ...keepSpeed,
    ...attributionMerged,
    updatedAt: Date.now()
  };
  if (!attributionMerged.accountScopeKey) {
    delete merged.accountScopeKey;
  }
  if (!attributionMerged.accountAttributionEvidence) {
    delete merged.accountAttributionEvidence;
  }
  if (!attributionMerged.unattributedReason) {
    delete merged.unattributedReason;
  }
  if (!chosenDateInfo.dateSource) {
    delete merged.dateSource;
  }
  if (mergedRev === null) {
    delete merged.sourceRevision;
  }

  const costCalc = calculateRequestApiCost(merged);
  if (costCalc.isPriced) {
    merged.modelKey = costCalc.modelKey;
    merged.isPriced = true;
    merged.costUSD = costCalc.costUSD ?? 0;
  } else {
    merged.modelKey = costCalc.modelKey || normalizeModelId(merged.model) || null;
    merged.isPriced = false;
    merged.costUSD = 0;
  }
  merged.isEstimated = Boolean(baseEntry.isEstimated && incomingEntry.isEstimated);
  return merged;
}

// Determine whether a cross-key candidate pair (real, syn) has sufficient evidence of being the same call: completed non-zero real records must never accept usage overwrites from a different cross-key ID
function isConfirmableSingleStepMatch(real, syn) {
  if (!real || !syn) return false;
  if (!areModelsCompatible(real.model, syn.model)) return false;
  const uReal = getCallTokenBreakdown(real);
  const uSyn = getCallTokenBreakdown(syn);
  if (uReal.inp === uSyn.inp && uReal.cap === uSyn.cap && uReal.out === uSyn.out) {
    return true;
  }
  if (real.status === 'streaming' || uReal.tot === 0) {
    return true;
  }
  if ((syn.status === 'streaming' || uSyn.tot === 0) && compareCallUsage(uSyn, uReal) <= 0) {
    return true;
  }
  return false;
}

function callSemanticSignature(c) {
  if (!c || typeof c !== 'object') return '';
  const u = getCallTokenBreakdown(c);
  const rev = extractSourceRevision(c);
  return [
    String(c.callId || ''),
    String(c.source || 'desktop'),
    String(c.cascadeId || ''),
    c.stepIndex ?? '',
    String(c.model || ''),
    String(c.modelKey || ''),
    String(c.modelExactId || ''),
    String(c.status || ''),
    Boolean(c.isEstimated),
    Boolean(c.isPriced),
    Number(c.costUSD || 0),
    u.inp,
    u.cap,
    u.out,
    u.think,
    u.tot,
    c.durationSec ?? '',
    c.tps ?? '',
    String(c.date || ''),
    String(c.created_at || ''),
    String(c.dateSource || ''),
    Boolean(c.dateIsProvisional),
    rev ?? '',
    String(c.accountScopeKey || ''),
    String(c.accountAttributionConfidence || ''),
    String(c.unattributedReason || '')
  ].join('|');
}

function hasCallsMapChanged(beforeCalls = {}, afterCalls = {}) {
  const bKeys = Object.keys(beforeCalls);
  const aKeys = Object.keys(afterCalls);
  if (bKeys.length !== aKeys.length) return true;
  for (const k of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(beforeCalls, k)) return true;
    if (callSemanticSignature(beforeCalls[k]) !== callSemanticSignature(afterCalls[k])) return true;
  }
  return false;
}

function reconcileConfirmableDuplicateStepCalls(callsObj) {
  if (!callsObj || typeof callsObj !== 'object') return false;
  const synItems = [];
  const realItems = [];

  for (const [key, entry] of Object.entries(callsObj)) {
    if (!entry || typeof entry !== 'object') continue;
    const parsedKey = parseStepFallbackKey(key, entry.cascadeId);
    if (parsedKey) {
      synItems.push({
        synKey: key,
        syn: entry,
        synSrc: entry.source || 'desktop',
        synCid: parsedKey.cascadeId.toLowerCase(),
        synStep: parsedKey.stepIndex
      });
    } else {
      realItems.push({ realKey: key, real: entry });
    }
  }

  if (!synItems.length || !realItems.length) return false;

  // Build local hash index by (source, cascadeId) to reduce O(syn * real) to linear O(syn + real)
  const synCidSet = new Set();
  for (let i = 0; i < synItems.length; i++) {
    synCidSet.add(`${synItems[i].synSrc}\0${synItems[i].synCid}`);
  }
  const ruleAIndex = new Map();
  const ruleBIndex = new Map();
  for (let i = 0; i < realItems.length; i++) {
    const item = realItems[i];
    const { realKey, real } = item;
    const src = real.source || 'desktop';
    const cid = String(real.cascadeId || '').toLowerCase();
    const srcCid = `${src}\0${cid}`;
    if (!synCidSet.has(srcCid)) continue;
    const stepNums = extractCallStepNumbers(real, realKey);
    if (stepNums.length > 0) {
      for (let j = 0; j < stepNums.length; j++) {
        const aKey = `${srcCid}\0${stepNums[j]}`;
        let list = ruleAIndex.get(aKey);
        if (!list) { list = []; ruleAIndex.set(aKey, list); }
        list.push(item);
      }
    } else {
      const uReal = getCallTokenBreakdown(real);
      const bKey = `${srcCid}\0${uReal.inp}:${uReal.cap}:${uReal.out}`;
      let list = ruleBIndex.get(bKey);
      if (!list) { list = []; ruleBIndex.set(bKey, list); }
      list.push(item);
    }
  }

  let reconciled = false;
  const usedRealKeys = new Set();
  const unmatchedSyn = [];

  // Rule A: Real responseId record under the same (source, cascadeId) with explicit matching stepIndex and compatible model
  for (const sItem of synItems) {
    const { synKey, syn, synSrc, synCid, synStep } = sItem;
    const indexedA = ruleAIndex.get(`${synSrc}\0${synCid}\0${synStep}`);
    const cands = indexedA ? indexedA.filter(({ realKey, real }) => {
      if (usedRealKeys.has(realKey) || !callsObj[realKey]) return false;
      return areModelsCompatible(real.model, syn.model);
    }) : [];

    let matchedRealKey = null;
    if (cands.length === 1) {
      if (isConfirmableSingleStepMatch(cands[0].real, syn)) {
        matchedRealKey = cands[0].realKey;
      }
    } else if (cands.length > 1) {
      const uSyn = getCallTokenBreakdown(syn);
      if (uSyn.inp + uSyn.cap + uSyn.out > 0) {
        const exactCands = cands.filter(({ real }) => {
          const uReal = getCallTokenBreakdown(real);
          return uReal.inp === uSyn.inp && uReal.cap === uSyn.cap && uReal.out === uSyn.out;
        });
        if (exactCands.length === 1) {
          matchedRealKey = exactCands[0].realKey;
        }
      }
    }

    if (matchedRealKey && callsObj[matchedRealKey]) {
      callsObj[matchedRealKey] = mergeSameCallRecords(callsObj[matchedRealKey], syn, matchedRealKey, synStep, false);
      delete callsObj[synKey];
      usedRealKeys.add(matchedRealKey);
      reconciled = true;
    } else {
      unmatchedSyn.push(sItem);
    }
  }

  // Rule B: Legacy real record with stepIndex == null, deduplicated 1-to-1 by unique non-zero (source, cascadeId, inp, cap, out) + compatible model
  if (unmatchedSyn.length) {
    const synByUsage = new Map();
    for (const sItem of unmatchedSyn) {
      const uSyn = getCallTokenBreakdown(sItem.syn);
      if (uSyn.inp + uSyn.cap + uSyn.out <= 0) continue;
      const uKey = `${sItem.synSrc}:${sItem.synCid}:${uSyn.inp}:${uSyn.cap}:${uSyn.out}`;
      let list = synByUsage.get(uKey);
      if (!list) { list = []; synByUsage.set(uKey, list); }
      list.push(sItem);
    }

    for (const [, synGroup] of synByUsage.entries()) {
      if (synGroup.length !== 1) continue;
      const { synKey, syn, synSrc, synCid, synStep } = synGroup[0];
      const uSyn = getCallTokenBreakdown(syn);
      const indexedB = ruleBIndex.get(`${synSrc}\0${synCid}\0${uSyn.inp}:${uSyn.cap}:${uSyn.out}`);
      const cands = indexedB ? indexedB.filter(({ realKey, real }) => {
        if (usedRealKeys.has(realKey) || !callsObj[realKey]) return false;
        return areModelsCompatible(real.model, syn.model);
      }) : [];

      if (cands.length === 1) {
        const matchedRealKey = cands[0].realKey;
        callsObj[matchedRealKey] = mergeSameCallRecords(callsObj[matchedRealKey], syn, matchedRealKey, synStep, false);
        delete callsObj[synKey];
        usedRealKeys.add(matchedRealKey);
        reconciled = true;
      }
    }
  }

  return reconciled;
}

const SCOPE_KEY_REGEX = /^acct_[0-9a-f]{16}$/i;
