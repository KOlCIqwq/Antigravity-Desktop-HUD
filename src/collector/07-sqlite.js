function getNodeDatabaseSync() {
  if (cachedNodeDatabaseSync !== undefined) return cachedNodeDatabaseSync;
  try {
    cachedNodeDatabaseSync = require('node:sqlite').DatabaseSync || null;
  } catch {
    cachedNodeDatabaseSync = null;
  }
  return cachedNodeDatabaseSync;
}

function buildSqliteUriWithQuery(dbPath, query) {
  const normalized = String(dbPath || '').replace(/\\/g, '/');
  const encoded = encodeURI(normalized).replace(/#/g, '%23').replace(/\?/g, '%3F');
  if (encoded.startsWith('//')) {
    return `file://${encoded}?${query}`;
  }
  return `file:///${encoded.replace(/^\/+/, '')}?${query}`;
}

/**
 * 构建 SQLite 只读 immutable URI，兼容 Windows 盘符、UNC (\\wsl.localhost\...) 与 POSIX 路径。
 * 必须显式使用 file:////wsl.localhost/...?immutable=1，否则 9P 共享目录会报 database is locked。
 * @param {string} dbPath
 * @returns {string}
 */
function buildSqliteImmutableUri(dbPath) {
  return buildSqliteUriWithQuery(dbPath, 'immutable=1');
}

function buildSqliteModeRoUri(dbPath) {
  return buildSqliteUriWithQuery(dbPath, 'mode=ro');
}

function readPbVarint(buf, offset, end = buf.length) {
  let value = 0;
  let multiplier = 1;
  let pos = offset;
  while (pos < end && pos - offset < 10) {
    const byte = buf[pos++];
    value += (byte & 0x7f) * multiplier;
    if ((byte & 0x80) === 0) {
      return { value, next: pos };
    }
    multiplier *= 128;
  }
  return null;
}

function walkPbFields(buf, start, end, onField) {
  let pos = start;
  while (pos < end) {
    const tagInfo = readPbVarint(buf, pos, end);
    if (!tagInfo) break;
    pos = tagInfo.next;
    const fieldNum = Math.floor(tagInfo.value / 8);
    const wireType = tagInfo.value % 8;
    if (fieldNum <= 0) break;

    if (wireType === 0) {
      const valInfo = readPbVarint(buf, pos, end);
      if (!valInfo) break;
      pos = valInfo.next;
      onField(fieldNum, wireType, valInfo.value, 0, 0);
    } else if (wireType === 1) {
      if (pos + 8 > end) break;
      pos += 8;
      onField(fieldNum, wireType, 0, pos - 8, pos);
    } else if (wireType === 2) {
      const lenInfo = readPbVarint(buf, pos, end);
      if (!lenInfo || lenInfo.value < 0) break;
      const valStart = lenInfo.next;
      const valEnd = valStart + lenInfo.value;
      if (valEnd > end) break;
      pos = valEnd;
      onField(fieldNum, wireType, 0, valStart, valEnd);
    } else if (wireType === 5) {
      if (pos + 4 > end) break;
      pos += 4;
      onField(fieldNum, wireType, 0, pos - 4, pos);
    } else {
      break;
    }
  }
}

function parsePbDurationSec(buf, start, end) {
  let seconds = 0;
  let nanos = 0;
  let hasField = false;
  walkPbFields(buf, start, end, (fn, wt, val) => {
    if (wt !== 0) return;
    if (fn === 1) { seconds = val; hasField = true; }
    else if (fn === 2) { nanos = val; hasField = true; }
  });
  if (!hasField) return null;
  const secVal = seconds + nanos / 1e9;
  return Number.isFinite(secVal) && secVal >= 0 ? Number(secVal.toFixed(2)) : null;
}

/**
 * 从 gen_metadata.data 的 Protobuf 负载提取完整的步骤元数据（兼容模型 ID、展示标签、耗时、responseId 与父子关联）。
 */
function extractStepMetaFromGenMetadataBlob(rawData) {
  if (!rawData || !rawData.length) return [];
  const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  const steps = [];
  let rawModel = '';
  let label = '';
  let modelEnum = '';
  let responseId = '';
  let ttftSec = null;
  let streamingSec = null;
  let parentCascadeId = '';
  let rootCascadeId = '';
  let subagentType = '';

  walkPbFields(buf, 0, buf.length, (fn, wt, val, vs, ve) => {
    if (fn === 2) {
      if (wt === 0 && Number.isInteger(val) && val >= 0) {
        steps.push(val);
      } else if (wt === 2) {
        let p = vs;
        while (p < ve) {
          const item = readPbVarint(buf, p, ve);
          if (!item) break;
          if (Number.isInteger(item.value) && item.value >= 0) {
            steps.push(item.value);
          }
          p = item.next;
        }
      }
    } else if (fn === 1 && wt === 2) {
      walkPbFields(buf, vs, ve, (cfn, cwt, _cval, cvs, cve) => {
        if (cwt !== 2) return;
        if (cfn === 4) {
          walkPbFields(buf, cvs, cve, (ufn, uwt, _uval, uvs, uve) => {
            if (ufn === 7 && uwt === 2) {
              const str = buf.toString('utf8', uvs, uve).trim();
              if (str) responseId = str;
            }
          });
        } else if (cfn === 11) {
          const d = parsePbDurationSec(buf, cvs, cve);
          if (d !== null) ttftSec = d;
        } else if (cfn === 12) {
          const d = parsePbDurationSec(buf, cvs, cve);
          if (d !== null) streamingSec = d;
        } else if (cfn === 19) {
          const str = buf.toString('utf8', cvs, cve).trim();
          if (str) rawModel = str;
        } else if (cfn === 20) {
          let k = '';
          let v = '';
          walkPbFields(buf, cvs, cve, (kfn, kwt, _kval, kvs, kve) => {
            if (kwt !== 2) return;
            if (kfn === 1) k = buf.toString('utf8', kvs, kve).trim();
            else if (kfn === 2) v = buf.toString('utf8', kvs, kve).trim();
          });
          if (k === 'model_enum' && v) modelEnum = v;
          else if (k === 'parent_cascade_id' && v) parentCascadeId = v;
          else if (k === 'root_cascade_id' && v) rootCascadeId = v;
          else if (k === 'subagent_type' && v) subagentType = v;
        } else if (cfn === 21) {
          const str = buf.toString('utf8', cvs, cve).trim();
          if (str) label = str;
        }
      });
    }
  });

  const resolvedModel = label || rawModel || modelEnum;
  const resolvedExactId = modelEnum || rawModel || '';
  if (!steps.length) return [];
  if (!resolvedModel && !resolvedExactId && !responseId && ttftSec === null && streamingSec === null && !parentCascadeId && !rootCascadeId) {
    return [];
  }
  return steps.map(stepIndex => ({
    stepIndex,
    model: resolvedModel,
    rawModel,
    modelLabel: label,
    modelExactId: resolvedExactId,
    responseId,
    ttftSec,
    streamingSec,
    parentCascadeId,
    rootCascadeId,
    subagentType
  }));
}

/**
 * 从会话数据库 gen_metadata.data 的 Protobuf 负载提取 stepIndex -> model/label 映射（保持兼容旧签名）。
 * 顶层字段 2 为 stepIndices（单个 varint 或 packed varint），字段 1 内的 19 为 rawModel、21 为展示标签。
 * @param {Buffer|Uint8Array} rawData
 * @returns {Array<{stepIndex: number, model: string}>}
 */
function extractStepModelsFromGenMetadataBlob(rawData) {
  return extractStepMetaFromGenMetadataBlob(rawData)
    .filter(item => Boolean(item.model))
    .map(item => ({ stepIndex: item.stepIndex, model: item.model }));
}

function extractTrajectoryBlobMeta(rawData, selfCascadeId = '') {
  const out = { parentCascadeId: '', rootCascadeId: '', subagentType: '', subagentRole: '' };
  if (!rawData || !rawData.length) return out;
  const buf = Buffer.isBuffer(rawData) ? rawData : Buffer.from(rawData);
  const selfNorm = String(selfCascadeId || '').trim().toLowerCase();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  walkPbFields(buf, 0, buf.length, (fn, wt, _val, vs, ve) => {
    if (wt !== 2) return;
    if (fn === 4) {
      walkPbFields(buf, vs, ve, (cfn, cwt, _cval, cvs, cve) => {
        if (cwt !== 2) return;
        if (cfn === 1) {
          const s = buf.toString('utf8', cvs, cve).trim();
          if (s && s.length < 64) out.subagentType = s;
        } else if (cfn === 2) {
          const s = buf.toString('utf8', cvs, cve).trim();
          if (s && s.length < 120) out.subagentRole = s;
        }
      });
    } else if (fn === 5) {
      const s = buf.toString('utf8', vs, ve).trim();
      if (uuidRe.test(s) && s.toLowerCase() !== selfNorm) out.parentCascadeId = s;
    } else if (fn === 6) {
      const s = buf.toString('utf8', vs, ve).trim();
      if (uuidRe.test(s) && s.toLowerCase() !== selfNorm) out.rootCascadeId = s;
    }
  });
  return out;
}

const conversationDbMetaCache = new Map();
const MAX_CONVERSATION_DB_CACHE_ENTRIES = 500;

function getDbFileCacheSig(dbPath) {
  try {
    const stDb = origFsMethods.statSync(dbPath);
    if (!stDb.isFile()) return null;
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    let walSize = 0;
    let walMtimeMs = 0;
    let hasWal = false;
    let hasShm = false;
    try {
      if (origFsMethods.existsSync(walPath)) {
        const stWal = origFsMethods.statSync(walPath);
        hasWal = stWal.isFile();
        walSize = stWal.size || 0;
        walMtimeMs = stWal.mtimeMs || 0;
      }
    } catch { }
    try {
      hasShm = origFsMethods.existsSync(shmPath) && origFsMethods.statSync(shmPath).isFile();
    } catch { }
    return {
      sig: `${stDb.size}:${stDb.mtimeMs}:${hasWal ? 1 : 0}:${walSize}:${walMtimeMs}:${hasShm ? 1 : 0}`,
      hasWal,
      walSize,
      hasShm
    };
  } catch {
    return null;
  }
}

/**
 * 严格只读且兼顾 WAL 一致性地读取会话 .db（不修改 .db / -wal / -shm，不以 immutable 绕过活跃锁读取撕裂页）：
 * - 当不存在非空 -wal 时，使用 ?immutable=1（零写零锁，且兼容 WSL UNC）；
 * - 当存在非空 -wal 且存在 -shm 时，使用 ?mode=ro（遵守 SQLite 锁读取一致 WAL 快照，不创建新伴生文件）；
 * - 当存在非空 -wal 但缺少 -shm 或只读受锁阻断时，安全降级返回空（保留未知，等待后续 checkpoint 后再回填）。
 */
function loadConversationDbMeta(dbPath, selfCascadeId = '') {
  const emptyResult = {
    stepMetaMap: new Map(),
    stepToModel: new Map(),
    parentCascadeId: '',
    rootCascadeId: '',
    subagentType: '',
    subagentRole: '',
    readMode: 'skipped',
    skippedReason: null
  };
  if (!dbPath || !origFsMethods.existsSync(dbPath)) {
    return { ...emptyResult, skippedReason: 'missing' };
  }
  const DatabaseSync = getNodeDatabaseSync();
  if (!DatabaseSync) {
    return { ...emptyResult, skippedReason: 'sqlite_unavailable' };
  }
  const sigInfo = getDbFileCacheSig(dbPath);
  if (!sigInfo) {
    return { ...emptyResult, skippedReason: 'stat_failed' };
  }

  const cacheKey = process.platform === 'win32' ? String(dbPath).toLowerCase() : String(dbPath);
  const cached = conversationDbMetaCache.get(cacheKey);
  if (cached && cached.sig === sigInfo.sig) {
    return cached.value;
  }

  let targetUri = null;
  let readMode = 'immutable';
  if (!sigInfo.hasWal || sigInfo.walSize === 0) {
    targetUri = buildSqliteImmutableUri(dbPath);
    readMode = 'immutable';
  } else if (sigInfo.hasShm) {
    targetUri = buildSqliteModeRoUri(dbPath);
    readMode = 'mode_ro_wal';
  } else {
    return { ...emptyResult, readMode: 'skipped', skippedReason: 'wal_without_shm' };
  }

  const stepMetaMap = new Map();
  const stepToModel = new Map();
  let parentCascadeId = '';
  let rootCascadeId = '';
  let subagentType = '';
  let subagentRole = '';

  let db = null;
  try {
    db = new DatabaseSync(targetUri, { readOnly: true });
    try {
      const rows = db.prepare('SELECT data FROM gen_metadata').all();
      for (const row of rows) {
        const entries = extractStepMetaFromGenMetadataBlob(row?.data);
        for (const item of entries) {
          if (!item || !Number.isInteger(item.stepIndex)) continue;
          stepMetaMap.set(item.stepIndex, item);
          if (item.model) stepToModel.set(item.stepIndex, item.model);
          if (!parentCascadeId && item.parentCascadeId) parentCascadeId = item.parentCascadeId;
          if (!rootCascadeId && item.rootCascadeId) rootCascadeId = item.rootCascadeId;
          if (!subagentType && item.subagentType) subagentType = item.subagentType;
        }
      }
    } catch {
      // 忽略缺失 gen_metadata 表或非预期 schema
    }
    try {
      const tmbRows = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 2').all();
      for (const row of tmbRows) {
        const tm = extractTrajectoryBlobMeta(row?.data, selfCascadeId);
        if (!parentCascadeId && tm.parentCascadeId) parentCascadeId = tm.parentCascadeId;
        if (!rootCascadeId && tm.rootCascadeId) rootCascadeId = tm.rootCascadeId;
        if (!subagentType && tm.subagentType) subagentType = tm.subagentType;
        if (!subagentRole && tm.subagentRole) subagentRole = tm.subagentRole;
      }
    } catch {
      // 旧库可能没有 trajectory_metadata_blob
    }
  } catch (err) {
    return {
      ...emptyResult,
      readMode: 'skipped',
      skippedReason: err?.code || err?.message || 'sqlite_open_error'
    };
  } finally {
    if (db) {
      try { db.close(); } catch { }
    }
  }

  const out = {
    stepMetaMap,
    stepToModel,
    parentCascadeId,
    rootCascadeId,
    subagentType,
    subagentRole,
    readMode,
    skippedReason: null
  };
  if (conversationDbMetaCache.size >= MAX_CONVERSATION_DB_CACHE_ENTRIES) {
    const oldest = conversationDbMetaCache.keys().next().value;
    if (oldest) conversationDbMetaCache.delete(oldest);
  }
  conversationDbMetaCache.set(cacheKey, { sig: sigInfo.sig, value: out });
  return out;
}

function loadStepModelMapFromSqlite(dbPath) {
  return loadConversationDbMeta(dbPath).stepToModel;
}

function needsDbLabelEnrichment(rec) {
  if (!rec || !(rec.tot > 0)) return false;
  if (!rec.model) return true;
  if (/^model_/i.test(rec.model)) return true;
  if (!rec.modelLabel && !/[A-Z\s()]/.test(rec.model)) return true;
  return false;
}

function backfillMissingModelsFromConversationDb(records, convDir, options = {}) {
  if (!Array.isArray(records) || !records.length || !convDir || options.fs || isFsMonkeyPatched()) return 0;

  const targetByCascade = new Map();
  for (const rec of records) {
    if (!rec || !(rec.tot > 0)) continue;
    const needsLabel = needsDbLabelEnrichment(rec);
    const needsMeta = !rec.modelExactId || rec.ttftSec == null || rec.streamingSec == null;
    if (!needsLabel && !needsMeta) continue;
    if (!Number.isInteger(rec.stepIndex) || rec.stepIndex < 0) continue;
    const cid = String(rec.cascadeId || '').trim();
    if (!cid || cid.includes('..') || cid.includes('/') || cid.includes('\\')) continue;
    let list = targetByCascade.get(cid);
    if (!list) {
      list = [];
      targetByCascade.set(cid, list);
    }
    list.push(rec);
  }
  if (targetByCascade.size === 0) return 0;

  let filledCount = 0;
  for (const [cid, recs] of targetByCascade.entries()) {
    const dbPath = path.join(convDir, `${cid}.db`);
    const dbMeta = loadConversationDbMeta(dbPath, cid);
    if (dbMeta.stepMetaMap.size === 0) continue;
    for (const rec of recs) {
      const recovered = dbMeta.stepMetaMap.get(rec.stepIndex);
      if (!recovered) continue;
      let modelOrLabelFilled = false;
      if (recovered.model && (!rec.model || (/^model_/i.test(rec.model) && recovered.model !== rec.model))) {
        rec.model = recovered.model;
        modelOrLabelFilled = true;
      }
      if (!rec.modelExactId && recovered.modelExactId) {
        rec.modelExactId = recovered.modelExactId;
      }
      const recoveredLabel = recovered.modelLabel || (recovered.model && /[A-Z\s()]/.test(recovered.model) ? recovered.model : '');
      if (!rec.modelLabel && recoveredLabel) {
        rec.modelLabel = recoveredLabel;
        modelOrLabelFilled = true;
      }
      if (modelOrLabelFilled) filledCount++;
      if (rec.ttftSec == null && recovered.ttftSec != null) {
        rec.ttftSec = recovered.ttftSec;
      }
      if (rec.streamingSec == null && recovered.streamingSec != null) {
        rec.streamingSec = recovered.streamingSec;
      }
      if (!rec.responseId && recovered.responseId) {
        rec.responseId = recovered.responseId;
      }
      if (!rec.parentCascadeId && (recovered.parentCascadeId || dbMeta.parentCascadeId)) {
        rec.parentCascadeId = recovered.parentCascadeId || dbMeta.parentCascadeId;
      }
      if (!rec.rootCascadeId && (recovered.rootCascadeId || dbMeta.rootCascadeId)) {
        rec.rootCascadeId = recovered.rootCascadeId || dbMeta.rootCascadeId;
      }
      if (!rec.subagentType && (recovered.subagentType || dbMeta.subagentType)) {
        rec.subagentType = recovered.subagentType || dbMeta.subagentType;
      }
    }
  }
  return filledCount;
}
