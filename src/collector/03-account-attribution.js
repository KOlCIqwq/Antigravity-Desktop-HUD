function isValidAccountScopeKey(val) {
  return typeof val === 'string' && SCOPE_KEY_REGEX.test(val.trim());
}

function getAccountAttributionRank(conf) {
  switch (String(conf || '')) {
    case 'explicit_account_email':
    case 'keepalive_bound':
      return 4;
    case 'session_window_verified':
      return 3;
    case 'repaired_session_window':
    case 'live_confirmed_account':
      return 2;
    case 'unattributed':
    default:
      return 0;
  }
}

function parseTimestampToMs(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return raw < 1e11 ? Math.round(raw * 1000) : Math.round(raw);
  }
  const str = String(raw).trim();
  if (!str) return null;
  // 纯日期 YYYY-MM-DD 缺少精确时刻，不得视为请求精确时间窗边界
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return null;
  if (/^\d+(\.\d+)?$/.test(str)) {
    const num = Number(str);
    if (!Number.isFinite(num) || num <= 0) return null;
    return num < 1e11 ? Math.round(num * 1000) : Math.round(num);
  }
  const parsed = Date.parse(str);
  return (Number.isFinite(parsed) && parsed > 0) ? parsed : null;
}

function extractCallTimeBoundsMs(call) {
  if (!call || typeof call !== 'object') return { startMs: null, endMs: null };
  // 临时轮询时间戳 (dateIsProvisional / dateSource === 'provisional') 是点开旧会话时填入的浏览时刻 Date.now()，绝不可当作请求真实发生时间
  const isProvisional = Boolean(call.dateIsProvisional || call.dateSource === 'provisional');
  const allowRawTimestamp = !isProvisional;
  const liveObsMs = call.liveRealtimeConfirmed === true ? parseTimestampToMs(call.liveObservedAtMs) : null;
  const startCand = parseTimestampToMs(call.requestStartMs)
    ?? parseTimestampToMs(call.startTimeMs)
    ?? parseTimestampToMs(call.startTime)
    ?? parseTimestampToMs(call.startedAt)
    ?? parseTimestampToMs(call.created_at)
    ?? parseTimestampToMs(call.createdAt)
    ?? (allowRawTimestamp ? parseTimestampToMs(call.timestamp) : null)
    ?? liveObsMs;
  const endCand = parseTimestampToMs(call.requestEndMs)
    ?? parseTimestampToMs(call.endTimeMs)
    ?? parseTimestampToMs(call.endTime)
    ?? parseTimestampToMs(call.completedAt)
    ?? (allowRawTimestamp ? parseTimestampToMs(call.timestamp) : null)
    ?? parseTimestampToMs(call.created_at)
    ?? liveObsMs
    ?? startCand;
  if (startCand == null && endCand == null) return { startMs: null, endMs: null };
  const s = startCand ?? endCand;
  const e = endCand ?? startCand;
  return { startMs: Math.min(s, e), endMs: Math.max(s, e) };
}

function mergeAccountAttributionFields(baseEntry = {}, incomingEntry = {}) {
  const bScope = isValidAccountScopeKey(baseEntry.accountScopeKey) && baseEntry.accountAttributionConfidence !== 'unattributed'
    ? baseEntry.accountScopeKey.trim()
    : null;
  const iScope = isValidAccountScopeKey(incomingEntry.accountScopeKey) && incomingEntry.accountAttributionConfidence !== 'unattributed'
    ? incomingEntry.accountScopeKey.trim()
    : null;
  const bRank = bScope ? Math.max(1, getAccountAttributionRank(baseEntry.accountAttributionConfidence)) : 0;
  const iRank = iScope ? Math.max(1, getAccountAttributionRank(incomingEntry.accountAttributionConfidence)) : 0;

  if (bScope && iScope) {
    if (bScope === iScope) {
      const winner = iRank >= bRank ? incomingEntry : baseEntry;
      return {
        accountScopeKey: bScope,
        accountAttributionConfidence: winner.accountAttributionConfidence || baseEntry.accountAttributionConfidence || incomingEntry.accountAttributionConfidence || 'live_confirmed_account',
        accountAttributionEvidence: winner.accountAttributionEvidence || baseEntry.accountAttributionEvidence || incomingEntry.accountAttributionEvidence || null,
        unattributedReason: null
      };
    }
    if (iRank > bRank) {
      return {
        accountScopeKey: iScope,
        accountAttributionConfidence: incomingEntry.accountAttributionConfidence,
        accountAttributionEvidence: incomingEntry.accountAttributionEvidence || null,
        unattributedReason: null
      };
    }
    if (bRank > iRank) {
      return {
        accountScopeKey: bScope,
        accountAttributionConfidence: baseEntry.accountAttributionConfidence,
        accountAttributionEvidence: baseEntry.accountAttributionEvidence || null,
        unattributedReason: null
      };
    }
    // 同一置信度指向不同账号时拒绝猜测，降级未归属冲突
    return {
      accountScopeKey: null,
      accountAttributionConfidence: 'unattributed',
      accountAttributionEvidence: null,
      unattributedReason: 'account_conflict'
    };
  }

  if (bScope && !iScope) {
    const baseIsHardBound = baseEntry.accountAttributionConfidence === 'explicit_account_email'
      || baseEntry.accountAttributionConfidence === 'keepalive_bound';
    if (!baseIsHardBound && incomingEntry.forceUnattributed && incomingEntry.unattributedReason) {
      return {
        accountScopeKey: null,
        accountAttributionConfidence: 'unattributed',
        accountAttributionEvidence: null,
        unattributedReason: incomingEntry.unattributedReason
      };
    }
    return {
      accountScopeKey: bScope,
      accountAttributionConfidence: baseEntry.accountAttributionConfidence || 'live_confirmed_account',
      accountAttributionEvidence: baseEntry.accountAttributionEvidence || null,
      unattributedReason: null
    };
  }

  if (!bScope && iScope) {
    return {
      accountScopeKey: iScope,
      accountAttributionConfidence: incomingEntry.accountAttributionConfidence || 'live_confirmed_account',
      accountAttributionEvidence: incomingEntry.accountAttributionEvidence || null,
      unattributedReason: null
    };
  }

  return {
    accountScopeKey: null,
    accountAttributionConfidence: 'unattributed',
    accountAttributionEvidence: incomingEntry.accountAttributionEvidence || baseEntry.accountAttributionEvidence || null,
    unattributedReason: incomingEntry.unattributedReason || baseEntry.unattributedReason || null
  };
}

function matchTimestampAgainstSessions(startMs, endMs, source, accountSessions = [], matchOpts = {}) {
  const normSource = String(source || 'desktop').toLowerCase();
  if (normSource === 'ide') {
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'unverified_source_ide' };
  }
  if (!Number.isFinite(startMs) || startMs <= 0) {
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'missing_request_timestamp' };
  }
  const rStart = Math.min(startMs, Number.isFinite(endMs) ? endMs : startMs);
  const rEnd = Math.max(startMs, Number.isFinite(endMs) ? endMs : startMs);
  const sessions = Array.isArray(accountSessions)
    ? accountSessions.filter(s => s && s.email && Number.isFinite(Number(s.startAtMs)))
    : [];
  if (!sessions.length) {
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'before_account_tracking' };
  }

  const openVerifiedMs = Number.isFinite(Number(matchOpts.openSessionVerifiedUntilMs))
    ? Number(matchOpts.openSessionVerifiedUntilMs)
    : 0;
  const openEmailNorm = typeof matchOpts.openSessionEmail === 'string'
    ? matchOpts.openSessionEmail.trim().toLowerCase()
    : '';

  const getSessionWinEnd = (s) => {
    const sStart = Number(s.startAtMs);
    const sLast = Number.isFinite(Number(s.lastVerifiedAtMs)) ? Number(s.lastVerifiedAtMs) : sStart;
    if (s.endAtMs != null) return Number(s.endAtMs) + 5000;
    const isMatchedOpen = openVerifiedMs > 0 && (!openEmailNorm || String(s.email).trim().toLowerCase() === openEmailNorm);
    const effLast = isMatchedOpen ? Math.max(sLast, sStart, openVerifiedMs) : Math.max(sLast, sStart);
    return effLast + 180000;
  };

  let earliestStart = Infinity;
  const matching = [];
  for (const s of sessions) {
    const sStart = Number(s.startAtMs);
    if (sStart < earliestStart) earliestStart = sStart;
    const winStart = sStart - 5000;
    const winEnd = getSessionWinEnd(s);
    if (rStart >= winStart && rEnd <= winEnd) {
      matching.push(s);
    }
  }
  if (matching.length > 0) {
    const distinct = new Set(matching.map(m => String(m.email).trim().toLowerCase()));
    if (distinct.size === 1) {
      const m = matching[0];
      return {
        accountScopeKey: isValidAccountScopeKey(m.accountScopeKey) ? m.accountScopeKey.trim() : buildAccountScopeKey(m.email),
        confidence: 'session_window_verified',
        evidence: m.evidence || 'host_user_status_window'
      };
    }
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'cross_switch_boundary' };
  }
  const touched = sessions.filter(s => {
    const sStart = Number(s.startAtMs);
    const winStart = sStart - 5000;
    const winEnd = getSessionWinEnd(s);
    return rEnd >= winStart && rStart <= winEnd;
  });
  if (touched.length > 0) {
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'cross_switch_boundary' };
  }
  if (rEnd < earliestStart - 5000) {
    return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'before_account_tracking' };
  }
  return { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'outside_verified_window' };
}

function resolveCallAccountAttribution(call, options = {}, existing = null) {
  if (call.accountAttributionConfidence === 'unattributed' && !call.accountEmail) {
    return {
      accountScopeKey: null,
      accountAttributionConfidence: 'unattributed',
      unattributedReason: call.unattributedReason || 'explicit_unattributed',
      forceUnattributed: Boolean(call.forceUnattributed)
    };
  }
  const explicitEmail = (typeof call.accountEmail === 'string' && call.accountEmail.includes('@'))
    ? call.accountEmail.trim().toLowerCase()
    : '';
  const explicitScope = isValidAccountScopeKey(call.accountScopeKey) ? call.accountScopeKey.trim() : null;
  const isHardBound = Boolean(explicitEmail || (explicitScope && (call.isKeepalive || call.accountAttributionConfidence === 'explicit_account_email' || call.accountAttributionConfidence === 'keepalive_bound')));
  if (isHardBound || (explicitScope && !Array.isArray(options.accountSessions))) {
    return {
      accountScopeKey: explicitScope || buildAccountScopeKey(explicitEmail),
      accountAttributionConfidence: call.accountAttributionConfidence || (call.isKeepalive ? 'keepalive_bound' : 'explicit_account_email'),
      accountAttributionEvidence: call.accountAttributionEvidence || (explicitEmail ? 'call_account_email' : 'call_account_scope_key'),
      unattributedReason: null
    };
  }

  const callSource = String(call.source || existing?.source || 'desktop').toLowerCase();
  if (Array.isArray(options.accountSessions)) {
    if (callSource === 'ide') {
      return {
        accountScopeKey: null,
        accountAttributionConfidence: 'unattributed',
        unattributedReason: 'unverified_source_ide',
        forceUnattributed: true
      };
    }
    // 优先采用非临时的权威请求时间戳（若入参为点开旧会话产生的 provisional 浏览记录，必须使用账本已有 existing 的权威时间）
    const callBounds = extractCallTimeBoundsMs(call);
    const existBounds = existing ? extractCallTimeBoundsMs(existing) : { startMs: null, endMs: null };
    const authBounds = callBounds.startMs != null ? callBounds : existBounds;
    const hasExactTs = authBounds.startMs != null;

    if (hasExactTs && options.accountSessions.length > 0) {
      const liveAcct = options.liveConfirmedAccount;
      const m = matchTimestampAgainstSessions(authBounds.startMs, authBounds.endMs, callSource, options.accountSessions, {
        openSessionEmail: liveAcct?.email || null,
        openSessionVerifiedUntilMs: liveAcct?.verifiedAtMs || null
      });
      if (m.accountScopeKey) {
        return {
          accountScopeKey: m.accountScopeKey,
          accountAttributionConfidence: m.confidence,
          accountAttributionEvidence: m.evidence || 'host_user_status_window',
          unattributedReason: null
        };
      }
      return {
        accountScopeKey: null,
        accountAttributionConfidence: 'unattributed',
        unattributedReason: m.unattributedReason || 'outside_verified_window',
        forceUnattributed: true
      };
    }

    if (hasExactTs && options.accountSessions.length === 0) {
      return {
        accountScopeKey: null,
        accountAttributionConfidence: 'unattributed',
        unattributedReason: 'before_account_tracking',
        forceUnattributed: true
      };
    }

    // 尚无 transcript 精确时间时：仅对前端明确确认为“会话水合后实时新产生/流式刚结束”的本机请求归入当前已验证活跃账号；
    // 点开历史旧会话首次水合出来的旧步骤严禁按当前登录账号猜测归属！
    const liveAcct = options.liveConfirmedAccount;
    const isOfflineScan = Boolean(options.trustTranscriptDate || call.fromTranscriptScan);
    if (!hasExactTs && !isOfflineScan && call.liveRealtimeConfirmed === true && callSource === 'desktop' && liveAcct && typeof liveAcct.email === 'string' && liveAcct.email.includes('@')) {
      const nowMs = Date.now();
      const verifiedAt = Number(liveAcct.verifiedAtMs) || nowMs;
      if (nowMs <= verifiedAt + 180000) {
        return {
          accountScopeKey: buildAccountScopeKey(liveAcct.email),
          accountAttributionConfidence: 'live_confirmed_account',
          accountAttributionEvidence: 'live_ipc_confirmed_account',
          unattributedReason: null
        };
      }
    }

    // 若既无精确时间也非实时确认新请求，保持现有有效归属或暂列未归属（等待 transcript 权威时间落盘裁决）
    if (existing && isValidAccountScopeKey(existing.accountScopeKey) && existing.accountAttributionConfidence !== 'unattributed') {
      return {
        accountScopeKey: existing.accountScopeKey.trim(),
        accountAttributionConfidence: existing.accountAttributionConfidence,
        accountAttributionEvidence: existing.accountAttributionEvidence || null,
        unattributedReason: null
      };
    }

    return {
      accountScopeKey: null,
      accountAttributionConfidence: 'unattributed',
      unattributedReason: 'pending_authoritative_timestamp'
    };
  }

  // 未提供 accountSessions 时：历史离线扫描严禁按当前账号强行归属；保留测试或明确传参兼容性
  if (options.trustTranscriptDate || call.fromTranscriptScan) {
    return {
      accountScopeKey: null,
      accountAttributionConfidence: 'unattributed',
      unattributedReason: 'history_scan_without_sessions'
    };
  }

  const fallbackEmail = (typeof options.confirmedAccountEmail === 'string' && options.confirmedAccountEmail.includes('@'))
    ? options.confirmedAccountEmail.trim().toLowerCase()
    : '';
  const fallbackScope = fallbackEmail
    ? buildAccountScopeKey(fallbackEmail)
    : (isValidAccountScopeKey(options.accountScopeKey) ? options.accountScopeKey.trim() : null);

  if (fallbackScope) {
    return {
      accountScopeKey: fallbackScope,
      accountAttributionConfidence: options.accountAttributionConfidence || 'live_confirmed_account',
      accountAttributionEvidence: options.accountAttributionEvidence || 'confirmed_account_email_option',
      unattributedReason: null
    };
  }

  return {
    accountScopeKey: null,
    accountAttributionConfidence: 'unattributed',
    unattributedReason: 'missing_account_context'
  };
}

function recordModelCalls(newCalls = [], options = {}) {
  if (!Array.isArray(newCalls) || !newCalls.length) return createRecordResult(true, false);
  const targetDir = typeof options === 'string' ? options : (options.ledgerPath || options.agDir);
  const fsOpt = (options && typeof options === 'object' && options.fs) ? { fs: options.fs } : undefined;
  const resolvedLedgerPath = path.resolve(getPricingLedgerPath(targetDir));

  const executeLocked = () => {
    // 持锁期间强制失效内存缓存，确保跨进程场景读到前一进程刚落盘的最新账本状态
    if (!fsOpt) {
      ledgerCacheByPath.delete(normalizeLedgerKey(resolvedLedgerPath));
    }
    const ledger = loadPricingLedger(targetDir, fsOpt);

    if (ledger.__corrupted || ledger.__unreadable) {
      const prefix = ledger.__corrupted
        ? '账本已损坏，阻止空覆盖'
        : `账本当前不可读 (${ledger.__error || 'I/O 异常'})，阻止覆盖`;
      return createRecordResult(
        false,
        false,
        `${prefix} (${ledger.__corruptedPath})`,
        ledger.__guardPhase || (ledger.__corrupted ? 'corrupted_guard' : 'unreadable_guard'),
        ledger.__code
      );
    }

    // 第一阶段：每条传入记录仅按自身 targetKey 入表或同键合并，避免逐条贪心跨键绑定引发输入顺序依赖
    const beforeCalls = ledger.calls || {};
    const draftCalls = { ...beforeCalls };

    for (const call of newCalls) {
      if (!call || !call.callId) continue;
      // 默认阻止测试样例和合成调用污染生产账本
      if (!options.allowSynthetic && isSyntheticCall(call.callId, call)) continue;

      const targetKey = String(call.callId);
      const incomingFallback = parseStepFallbackKey(targetKey, call.cascadeId);
      const callCidRaw = call.cascadeId || incomingFallback?.cascadeId;
      const existing = draftCalls[targetKey];

      // 严格账号归属：结合会话活跃时间窗或显式已核实账号，绝不把离线扫描旧记录或跨号边界错记到当前账号
      const attrRes = resolveCallAccountAttribution(call, options, existing);
      const resolvedScopeKey = attrRes.accountScopeKey;
      const resolvedAttrConf = attrRes.accountAttributionConfidence;
      const resolvedAttrEvidence = attrRes.accountAttributionEvidence || null;
      const resolvedUnattrReason = attrRes.unattributedReason || null;
      const callWithAttr = {
        ...call,
        ...(resolvedScopeKey ? { accountScopeKey: resolvedScopeKey } : {}),
        accountAttributionConfidence: resolvedAttrConf,
        ...(resolvedAttrEvidence ? { accountAttributionEvidence: resolvedAttrEvidence } : {}),
        ...(resolvedUnattrReason ? { unattributedReason: resolvedUnattrReason } : {}),
        ...(attrRes.forceUnattributed ? { forceUnattributed: true } : {})
      };
      if (!resolvedScopeKey) {
        delete callWithAttr.accountScopeKey;
      }

      if (!existing) {
        const normalizedStep = extractCallStepNumbers(callWithAttr, targetKey)[0] ?? null;
        const uInc = getCallTokenBreakdown(callWithAttr);
        const dInfo = extractNormalizedDateInfo(callWithAttr);
        const incRev = extractSourceRevision(callWithAttr);
        const nextEntry = {
          ...callWithAttr,
          callId: targetKey,
          ...(resolvedScopeKey ? { accountScopeKey: resolvedScopeKey } : {}),
          accountAttributionConfidence: resolvedAttrConf,
          ...(resolvedAttrEvidence ? { accountAttributionEvidence: resolvedAttrEvidence } : {}),
          ...(resolvedUnattrReason ? { unattributedReason: resolvedUnattrReason } : {}),
          ...(call.isKeepalive ? { isKeepalive: true } : {}),
          ...(callCidRaw && !call.cascadeId ? { cascadeId: callCidRaw } : {}),
          ...(normalizedStep !== null && call.stepIndex == null ? { stepIndex: normalizedStep } : {}),
          ...(call.totalTokens == null && uInc.tot > 0 ? { totalTokens: uInc.tot } : {}),
          ...(dInfo.date ? { date: dInfo.date } : {}),
          ...(dInfo.created_at ? { created_at: dInfo.created_at } : (dInfo.dateIsProvisional ? { created_at: null } : {})),
          ...(dInfo.dateSource ? { dateSource: dInfo.dateSource } : {}),
          dateIsProvisional: Boolean(dInfo.dateIsProvisional),
          ...(incRev !== null ? { sourceRevision: incRev } : {}),
          updatedAt: Date.now()
        };
        if (incRev === null) {
          delete nextEntry.sourceRevision;
        }
        if (dInfo.date && dInfo.date !== call.date) {
          const recalc = calculateRequestApiCost(nextEntry);
          if (recalc.isPriced) {
            nextEntry.modelKey = recalc.modelKey;
            nextEntry.isPriced = true;
            nextEntry.costUSD = recalc.costUSD ?? 0;
          }
        }
        draftCalls[targetKey] = nextEntry;
        continue;
      }

      const uExist = getCallTokenBreakdown(existing);
      const uCall = getCallTokenBreakdown(call);
      const usageCmp = compareCallUsage(uCall, uExist);
      const existRev = extractSourceRevision(existing);
      const callRev = extractSourceRevision(call);
      const revCmp = compareSourceRevision(callRev, existRev);
      const incomingIsStaleStatus = existing.status === 'final' && Boolean(call.status) && call.status !== 'final';
      const isUsageRollback = incomingIsStaleStatus || (existing.status === 'final' && usageCmp < 0);
      const existDateInfo = extractNormalizedDateInfo(existing);
      const callDateInfo = extractNormalizedDateInfo(call);
      const trustIncomingTranscriptDate = Boolean(options.trustTranscriptDate && callDateInfo.dateSource === 'transcript');
      const adoptIncomingSameRankDate = callDateInfo.rank >= 2 &&
        callDateInfo.rank === existDateInfo.rank &&
        shouldAdoptSameRankAuthDate(existing, call, existDateInfo, callDateInfo, usageCmp, revCmp, trustIncomingTranscriptDate);
      const sameRankAuthDateProgressed = adoptIncomingSameRankDate && (
        callDateInfo.date !== existDateInfo.date ||
        (callDateInfo.rank >= 3 && Boolean(callDateInfo.created_at) && callDateInfo.created_at !== existDateInfo.created_at)
      );
      const dateProgressed = (
        callDateInfo.rank > existDateInfo.rank ||
        sameRankAuthDateProgressed ||
        (existing.date && existDateInfo.date && existing.date !== existDateInfo.date)
      ) && Boolean(callDateInfo.date || existDateInfo.date);
      const stateProgressed = existing.status !== 'final' && call.status === 'final';
      const usageProgressed = !incomingIsStaleStatus && usageCmp > 0;
      const revisionUsageProgressed = !isUsageRollback && usageCmp === 0 && revCmp > 0 && (
        uCall.inp !== uExist.inp || uCall.cap !== uExist.cap || uCall.think !== uExist.think
      );
      const revisionMetaProgressed = !isUsageRollback && revCmp > 0 && callRev !== existRev;
      const modelProgressed = getCollectorModelRank(call.model) > getCollectorModelRank(existing.model);
      const speedProgressed = !hasSpeedMetrics(existing) && hasSpeedMetrics(call) && isValidSpeedSample(call);
      const modelExactProgressed = !existing.modelExactId && Boolean(call.modelExactId);
      const recalcExist = calculateRequestApiCost(existing);
      const costOutOfSync = Boolean(recalcExist.isPriced) !== Boolean(existing.isPriced)
        || (recalcExist.isPriced && Number(existing.costUSD || 0) !== Number(recalcExist.costUSD || 0));
      const pricingProgressed = costOutOfSync || ((!existing.isPriced || !existing.costUSD) && Boolean((call.isPriced && call.costUSD > 0) || normalizeModelId(call.model || existing.model)));
      const resolvedStepIndex = existing.stepIndex ?? call.stepIndex ?? extractCallStepNumbers(existing, targetKey)[0] ?? extractCallStepNumbers(call, targetKey)[0] ?? null;
      const existScopeClean = isValidAccountScopeKey(existing.accountScopeKey) && existing.accountAttributionConfidence !== 'unattributed'
        ? existing.accountScopeKey.trim()
        : null;
      const existRank = existScopeClean ? Math.max(1, getAccountAttributionRank(existing.accountAttributionConfidence)) : 0;
      const incRank = resolvedScopeKey ? Math.max(1, getAccountAttributionRank(resolvedAttrConf)) : 0;
      const existBaseHardBound = existing.accountAttributionConfidence === 'explicit_account_email'
        || existing.accountAttributionConfidence === 'keepalive_bound';
      const attributionProgressed = Boolean(
        (!existScopeClean && resolvedScopeKey)
        || (existScopeClean && resolvedScopeKey && existScopeClean === resolvedScopeKey && incRank > existRank)
        || (existScopeClean && resolvedScopeKey && existScopeClean !== resolvedScopeKey && incRank >= existRank)
        || (existScopeClean && !resolvedScopeKey && attrRes.forceUnattributed && !existBaseHardBound)
        || (!existScopeClean && !existing.unattributedReason && resolvedUnattrReason)
      );
      const metaProgressed = (existing.stepIndex == null && resolvedStepIndex != null) || (!existing.cascadeId && Boolean(callCidRaw)) || modelExactProgressed || attributionProgressed;

      if (modelProgressed || metaProgressed || dateProgressed || (!isUsageRollback && (stateProgressed || usageProgressed || revisionUsageProgressed || revisionMetaProgressed || pricingProgressed || speedProgressed))) {
        draftCalls[targetKey] = mergeSameCallRecords(
          existing,
          callWithAttr,
          targetKey,
          resolvedStepIndex,
          !isUsageRollback && revCmp >= 0,
          adoptIncomingSameRankDate
        );
      }
    }

    // 第二阶段：在完整候选集（既有记录 + 整批新入账记录）上统一执行无顺序依赖的充分证据跨键消解
    reconcileConfirmableDuplicateStepCalls(draftCalls);
    pruneExcessSpeedSamples(draftCalls);

    const changed = Boolean(ledger.__hadDuplicateStepKeys) || hasCallsMapChanged(beforeCalls, draftCalls);

    if (changed) {
      const draftLedger = {
        ...ledger,
        calls: draftCalls,
        updatedAt: new Date().toISOString()
      };
      const saveRes = savePricingLedger(draftLedger, targetDir, fsOpt);
      if (!saveRes.ok) {
        return createRecordResult(false, false, saveRes.error || '保存账本落盘失败', saveRes.phase, saveRes.code);
      }
      // 同步落盘物理隔离的分账号账本目录（account_ledgers/<accountScopeKey>.json 与 unattributed.json）
      if (!fsOpt || typeof fsOpt.fs?.writeFileSync === 'function') {
        try {
          syncAccountLedgerPartitions(resolvedLedgerPath, draftCalls, fsOpt?.fs || fs);
        } catch { }
      }
      // 账本变化时失效聚合热缓存（含按 agDir 隔离作用域的扫描缓存）
      cachedTokenHistoryAt = 0;
    }

    return createRecordResult(true, changed);
  };

  if (fsOpt) {
    return executeLocked();
  }
  return withFileLockSync(resolvedLedgerPath, executeLocked);
}

/**
 * 将账本 calls 按 accountScopeKey 严格拆分为独立账号分片与 unattributed.json
 * 不同账号数据绝不互相混合，未归属历史单独隔离。
 */
function syncAccountLedgerPartitions(resolvedLedgerPath, callsMap = {}, fsImpl = fs) {
  const partDir = path.join(path.dirname(resolvedLedgerPath), 'account_ledgers');
  if (!fsImpl.existsSync(partDir)) {
    fsImpl.mkdirSync(partDir, { recursive: true });
  }
  const buckets = new Map();
  buckets.set('unattributed', {});
  for (const [callId, rec] of Object.entries(callsMap || {})) {
    if (!rec || typeof rec !== 'object') continue;
    const rawKey = (typeof rec.accountScopeKey === 'string' && /^acct_[0-9a-f]{16}$/i.test(rec.accountScopeKey.trim()))
      ? rec.accountScopeKey.trim()
      : 'unattributed';
    if (!buckets.has(rawKey)) buckets.set(rawKey, {});
    buckets.get(rawKey)[callId] = rec;
  }
  const nowIso = new Date().toISOString();
  for (const [scopeKey, partCalls] of buckets.entries()) {
    const targetFile = path.join(partDir, `${scopeKey}.json`);
    const payload = JSON.stringify({
      version: 1,
      accountScopeKey: scopeKey,
      updatedAt: nowIso,
      callCount: Object.keys(partCalls).length,
      calls: partCalls
    });
    const tmp = `${targetFile}.${process.pid}.tmp`;
    fsImpl.writeFileSync(tmp, payload, 'utf8');
    fsImpl.renameSync(tmp, targetFile);
  }
  // 清理纠偏后已不再包含任何归属记录的陈旧 acct_*.json 分片文件，保证分片目录与主账本 100% 一致
  if (typeof fsImpl.readdirSync === 'function' && typeof fsImpl.unlinkSync === 'function') {
    try {
      for (const fName of fsImpl.readdirSync(partDir)) {
        if (!/^acct_[0-9a-f]{16}\.json$/i.test(fName)) continue;
        const sk = fName.slice(0, -5);
        if (!buckets.has(sk)) {
          fsImpl.unlinkSync(path.join(partDir, fName));
        }
      }
    } catch { }
  }
}

function accumulateDayBucket(map, dKey, u, tot, steps = 1) {
  if (!dKey) return;
  if (!map[dKey]) {
    map[dKey] = { input: 0, cache: 0, output: 0, total: 0, steps: 0 };
  }
  map[dKey].input += u.inp;
  map[dKey].cache += u.cap;
  map[dKey].output += u.out;
  map[dKey].total += tot;
  map[dKey].steps += steps;
}

function accumulateModelDayBucket(srcMap, dKey, vKey, u, tot, steps = 1) {
  if (!dKey || !vKey) return;
  if (!srcMap[dKey]) srcMap[dKey] = {};
  if (!srcMap[dKey][vKey]) {
    srcMap[dKey][vKey] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
  }
  srcMap[dKey][vKey].total += tot;
  srcMap[dKey][vKey].input += u.inp;
  srcMap[dKey][vKey].output += u.out;
  srcMap[dKey][vKey].cache += u.cap;
  srcMap[dKey][vKey].steps += steps;
}

function buildRefCostBundle(inp, outp, cap, tot, mInp, mOutp, mCap, mTot, costAll, costMonth) {
  return {
    all: calculateReferenceModelCost({ inputTokens: inp, outputTokens: outp, cacheTokens: cap, totalTokens: tot }, 'gemini-3.8-flash', { pricingDate: '2026-11-08', mode: 'all' }),
    currentMonth: calculateReferenceModelCost({ inputTokens: mInp, outputTokens: mOutp, cacheTokens: mCap, totalTokens: mTot }, 'gemini-3.8-flash', { pricingDate: '2026-11-08', mode: 'all' }),
    hybrid: calculateReferenceModelCost({ inputTokens: inp, outputTokens: outp, cacheTokens: cap, totalTokens: tot }, 'gemini-3.8-flash', {
      pricingDate: '2026-11-09',
      mode: 'unpriced_only',
      knownUsage: { byCategory: costAll?.byCategory, costUSD: costAll?.pricedCostUSD || 0 }
    }),
    currentMonthHybrid: calculateReferenceModelCost({ inputTokens: mInp, outputTokens: mOutp, cacheTokens: mCap, totalTokens: mTot }, 'gemini-3.8-flash', {
      pricingDate: '2026-11-09',
      mode: 'unpriced_only',
      knownUsage: { byCategory: costMonth?.byCategory, costUSD: costMonth?.pricedCostUSD || 0 }
    })
  };
}

/**
 * 构建严格的跨账号用量隔离统计：
 * - 只有带明确 accountScopeKey 且非 unattributed 的记录计入对应账号；
 * - 为每个账号完整生成 dailyMapBySource / dailyModelMapBySource / 费用 / 缓存 / 对话数，确保全界面任意筛选项严密同步；
 * - 未归属记录与旧档案按照「全量 - 已归属各账号总和」精确对账并入 unattributed，绝不默认算给当前账号。
 * - 保活请求 (isKeepalive: true) 计入对应账号同时提供独立统计 keepaliveStats。
 */
function buildAccountUsageBreakdown({
  finalCallsEntries = [],
  resolveLedgerCallDate = (k, c) => c?.date || null,
  dailyMapAll = {},
  mergedDesktop = {},
  mergedCli = {},
  mergedLegacyUnallocated = {},
  dailyModelMapBySource = null,
  modelMetaByKey = {},
  compactModelConfigs = [],
  availableModelDetails = null,
  totalConversationsAll = 0,
  unpricedSummaryBySource = null,
  now = new Date()
} = {}) {
  const todayKey = formatLocalDateKey(now);
  const monthPrefix = todayKey.slice(0, 7);
  const yearPrefix = todayKey.slice(0, 4);

  const ensureAcct = (scopeKey) => ({
    accountScopeKey: scopeKey,
    totalTokens: 0,
    totalInputTokens: 0,
    totalCacheTokens: 0,
    totalOutputTokens: 0,
    todayTokens: 0,
    monthTokens: 0,
    yearTokens: 0,
    currentMonthInput: 0,
    currentMonthCache: 0,
    currentMonthOutput: 0,
    callCount: 0,
    totalSteps: 0,
    totalConversations: 0,
    activeDaysCount: 0,
    firstUseDate: null,
    keepaliveRequests: 0,
    keepaliveTokens: 0,
    sources: { desktop: 0, cli: 0, agent: 0, ide: 0 },
    dailyMap: {},
    dailyMapBySource: { all: {}, desktop: {}, cli: {}, legacyUnallocated: {} },
    dailyModelMapBySource: { all: {}, desktop: {}, cli: {} },
    modelMetaByKey: {},
    _convIds: new Set(),
    _cacheItems: [],
    _monthCacheItems: [],
    _calls: [],
    _monthCalls: [],
    _desktopCalls: [],
    _cliCalls: []
  });

  const byAccount = {};
  const unattributedCallsMap = new Map();
  const attributedByDayAll = {};
  const attributedByDayDesktop = {};
  const attributedByDayCli = {};
  const attributedModelByDay = { all: {}, desktop: {}, cli: {} };
  const attributedConvIds = new Set();
  const bucketMemo = new Map();

  const resolveCallModelBucket = (callObj) => {
    const memoKey = `${callObj.model || ''}\0${callObj.modelExactId || ''}\0${callObj.modelLabel || ''}\0${callObj.effort || ''}`;
    let bucket = bucketMemo.get(memoKey);
    if (!bucket) {
      bucket = resolveModelUsageBucket(callObj, compactModelConfigs, availableModelDetails);
      if (bucketMemo.size < 2000) bucketMemo.set(memoKey, bucket);
    }
    return bucket;
  };

  for (const [ledgerKey, call] of (Array.isArray(finalCallsEntries) ? finalCallsEntries : [])) {
    if (!call || typeof call !== 'object') continue;
    const scopeKey = (typeof call.accountScopeKey === 'string' && SCOPE_KEY_REGEX.test(call.accountScopeKey.trim()) && call.accountAttributionConfidence !== 'unattributed')
      ? call.accountScopeKey.trim()
      : 'unattributed';
    const dKey = resolveLedgerCallDate(ledgerKey, call) || todayKey;
    const u = getCallTokenBreakdown(call);
    const tot = u.tot || (u.inp + u.cap + u.out);
    if (tot <= 0 && !call.isKeepalive) continue;

    if (scopeKey === 'unattributed') {
      unattributedCallsMap.set(ledgerKey, { call, dKey, u, tot });
      continue;
    }

    if (!byAccount[scopeKey]) byAccount[scopeKey] = ensureAcct(scopeKey);
    const acc = byAccount[scopeKey];
    acc.callCount += 1;
    acc.totalSteps += 1;
    acc.totalInputTokens += u.inp;
    acc.totalCacheTokens += u.cap;
    acc.totalOutputTokens += u.out;
    acc.totalTokens += tot;
    if (!acc.firstUseDate || dKey < acc.firstUseDate) acc.firstUseDate = dKey;
    if (dKey === todayKey) acc.todayTokens += tot;
    if (dKey.startsWith(monthPrefix)) {
      acc.monthTokens += tot;
      acc.currentMonthInput += u.inp;
      acc.currentMonthCache += u.cap;
      acc.currentMonthOutput += u.out;
      acc._monthCacheItems.push({ inputTokens: u.inp, cacheReadTokens: u.cap, outputTokens: u.out, totalTokens: tot, hasInputCacheFields: true });
      acc._monthCalls.push(call);
    }
    if (dKey.startsWith(yearPrefix)) acc.yearTokens += tot;
    if (call.isKeepalive) {
      acc.keepaliveRequests += 1;
      acc.keepaliveTokens += tot;
    }

    const roleSrc = call.agentRole === 'subagent' ? 'agent' : (call.source === 'cli' ? 'cli' : (call.source === 'ide' ? 'ide' : 'desktop'));
    acc.sources[roleSrc] = (acc.sources[roleSrc] || 0) + 1;

    const srcKey = call.source === 'cli' ? 'cli' : 'desktop';
    const convKey = call.cascadeId ? `${srcKey}:${String(call.cascadeId).toLowerCase()}` : `call:${ledgerKey}`;
    acc._convIds.add(convKey);
    attributedConvIds.add(convKey);

    accumulateDayBucket(acc.dailyMap, dKey, u, tot, 1);
    accumulateDayBucket(acc.dailyMapBySource.all, dKey, u, tot, 1);
    accumulateDayBucket(acc.dailyMapBySource[srcKey], dKey, u, tot, 1);
    accumulateDayBucket(attributedByDayAll, dKey, u, tot, 1);
    accumulateDayBucket(srcKey === 'cli' ? attributedByDayCli : attributedByDayDesktop, dKey, u, tot, 1);

    const bucket = resolveCallModelBucket(call);
    const vKey = bucket.variantKey || UNATTRIBUTED_MODEL_KEY;
    if (bucket.isAttributed && vKey !== UNATTRIBUTED_MODEL_KEY) {
      acc.modelMetaByKey[vKey] = modelMetaByKey[vKey] || {
        modelKey: bucket.modelKey,
        modelLabel: bucket.modelLabel,
        variantKey: vKey,
        variantLabel: bucket.variantLabel
      };
    }
    accumulateModelDayBucket(acc.dailyModelMapBySource.all, dKey, vKey, u, tot, 1);
    accumulateModelDayBucket(acc.dailyModelMapBySource[srcKey], dKey, vKey, u, tot, 1);
    accumulateModelDayBucket(attributedModelByDay.all, dKey, vKey, u, tot, 1);
    accumulateModelDayBucket(attributedModelByDay[srcKey], dKey, vKey, u, tot, 1);

    acc._cacheItems.push({ inputTokens: u.inp, cacheReadTokens: u.cap, outputTokens: u.out, totalTokens: tot, hasInputCacheFields: true });
    acc._calls.push(call);
    if (srcKey === 'cli') acc._cliCalls.push(call);
    else acc._desktopCalls.push(call);
  }

  for (const acc of Object.values(byAccount)) {
    acc.activeDaysCount = Object.keys(acc.dailyMap).length;
    acc.totalConversations = acc._convIds.size;
    acc.cacheReadStats = summarizeCacheReadStats(acc._cacheItems);
    acc.currentMonthCacheReadStats = summarizeCacheReadStats(acc._monthCacheItems);
    acc.cacheReadStatsBySource = {
      all: acc.cacheReadStats,
      desktop: summarizeDailyMapCacheStats(acc.dailyMapBySource.desktop),
      cli: summarizeDailyMapCacheStats(acc.dailyMapBySource.cli)
    };
    acc.currentMonthCacheReadStatsBySource = {
      all: acc.currentMonthCacheReadStats,
      desktop: summarizeDailyMapCacheStats(acc.dailyMapBySource.desktop, monthPrefix),
      cli: summarizeDailyMapCacheStats(acc.dailyMapBySource.cli, monthPrefix)
    };
    acc.costEstimate = summarizeApiCost(acc._calls, 0, {}, 0);
    acc.costEstimateCurrentMonth = summarizeApiCost(acc._monthCalls, 0, {}, 0);
    acc.costEstimateBySource = {
      all: acc.costEstimate,
      desktop: summarizeApiCost(acc._desktopCalls, 0, {}, 0),
      cli: summarizeApiCost(acc._cliCalls, 0, {}, 0)
    };
    acc.referenceCost = buildRefCostBundle(
      acc.totalInputTokens, acc.totalOutputTokens, acc.totalCacheTokens, acc.totalTokens,
      acc.currentMonthInput, acc.currentMonthOutput, acc.currentMonthCache, acc.monthTokens,
      acc.costEstimate, acc.costEstimateCurrentMonth
    );
    delete acc._convIds;
    delete acc._cacheItems;
    delete acc._monthCacheItems;
    delete acc._calls;
    delete acc._monthCalls;
    delete acc._desktopCalls;
    delete acc._cliCalls;
  }

  // 构建严格“未归属历史”视图：严格遵循「全量 - SUM(已归属账号)」守恒公式
  const unattributed = ensureAcct('unattributed');
  unattributed.unattributedReasonCounts = {};
  unattributed.unattributedReasonTokens = {};

  const subtractSourceDailyMap = (fullMap, attrMap, targetMap) => {
    for (const [dKey, rec] of Object.entries(fullMap || {})) {
      if (!rec || typeof rec !== 'object') continue;
      const attr = attrMap[dKey] || { input: 0, cache: 0, output: 0, total: 0, steps: 0 };
      const remInp = Math.max(0, Number(rec.input || 0) - attr.input);
      const remCap = Math.max(0, Number(rec.cache || 0) - attr.cache);
      const remOut = Math.max(0, Number(rec.output || 0) - attr.output);
      const remTot = Math.max(0, Number(rec.total || 0) - attr.total);
      const remSteps = Math.max(0, Number(rec.steps || rec.conversations || 0) - attr.steps);
      if (remTot <= 0 && remSteps <= 0) continue;
      targetMap[dKey] = { input: remInp, cache: remCap, output: remOut, total: remTot, steps: remSteps };
    }
  };

  subtractSourceDailyMap(dailyMapAll, attributedByDayAll, unattributed.dailyMap);
  unattributed.dailyMapBySource.all = unattributed.dailyMap;
  subtractSourceDailyMap(mergedDesktop, attributedByDayDesktop, unattributed.dailyMapBySource.desktop);
  subtractSourceDailyMap(mergedCli, attributedByDayCli, unattributed.dailyMapBySource.cli);
  unattributed.dailyMapBySource.legacyUnallocated = { ...(mergedLegacyUnallocated || {}) };

  for (const [dKey, rec] of Object.entries(unattributed.dailyMap)) {
    if (!unattributed.firstUseDate || dKey < unattributed.firstUseDate) unattributed.firstUseDate = dKey;
    unattributed.totalInputTokens += rec.input;
    unattributed.totalCacheTokens += rec.cache;
    unattributed.totalOutputTokens += rec.output;
    unattributed.totalTokens += rec.total;
    unattributed.callCount += rec.steps;
    unattributed.totalSteps += rec.steps;
    if (dKey === todayKey) unattributed.todayTokens += rec.total;
    if (dKey.startsWith(monthPrefix)) {
      unattributed.monthTokens += rec.total;
      unattributed.currentMonthInput += rec.input;
      unattributed.currentMonthCache += rec.cache;
      unattributed.currentMonthOutput += rec.output;
    }
    if (dKey.startsWith(yearPrefix)) unattributed.yearTokens += rec.total;
  }

  const subtractSourceModelMap = (srcName, authDailyMap) => {
    const fullSrcModel = dailyModelMapBySource?.[srcName] || {};
    const attrSrcModel = attributedModelByDay[srcName] || {};
    const out = {};
    for (const [dKey, authRec] of Object.entries(authDailyMap || {})) {
      if (!authRec || authRec.total <= 0) continue;
      const fullDay = fullSrcModel[dKey] || {};
      const attrDay = attrSrcModel[dKey] || {};
      const dayOut = {};
      let sumTot = 0, sumInp = 0, sumCap = 0, sumOut = 0, sumSteps = 0;
      for (const [vKey, fRec] of Object.entries(fullDay)) {
        const aRec = attrDay[vKey] || { total: 0, input: 0, cache: 0, output: 0, steps: 0 };
        const rTot = Math.max(0, Number(fRec.total || 0) - aRec.total);
        if (rTot <= 0) continue;
        const rInp = Math.max(0, Number(fRec.input || 0) - aRec.input);
        const rCap = Math.max(0, Number(fRec.cache || 0) - aRec.cache);
        const rOut = Math.max(0, Number(fRec.output || 0) - aRec.output);
        const rStp = Math.max(0, Number(fRec.steps || 0) - aRec.steps);
        dayOut[vKey] = { total: rTot, input: rInp, output: rOut, cache: rCap, steps: rStp };
        if (modelMetaByKey?.[vKey]) unattributed.modelMetaByKey[vKey] = modelMetaByKey[vKey];
        sumTot += rTot; sumInp += rInp; sumCap += rCap; sumOut += rOut; sumSteps += rStp;
      }
      const diffTot = Math.max(0, authRec.total - sumTot);
      if (diffTot > 0) {
        if (!dayOut[UNATTRIBUTED_MODEL_KEY]) {
          dayOut[UNATTRIBUTED_MODEL_KEY] = { total: 0, input: 0, output: 0, cache: 0, steps: 0 };
        }
        dayOut[UNATTRIBUTED_MODEL_KEY].total += diffTot;
        dayOut[UNATTRIBUTED_MODEL_KEY].input += Math.max(0, authRec.input - sumInp);
        dayOut[UNATTRIBUTED_MODEL_KEY].cache += Math.max(0, authRec.cache - sumCap);
        dayOut[UNATTRIBUTED_MODEL_KEY].output += Math.max(0, authRec.output - sumOut);
        dayOut[UNATTRIBUTED_MODEL_KEY].steps += Math.max(0, authRec.steps - sumSteps);
      }
      if (Object.keys(dayOut).length > 0) out[dKey] = dayOut;
    }
    unattributed.dailyModelMapBySource[srcName] = out;
  };
  subtractSourceModelMap('all', unattributed.dailyMapBySource.all);
  subtractSourceModelMap('desktop', unattributed.dailyMapBySource.desktop);
  subtractSourceModelMap('cli', unattributed.dailyMapBySource.cli);

  const unattrCalls = [], unattrMonthCalls = [], unattrDesktopCalls = [], unattrCliCalls = [];
  for (const { call, dKey, tot } of unattributedCallsMap.values()) {
    const reason = call.unattributedReason || (call.source === 'ide' ? 'unverified_source_ide' : 'before_account_tracking');
    unattributed.unattributedReasonCounts[reason] = (unattributed.unattributedReasonCounts[reason] || 0) + 1;
    unattributed.unattributedReasonTokens[reason] = (unattributed.unattributedReasonTokens[reason] || 0) + tot;
    unattrCalls.push(call);
    if (dKey.startsWith(monthPrefix)) unattrMonthCalls.push(call);
    if (call.source === 'cli') unattrCliCalls.push(call);
    else unattrDesktopCalls.push(call);
  }

  unattributed.activeDaysCount = Object.keys(unattributed.dailyMap).length;
  unattributed.totalConversations = Math.max(0, (Number(totalConversationsAll) || unattributed.activeDaysCount) - attributedConvIds.size);
  unattributed.cacheReadStats = summarizeDailyMapCacheStats(unattributed.dailyMap);
  unattributed.currentMonthCacheReadStats = summarizeDailyMapCacheStats(unattributed.dailyMap, monthPrefix);
  unattributed.cacheReadStatsBySource = {
    all: unattributed.cacheReadStats,
    desktop: summarizeDailyMapCacheStats(unattributed.dailyMapBySource.desktop),
    cli: summarizeDailyMapCacheStats(unattributed.dailyMapBySource.cli)
  };
  unattributed.currentMonthCacheReadStatsBySource = {
    all: unattributed.currentMonthCacheReadStats,
    desktop: summarizeDailyMapCacheStats(unattributed.dailyMapBySource.desktop, monthPrefix),
    cli: summarizeDailyMapCacheStats(unattributed.dailyMapBySource.cli, monthPrefix)
  };
  unattributed.costEstimate = summarizeApiCost(
    unattrCalls,
    unpricedSummaryBySource?.all?.count || 0,
    unpricedSummaryBySource?.all?.reasons || {},
    unpricedSummaryBySource?.all?.tokens || 0
  );
  unattributed.costEstimateCurrentMonth = summarizeApiCost(
    unattrMonthCalls,
    unpricedSummaryBySource?.currentMonth?.count || 0,
    unpricedSummaryBySource?.currentMonth?.reasons || {},
    unpricedSummaryBySource?.currentMonth?.tokens || 0
  );
  unattributed.costEstimateBySource = {
    all: unattributed.costEstimate,
    desktop: summarizeApiCost(
      unattrDesktopCalls,
      unpricedSummaryBySource?.desktop?.count || 0,
      unpricedSummaryBySource?.desktop?.reasons || {},
      unpricedSummaryBySource?.desktop?.tokens || 0
    ),
    cli: summarizeApiCost(
      unattrCliCalls,
      unpricedSummaryBySource?.cli?.count || 0,
      unpricedSummaryBySource?.cli?.reasons || {},
      unpricedSummaryBySource?.cli?.tokens || 0
    )
  };
  unattributed.referenceCost = buildRefCostBundle(
    unattributed.totalInputTokens, unattributed.totalOutputTokens, unattributed.totalCacheTokens, unattributed.totalTokens,
    unattributed.currentMonthInput, unattributed.currentMonthOutput, unattributed.currentMonthCache, unattributed.monthTokens,
    unattributed.costEstimate, unattributed.costEstimateCurrentMonth
  );
  delete unattributed._convIds;
  delete unattributed._cacheItems;
  delete unattributed._monthCacheItems;
  delete unattributed._calls;
  delete unattributed._monthCalls;
  delete unattributed._desktopCalls;
  delete unattributed._cliCalls;

  return {
    byAccount,
    unattributed
  };
}

const CURRENT_ATTRIBUTION_REPAIR_VERSION = 'elv89-v3';

/**
 * 幂等账本账号归属迁移与纠偏：
 * - 先对原 pricing_ledger_v1.json 做 .bak 备份；
 * - 对带有精确时间戳且落在单一已核实 accountSessions 窗口内的记录准确归属；
 * - 剥离早于追踪起点、缺时间戳、IDE 未核实或跨切号边界却被错误标为当前账号的 accountScopeKey；
 * - 写入 attributionRepairVersion: CURRENT_ATTRIBUTION_REPAIR_VERSION，多次执行保持幂等不重复计数。
 */
function repairAndMigrateAccountLedger({
  agDir = null,
  ledgerPath = null,
  accountSessions = [],
  force = false,
  dryRun = false,
  backupSuffix = null
} = {}) {
  const targetDir = ledgerPath || agDir;
  const resolvedLedgerPath = path.resolve(getPricingLedgerPath(targetDir));

  const runLocked = () => {
    ledgerCacheByPath.delete(normalizeLedgerKey(resolvedLedgerPath));
    const ledger = loadPricingLedger(targetDir);
    if (!ledger || ledger.__corrupted || ledger.__unreadable) {
      return { ok: false, error: ledger?.__error || '账本不可读或已损坏' };
    }
    const calls = ledger.calls || {};
    const nextCalls = { ...calls };

    const summarizeCounts = (map) => {
      const counts = { total: 0, attributed: {}, unattributed: 0 };
      for (const rec of Object.values(map)) {
        if (!rec || typeof rec !== 'object') continue;
        counts.total += 1;
        const sk = isValidAccountScopeKey(rec.accountScopeKey) && rec.accountAttributionConfidence !== 'unattributed'
          ? rec.accountScopeKey.trim()
          : null;
        if (sk) counts.attributed[sk] = (counts.attributed[sk] || 0) + 1;
        else counts.unattributed += 1;
      }
      return counts;
    };

    const before = summarizeCounts(calls);
    let updatedCount = 0;
    let clearedCount = 0;
    let attributedOrFixedCount = 0;
    const unattributedReasons = {};

    for (const [k, rec] of Object.entries(calls)) {
      if (!rec || typeof rec !== 'object') continue;
      if (!force && rec.attributionRepairVersion === CURRENT_ATTRIBUTION_REPAIR_VERSION) continue;

      const copy = { ...rec };
      const curScope = isValidAccountScopeKey(copy.accountScopeKey) && copy.accountAttributionConfidence !== 'unattributed'
        ? copy.accountScopeKey.trim()
        : null;

      // 保护极近期（3分钟内）实时确认的新增调用，避免在 transcript 落盘前或窗口同步间隙被误清除（不写入修复版本号以便稳定后复核）
      if (copy.accountAttributionConfidence === 'live_confirmed_account' && curScope && !force) {
        const obsMs = Number(copy.liveObservedAtMs) || (copy.updatedAt ? Date.parse(copy.updatedAt) : NaN) || Number(copy.timestamp);
        if (Number.isFinite(obsMs) && (Date.now() - obsMs) >= 0 && (Date.now() - obsMs) < 180000) {
          nextCalls[k] = copy;
          continue;
        }
      }

      // 显式保留用户/实验硬绑定的账号记录（keepalive / explicit email），其余均依据权威时间戳严格复核
      if (copy.isKeepalive && curScope && copy.accountAttributionConfidence === 'keepalive_bound') {
        copy.attributionRepairVersion = CURRENT_ATTRIBUTION_REPAIR_VERSION;
        nextCalls[k] = copy;
        continue;
      }
      if (copy.accountEmail && typeof copy.accountEmail === 'string' && copy.accountEmail.includes('@')) {
        copy.accountScopeKey = buildAccountScopeKey(copy.accountEmail);
        copy.accountAttributionConfidence = 'explicit_account_email';
        copy.accountAttributionEvidence = copy.accountAttributionEvidence || 'call_account_email';
        delete copy.unattributedReason;
        copy.attributionRepairVersion = CURRENT_ATTRIBUTION_REPAIR_VERSION;
        nextCalls[k] = copy;
        if (curScope !== copy.accountScopeKey) updatedCount++;
        continue;
      }

      const { startMs, endMs } = extractCallTimeBoundsMs(copy);
      const src = String(copy.source || 'desktop').toLowerCase();
      let verdict;
      if (src === 'ide') {
        verdict = { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'unverified_source_ide' };
      } else if (startMs != null) {
        verdict = matchTimestampAgainstSessions(startMs, endMs, src, accountSessions);
      } else {
        verdict = { accountScopeKey: null, confidence: 'unattributed', unattributedReason: 'missing_request_timestamp' };
      }

      if (verdict.accountScopeKey) {
        if (curScope !== verdict.accountScopeKey || copy.accountAttributionConfidence !== 'repaired_session_window') {
          attributedOrFixedCount += 1;
          updatedCount += 1;
        }
        copy.accountScopeKey = verdict.accountScopeKey;
        copy.accountAttributionConfidence = 'repaired_session_window';
        copy.accountAttributionEvidence = verdict.evidence || 'session_window_repair';
        delete copy.unattributedReason;
      } else {
        if (curScope) {
          clearedCount += 1;
          updatedCount += 1;
        } else if (copy.accountAttributionConfidence !== 'unattributed' || !copy.unattributedReason) {
          updatedCount += 1;
        }
        delete copy.accountScopeKey;
        copy.accountAttributionConfidence = 'unattributed';
        copy.unattributedReason = verdict.unattributedReason || 'before_account_tracking';
        delete copy.accountAttributionEvidence;
        unattributedReasons[copy.unattributedReason] = (unattributedReasons[copy.unattributedReason] || 0) + 1;
      }
      copy.attributionRepairVersion = CURRENT_ATTRIBUTION_REPAIR_VERSION;
      nextCalls[k] = copy;
    }

    const after = summarizeCounts(nextCalls);
    let backupPath = null;
    if (!dryRun && fs.existsSync(resolvedLedgerPath)) {
      const tsTag = backupSuffix || `${Date.now()}`;
      backupPath = `${resolvedLedgerPath}.bak-pre-elv89-${tsTag}`;
      fs.copyFileSync(resolvedLedgerPath, backupPath);
    }

    if (!dryRun && (updatedCount > 0 || force)) {
      const draftLedger = {
        ...ledger,
        calls: nextCalls,
        updatedAt: new Date().toISOString()
      };
      const saveRes = savePricingLedger(draftLedger, targetDir);
      if (!saveRes.ok) {
        return { ok: false, error: saveRes.error || '修复后账本保存失败', backupPath };
      }
      try {
        syncAccountLedgerPartitions(resolvedLedgerPath, nextCalls, fs);
      } catch { }
      cachedTokenHistoryAt = 0;
    }

    return {
      ok: true,
      dryRun: Boolean(dryRun),
      ledgerPath: resolvedLedgerPath,
      backupPath,
      updatedCount,
      clearedCount,
      attributedOrFixedCount,
      unattributedReasons,
      before,
      after
    };
  };

  return withFileLockSync(resolvedLedgerPath, runLocked);
}

/**
 * 查询某账号在某模型共享池与指定时间区间内的本地实测消耗（专供 ELV-57 配额变化对照使用）
 */
function summarizeAccountWindowUsage({ agDir, ledgerPath, accountScopeKey, poolKey, startMs, endMs } = {}) {
  const targetDir = ledgerPath || agDir;
  const ledger = loadPricingLedger(targetDir);
  const calls = ledger?.calls && typeof ledger.calls === 'object' ? Object.values(ledger.calls) : [];
  const start = Number(startMs) || 0;
  const end = Number(endMs) || Date.now();
  let requestCount = 0;
  let uncachedInputTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let keepaliveRequests = 0;
  let keepaliveTokens = 0;

  for (const call of calls) {
    if (!call || typeof call !== 'object') continue;
    if (accountScopeKey && call.accountScopeKey !== accountScopeKey) continue;
    if (call.accountAttributionConfidence === 'unattributed') continue;
    const ts = getCallSortTimestamp(call) ?? Number(call.timestamp) ?? (call.created_at ? Date.parse(call.created_at) : NaN);
    if (!Number.isFinite(ts) || ts < start || ts > end) continue;
    if (poolKey) {
      const rawModel = call.modelExactId || extractModelString(call) || call.model || '';
      const sharedKey = typeof getSharedQuotaGroupKey === 'function' ? getSharedQuotaGroupKey(rawModel || call.modelLabel || '') : null;
      const singlePoolKey = typeof getModelPoolKey === 'function' ? getModelPoolKey(rawModel, call.modelLabel || '') : null;
      if (sharedKey !== poolKey && singlePoolKey !== poolKey) continue;
    }
    const u = getCallTokenBreakdown(call);
    const tot = u.tot || (u.inp + u.cap + u.out);
    requestCount += 1;
    uncachedInputTokens += u.inp;
    cacheReadTokens += u.cap;
    outputTokens += u.out;
    totalTokens += tot;
    if (call.isKeepalive) {
      keepaliveRequests += 1;
      keepaliveTokens += tot;
    }
  }

  return {
    requestCount,
    uncachedInputTokens,
    cacheReadTokens,
    outputTokens,
    totalTokens,
    keepaliveRequests,
    keepaliveTokens
  };
}
