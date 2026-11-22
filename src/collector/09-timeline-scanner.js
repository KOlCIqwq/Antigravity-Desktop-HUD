function parseTranscriptForSessionTimeline(transcriptPath, cascadeId, convDir, sourceName = 'desktop', extraOpts = {}) {
  const turns = [];
  const calls = [];
  const subagentLinks = [];
  const uuidExtractRe = /"conversationId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/gi;

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { turns, calls, subagentLinks };
  }

  let content = '';
  try {
    content = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return { turns, calls, subagentLinks };
  }

  const dbMeta = convDir && !extraOpts.fs && !isFsMonkeyPatched()
    ? loadConversationDbMeta(path.join(convDir, `${cascadeId}.db`), cascadeId)
    : null;

  const lines = content.split(/\r?\n/);
  const explicitUserTurns = [];
  const fallbackUserTurns = [];
  const pendingInvokes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let event = null;
    try { event = JSON.parse(line); } catch { continue; }

    const rawStep = event.step_index ?? event.stepIndex;
    const parsedStep = rawStep !== undefined && rawStep !== null && rawStep !== '' ? Number(rawStep) : NaN;
    const stepIndex = Number.isInteger(parsedStep) && parsedStep >= 0 ? parsedStep : null;
    const createdAt = event.created_at || event.createdAt || null;
    const ts = createdAt ? Date.parse(createdAt) : NaN;
    const validTs = Number.isFinite(ts) && ts > 0 ? ts : null;

    if (event.type === 'USER_INPUT' || event.type === 'user' || event.role === 'user') {
      const textBody = typeof event.content === 'string' ? event.content : (typeof event.text === 'string' ? event.text : '');
      const rawPreview = sanitizeTurnPreviewText(textBody, 120);
      const turnEntry = {
        stepIndex,
        timestamp: validTs,
        created_at: createdAt,
        source: event.source || 'USER_EXPLICIT',
        preview: rawPreview
      };
      if (event.source === 'SYSTEM_SDK') {
        fallbackUserTurns.push(turnEntry);
      } else {
        explicitUserTurns.push(turnEntry);
      }
      continue;
    }

    if (Array.isArray(event.tool_calls)) {
      for (const tc of event.tool_calls) {
        if (!tc || !tc.name) continue;
        if (tc.name === 'invoke_subagent' || tc.name === 'send_message') {
          const cleanArg = (v) => (typeof v === 'string' ? v.replace(/^"|"$/g, '').trim() : '');
          pendingInvokes.push({
            stepIndex,
            toolName: tc.name,
            role: cleanArg(tc.args?.Role),
            typeName: cleanArg(tc.args?.TypeName),
            recipient: cleanArg(tc.args?.Recipient)
          });
        }
      }
    }

    if (typeof event.content === 'string' && event.content.includes('conversationId')) {
      let m;
      uuidExtractRe.lastIndex = 0;
      while ((m = uuidExtractRe.exec(event.content)) !== null) {
        const childCid = m[1];
        if (!childCid || childCid.toLowerCase() === String(cascadeId).toLowerCase()) continue;
        // 寻找紧邻前文的 invoke_subagent 调用以定位准确父步骤和 Role/TypeName
        let matchedInvoke = null;
        for (let pIdx = pendingInvokes.length - 1; pIdx >= 0; pIdx--) {
          const inv = pendingInvokes[pIdx];
          if (inv.toolName === 'invoke_subagent' && (stepIndex === null || inv.stepIndex === null || Math.abs(stepIndex - inv.stepIndex) <= 15)) {
            matchedInvoke = inv;
            break;
          }
        }
        const alreadyLinked = subagentLinks.find(l => l.childCid.toLowerCase() === childCid.toLowerCase());
        if (!alreadyLinked) {
          subagentLinks.push({
            childCid,
            parentCascadeId: cascadeId,
            parentStepIndex: matchedInvoke?.stepIndex ?? stepIndex,
            subagentRole: matchedInvoke?.role || '',
            subagentType: matchedInvoke?.typeName || '',
            confidence: 'verified_tool_output'
          });
        }
      }
    }

    const u = event.chatModel?.usage || null;
    const hasTokenFields = event.input_tokens != null || event.output_tokens != null || event.cache_read_tokens != null || u != null;
    if (!hasTokenFields && !event.error && event.type !== 'PLANNER_RESPONSE') continue;

    const inp = event.input_tokens != null ? Number(event.input_tokens || 0) : (u?.inputTokens != null ? Number(u.inputTokens || 0) : null);
    const outp = event.output_tokens != null ? Number(event.output_tokens || 0) : (u?.outputTokens != null ? Number(u.outputTokens || 0) : null);
    const cap = event.cache_read_tokens != null ? Number(event.cache_read_tokens || 0) : (u?.cacheReadTokens != null ? Number(u.cacheReadTokens || 0) : null);
    const thinking = event.thinking_output_tokens != null ? Number(event.thinking_output_tokens || 0) : (u?.thinkingOutputTokens != null ? Number(u.thinkingOutputTokens || 0) : 0);

    const dbStep = (dbMeta && stepIndex !== null) ? dbMeta.stepMetaMap.get(stepIndex) : null;
    const model = event.chatModel?.model || event.chatModel?.responseModel || event.model || event.modelId || dbStep?.model || '';
    const modelExactId = event.chatModel?.modelId || event.modelId || dbStep?.modelExactId || '';
    const modelLabel = event.chatModel?.modelDisplayName || dbStep?.modelLabel || '';

    const callId = dbStep?.responseId || extractCallId(event, cascadeId, stepIndex ?? i);
    if (!callId) continue;

    const hasUsageNums = inp !== null || cap !== null || outp !== null;
    if (!hasUsageNums && !event.error) continue;

    calls.push({
      callId,
      cascadeId,
      source: sourceName,
      stepIndex,
      model,
      ...(modelExactId ? { modelExactId } : {}),
      ...(modelLabel ? { modelLabel } : {}),
      inputTokens: inp,
      cacheReadTokens: cap,
      cacheTokens: cap,
      outputTokens: outp,
      thinkingTokens: thinking,
      totalTokens: hasUsageNums ? ((inp || 0) + (cap || 0) + (outp || 0)) : null,
      hasInputCacheFields: inp !== null || cap !== null,
      ttftSec: dbStep?.ttftSec ?? null,
      streamingSec: dbStep?.streamingSec ?? null,
      status: event.status === 'RUNNING' ? 'streaming' : 'final',
      ...(event.error ? { error: String(event.error) } : {}),
      date: validTs ? formatLocalDateKey(new Date(validTs)) : null,
      dateSource: 'transcript',
      dateIsProvisional: false,
      created_at: createdAt,
      timestamp: validTs
    });
  }

  const chosenTurns = explicitUserTurns.length ? explicitUserTurns : fallbackUserTurns;
  for (const t of chosenTurns) turns.push(t);
  return { turns, calls, subagentLinks, dbMeta };
}

const subagentParentIndexCache = { dirMtimesKey: '', byParent: new Map(), at: 0 };

/**
 * 基于目录签名缓存扫描所有可用根目录 conversations/*.db，查找显式记录了 parentCascadeId / rootCascadeId 的子代理会话。
 */
function findSubagentChildrenFromConvDirs(parentCascadeId, convDirs = [], options = {}) {
  if (!parentCascadeId || options.fs || isFsMonkeyPatched()) return [];
  const normParent = String(parentCascadeId).trim().toLowerCase();
  const dirSigParts = [];
  const uniqueConvDirs = dedupeScanPaths(convDirs);
  for (const d of uniqueConvDirs) {
    try {
      if (origFsMethods.existsSync(d)) {
        const st = origFsMethods.statSync(d);
        dirSigParts.push(`${d}:${st.mtimeMs}`);
      }
    } catch { }
  }
  const dirKey = dirSigParts.join('|');
  if (subagentParentIndexCache.dirMtimesKey !== dirKey || (Date.now() - subagentParentIndexCache.at) > 60000) {
    const nextByParent = new Map();
    for (const cDir of uniqueConvDirs) {
      try {
        if (!origFsMethods.existsSync(cDir)) continue;
        for (const name of origFsMethods.readdirSync(cDir)) {
          if (!name.endsWith('.db')) continue;
          const cid = name.slice(0, -3);
          const dbMeta = loadConversationDbMeta(path.join(cDir, name), cid);
          const pRaw = String(dbMeta.parentCascadeId || '').trim();
          const rRaw = String(dbMeta.rootCascadeId || '').trim();
          const parentKeys = new Set([pRaw.toLowerCase(), rRaw.toLowerCase()].filter(k => k && k !== cid.toLowerCase()));
          for (const pk of parentKeys) {
            let list = nextByParent.get(pk);
            if (!list) { list = []; nextByParent.set(pk, list); }
            if (!list.some(item => item.childCid === cid && item.convDir === cDir)) {
              list.push({
                childCid: cid,
                parentCascadeId: pRaw || rRaw,
                rootCascadeId: rRaw || pRaw,
                subagentType: dbMeta.subagentType || '',
                subagentRole: dbMeta.subagentRole || '',
                convDir: cDir
              });
            }
          }
        }
      } catch { }
    }
    subagentParentIndexCache.dirMtimesKey = dirKey;
    subagentParentIndexCache.byParent = nextByParent;
    subagentParentIndexCache.at = Date.now();
  }
  return subagentParentIndexCache.byParent.get(normParent) || [];
}

/**
 * 聚合指定会话的按用户轮次请求时间线与可验证子代理调用（仅只读访问，复用现有本地目录与账本）。
 */
async function collectSessionTimelineCoreAsync(cascadeId, options = {}) {
  const cid = String(cascadeId || '').trim();
  if (!cid || cid.includes('..') || cid.includes('/') || cid.includes('\\')) {
    return { cascadeId: cid, turns: [], unlinkedSubagentCalls: [], totalCalls: 0, mainCallsCount: 0, subagentCallsCount: 0, cacheSummary: summarizeCacheReadStats([]), latestCall: null, subagentLinks: [] };
  }

  const { agDir, agCliDir } = resolvePrimaryGeminiDirs(options);
  const extraWsl = await discoverWslGeminiDirsAsync(options);

  const rootEntries = [
    ...dedupeScanPaths([agDir, ...(Array.isArray(options.extraAgDirs) ? options.extraAgDirs : []), ...extraWsl.desktopDirs]).map(d => ({ dir: d, source: 'desktop' })),
    ...dedupeScanPaths([agCliDir, ...(Array.isArray(options.extraAgCliDirs) ? options.extraAgCliDirs : []), ...extraWsl.cliDirs]).map(d => ({ dir: d, source: 'cli' }))
  ];

  const allTurns = [];
  const allCalls = [];
  const subagentMap = new Map();
  let mainDbMeta = null;

  const findTranscriptForCid = (targetCid) => {
    for (const r of rootEntries) {
      const candidates = [
        path.join(r.dir, 'brain', targetCid, '.system_generated', 'logs', 'transcript.jsonl'),
        path.join(r.dir, 'brain', targetCid, 'transcript.jsonl')
      ];
      for (const tp of candidates) {
        if (fs.existsSync(tp)) {
          return { path: tp, convDir: path.join(r.dir, 'conversations'), source: r.source };
        }
      }
    }
    return null;
  };

  // 1. 解析主会话自身 transcript + .db
  const mainFile = findTranscriptForCid(cid);
  if (mainFile) {
    const parsed = parseTranscriptForSessionTimeline(mainFile.path, cid, mainFile.convDir, mainFile.source, options);
    allTurns.push(...parsed.turns);
    allCalls.push(...parsed.calls);
    if (parsed.dbMeta) mainDbMeta = parsed.dbMeta;
    for (const link of parsed.subagentLinks) {
      subagentMap.set(link.childCid.toLowerCase(), link);
    }
  } else if (!options.fs && !isFsMonkeyPatched()) {
    for (const r of rootEntries) {
      const dbP = path.join(r.dir, 'conversations', `${cid}.db`);
      if (fs.existsSync(dbP)) {
        mainDbMeta = loadConversationDbMeta(dbP, cid);
        break;
      }
    }
  }

  // 2. 合并前端 / RPC 传入的 liveSteps（识别当前尚未写入磁盘的最新轮次与 invoke_subagent 调用）
  if (Array.isArray(options.liveSteps) && options.liveSteps.length) {
    for (let idx = 0; idx < options.liveSteps.length; idx++) {
      const s = options.liveSteps[idx];
      if (!s || typeof s !== 'object') continue;
      const stepIndex = Number.isInteger(Number(s.stepIndex ?? s.idx)) ? Number(s.stepIndex ?? s.idx) : idx;
      if (s.userInput) {
        const u = s.userInput;
        const rawText = String(u.userResponse || (u.items || []).map(item => item.text || '').join(' ') || '');
        const rawPreview = sanitizeTurnPreviewText(rawText, 120);
        const already = allTurns.some(t => t.stepIndex === stepIndex);
        if (!already) {
          allTurns.push({
            stepIndex,
            timestamp: s.timestamp || (s.createdAt ? Date.parse(s.createdAt) : null),
            created_at: s.createdAt || null,
            source: u.source || 'USER_EXPLICIT',
            preview: rawPreview
          });
        }
      }
    }
  }

  // 3. 合并来自当前会话 RPC / 前端传来的 liveCalls
  const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];
  if (Array.isArray(options.liveCalls)) {
    for (const c of options.liveCalls) {
      if (!c || typeof c !== 'object') continue;
      if (c.cascadeId && String(c.cascadeId).toLowerCase() !== cid.toLowerCase()) continue;
      const dbStep = (mainDbMeta && Number.isInteger(Number(c.stepIndex)))
        ? mainDbMeta.stepMetaMap.get(Number(c.stepIndex))
        : null;
      allCalls.push({
        ...c,
        cascadeId: c.cascadeId || cid,
        modelExactId: c.modelExactId || dbStep?.modelExactId || resolveStableModelId(c, cascadeConfigs) || undefined,
        modelLabel: c.modelLabel || dbStep?.modelLabel || undefined
      });
    }
  }

  // 4. 合并本地 pricing_ledger_v1.json 中当前会话（及其子代理）的持久化记录
  const ledger = loadPricingLedger(agDir, options.fs ? { fs: options.fs } : undefined);
  const ledgerCalls = ledger && ledger.calls && typeof ledger.calls === 'object' ? Object.values(ledger.calls) : [];
  const normCid = cid.toLowerCase();
  for (const lc of ledgerCalls) {
    if (!lc || !lc.cascadeId) continue;
    if (String(lc.cascadeId).toLowerCase() === normCid) {
      allCalls.push(lc);
    }
  }

  // 5. 发现基于 .db parent_cascade_id / root_cascade_id 的可验证子代理会话
  const dbChildren = findSubagentChildrenFromConvDirs(cid, rootEntries.map(r => path.join(r.dir, 'conversations')), options);
  for (const dc of dbChildren) {
    const k = dc.childCid.toLowerCase();
    const existing = subagentMap.get(k);
    if (!existing) {
      subagentMap.set(k, {
        childCid: dc.childCid,
        parentCascadeId: dc.parentCascadeId || cid,
        parentStepIndex: null,
        subagentRole: dc.subagentRole || '',
        subagentType: dc.subagentType || '',
        confidence: 'verified_db_meta'
      });
    } else if (!existing.subagentType && dc.subagentType) {
      existing.subagentType = dc.subagentType;
    }
  }

  // 6. 读取所有已验证关联子代理的 transcript + .db + ledger 调用
  const subagentLinks = Array.from(subagentMap.values());
  for (const link of subagentLinks) {
    const childFile = findTranscriptForCid(link.childCid);
    const childNorm = link.childCid.toLowerCase();
    if (childFile) {
      const childParsed = parseTranscriptForSessionTimeline(childFile.path, link.childCid, childFile.convDir, childFile.source, options);
      for (const cc of childParsed.calls) {
        allCalls.push({
          ...cc,
          agentRole: 'subagent',
          parentCascadeId: link.parentCascadeId || cid,
          parentStepIndex: link.parentStepIndex ?? null,
          subagentType: link.subagentType || childParsed.dbMeta?.subagentType || '',
          subagentRole: link.subagentRole || childParsed.dbMeta?.subagentRole || '',
          attributionConfidence: link.confidence
        });
      }
    }
    for (const lc of ledgerCalls) {
      if (!lc || !lc.cascadeId) continue;
      if (String(lc.cascadeId).toLowerCase() === childNorm) {
        allCalls.push({
          ...lc,
          agentRole: 'subagent',
          parentCascadeId: link.parentCascadeId || cid,
          parentStepIndex: link.parentStepIndex ?? null,
          subagentType: link.subagentType || '',
          subagentRole: link.subagentRole || '',
          attributionConfidence: link.confidence
        });
      }
    }
  }

  const grouped = groupSessionCallsByTurns(allTurns, allCalls, {
    cascadeId: cid,
    cascadeModelConfigs: cascadeConfigs,
    userStatus: options.userStatus || null
  });
  return {
    ...grouped,
    subagentLinks,
    subagentNote: mainDbMeta?.skippedReason ? `db_${mainDbMeta.skippedReason}` : null
  };
}

async function collectSessionTimelineAsync(cascadeId, options = {}) {
  if (canUseHistoryWorker(options)) {
    const workerResp = await runHistoryWorkerTask({
      cascadeId,
      options: cloneCollectorOptionsForWorker(options)
    }, 'collectSessionTimeline', options);
    if (workerResp && workerResp._workerHandled && workerResp.result) {
      return workerResp.result;
    }
  }
  return collectSessionTimelineCoreAsync(cascadeId, options);
}

if (!isMainThread && workerData && workerData.agCollectorHistoryWorker && parentPort) {
  parentPort.on('message', async (msg) => {
    const { id, cmd, payload, env } = msg || {};
    const prevEnv = {};
    if (env && typeof env === 'object') {
      for (const [k, v] of Object.entries(env)) {
        prevEnv[k] = process.env[k];
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
    try {
      if (cmd === 'collectTokenHistory') {
        const opts = { ...(payload?.options || {}), _inWorker: true };
        const result = await collectTokenHistoryCoreAsync(opts, {
          livePlanStatus: payload?.livePlanStatus ?? null,
          prevAccountEmail: payload?.prevAccountEmail ?? null,
          prevArchiveSig: payload?.prevArchiveSig ?? null
        });
        parentPort.postMessage({ id, ok: true, result });
      } else if (cmd === 'recordModelCalls') {
        const opts = { ...(payload?.options || {}), _inWorker: true };
        const result = recordModelCalls(payload?.newCalls || [], opts);
        // createRecordResult 附带 valueOf 函数，跨 Worker 边界时须剥离函数属性避免 StructuredClone 抛 DataCloneError
        const plainResult = {
          ok: result ? result.ok !== false : false,
          changed: Boolean(result && result.changed),
          ...(result?.error ? { error: result.error } : {}),
          ...(result?.phase ? { phase: result.phase } : {}),
          ...(result?.code ? { code: result.code } : {})
        };
        parentPort.postMessage({ id, ok: true, result: plainResult });
      } else if (cmd === 'collectSessionTimeline') {
        const opts = { ...(payload?.options || {}), _inWorker: true };
        const result = await collectSessionTimelineCoreAsync(payload?.cascadeId || '', opts);
        parentPort.postMessage({ id, ok: true, result });
      } else {
        throw new Error(`Unknown collector worker command: ${cmd}`);
      }
    } catch (err) {
      parentPort.postMessage({ id, ok: false, error: err?.message || String(err) });
    } finally {
      for (const [k, oldV] of Object.entries(prevEnv)) {
        if (oldV === undefined) delete process.env[k];
        else process.env[k] = oldV;
      }
    }
  });
}

function collectTokenHistory(options = {}) {
  const scopeKey = getEffectiveScanScopeKey(options);
  const canCacheByScope = !options.fs && !options.hostFetcher && !options.customPlan;
  // 同步封装：如果缓存可用直接返回，否则启动异步刷新并返回缓存或空壳
  if (!options.force && canCacheByScope && cachedTokenHistory && cachedTokenHistoryScope === scopeKey && Date.now() - cachedTokenHistoryAt < 15000) {
    return cachedTokenHistory;
  }
  // 触发异步更新
  void collectTokenHistoryAsync(options);
  return (cachedTokenHistory && cachedTokenHistoryScope === scopeKey) ? cachedTokenHistory : {
    schemaVersion: PROJECT_VERSION,
    version: PROJECT_VERSION,
    loading: true,
    updatedAt: '',
    firstUseDate: null,
    planStatus: parseUserPlanStatus(null),
    costEstimate: { pricedCostUSD: 0, coveragePercent: 0, byModel: {} },
    summary: { grandTotalTokens: 0, todayTokens: 0, monthTokens: 0, yearTokens: 0, totalConversations: 0, activeDaysCount: 0 },
    quotaUsageCoverageStartMs: null,
    quotaUsageAccounting: 'raw_input_cache_output',
    recentModelUsage: [],
    dailyMap: {},
    dailyMapBySource: { all: {}, desktop: {}, cli: {} }
  };
}
