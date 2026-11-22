function mergeModelDailyMaps(...maps) {
  const out = {};
  for (const m of maps) {
    if (!m || typeof m !== 'object') continue;
    for (const [dateKey, modelRecs] of Object.entries(m)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey) || !modelRecs || typeof modelRecs !== 'object') continue;
      if (!out[dateKey]) out[dateKey] = {};
      for (const [mKey, rec] of Object.entries(modelRecs)) {
        if (!rec || typeof rec !== 'object') continue;
        if (!out[dateKey][mKey]) {
          out[dateKey][mKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        out[dateKey][mKey].total += Number(rec.total) || 0;
        out[dateKey][mKey].input += Number(rec.input) || 0;
        out[dateKey][mKey].output += Number(rec.output) || 0;
        out[dateKey][mKey].cache += Number(rec.cache) || 0;
        out[dateKey][mKey].steps += Number(rec.steps) || 0;
      }
    }
  }
  return out;
}

/**
 * Build per-source, per-day, per-model usage breakdowns from the ledger (including RPC-enriched models) and unmatched live transcript records,
 * strictly aligning with authoritative dailyMap totals (any unattributed model difference falls into UNATTRIBUTED_MODEL_KEY).
 */
function buildDailyModelBreakdown(params) {
  const {
    recentRequests,
    finalCallsEntries,
    matchedTranscriptReqs,
    matchedLedgerKeys,
    resolveLedgerCallDate,
    mergedDesktop,
    mergedCli,
    mergedLegacyUnallocated,
    archiveV2,
    compactModelConfigs,
    availableModelDetails
  } = params;

  const modelMetaByKey = {};
  const archivedMetaByKey = (archiveV2?.modelMetaByKey && typeof archiveV2.modelMetaByKey === 'object')
    ? archiveV2.modelMetaByKey
    : {};
  const matchedModels = { desktop: {}, cli: {} };
  const extraModels = { desktop: {}, cli: {} };
  const bucketMemo = new Map();

  const addModelBucket = (srcMap, dateKey, callObj, inp, cap, outp, tot, steps = 1) => {
    if (!dateKey || !/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) return;
    if (tot <= 0 && steps <= 0) return;
    const memoKey = `${callObj.model || ''}\0${callObj.modelExactId || ''}\0${callObj.modelLabel || ''}\0${callObj.effort || ''}`;
    let bucket = bucketMemo.get(memoKey);
    if (!bucket) {
      bucket = resolveModelUsageBucket(callObj, compactModelConfigs, availableModelDetails);
      if (bucketMemo.size < 2000) bucketMemo.set(memoKey, bucket);
    }
    const vKey = bucket.variantKey || UNATTRIBUTED_MODEL_KEY;
    if (bucket.isAttributed && vKey !== UNATTRIBUTED_MODEL_KEY) {
      modelMetaByKey[vKey] = {
        modelKey: bucket.modelKey,
        modelLabel: bucket.modelLabel,
        variantKey: vKey,
        variantLabel: bucket.variantLabel
      };
    }
    if (!srcMap[dateKey]) srcMap[dateKey] = {};
    if (!srcMap[dateKey][vKey]) {
      srcMap[dateKey][vKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    }
    srcMap[dateKey][vKey].total += tot;
    srcMap[dateKey][vKey].input += inp;
    srcMap[dateKey][vKey].output += outp;
    srcMap[dateKey][vKey].cache += cap;
    srcMap[dateKey][vKey].steps += steps;
  };

  for (const [ledgerKey, c] of finalCallsEntries) {
    if (!c) continue;
    const effDate = resolveLedgerCallDate(ledgerKey, c);
    if (!effDate || !/^\d{4}-\d{2}-\d{2}$/.test(effDate)) continue;
    const srcKey = c.source === 'cli' ? 'cli' : 'desktop';
    const inp = Number(c.inputTokens ?? c.input_tokens ?? c.input ?? 0) || 0;
    const cap = Number(c.cacheTokens ?? c.cacheReadTokens ?? c.cache_read_tokens ?? c.cached ?? 0) || 0;
    const outp = Number(c.outputTokens ?? c.output_tokens ?? c.output ?? 0) || 0;
    const tot = Number(c.totalTokens) || (inp + cap + outp);
    addModelBucket(matchedLedgerKeys.has(ledgerKey) ? matchedModels[srcKey] : extraModels[srcKey], effDate, c, inp, cap, outp, tot, 1);
  }

  for (const r of recentRequests) {
    if (matchedTranscriptReqs && matchedTranscriptReqs.has(r)) continue;
    const srcKey = r.source === 'cli' ? 'cli' : 'desktop';
    const inp = Number(r.inputTokens) || 0;
    const cap = Number(r.cacheTokens ?? r.cacheReadTokens ?? 0) || 0;
    const outp = Number(r.outputTokens) || 0;
    const tot = Number(r.totalTokens) || (inp + cap + outp);
    addModelBucket(matchedModels[srcKey], r.date, r, inp, cap, outp, tot, 1);
  }

  const appendScaledDayBuckets = (dayOut, srcDay, authTotal, state) => {
    if (!srcDay) return;
    for (const [mKey, rec] of Object.entries(srcDay)) {
      if (state.sumTot >= authTotal) break;
      const takeTot = Math.min(rec.total, authTotal - state.sumTot);
      const ratio = rec.total > 0 ? takeTot / rec.total : 0;
      if (!dayOut[mKey]) dayOut[mKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
      const addInp = takeTot === rec.total ? rec.input : Math.round(rec.input * ratio);
      const addOut = takeTot === rec.total ? rec.output : Math.round(rec.output * ratio);
      const addCap = takeTot === rec.total ? rec.cache : Math.max(0, takeTot - addInp - addOut);
      dayOut[mKey].total += takeTot;
      dayOut[mKey].input += addInp;
      dayOut[mKey].output += addOut;
      dayOut[mKey].cache += addCap;
      dayOut[mKey].steps += rec.steps;
      state.sumTot += takeTot;
      state.sumInp += addInp;
      state.sumOut += addOut;
      state.sumCap += addCap;
      state.sumSteps += rec.steps;
    }
  };

  const reconcileSourceMap = (srcKey, authDailyMap) => {
    const archivedModels = archiveV2?.dailyModelMapBySource?.[srcKey] || {};
    const outMap = {};
    const allDates = new Set([
      ...Object.keys(authDailyMap || {}),
      ...Object.keys(matchedModels[srcKey]),
      ...Object.keys(extraModels[srcKey])
    ]);
    for (const dateKey of allDates) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) continue;
      const authRec = authDailyMap?.[dateKey];
      if (!authRec || Number(authRec.total) <= 0) continue;

      const dayOut = {};
      const scanDay = matchedModels[srcKey][dateKey];
      const extraDay = extraModels[srcKey][dateKey];
      const state = { sumTot: 0, sumInp: 0, sumOut: 0, sumCap: 0, sumSteps: 0 };

      if (scanDay || extraDay) {
        appendScaledDayBuckets(dayOut, scanDay, authRec.total, state);
        appendScaledDayBuckets(dayOut, extraDay, authRec.total, state);
      } else if (archivedModels[dateKey]) {
        for (const [mKey, rec] of Object.entries(archivedModels[dateKey])) {
          if (!rec || typeof rec !== 'object') continue;
          const addTot = Number(rec.total) || 0;
          const addInp = Number(rec.input) || 0;
          const addOut = Number(rec.output) || 0;
          const addCap = Number(rec.cache) || 0;
          const addSteps = Number(rec.steps) || 0;
          let effKey = mKey;
          if (mKey !== UNATTRIBUTED_MODEL_KEY) {
            const oldMeta = archivedMetaByKey[mKey] || null;
            const probeLabel = oldMeta?.variantLabel || oldMeta?.modelLabel || '';
            const reBucket = resolveModelUsageBucket(
              { model: mKey, ...(probeLabel ? { modelLabel: probeLabel } : {}) },
              compactModelConfigs,
              availableModelDetails
            );
            effKey = reBucket.variantKey || mKey;
            if (reBucket.isAttributed && effKey !== UNATTRIBUTED_MODEL_KEY) {
              modelMetaByKey[effKey] = {
                modelKey: reBucket.modelKey,
                modelLabel: reBucket.modelLabel,
                variantKey: effKey,
                variantLabel: reBucket.variantLabel
              };
            } else if (oldMeta && !modelMetaByKey[effKey]) {
              modelMetaByKey[effKey] = oldMeta;
            }
          }
          if (!dayOut[effKey]) dayOut[effKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
          dayOut[effKey].total += addTot;
          dayOut[effKey].input += addInp;
          dayOut[effKey].output += addOut;
          dayOut[effKey].cache += addCap;
          dayOut[effKey].steps += addSteps;
          state.sumTot += addTot;
          state.sumInp += addInp;
          state.sumOut += addOut;
          state.sumCap += addCap;
          state.sumSteps += addSteps;
        }
      }

      const diffTot = Math.max(0, (Number(authRec.total) || 0) - state.sumTot);
      if (diffTot > 0) {
        if (!dayOut[UNATTRIBUTED_MODEL_KEY]) {
          dayOut[UNATTRIBUTED_MODEL_KEY] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        dayOut[UNATTRIBUTED_MODEL_KEY].total += diffTot;
        dayOut[UNATTRIBUTED_MODEL_KEY].input += Math.max(0, (Number(authRec.input) || 0) - state.sumInp);
        dayOut[UNATTRIBUTED_MODEL_KEY].output += Math.max(0, (Number(authRec.output) || 0) - state.sumOut);
        dayOut[UNATTRIBUTED_MODEL_KEY].cache += Math.max(0, (Number(authRec.cache) || 0) - state.sumCap);
        dayOut[UNATTRIBUTED_MODEL_KEY].steps += Math.max(0, (Number(authRec.steps) || 0) - state.sumSteps);
      }

      if (Object.keys(dayOut).length > 0) outMap[dateKey] = dayOut;
    }
    return outMap;
  };

  const desktopModelMap = reconcileSourceMap('desktop', mergedDesktop);
  const cliModelMap = reconcileSourceMap('cli', mergedCli);
  const unallocatedModelMap = {};
  for (const [dateKey, rec] of Object.entries(mergedLegacyUnallocated || {})) {
    if (!rec || Number(rec.total) <= 0) continue;
    unallocatedModelMap[dateKey] = { [UNATTRIBUTED_MODEL_KEY]: { ...rec } };
  }
  const allModelMap = mergeModelDailyMaps(desktopModelMap, cliModelMap, unallocatedModelMap);

  return {
    dailyModelMapBySource: {
      all: allModelMap,
      desktop: desktopModelMap,
      cli: cliModelMap
    },
    modelMetaByKey
  };
}

/**
 * Core historical usage and ledger aggregation logic (supports running in a Worker thread or directly on the main thread)
 * @param {object} options
 * @param {object} extraContext
 */
async function collectTokenHistoryCoreAsync(options = {}, extraContext = {}) {
  const { home, agDir, agCliDir } = resolvePrimaryGeminiDirs(options);

  const archivePathV1 = path.join(agDir, 'token_usage_archive_v1.json');
  const archivePathV2 = path.join(agDir, 'token_usage_archive_v2.json');

  // 1. Read legacy v1 archive (and auto-generate a .bak backup on first migration)
  const bakPathV1 = path.join(agDir, 'token_usage_archive_v1.bak.json');
  const readV1 = safeReadJsonSync(archivePathV1, null, { backupPath: bakPathV1 });
  let legacyV1Archive = { firstUseDate: null, dailyMap: {}, maxConversations: 0 };
  if (readV1.exists) {
    if (readV1.ok && readV1.data && typeof readV1.data === 'object') {
      legacyV1Archive = readV1.data;
      if (!fs.existsSync(bakPathV1)) {
        try { fs.copyFileSync(archivePathV1, bakPathV1); } catch { }
      }
    }
  }

  // 2. Read existing v2 archive
  const bakPathV2 = path.join(agDir, 'token_usage_archive_v2.bak.json');
  const readV2 = safeReadJsonSync(archivePathV2, null, { backupPath: bakPathV2 });
  let archiveV2 = {
    version: '2.0.0',
    firstUseDate: legacyV1Archive.firstUseDate || null,
    planStatus: null,
    dailyMapBySource: {
      desktop: {},
      cli: {},
      legacyUnallocated: legacyV1Archive.dailyMap || {}
    }
  };
  if (readV2.exists) {
    if (readV2.ok && readV2.data && typeof readV2.data === 'object') {
      archiveV2 = { ...archiveV2, ...readV2.data };
      if (!fs.existsSync(bakPathV2)) {
        try { fs.copyFileSync(archivePathV2, bakPathV2); } catch { }
      }
    }
  }

  let earliestDate = archiveV2.firstUseDate || legacyV1Archive.firstUseDate || null;
  const registerDate = (dateStr) => {
    if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      if (!earliestDate || dateStr < earliestDate) earliestDate = dateStr;
    }
  };

  // 3. Scan desktop and CLI session files (including async-probed WSL distro directories on Windows; ignore companion files and deduplicate across roots only for standard UUIDs)
  const extraWsl = await discoverWslGeminiDirsAsync(options);
  const desktopAgDirs = dedupeScanPaths([
    agDir,
    ...(Array.isArray(options.extraAgDirs) ? options.extraAgDirs : []),
    ...extraWsl.desktopDirs
  ]);
  const cliAgDirs = dedupeScanPaths([
    agCliDir,
    ...(Array.isArray(options.extraAgCliDirs) ? options.extraAgCliDirs : []),
    ...extraWsl.cliDirs
  ]);

  let desktopPbCount = 0;
  let cliPbCount = 0;
  const seenDesktopConvs = new Set();
  const seenCliConvs = new Set();
  const nonUuidConvDirsBySource = {
    desktop: new Map(),
    cli: new Map()
  };
  const UUID_SESSION_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:db|pb)$/i;
  const scanSessionDir = (dir, sourceName, seenSet = null) => {
    let count = 0;
    try {
      if (!fs.existsSync(dir)) return 0;
      const normDirKey = process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
      for (const name of fs.readdirSync(dir)) {
        if (isCompanionOrTempFile(name)) continue;
        if (!name.endsWith('.pb') && !name.endsWith('.db')) continue;
        const p = path.join(dir, name);
        const isUuid = UUID_SESSION_FILE_RE.test(name);
        let dedupeKey;
        if (isUuid) {
          dedupeKey = process.platform === 'win32' ? name.toLowerCase() : name;
        } else {
          // Non-UUID sessions are not merged solely by filename; treat as the same file only when realpaths match or when mirrored via shared responseId events
          let realFile = p;
          try { realFile = fs.realpathSync(p); } catch { }
          dedupeKey = process.platform === 'win32' ? realFile.toLowerCase() : realFile;
        }
        if (seenSet && seenSet.has(dedupeKey)) continue;
        try {
          const st = fs.statSync(p);
          if (st.isFile()) {
            if (seenSet) seenSet.add(dedupeKey);
            count++;
            if (!isUuid) {
              const baseLower = name.replace(/\.(?:db|pb)$/i, '').toLowerCase();
              const dirMap = nonUuidConvDirsBySource[sourceName];
              if (dirMap) {
                if (!dirMap.has(baseLower)) dirMap.set(baseLower, new Set());
                dirMap.get(baseLower).add(normDirKey);
              }
            }
            const ts = st.birthtimeMs && st.birthtimeMs > 946684800000 ? Math.min(st.birthtimeMs, st.mtimeMs) : st.mtimeMs;
            if (ts > 946684800000) registerDate(formatLocalDateKey(new Date(ts)));
          }
        } catch { }
      }
    } catch { }
    return count;
  };

  for (const dDir of desktopAgDirs) {
    desktopPbCount += scanSessionDir(path.join(dDir, 'conversations'), 'desktop', seenDesktopConvs);
  }
  for (const cDir of cliAgDirs) {
    cliPbCount += scanSessionDir(path.join(cDir, 'conversations'), 'cli', seenCliConvs);
  }

  // 4. Multi-directory traversal scanning transcript.jsonl (skipping heavy steps/scratch directories, deduplicating symlinks and cycles)
  const visitedRealDirs = new Set();
  const transcriptJobs = [];

  const walkTranscripts = (dir, sourceName, depth = 0, convDirPath = '') => {
    if (depth > 4) return;
    try {
      if (!fs.existsSync(dir)) return;
      const normDir = path.resolve(dir);
      const normKey = process.platform === 'win32' ? normDir.toLowerCase() : normDir;
      if (visitedRealDirs.has(normKey)) return;
      visitedRealDirs.add(normKey);

      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (TRANSCRIPT_SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          try {
            const realTarget = fs.realpathSync(fullPath);
            const realKey = process.platform === 'win32' ? realTarget.toLowerCase() : realTarget;
            const st = fs.statSync(realTarget);
            if (st.isDirectory()) {
              if (!visitedRealDirs.has(realKey)) {
                walkTranscripts(realTarget, sourceName, depth + 1, convDirPath);
              }
            } else if (entry.name === 'transcript.jsonl') {
              transcriptJobs.push({ path: realTarget, source: sourceName, convDir: convDirPath });
            }
          } catch { }
        } else if (entry.isDirectory()) {
          if (depth === 0) {
            const stdLogPath = path.join(fullPath, '.system_generated', 'logs', 'transcript.jsonl');
            const directLogPath = path.join(fullPath, 'transcript.jsonl');
            let matchedFast = false;
            if (fs.existsSync(stdLogPath)) {
              transcriptJobs.push({ path: stdLogPath, source: sourceName, convDir: convDirPath });
              matchedFast = true;
            }
            if (fs.existsSync(directLogPath)) {
              transcriptJobs.push({ path: directLogPath, source: sourceName, convDir: convDirPath });
              matchedFast = true;
            }
            if (matchedFast) continue;
          }
          walkTranscripts(fullPath, sourceName, depth + 1, convDirPath);
        } else if (entry.name === 'transcript.jsonl') {
          transcriptJobs.push({ path: fullPath, source: sourceName, convDir: convDirPath });
        }
      }
    } catch { }
  };

  for (const dDir of desktopAgDirs) {
    const bDir = path.join(dDir, 'brain');
    if (fs.existsSync(bDir)) walkTranscripts(bDir, 'desktop', 0, path.join(dDir, 'conversations'));
  }
  for (const cDir of cliAgDirs) {
    const cbDir = path.join(cDir, 'brain');
    if (fs.existsSync(cbDir)) walkTranscripts(cbDir, 'cli', 0, path.join(cDir, 'conversations'));
  }

  // 5. Structured JSON parsing of transcript.jsonl (incremental per-file cache keyed by size+mtimeMs, deduplicated and aggregated)
  const scannedBySource = {
    desktop: {},
    cli: {}
  };
  const seenEvents = new Map();
  const recentRequests = [];

  for (let jIdx = 0; jIdx < transcriptJobs.length; jIdx++) {
    const job = transcriptJobs[jIdx];
    if (jIdx > 0 && jIdx % 15 === 0) {
      await new Promise(resolve => setImmediate(resolve));
    }
    try {
      const st = fs.statSync(job.path);
      const cachedFile = transcriptFileCache.get(job.path);
      let fileRecords = null;

      if (cachedFile && cachedFile.size === st.size && cachedFile.mtimeMs === st.mtimeMs) {
        fileRecords = cachedFile.records;
      } else {
        fileRecords = [];
        const brainMatch = String(job.path).match(/[\\/]brain[\\/]([^\\/]+)[\\/]/i);
        const content = fs.readFileSync(job.path, 'utf8');
        const lines = content.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (!line || !line.trim()) continue;
          let event = null;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }

          let hasValidCreatedAt = false;
          if (event.created_at) {
            const d = new Date(event.created_at);
            if (!Number.isNaN(d.getTime())) {
              hasValidCreatedAt = true;
            }
          }
          if (!hasValidCreatedAt) continue;

          let inp = 0, outp = 0, cap = 0, thinking = 0;
          const model = event.chatModel?.model || event.chatModel?.responseModel || event.model || event.modelId || '';
          const modelExactId = event.chatModel?.modelId || event.modelId || '';
          const modelLabel = event.chatModel?.modelDisplayName || '';

          if (event.input_tokens != null || event.output_tokens != null || event.cache_read_tokens != null) {
            inp = Number(event.input_tokens || 0);
            outp = Number(event.output_tokens || 0);
            cap = Number(event.cache_read_tokens || 0);
            thinking = Number(event.thinking_output_tokens || 0);
          } else if (event.chatModel?.usage) {
            const u = event.chatModel.usage;
            inp = Number(u.inputTokens || 0);
            outp = Number(u.outputTokens || 0);
            cap = Number(u.cacheReadTokens || 0);
            thinking = Number(u.thinkingOutputTokens || 0);
          }

          const tot = inp + outp + cap;
          if (tot > 0) {
            // Deduplicate by unique event ID (prevent double-counting from copies, symlinks, or duplicate logs)
            const cascadeId = String(event.cascadeId || (brainMatch ? brainMatch[1] : path.basename(job.path, '.jsonl')));
            const rawStep = event.step_index ?? event.stepIndex;
            const parsedStep = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN;
            const stepIndex = Number.isInteger(parsedStep) && parsedStep >= 0 ? parsedStep : null;
            const fallbackScope = (event.cascadeId || brainMatch) ? cascadeId : job.path;
            const eventId = extractCallId(event, fallbackScope, stepIndex ?? i);

            fileRecords.push({
              eventId,
              cascadeId,
              stepIndex,
              model,
              ...(modelExactId ? { modelExactId } : {}),
              ...(modelLabel ? { modelLabel } : {}),
              inp,
              outp,
              cap,
              thinking,
              tot,
              created_at: event.created_at
            });
          } else {
            fileRecords.push({
              tot: 0,
              created_at: event.created_at
            });
          }
        }
        backfillMissingModelsFromConversationDb(fileRecords, job.convDir, options);
        if (transcriptFileCache.size > 1000) {
          const oldestKey = transcriptFileCache.keys().next().value;
          if (oldestKey) transcriptFileCache.delete(oldestKey);
        }
        transcriptFileCache.set(job.path, { size: st.size, mtimeMs: st.mtimeMs, records: fileRecords });
      }

      const jobConvNorm = job.convDir ? (process.platform === 'win32' ? path.resolve(job.convDir).toLowerCase() : path.resolve(job.convDir)) : '';
      for (let rIdx = 0; rIdx < fileRecords.length; rIdx++) {
        const rec = fileRecords[rIdx];
        const parsedDate = new Date(rec.created_at);
        if (Number.isNaN(parsedDate.getTime())) continue;
        const dateKey = formatLocalDateKey(parsedDate);
        registerDate(dateKey);
        if (!rec.tot || !rec.eventId) continue;

        const existingReq = seenEvents.get(rec.eventId);
        if (existingReq) {
          // Never double-count tokens for duplicate events across roots; enrich the original record in place only if the new root provides/retains a better model ID
          if (getCollectorModelRank(rec.model) > getCollectorModelRank(existingReq.model)) {
            existingReq.model = rec.model;
            existingReq.modelKey = normalizeModelId(rec.model);
            const enrichedCost = calculateRequestApiCost(existingReq);
            existingReq.isPriced = enrichedCost.isPriced;
            existingReq.costUSD = enrichedCost.costUSD ?? 0;
          }
          if (!existingReq.modelExactId && rec.modelExactId) existingReq.modelExactId = rec.modelExactId;
          if (!existingReq.modelLabel && rec.modelLabel) existingReq.modelLabel = rec.modelLabel;
          // If two identically named non-UUID sessions under different convDirs share the same real responseId (not a step-composite key), they are proven to be mirrored sessions
          if (
            !String(rec.eventId).includes('#') &&
            existingReq.source === job.source &&
            existingReq._convDirNorm &&
            jobConvNorm &&
            existingReq._convDirNorm !== jobConvNorm &&
            existingReq.cascadeId &&
            existingReq.cascadeId === rec.cascadeId &&
            !UUID_SESSION_FILE_RE.test(`${rec.cascadeId}.db`)
          ) {
            const baseLower = String(rec.cascadeId).toLowerCase();
            const mirrorKey = `${job.source}|${jobConvNorm}|${baseLower}`;
            const convDirSet = nonUuidConvDirsBySource[job.source]?.get(baseLower);
            if (convDirSet && convDirSet.has(existingReq._convDirNorm) && convDirSet.has(jobConvNorm) && !seenEvents.has(`__mirror_dedup:${mirrorKey}`)) {
              seenEvents.set(`__mirror_dedup:${mirrorKey}`, true);
              if (job.source === 'cli' && cliPbCount > 1) cliPbCount--;
              else if (job.source === 'desktop' && desktopPbCount > 1) desktopPbCount--;
            }
          }
          continue;
        }

        const srcMap = scannedBySource[job.source] || scannedBySource.desktop;
        if (!srcMap[dateKey]) {
          srcMap[dateKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        srcMap[dateKey].total += rec.tot;
        srcMap[dateKey].input += rec.inp;
        srcMap[dateKey].output += rec.outp;
        srcMap[dateKey].cache += rec.cap;
        srcMap[dateKey].steps += 1;

        const modelKey = normalizeModelId(rec.model);
        const reqObj = {
          callId: rec.eventId,
          source: job.source,
          _convDirNorm: jobConvNorm,
          cascadeId: rec.cascadeId,
          stepIndex: rec.stepIndex,
          model: rec.model,
          ...(rec.modelExactId ? { modelExactId: rec.modelExactId } : {}),
          ...(rec.modelLabel ? { modelLabel: rec.modelLabel } : {}),
          modelKey,
          inputTokens: rec.inp,
          cacheTokens: rec.cap,
          cacheReadTokens: rec.cap,
          outputTokens: rec.outp,
          thinkingTokens: rec.thinking,
          totalTokens: rec.tot,
          status: 'final',
          isEstimated: false,
          date: dateKey,
          dateSource: 'transcript',
          dateIsProvisional: false,
          created_at: rec.created_at || null,
          timestamp: parsedDate.getTime()
        };
        const costCalc = calculateRequestApiCost(reqObj);
        reqObj.isPriced = costCalc.isPriced;
        reqObj.costUSD = costCalc.costUSD ?? 0;

        seenEvents.set(rec.eventId, reqObj);
        recentRequests.push(reqObj);
      }
    } catch { }
  }

  // 6. Diff-merge with legacy archive to prevent naive addition or Math.max from erasing CLI increments
  // Rule: if (desktop + cli) < legacyV1, preserve the difference as legacyUnallocated; otherwise consider it fully covered by new logs
  const legacyDaily = legacyV1Archive.dailyMap || {};
  const mergedDesktop = { ...(archiveV2.dailyMapBySource?.desktop || {}), ...scannedBySource.desktop };
  const mergedCli = { ...(archiveV2.dailyMapBySource?.cli || {}), ...scannedBySource.cli };
  const mergedLegacyUnallocated = {};

  const allDateKeys = new Set([
    ...Object.keys(legacyDaily),
    ...Object.keys(mergedDesktop),
    ...Object.keys(mergedCli)
  ]);

  const dailyMapAll = {};
  for (const k of Array.from(allDateKeys).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;
    registerDate(k);
    const dRec = mergedDesktop[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    const cRec = mergedCli[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    const lRec = legacyDaily[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };

    const scannedSum = (dRec.total || 0) + (cRec.total || 0);
    let unallocatedDiff = Math.max(0, (lRec.total || 0) - scannedSum);

    if (unallocatedDiff > 0) {
      mergedLegacyUnallocated[k] = {
        total: unallocatedDiff,
        input: Math.max(0, (lRec.input || 0) - (dRec.input || 0) - (cRec.input || 0)),
        output: Math.max(0, (lRec.output || 0) - (dRec.output || 0) - (cRec.output || 0)),
        cache: Math.max(0, (lRec.cache || 0) - (dRec.cache || 0) - (cRec.cache || 0)),
        steps: Math.max(0, (lRec.steps || 0) - (dRec.steps || 0) - (cRec.steps || 0))
      };
    }

    const unRec = mergedLegacyUnallocated[k] || { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
    dailyMapAll[k] = {
      total: (dRec.total || 0) + (cRec.total || 0) + (unRec.total || 0),
      input: (dRec.input || 0) + (cRec.input || 0) + (unRec.input || 0),
      output: (dRec.output || 0) + (cRec.output || 0) + (unRec.output || 0),
      cache: (dRec.cache || 0) + (cRec.cache || 0) + (unRec.cache || 0),
      steps: (dRec.steps || 0) + (cRec.steps || 0) + (unRec.steps || 0)
    };
  }

  // 7. Compute aggregated summary statistics
  const now = new Date();
  const todayKey = formatLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);
  if (!earliestDate) earliestDate = todayKey;

  let grandTotalTokens = 0, totalInputTokens = 0, totalOutputTokens = 0, totalCacheTokens = 0, totalSteps = 0;
  let todayTokens = 0, monthTokens = 0, yearTokens = 0;

  for (const [k, v] of Object.entries(dailyMapAll)) {
    if (!v) continue;
    grandTotalTokens += v.total || 0;
    totalInputTokens += v.input || 0;
    totalOutputTokens += v.output || 0;
    totalCacheTokens += v.cache || 0;
    totalSteps += v.steps || 0;
    if (k === todayKey) todayTokens += v.total || 0;
    if (k.startsWith(monthPrefix)) monthTokens += v.total || 0;
    if (k.startsWith(yearPrefix)) yearTokens += v.total || 0;
  }

  // Compute current-period (current calendar month) category breakdowns and step counts
  let currentMonthInput = 0, currentMonthOutput = 0, currentMonthCache = 0, currentMonthSteps = 0;
  for (const [k, v] of Object.entries(dailyMapAll)) {
    if (k.startsWith(monthPrefix) && v) {
      currentMonthInput += v.input || 0;
      currentMonthOutput += v.output || 0;
      currentMonthCache += v.cache || 0;
      currentMonthSteps += v.steps || 0;
    }
  }

  const totalConversations = Math.max(
    legacyV1Archive.maxConversations || 0,
    transcriptJobs.length,
    desktopPbCount + cliPbCount
  );

  // 8. Merge auto-detected plan with user custom settings (observed values > custom > unknown)
  let livePlanStatus = Object.prototype.hasOwnProperty.call(extraContext, 'livePlanStatus')
    ? extraContext.livePlanStatus
    : await fetchUserStatusFromHost(options);
  if (!livePlanStatus) {
    livePlanStatus = archiveV2.planStatus || parseUserPlanStatus(null);
  }

  const customSettingsAll = loadCustomPlanSettings(agDir);
  const currentAccountKey = livePlanStatus?.email || archiveV2.planStatus?.email || null;
  const currentCustom = resolveAccountCustomPlan(customSettingsAll, currentAccountKey);

  const effectivePlanStatus = resolveEffectivePlanStatus(livePlanStatus, currentCustom, {
    cachedLivePlan: archiveV2.planStatus,
    currentEmail: currentAccountKey
  });

  // Load account active sessions for historical backfill attribution verification (read only when using default host dir or explicitly passed; isolated tests do not read real host accounts)
  let sessionWindowsForHistory = Array.isArray(extraContext.accountSessions)
    ? extraContext.accountSessions
    : (Array.isArray(options.accountSessions) ? options.accountSessions : null);
  let hasRealAccountStore = false;
  if (!sessionWindowsForHistory || !options.skipAutoRepair) {
    try {
      const defaultAgDir = path.resolve(path.join(os.homedir(), '.gemini', 'antigravity'));
      const isDefaultHostAg = path.resolve(agDir) === defaultAgDir;
      if (isDefaultHostAg || options.stateDir) {
        const { getStateDir } = require('./asar-engine');
        const stDir = options.stateDir || getStateDir();
        const acctStorePath = path.join(stDir, 'accounts_v1.json');
        if (fs.existsSync(acctStorePath)) {
          hasRealAccountStore = true;
          const parsedAcct = JSON.parse(fs.readFileSync(acctStorePath, 'utf8'));
          if (!sessionWindowsForHistory && Array.isArray(parsedAcct?.accountSessions) && parsedAcct.accountSessions.length > 0) {
            sessionWindowsForHistory = parsedAcct.accountSessions;
          }
        }
      } else if (Array.isArray(options.accountSessions) && options.accountSessions.length > 0) {
        hasRealAccountStore = true;
      }
    } catch { }
  }

  // Before any transcript alignment or enrichment overwrite, run a one-time idempotent repair with backup on ledgers that have account attributions not yet verified under the latest repair version
  if (hasRealAccountStore && !options.skipAutoRepair && (!options.fs || options.fs === fs)) {
    try {
      const preRepairCalls = (loadPricingLedger(agDir).calls || {});
      const needsAttributionRepair = Object.values(preRepairCalls).some(rec =>
        rec &&
        typeof rec === 'object' &&
        rec.attributionRepairVersion !== CURRENT_ATTRIBUTION_REPAIR_VERSION &&
        isValidAccountScopeKey(rec.accountScopeKey) &&
        rec.accountAttributionConfidence !== 'unattributed'
      );
      if (needsAttributionRepair) {
        repairAndMigrateAccountLedger({
          agDir,
          accountSessions: Array.isArray(sessionWindowsForHistory) ? sessionWindowsForHistory : []
        });
      }
    } catch { }
  }

  // Combine persisted per-request ledger with calls from this scan: first perform two-phase 1-to-1 alignment and enrichment against existing ledger entries, then flush only unmatched priced scan requests to disk
  const initialCallsMap = loadPricingLedger(agDir).calls || {};
  const matchedTranscriptReqs = new Set();
  const matchedLedgerKeys = new Set();
  const callEffectiveDate = new Map();
  const reqsByCallId = new Map();
  const reqsByStepKey = new Map();

  for (const r of recentRequests) {
    if (r.callId) {
      const rId = String(r.callId);
      let list = reqsByCallId.get(rId);
      if (!list) { list = []; reqsByCallId.set(rId, list); }
      list.push(r);
    }
    if (r.cascadeId && r.stepIndex !== null && r.stepIndex !== undefined) {
      const sKey = `${r.source || 'desktop'}:${String(r.cascadeId).toLowerCase()}#${r.stepIndex}`;
      let list = reqsByStepKey.get(sKey);
      if (!list) { list = []; reqsByStepKey.set(sKey, list); }
      list.push(r);
    }
  }

  // Count non-synthetic ledger calls per (source, cascadeId, stepIndex) to avoid misbinding usage from another independent responseId in the same step
  const realLedgerCountByStepKey = new Map();
  for (const [ledgerKey, c] of Object.entries(initialCallsMap)) {
    if (!c || !c.cascadeId) continue;
    const cidKey = String(c.callId || ledgerKey);
    if (isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId)) continue;
    const cSrc = c.source || 'desktop';
    const cCid = String(c.cascadeId).toLowerCase();
    for (const stIdx of extractCallStepNumbers(c, ledgerKey)) {
      const sKey = `${cSrc}:${cCid}#${stIdx}`;
      realLedgerCountByStepKey.set(sKey, (realLedgerCountByStepKey.get(sKey) || 0) + 1);
    }
  }

  const takeUnmatchedReq = (list, predicate = null) => {
    if (!list) return null;
    for (const item of list) {
      if (matchedTranscriptReqs.has(item)) continue;
      if (predicate && !predicate(item)) continue;
      matchedTranscriptReqs.add(item);
      return item;
    }
    return null;
  };

  // Strict rule: only allow "synthetic key <-> real ID" (or synthetic-to-synthetic) fallback matching via stepIndex / usage fingerprint; never cross-bind two different real IDs
  const canFallbackLink = (ledgerKey, c, cidKey, reqItem) => {
    const cIsFallback = isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId);
    const rId = String(reqItem.callId || '');
    const rIsFallback = !rId || isStepFallbackCallId(rId, reqItem.cascadeId);
    return cIsFallback || rIsFallback;
  };

  const ledgerEnrichmentCalls = [];
  const inMemoryEnrichments = new Map();

  const applyTranscriptMatch = (ledgerKey, c, cidKey, matched) => {
    const cIsFallback = isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId);
    const mId = String(matched.callId || '');
    const mIsFallback = !mId || isStepFallbackCallId(mId, matched.cascadeId);
    const targetCallId = (cIsFallback && !mIsFallback) ? mId : cidKey;

    const uC = getCallTokenBreakdown(c);
    const merged = mergeSameCallRecords(c, matched, targetCallId, null, false, true);
    const uMerged = getCallTokenBreakdown(merged);

    const keyChanged = targetCallId !== ledgerKey;
    const modelEnriched = getCollectorModelRank(merged.model) > getCollectorModelRank(c.model);
    const usageEnriched = uMerged.tot > uC.tot || (uMerged.tot === uC.tot && uMerged.out > uC.out);
    const stepEnriched = (c.stepIndex === null || c.stepIndex === undefined) && merged.stepIndex !== null && merged.stepIndex !== undefined;
    const cascadeEnriched = !c.cascadeId && Boolean(merged.cascadeId);
    const dateEnriched = String(c.date || '') !== String(merged.date || '')
      || String(c.created_at || '') !== String(merged.created_at || '')
      || Boolean(c.dateIsProvisional) !== Boolean(merged.dateIsProvisional);
    const statusEnriched = String(c.status || '') !== String(merged.status || '');
    const pricingEnriched = Boolean(c.isPriced) !== Boolean(merged.isPriced) || Number(c.costUSD || 0) !== Number(merged.costUSD || 0);

    if (keyChanged || modelEnriched || usageEnriched || stepEnriched || cascadeEnriched || dateEnriched || statusEnriched || pricingEnriched) {
      ledgerEnrichmentCalls.push(merged);
      inMemoryEnrichments.set(ledgerKey, { targetCallId, merged });
    }
    const effectiveDateVal = merged.date || matched.date || c.date || null;
    matchedLedgerKeys.add(ledgerKey);
    callEffectiveDate.set(ledgerKey, effectiveDateVal);
    if (targetCallId !== ledgerKey) {
      matchedLedgerKeys.add(targetCallId);
      callEffectiveDate.set(targetCallId, effectiveDateVal);
    }
  };

  // Pass 1A: Complete exact callId alignment across all ledger records first so same-key records are not prematurely consumed by other same-step records
  const unmatchedAfterExactId = [];
  for (const [ledgerKey, c] of Object.entries(initialCallsMap)) {
    if (!c) continue;
    const cidKey = String(c.callId || ledgerKey);
    let matched = takeUnmatchedReq(reqsByCallId.get(cidKey));
    if (!matched && cidKey !== ledgerKey) {
      matched = takeUnmatchedReq(reqsByCallId.get(ledgerKey));
    }
    if (matched) {
      applyTranscriptMatch(ledgerKey, c, cidKey, matched);
    } else {
      unmatchedAfterExactId.push([ledgerKey, c]);
    }
  }

  // Pass 1B: Cross-key stepIndex alignment (enforce sufficient-evidence gate: two finalized calls that both have models and different usage must never be cross-key merged)
  const unmatchedLedgerPass2 = [];
  for (const [ledgerKey, c] of unmatchedAfterExactId) {
    const cidKey = String(c.callId || ledgerKey);
    let matched = null;
    if (c.cascadeId) {
      const cSrc = c.source || 'desktop';
      const cCid = String(c.cascadeId).toLowerCase();
      const candSteps = extractCallStepNumbers(c, ledgerKey);
      const uC = getCallTokenBreakdown(c);
      for (const stIdx of candSteps) {
        const sKey = `${cSrc}:${cCid}#${stIdx}`;
        const multiRealAtStep = (realLedgerCountByStepKey.get(sKey) || 0) > 1;
        if (multiRealAtStep && (uC.inp + uC.cap + uC.out) > 0) {
          matched = takeUnmatchedReq(reqsByStepKey.get(sKey), (item) => {
            if (!canFallbackLink(ledgerKey, c, cidKey, item)) return false;
            if (!areModelsCompatible(c.model, item.model)) return false;
            const uItem = getCallTokenBreakdown(item);
            return uItem.inp === uC.inp && uItem.cap === uC.cap && uItem.out === uC.out;
          });
        } else if (!multiRealAtStep) {
          const cIsFallback = isStepFallbackCallId(ledgerKey, c.cascadeId) || isStepFallbackCallId(cidKey, c.cascadeId);
          matched = takeUnmatchedReq(reqsByStepKey.get(sKey), (item) => {
            if (!canFallbackLink(ledgerKey, c, cidKey, item)) return false;
            const rId = String(item.callId || '');
            const rIsFallback = !rId || isStepFallbackCallId(rId, item.cascadeId);
            return (cIsFallback && !rIsFallback)
              ? isConfirmableSingleStepMatch(item, c)
              : isConfirmableSingleStepMatch(c, item);
          });
        }
        if (matched) break;
      }
    }
    if (matched) {
      applyTranscriptMatch(ledgerKey, c, cidKey, matched);
    } else {
      unmatchedLedgerPass2.push([ledgerKey, c]);
    }
  }

  // Pass 2: Support historical ledger entries without stepIndex by bidirectional unique (1-to-1) matching on same-session exact non-zero usage fingerprint + compatible model
  if (unmatchedLedgerPass2.length) {
    const reqsByUsageKey = new Map();
    for (const r of recentRequests) {
      if (matchedTranscriptReqs.has(r) || !r.cascadeId) continue;
      const uR = getCallTokenBreakdown(r);
      if (uR.inp + uR.cap + uR.out <= 0) continue;
      const uKey = `${r.source || 'desktop'}:${String(r.cascadeId).toLowerCase()}:${uR.inp}:${uR.cap}:${uR.out}`;
      let list = reqsByUsageKey.get(uKey);
      if (!list) { list = []; reqsByUsageKey.set(uKey, list); }
      list.push(r);
    }
    const ledgerCandsByUsageKey = new Map();
    for (const [ledgerKey, c] of unmatchedLedgerPass2) {
      if (!c.cascadeId) continue;
      if (c.stepIndex !== null && c.stepIndex !== undefined) continue;
      if (extractCallStepNumbers(c, ledgerKey).length > 0) continue;
      const uC = getCallTokenBreakdown(c);
      if (uC.inp + uC.cap + uC.out <= 0) continue;
      const uKey = `${c.source || 'desktop'}:${String(c.cascadeId).toLowerCase()}:${uC.inp}:${uC.cap}:${uC.out}`;
      let list = ledgerCandsByUsageKey.get(uKey);
      if (!list) { list = []; ledgerCandsByUsageKey.set(uKey, list); }
      list.push([ledgerKey, c, String(c.callId || ledgerKey)]);
    }
    for (const [uKey, ledgerGroup] of ledgerCandsByUsageKey.entries()) {
      const reqCandidates = (reqsByUsageKey.get(uKey) || []).filter(item => !matchedTranscriptReqs.has(item));
      if (!reqCandidates.length) continue;
      const reqToCompatibleLedgers = new Map();
      const ledgerToCompatibleReqs = new Map();
      for (const lEntry of ledgerGroup) {
        const [ledgerKey, c, cidKey] = lEntry;
        const compatReqs = reqCandidates.filter(
          item => canFallbackLink(ledgerKey, c, cidKey, item) && areModelsCompatible(c.model, item.model)
        );
        ledgerToCompatibleReqs.set(lEntry, compatReqs);
        for (const rItem of compatReqs) {
          let lList = reqToCompatibleLedgers.get(rItem);
          if (!lList) { lList = []; reqToCompatibleLedgers.set(rItem, lList); }
          lList.push(lEntry);
        }
      }
      for (const lEntry of ledgerGroup) {
        const compatReqs = ledgerToCompatibleReqs.get(lEntry) || [];
        if (compatReqs.length !== 1) continue;
        const targetReq = compatReqs[0];
        if ((reqToCompatibleLedgers.get(targetReq) || []).length !== 1) continue;
        if (matchedTranscriptReqs.has(targetReq)) continue;
        matchedTranscriptReqs.add(targetReq);
        const [ledgerKey, c, cidKey] = lEntry;
        applyTranscriptMatch(ledgerKey, c, cidKey, targetReq);
      }
    }
  }

  // Write enrichment updates for existing records (backfilling model / latest full usage / stepIndex) and unmatched priced scan calls to the ledger
  const unmatchedPricedTranscriptReqs = recentRequests.filter(r => !matchedTranscriptReqs.has(r) && r.isPriced && r.callId);
  const ledgerUpdates = [...ledgerEnrichmentCalls, ...unmatchedPricedTranscriptReqs];
  if (ledgerUpdates.length) {
    recordModelCalls(ledgerUpdates, {
      agDir,
      trustTranscriptDate: true,
      ...(sessionWindowsForHistory ? { accountSessions: sessionWindowsForHistory } : {})
    });
  }

  const effectiveCallsMap = { ...(loadPricingLedger(agDir).calls || {}) };
  for (const [origKey, { targetCallId, merged }] of inMemoryEnrichments.entries()) {
    if (effectiveCallsMap[targetCallId]) {
      const diskRec = effectiveCallsMap[targetCallId];
      const nextMerged = mergeSameCallRecords(diskRec, merged, targetCallId, merged.stepIndex, false, true);
      if (diskRec.attributionRepairVersion === CURRENT_ATTRIBUTION_REPAIR_VERSION) {
        nextMerged.attributionRepairVersion = diskRec.attributionRepairVersion;
        if (diskRec.accountAttributionConfidence === 'unattributed') {
          delete nextMerged.accountScopeKey;
          delete nextMerged.accountAttributionEvidence;
          nextMerged.accountAttributionConfidence = 'unattributed';
          if (diskRec.unattributedReason) nextMerged.unattributedReason = diskRec.unattributedReason;
        } else if (isValidAccountScopeKey(diskRec.accountScopeKey)) {
          nextMerged.accountScopeKey = diskRec.accountScopeKey;
          nextMerged.accountAttributionConfidence = diskRec.accountAttributionConfidence;
          if (diskRec.accountAttributionEvidence) nextMerged.accountAttributionEvidence = diskRec.accountAttributionEvidence;
        }
      }
      effectiveCallsMap[targetCallId] = nextMerged;
    } else if (effectiveCallsMap[origKey]) {
      if (targetCallId !== origKey) delete effectiveCallsMap[origKey];
      effectiveCallsMap[targetCallId] = merged;
    }
  }

  const finalRealKeysByStep = new Map();
  for (const [ledgerKey, c] of Object.entries(effectiveCallsMap)) {
    if (!c || !c.cascadeId) continue;
    if (isStepFallbackCallId(ledgerKey, c.cascadeId)) continue;
    const src = c.source || 'desktop';
    const cid = String(c.cascadeId).toLowerCase();
    for (const st of extractCallStepNumbers(c, ledgerKey)) {
      const sKey = `${src}:${cid}#${st}`;
      let list = finalRealKeysByStep.get(sKey);
      if (!list) { list = []; finalRealKeysByStep.set(sKey, list); }
      list.push(ledgerKey);
    }
  }
  for (const r of unmatchedPricedTranscriptReqs) {
    const rKey = String(r.callId);
    let persistedKey = effectiveCallsMap[rKey] ? rKey : null;
    if (!persistedKey && isStepFallbackCallId(rKey, r.cascadeId) && r.cascadeId && r.stepIndex !== null && r.stepIndex !== undefined) {
      const cands = (finalRealKeysByStep.get(`${r.source || 'desktop'}:${String(r.cascadeId).toLowerCase()}#${r.stepIndex}`) || [])
        .filter(k => effectiveCallsMap[k] && areModelsCompatible(effectiveCallsMap[k].model, r.model));
      if (cands.length === 1) {
        if (isConfirmableSingleStepMatch(effectiveCallsMap[cands[0]], r)) {
          persistedKey = cands[0];
        }
      } else if (cands.length > 1) {
        const uR = getCallTokenBreakdown(r);
        if (uR.inp + uR.cap + uR.out > 0) {
          const exact = cands.filter(k => {
            const uK = getCallTokenBreakdown(effectiveCallsMap[k]);
            return uK.inp === uR.inp && uK.cap === uR.cap && uK.out === uR.out;
          });
          if (exact.length === 1) persistedKey = exact[0];
        }
      }
    }
    if (!persistedKey && !isSyntheticCall(rKey, r)) {
      effectiveCallsMap[rKey] = r;
      persistedKey = rKey;
    }
    if (persistedKey) {
      matchedTranscriptReqs.add(r);
      matchedLedgerKeys.add(persistedKey);
      callEffectiveDate.set(persistedKey, r.date || effectiveCallsMap[persistedKey].date || null);
    }
  }

  const finalCallsEntries = Object.entries(effectiveCallsMap);
  const mergedCalls = finalCallsEntries.map(([, c]) => c);

  const resolveLedgerCallDate = (ledgerKey, c) => {
    const mapped = callEffectiveDate.get(ledgerKey);
    if (mapped) return String(mapped).slice(0, 10);
    const dInfo = extractNormalizedDateInfo(c);
    if (dInfo.date) return dInfo.date;
    return null;
  };

  // Aggregate ledger calls unmatched to any live transcript by source and date to offset shares already covered by the ledger in v2 / v1 historical archives
  const unmatchedLedgerBySourceDate = new Map();
  for (const [ledgerKey, c] of finalCallsEntries) {
    if (!c || matchedLedgerKeys.has(ledgerKey)) continue;
    const effDate = resolveLedgerCallDate(ledgerKey, c);
    if (!effDate || !/^\d{4}-\d{2}-\d{2}$/.test(effDate)) continue;
    const cSrc = c.source === 'cli' ? 'cli' : 'desktop';
    const cInp = Number(c.inputTokens ?? c.input_tokens ?? c.input ?? 0);
    const cCap = Number(c.cacheTokens ?? c.cacheReadTokens ?? c.cache_read_tokens ?? c.cached ?? 0);
    const cOut = Number(c.outputTokens ?? c.output_tokens ?? c.output ?? 0);
    const cTok = cInp + cCap + cOut;
    const mapKey = `${cSrc}:${effDate}`;
    const prev = unmatchedLedgerBySourceDate.get(mapKey) || { tokens: 0, steps: 0 };
    prev.tokens += cTok;
    prev.steps += 1;
    unmatchedLedgerBySourceDate.set(mapKey, prev);
  }

  let archDeskUncovSteps = 0, archDeskUncovTokens = 0;
  let archCliUncovSteps = 0, archCliUncovTokens = 0;
  let archMonthUncovSteps = 0, archMonthUncovTokens = 0;

  for (const k of Array.from(allDateKeys).sort()) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) continue;

    const v2OnlyDeskTok = Math.max(0, (mergedDesktop[k]?.total || 0) - (scannedBySource.desktop[k]?.total || 0));
    const v2OnlyDeskSteps = Math.max(0, (mergedDesktop[k]?.steps || 0) - (scannedBySource.desktop[k]?.steps || 0));
    const covDesk = unmatchedLedgerBySourceDate.get(`desktop:${k}`) || { tokens: 0, steps: 0 };
    const v2UncovDeskTok = Math.max(0, v2OnlyDeskTok - covDesk.tokens);
    const v2UncovDeskSteps = v2UncovDeskTok > 0
      ? Math.max(1, v2OnlyDeskSteps - covDesk.steps)
      : Math.max(0, v2OnlyDeskSteps - covDesk.steps);
    const excessDeskTok = Math.max(0, covDesk.tokens - v2OnlyDeskTok);
    const excessDeskSteps = Math.max(0, covDesk.steps - v2OnlyDeskSteps);

    const v2OnlyCliTok = Math.max(0, (mergedCli[k]?.total || 0) - (scannedBySource.cli[k]?.total || 0));
    const v2OnlyCliSteps = Math.max(0, (mergedCli[k]?.steps || 0) - (scannedBySource.cli[k]?.steps || 0));
    const covCli = unmatchedLedgerBySourceDate.get(`cli:${k}`) || { tokens: 0, steps: 0 };
    const v2UncovCliTok = Math.max(0, v2OnlyCliTok - covCli.tokens);
    const v2UncovCliSteps = v2UncovCliTok > 0
      ? Math.max(1, v2OnlyCliSteps - covCli.steps)
      : Math.max(0, v2OnlyCliSteps - covCli.steps);
    const excessCliTok = Math.max(0, covCli.tokens - v2OnlyCliTok);
    const excessCliSteps = Math.max(0, covCli.steps - v2OnlyCliSteps);

    const rawV1Tok = mergedLegacyUnallocated[k]?.total || 0;
    const rawV1Steps = mergedLegacyUnallocated[k]?.steps || 0;
    const excessTok = excessDeskTok + excessCliTok;
    const excessSteps = excessDeskSteps + excessCliSteps;
    const v1UncovTok = Math.max(0, rawV1Tok - excessTok);
    const v1UncovSteps = v1UncovTok > 0
      ? Math.max(1, rawV1Steps - excessSteps)
      : Math.max(0, rawV1Steps - excessSteps);

    archDeskUncovTokens += v2UncovDeskTok + v1UncovTok;
    archDeskUncovSteps += v2UncovDeskSteps + v1UncovSteps;
    archCliUncovTokens += v2UncovCliTok;
    archCliUncovSteps += v2UncovCliSteps;
    if (k.startsWith(monthPrefix)) {
      archMonthUncovTokens += v2UncovDeskTok + v2UncovCliTok + v1UncovTok;
      archMonthUncovSteps += v2UncovDeskSteps + v2UncovCliSteps + v1UncovSteps;
    }
  }

  // Dynamically compute remaining unpriced requests and reasons per source and in total not covered by the ledger
  const unmatchedRecentUnpriced = recentRequests.filter(r => !matchedTranscriptReqs.has(r) && !r.isPriced);
  const desktopRecentUnpriced = unmatchedRecentUnpriced.filter(r => r.source === 'desktop');
  const cliRecentUnpriced = unmatchedRecentUnpriced.filter(r => r.source === 'cli');

  function aggregateUnpriced(items, extraCount = 0, extraTokens = 0) {
    const reasons = { missingModel: extraCount, unsupportedModel: 0, missingUsage: 0 };
    let tokens = extraTokens;
    for (const it of items) {
      tokens += (it.inputTokens + it.cacheTokens + it.outputTokens);
      if (!it.model) reasons.missingModel++;
      else if ((it.inputTokens + it.cacheTokens + it.outputTokens) === 0) reasons.missingUsage++;
      else reasons.unsupportedModel++;
    }
    return { count: items.length + extraCount, tokens, reasons };
  }

  const deskUnpriced = aggregateUnpriced(desktopRecentUnpriced, archDeskUncovSteps, archDeskUncovTokens);
  const cliUnpriced = aggregateUnpriced(cliRecentUnpriced, archCliUncovSteps, archCliUncovTokens);

  const totalUnpricedCount = deskUnpriced.count + cliUnpriced.count;
  const totalUnpricedTokens = deskUnpriced.tokens + cliUnpriced.tokens;
  const totalUnpricedReasons = {
    missingModel: deskUnpriced.reasons.missingModel + cliUnpriced.reasons.missingModel,
    unsupportedModel: deskUnpriced.reasons.unsupportedModel + cliUnpriced.reasons.unsupportedModel,
    missingUsage: deskUnpriced.reasons.missingUsage + cliUnpriced.reasons.missingUsage
  };

  const costEstimateAll = summarizeApiCost(mergedCalls, totalUnpricedCount, totalUnpricedReasons, totalUnpricedTokens);
  const costEstimateDesktop = summarizeApiCost(mergedCalls.filter(c => (c.source || 'desktop') === 'desktop'), deskUnpriced.count, deskUnpriced.reasons, deskUnpriced.tokens);
  const costEstimateCli = summarizeApiCost(mergedCalls.filter(c => c.source === 'cli'), cliUnpriced.count, cliUnpriced.reasons, cliUnpriced.tokens);

  // Current-period (current calendar month) ledger filtering and pricing analysis (appending only remaining current-month steps and v2/v1 legacy deltas not covered by the ledger)
  const currentMonthCalls = finalCallsEntries
    .filter(([ledgerKey, c]) => {
      if (!c) return false;
      const effDate = resolveLedgerCallDate(ledgerKey, c);
      return effDate && effDate.startsWith(monthPrefix);
    })
    .map(([, c]) => c);
  const currentMonthUnmatchedReqs = unmatchedRecentUnpriced.filter(r => r.date && String(r.date).startsWith(monthPrefix));
  const monthUnpriced = aggregateUnpriced(currentMonthUnmatchedReqs, archMonthUncovSteps, archMonthUncovTokens);
  const costEstimateCurrentMonth = summarizeApiCost(
    currentMonthCalls,
    monthUnpriced.count,
    monthUnpriced.reasons,
    monthUnpriced.tokens
  );

  // 9. Reference model conversion (official standard pricing table 2026-11-08)
  const referenceCostAll = calculateReferenceModelCost({
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheTokens: totalCacheTokens,
    totalTokens: grandTotalTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-08',
    mode: 'all'
  });

  const referenceCostCurrentMonth = calculateReferenceModelCost({
    inputTokens: currentMonthInput,
    outputTokens: currentMonthOutput,
    cacheTokens: currentMonthCache,
    totalTokens: monthTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-08',
    mode: 'all'
  });

  const referenceCostHybrid = calculateReferenceModelCost({
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheTokens: totalCacheTokens,
    totalTokens: grandTotalTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-09',
    mode: 'unpriced_only',
    knownUsage: {
      byCategory: costEstimateAll.byCategory,
      costUSD: costEstimateAll.pricedCostUSD
    }
  });

  const referenceCostCurrentMonthHybrid = calculateReferenceModelCost({
    inputTokens: currentMonthInput,
    outputTokens: currentMonthOutput,
    cacheTokens: currentMonthCache,
    totalTokens: monthTokens
  }, 'gemini-3.8-flash', {
    pricingDate: '2026-11-09',
    mode: 'unpriced_only',
    knownUsage: {
      byCategory: costEstimateCurrentMonth.byCategory,
      costUSD: costEstimateCurrentMonth.pricedCostUSD
    }
  });

  const costEstimate = costEstimateAll;

  const speedRecords = mergedCalls
    .filter(c => isValidSpeedSample(c))
    .map(c => ({
      callId: c.callId,
      model: c.model,
      modelExactId: c.modelExactId || resolveStableModelId(c, livePlanStatus?.cascadeModelConfigs || []) || null,
      modelLabel: c.modelLabel || c.model || null,
      effort: c.effort || null,
      inputTokens: c.inputTokens,
      cacheReadTokens: c.cacheReadTokens ?? c.cacheTokens ?? 0,
      outputTokens: c.outputTokens,
      ttftSec: c.ttftSec ?? null,
      streamingSec: c.streamingSec ?? null,
      durationSec: c.durationSec,
      tps: c.tps ?? null,
      origin: c.origin === 'speed-test' ? 'speed-test' : 'chat',
      status: c.status,
      isEstimated: Boolean(c.isEstimated),
      date: c.date || null,
      created_at: c.created_at || null,
      timestamp: getCallSortTimestamp(c) || null
    }));

  const compactModelConfigs = Array.isArray(livePlanStatus?.cascadeModelConfigs)
    ? livePlanStatus.cascadeModelConfigs.map(sanitizeCascadeModelConfig).filter(Boolean)
    : [];

  // Aggregate actual consumption events over the last 8 days per shared quota pool (used for 5h / weekly dual-cycle remaining token estimate calibration)
  // Counting basis: sum of raw inputTokens + cacheReadTokens + outputTokens; also compute the earliest known call timestamp across all history to assess cycle start coverage completeness
  const quotaNowMs = Date.now();
  const quotaCutoffMs = quotaNowMs - 8 * 86400000;
  const quotaRecentCutoffMs = quotaNowMs - 86400000;
  const seenQuotaCallIds = new Set();
  const recentModelUsage = [];
  const olderQuotaBuckets = new Map();
  let allKnownCallsMinTs = null;
  const pushQuotaUsageCall = (call) => {
    if (!call || typeof call !== 'object') return;
    if (call.callId && seenQuotaCallIds.has(call.callId)) return;
    const rawTs = getCallSortTimestamp(call) ?? call.timestamp ?? (call.created_at ? new Date(call.created_at).getTime() : NaN);
    const ts = Number(rawTs);
    if (!Number.isFinite(ts) || ts <= 0 || ts > quotaNowMs + 60000) return;
    if (allKnownCallsMinTs === null || ts < allKnownCallsMinTs) {
      allKnownCallsMinTs = ts;
    }
    if (ts < quotaCutoffMs) return;
    const rawModel = call.modelExactId || extractModelString(call) || call.model || '';
    const poolKey = typeof getModelPoolKey === 'function' ? getModelPoolKey(rawModel, call.modelLabel || '') : 'unknown';
    const sharedGroupKey = typeof getSharedQuotaGroupKey === 'function' ? getSharedQuotaGroupKey(rawModel || poolKey) : 'unknown';
    if ((!poolKey || poolKey === 'unknown') && (!sharedGroupKey || sharedGroupKey === 'unknown')) return;
    const inp = Math.max(0, Number(call.inputTokens || 0));
    const cache = Math.max(0, Number(call.cacheTokens ?? call.cacheReadTokens ?? 0));
    const outp = Math.max(0, Number(call.outputTokens || 0));
    const sumParts = inp + cache + outp;
    const totalTokens = Number(call.totalTokens ?? sumParts);
    if (!Number.isFinite(totalTokens) || totalTokens <= 0) return;
    if (call.callId) seenQuotaCallIds.add(call.callId);
    if (ts >= quotaRecentCutoffMs) {
      recentModelUsage.push({
        id: call.callId || null,
        poolKey,
        sharedGroupKey,
        ts,
        inputTokens: inp,
        cacheTokens: cache,
        outputTokens: outp,
        totalTokens
      });
    } else {
      const bTs = Math.floor(ts / 900000) * 900000;
      const bKey = `${sharedGroupKey}:${poolKey}:${bTs}`;
      const existingB = olderQuotaBuckets.get(bKey);
      if (existingB) {
        existingB.inputTokens += inp;
        existingB.cacheTokens += cache;
        existingB.outputTokens += outp;
        existingB.totalTokens += totalTokens;
      } else {
        olderQuotaBuckets.set(bKey, {
          poolKey,
          sharedGroupKey,
          ts: bTs,
          inputTokens: inp,
          cacheTokens: cache,
          outputTokens: outp,
          totalTokens
        });
      }
    }
  };
  for (const c of mergedCalls) pushQuotaUsageCall(c);
  for (const c of recentRequests) pushQuotaUsageCall(c);
  for (const b of olderQuotaBuckets.values()) recentModelUsage.push(b);
  const quotaUsageCoverageStartMs = allKnownCallsMinTs !== null ? Math.max(quotaCutoffMs, allKnownCallsMinTs) : null;

  const modelBreakdown = buildDailyModelBreakdown({
    recentRequests,
    finalCallsEntries,
    matchedTranscriptReqs,
    matchedLedgerKeys,
    resolveLedgerCallDate,
    mergedDesktop,
    mergedCli,
    mergedLegacyUnallocated,
    archiveV2,
    compactModelConfigs,
    availableModelDetails: livePlanStatus?.availableModelDetails || null
  });

  const cacheReadStatsAll = summarizeDailyMapCacheStats(dailyMapAll);
  const cacheReadStatsDesktop = summarizeDailyMapCacheStats(mergedDesktop);
  const cacheReadStatsCli = summarizeDailyMapCacheStats(mergedCli);
  const currentMonthCacheReadStatsAll = summarizeDailyMapCacheStats(dailyMapAll, monthPrefix);
  const currentMonthCacheReadStatsDesktop = summarizeDailyMapCacheStats(mergedDesktop, monthPrefix);
  const currentMonthCacheReadStatsCli = summarizeDailyMapCacheStats(mergedCli, monthPrefix);

  const prevAccountEmail = Object.prototype.hasOwnProperty.call(extraContext, 'prevAccountEmail')
    ? extraContext.prevAccountEmail
    : (collectTokenHistoryAsync._lastAccountEmail || null);
  const accountUsageBreakdown = buildAccountUsageBreakdown({
    finalCallsEntries,
    resolveLedgerCallDate,
    dailyMapAll,
    mergedDesktop,
    mergedCli,
    mergedLegacyUnallocated,
    dailyModelMapBySource: modelBreakdown.dailyModelMapBySource,
    modelMetaByKey: modelBreakdown.modelMetaByKey,
    compactModelConfigs,
    availableModelDetails: livePlanStatus?.availableModelDetails || null,
    totalConversationsAll: totalConversations,
    unpricedSummaryBySource: {
      all: { count: totalUnpricedCount, reasons: totalUnpricedReasons, tokens: totalUnpricedTokens },
      desktop: deskUnpriced,
      cli: cliUnpriced,
      currentMonth: monthUnpriced
    },
    now
  });
  const out = {
    schemaVersion: PROJECT_VERSION,
    version: PROJECT_VERSION,
    accountScopeKey: currentAccountKey ? buildAccountScopeKey(currentAccountKey) : null,
    currentAccountEmail: currentAccountKey || null,
    usageByAccount: accountUsageBreakdown.byAccount,
    unattributedUsage: accountUsageBreakdown.unattributed,
    attributionPolicy: {
      historicalFilesAttributed: false,
      description: '仅带有可靠账号归属证据的请求计入对应账号；未携带账号依据的历史会话及离线日志统一保留在未归属账本，绝不默认算给当前登录账号。'
    },
    isAccountSwitched: Boolean(
      currentAccountKey &&
      prevAccountEmail &&
      String(prevAccountEmail).toLowerCase() !== String(currentAccountKey).toLowerCase()
    ),
    updatedAt: `${todayKey} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`,
    firstUseDate: earliestDate,
    quotaUsageCoverageStartMs,
    quotaUsageAccounting: 'raw_input_cache_output',
    recentModelUsage,
    speedRecords,
    cascadeModelConfigs: compactModelConfigs,
    modelCapabilitiesById: livePlanStatus?.availableModelDetails || null,
    currentPeriod: {
      key: monthPrefix,
      periodType: 'calendar_month',
      label: monthPrefix,
      isCurrentMonth: true
    },
    sources: {
      desktop: {
        conversationsCount: desktopPbCount,
        transcriptsCount: transcriptJobs.filter(j => j.source === 'desktop').length
      },
      cli: {
        dirExists: cliAgDirs.some(d => fs.existsSync(d)),
        conversationsCount: cliPbCount,
        transcriptsCount: transcriptJobs.filter(j => j.source === 'cli').length
      },
      wsl: {
        distros: extraWsl.distros,
        desktopDirsCount: extraWsl.desktopDirs.length,
        cliDirsCount: extraWsl.cliDirs.length,
        skippedRoots: Array.isArray(extraWsl.skippedRoots) ? extraWsl.skippedRoots : []
      }
    },
    planStatus: effectivePlanStatus,
    rawPlanStatus: livePlanStatus,
    customPlanSettings: currentCustom,
    uiPreferences: customSettingsAll.uiPreferences || {},
    costEstimate,
    costEstimateCurrentMonth,
    costEstimateBySource: {
      all: costEstimateAll,
      desktop: costEstimateDesktop,
      cli: costEstimateCli
    },
    cacheReadStatsBySource: {
      all: cacheReadStatsAll,
      desktop: cacheReadStatsDesktop,
      cli: cacheReadStatsCli
    },
    currentMonthCacheReadStatsBySource: {
      all: currentMonthCacheReadStatsAll,
      desktop: currentMonthCacheReadStatsDesktop,
      cli: currentMonthCacheReadStatsCli
    },
    referenceCost: {
      all: referenceCostAll,
      currentMonth: referenceCostCurrentMonth,
      hybrid: referenceCostHybrid,
      currentMonthHybrid: referenceCostCurrentMonthHybrid
    },
    summary: {
      grandTotalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      todayTokens,
      monthTokens,
      yearTokens,
      currentMonthInput,
      currentMonthOutput,
      currentMonthCache,
      cacheReadStats: cacheReadStatsAll,
      currentMonthCacheReadStats: currentMonthCacheReadStatsAll,
      totalSteps,
      totalConversations,
      firstUseDate: earliestDate,
      activeDaysCount: Object.keys(dailyMapAll).length,
      costEstimate,
      costEstimateCurrentMonth,
      referenceCost: {
        all: referenceCostAll,
        currentMonth: referenceCostCurrentMonth,
        hybrid: referenceCostHybrid,
        currentMonthHybrid: referenceCostCurrentMonthHybrid
      }
    },
    dailyMap: dailyMapAll,
    dailyMapBySource: {
      all: dailyMapAll,
      desktop: mergedDesktop,
      cli: mergedCli,
      legacyUnallocated: mergedLegacyUnallocated
    },
    dailyModelMapBySource: modelBreakdown.dailyModelMapBySource,
    modelMetaByKey: modelBreakdown.modelMetaByKey
  };

  const unattributedModelTokens = Object.values(modelBreakdown.dailyModelMapBySource?.all || {}).reduce(
    (acc, dayRec) => acc + (Number(dayRec?.[UNATTRIBUTED_MODEL_KEY]?.total) || 0),
    0
  );
  const modelMetaSig = Object.keys(modelBreakdown.modelMetaByKey).sort().join(',');
  const archiveSig = `${agDir}|${earliestDate}|${totalConversations}|${grandTotalTokens}|${totalSteps}|m:${modelMetaSig}|u:${unattributedModelTokens}|${effectivePlanStatus?.tierKey || ''}|${effectivePlanStatus?.tierId || ''}|${effectivePlanStatus?.teamsTier || ''}|${effectivePlanStatus?.actualPricePaid ?? ''}|${effectivePlanStatus?.currency || ''}|${costEstimate?.pricedCostUSD ?? ''}`;
  const isStaleCheck = typeof extraContext.isStale === 'function' ? extraContext.isStale : null;
  if (isStaleCheck && isStaleCheck()) {
    return { out, archiveSig: null, accountKey: currentAccountKey || null, stale: true };
  }

  // Persist to v2 and v1 archives (atomic write only when data changed or file does not exist, reducing frequent disk I/O)
  const prevArchiveSig = Object.prototype.hasOwnProperty.call(extraContext, 'prevArchiveSig')
    ? extraContext.prevArchiveSig
    : collectTokenHistoryAsync._lastArchiveSig;
  try {
    const shouldWriteArchive = options.agDir || archiveSig !== prevArchiveSig || !fs.existsSync(archivePathV2) || !fs.existsSync(archivePathV1);
    if (shouldWriteArchive) {
      const v2Payload = {
        version: '2.0.0',
        firstUseDate: earliestDate,
        updatedAt: out.updatedAt,
        maxConversations: totalConversations,
        planStatus: effectivePlanStatus,
        costEstimate,
        costEstimateCurrentMonth,
        referenceCost: out.referenceCost,
        dailyMapBySource: out.dailyMapBySource,
        dailyModelMapBySource: modelBreakdown.dailyModelMapBySource,
        modelMetaByKey: modelBreakdown.modelMetaByKey
      };
      safeWriteJsonSync(archivePathV2, v2Payload);

      // Also write back in v1 format to maintain full backward compatibility
      const v1Payload = {
        firstUseDate: earliestDate,
        maxConversations: totalConversations,
        updatedAt: out.updatedAt,
        dailyMap: dailyMapAll
      };
      safeWriteJsonSync(archivePathV1, v1Payload);
    }
  } catch { }

  return {
    out,
    archiveSig,
    accountKey: currentAccountKey ? String(currentAccountKey) : null,
    stale: false
  };
}

/**
 * Asynchronously collect historical token usage and cost summary (preferring a background Worker thread to avoid blocking the host main event loop)
 * @param {object} options
 */
async function collectTokenHistoryAsync(options = {}) {
  const scopeKey = getEffectiveScanScopeKey(options);
  const canCacheByScope = !options.fs && !options.hostFetcher && !options.customPlan;
  if (!options.force && canCacheByScope && cachedTokenHistory && cachedTokenHistoryScope === scopeKey && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  if (!options.force && !options.agDir && activeScanPromise && activeScanScope === scopeKey) {
    return activeScanPromise;
  }

  const thisScanSeq = ++currentScanSequence;
  const runner = (async () => {
    const livePlanStatus = await fetchUserStatusFromHost(options);
    const prevAccountEmail = collectTokenHistoryAsync._lastAccountEmail || null;
    const prevArchiveSig = collectTokenHistoryAsync._lastArchiveSig || null;

    let result = null;
    if (canUseHistoryWorker(options)) {
      const workerResp = await runHistoryWorkerTask({
        options: cloneCollectorOptionsForWorker(options),
        livePlanStatus,
        prevAccountEmail,
        prevArchiveSig
      }, 'collectTokenHistory', options);
      if (workerResp && workerResp._workerHandled && workerResp.result && workerResp.result.out) {
        result = workerResp.result;
      }
    }

    if (!result) {
      result = await collectTokenHistoryCoreAsync(options, {
        livePlanStatus,
        prevAccountEmail,
        prevArchiveSig,
        isStale: () => !options.agDir && thisScanSeq !== currentScanSequence
      });
    }

    if (!options.agDir && thisScanSeq !== currentScanSequence) {
      return result.out;
    }
    if (result.archiveSig) {
      collectTokenHistoryAsync._lastArchiveSig = result.archiveSig;
    }
    if (canCacheByScope) {
      if (!options.agDir && result.accountKey) collectTokenHistoryAsync._lastAccountEmail = result.accountKey;
      cachedTokenHistory = result.out;
      cachedTokenHistoryScope = scopeKey;
      cachedTokenHistoryAt = Date.now();
    }
    return result.out;
  })();

  if (!options.agDir) {
    activeScanScope = scopeKey;
    const tracked = runner.finally(() => {
      if (activeScanPromise === tracked) {
        activeScanPromise = null;
        activeScanScope = '';
      }
    });
    activeScanPromise = tracked;
    return tracked;
  }
  return runner;
}

/**
 * Extract user turn markers, model call records, and verifiable subagent call associations from a single transcript.jsonl.
 */