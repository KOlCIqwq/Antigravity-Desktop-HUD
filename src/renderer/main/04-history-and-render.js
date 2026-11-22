  // =========================================================================
  // 模块 4: 数据渲染、完整本地 Token 历史读取与首次使用日起算时间轴
  // =========================================================================
  function renderFiles(session) {
    const parent = el('files');
    if (!parent) return;
    if (!session) {
      const sig = `none|${currentPanelLanguage}`;
      if (parent._lastRenderSig === sig) return;
      parent._lastRenderSig = sig;
      const item = document.createElement('p');
      item.textContent = t('files.reading');
      parent.replaceChildren(item);
      return;
    }
    if (!Array.isArray(session.attachments) || !session.attachments.length) {
      const sig = `empty|${currentPanelLanguage}`;
      if (parent._lastRenderSig === sig) return;
      parent._lastRenderSig = sig;
      const item = document.createElement('p');
      item.textContent = t('files.empty');
      parent.replaceChildren(item);
      return;
    }
    const filesSig = `${currentPanelLanguage}|` + session.attachments.map(file =>
      `${file.name}|${file.references}|${file.width || 0}x${file.height || 0}|${file.chars || 0}|${file.sheets ?? ''}|${file.cells || 0}|${file.hiddenSheets || 0}|${file.source || ''}|${range(file) || ''}|${(file.unknownParts || []).join(',')}`
    ).join(';');
    if (parent._lastRenderSig === filesSig) return;
    parent._lastRenderSig = filesSig;

    const nodes = [];
    for (const file of session.attachments) {
      const item = document.createElement('div'); item.className = 'file';
      const name = document.createElement('div'); name.className = 'file-name'; name.textContent = `${file.name} ${file.references > 1 ? t('files.refs', { n: file.references }) : ''}`;
      const detail = document.createElement('div'); detail.className = 'file-detail';
      const sizeInfo = file.width && file.height
        ? t('files.px', { w: file.width, h: file.height })
        : (typeof file.chars === 'number' && file.chars > 0 ? t('files.chars', { n: fmt(file.chars) }) : '');
      const tokenInfo = range(file) ? `${range(file)} token` : t('files.tokUnknown');
      const sheetsPart = file.sheets != null ? t('files.sheets', { sheets: file.sheets, cells: fmt(file.cells) }) : '';
      const hiddenPart = file.hiddenSheets ? t('files.hiddenSheets', { n: file.hiddenSheets }) : '';
      detail.textContent = `${file.source === 'assistant' ? t('files.assistantPrefix') : ''}${tokenInfo}${sizeInfo ? ` · ${sizeInfo}` : ''}${sheetsPart}${hiddenPart}`;
      item.appendChild(name); item.appendChild(detail);
      if (file.unknownParts?.length) { const unknown = document.createElement('div'); unknown.className = 'file-unknown'; unknown.textContent = t('files.unknownPrefix', { parts: file.unknownParts.join('；') }); item.appendChild(unknown); }
      nodes.push(item);
    }
    const outerPanel = el('panel');
    const prevPanelScrollTop = (outerPanel && typeof outerPanel.scrollTop === 'number') ? outerPanel.scrollTop : 0;
    parent.replaceChildren();
    for (const n of nodes) parent.appendChild(n);
    if (outerPanel && prevPanelScrollTop > 0 && Math.abs((outerPanel.scrollTop || 0) - prevPanelScrollTop) > 1) {
      outerPanel.scrollTop = prevPanelScrollTop;
    }
  }

  function setHoverExtra(text) {
    const extra = el('hover-extra');
    if (extra && extra.textContent !== text) {
      extra.textContent = text;
    }
  }

  function fmtYi(n) {
    if (!n || n <= 0) return '0';
    if (n >= 1e9) return `${parseFloat((n / 1e9).toFixed(2))}B`;
    if (n >= 1e6) return `${parseFloat((n / 1e6).toFixed(2))}M`;
    if (n >= 1e3) return `${parseFloat((n / 1e3).toFixed(1))}K`;
    return n.toLocaleString('en-US');
  }

  function getLvl(t) {
    if (!t || t <= 0) return 0;
    if (t < 3e6) return 1;
    if (t < 15e6) return 2;
    if (t < 60e6) return 3;
    return 4;
  }

  function parseLocalYmd(ymd) {
    if (!ymd || typeof ymd !== 'string') return null;
    const m = ymd.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function formatLocalYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function formatDotYmd(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}.${m}.${day}`;
  }

  function formatZhYmd(ymd) {
    const d = parseLocalYmd(ymd);
    if (!d) return ymd || '—';
    if (currentPanelLanguage === 'en') {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function addDays(baseDate, deltaDays) {
    const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
    d.setDate(d.getDate() + deltaDays);
    return d;
  }

  function getFirstUseDateStr() {
    const map = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const keys = Object.keys(map).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && (map[k]?.total > 0)).sort();
    const isScopedView = activeTokenAccountFilter !== 'all' || activeTokenSource !== 'all';
    if (isScopedView) {
      return keys.length ? keys[0] : null;
    }
    const declared = ANTIGRAVITY_TOKEN_DATA.firstUseDate;
    if (declared && /^\d{4}-\d{2}-\d{2}$/.test(declared)) {
      if (keys.length && keys[0] < declared) return keys[0];
      return declared;
    }
    if (keys.length) return keys[0];
    return null;
  }

  // 计算从「实际首次使用日」起算的 12 个月（52 周 = 364 天）展示窗口，绝不展示首次使用日之前的日期
  function computeTimelineWindow() {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const firstStr = getFirstUseDateStr();
    const firstDate = firstStr ? (parseLocalYmd(firstStr) || today) : today;
    const totalDays = 52 * 7; // 364 天（12 个月 / 52 周）
    const elapsedDays = Math.max(0, Math.floor((today.getTime() - firstDate.getTime()) / 86400000)) + 1;

    let winStart;
    let winEnd;
    let canPrev = false;
    let canNext = false;

    if (elapsedDays <= totalDays) {
      // 使用未满一年：起点固定为实际首次使用日，向后铺满 12 个月（前置空白为 0）
      heatPageOffset = 0;
      winStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
      winEnd = addDays(winStart, totalDays - 1);
    } else {
      // 使用满一年后：默认窗口滚动为「以今天结尾的最近 12 个月」，且起点永不早于首次使用日；支持 ‹ / › 翻页回看更早归档
      const latestStart = addDays(today, -(totalDays - 1));
      const stepDays = 26 * 7; // 每次翻页半年度（26 周）
      let candidateStart = addDays(latestStart, heatPageOffset * stepDays);
      if (candidateStart.getTime() <= firstDate.getTime()) {
        candidateStart = new Date(firstDate.getFullYear(), firstDate.getMonth(), firstDate.getDate());
        const maxBackSteps = -Math.ceil((latestStart.getTime() - firstDate.getTime()) / (stepDays * 86400000));
        if (heatPageOffset < maxBackSteps) heatPageOffset = maxBackSteps;
      }
      winStart = candidateStart;
      winEnd = addDays(winStart, totalDays - 1);
      canPrev = winStart.getTime() > firstDate.getTime();
      canNext = heatPageOffset < 0;
    }

    const firstBadge = el('first-use-badge');
    if (firstBadge) firstBadge.textContent = firstStr ? t('tokens.firstUse', { date: formatZhYmd(firstStr) }) : t('tokens.firstUseNone');
    const rangeEl = el('h-win-range');
    const prevBtn = el('h-page-prev');
    const nextBtn = el('h-page-next');

    if (activeHeatView === 'monthly') {
      const targetMonthDate = new Date(today.getFullYear(), today.getMonth() + heatMonthOffset, 1);
      const targetY = targetMonthDate.getFullYear();
      const targetM = targetMonthDate.getMonth();
      const firstY = firstDate.getFullYear();
      const firstM = firstDate.getMonth();
      const targetMonthKey = targetY * 12 + targetM;
      const firstMonthKey = firstY * 12 + firstM;
      canPrev = targetMonthKey > firstMonthKey;
      canNext = heatMonthOffset < 0;
      if (rangeEl) rangeEl.textContent = t('tokens.range.month', { y: targetY, m: currentPanelLanguage === 'en' ? String(targetM + 1).padStart(2, '0') : (targetM + 1) });
    } else if (activeHeatView === 'yearly') {
      const thisY = today.getFullYear();
      const targetY = thisY + heatYearOffset;
      const firstY = firstDate.getFullYear();
      canPrev = targetY > firstY;
      canNext = heatYearOffset < 0;
      if (rangeEl) {
        rangeEl.textContent = (targetY === thisY) ? t('tokens.range.yearToToday', { y: targetY }) : t('tokens.range.year', { y: targetY });
      }
    } else {
      if (rangeEl) rangeEl.textContent = `${formatDotYmd(winStart)} – ${formatDotYmd(winEnd)}`;
    }

    if (prevBtn) prevBtn.disabled = !canPrev;
    if (nextBtn) nextBtn.disabled = !canNext;

    return { firstStr, firstDate, today, winStart, winEnd, totalDays, canPrev, canNext };
  }

  function applyTokenHistoryPayload(payload) {
    if (!payload || typeof payload !== 'object') return false;
    const incomingScope = payload.accountScopeKey || (payload.planStatus?.email ? String(payload.planStatus.email).trim().toLowerCase() : null);
    if (payload.isAccountSwitched || (incomingScope && typeof handleQuotaAccountSwitch === 'function' && handleQuotaAccountSwitch(incomingScope))) {
      if (typeof handleQuotaAccountSwitch === 'function') handleQuotaAccountSwitch(incomingScope || null, { forceRefresh: true });
    }
    if (payload.loading) {
      if (Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0) return false;
    }

    if (payload.isAccountSwitched) {
      ANTIGRAVITY_TOKEN_DATA.recentModelUsage = [];
      ANTIGRAVITY_TOKEN_DATA.quotaUsageCoverageStartMs = null;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'quotaUsageCoverageStartMs')) {
      ANTIGRAVITY_TOKEN_DATA.quotaUsageCoverageStartMs = payload.quotaUsageCoverageStartMs ?? null;
    }
    if (Array.isArray(payload.recentModelUsage)) {
      ANTIGRAVITY_TOKEN_DATA.recentModelUsage = payload.recentModelUsage;
      if (typeof refreshQuotaTokenEstimates === 'function') {
        refreshQuotaTokenEstimates();
      }
    }
    if (Array.isArray(payload.speedRecords)) {
      ANTIGRAVITY_TOKEN_DATA.speedRecords = payload.speedRecords;
      if (!isContextSettingsView && activeContextTab === 'speed') {
        renderSpeedComparisonTab();
      } else if (!isContextSettingsView && activeContextTab === 'models') {
        renderModelSettingsTab();
      }
    }
    if (payload.modelCapabilitiesById && typeof payload.modelCapabilitiesById === 'object') {
      mergeCapabilitiesMapClient(payload.modelCapabilitiesById);
    }
    if (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0) {
      const hasExisting = Array.isArray(state.cascadeModelConfigs) && state.cascadeModelConfigs.length > 0;
      const incomingHasCaps = payload.cascadeModelConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      const existingHasCaps = hasExisting && state.cascadeModelConfigs.some(c => Number.isFinite(c?.maxTokens) && c.maxTokens > 0);
      if (!hasExisting || (incomingHasCaps && !existingHasCaps)) {
        state.cascadeModelConfigs = payload.cascadeModelConfigs;
        renderHeaderModelDropdown();
        if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
      }
    }

    const hasExistingData = Number(ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) > 0;
    const incomingAllMap = payload.dailyMapBySource?.[activeTokenSource] || payload.dailyMapBySource?.all || payload.dailyMap || {};
    const incomingKeys = Object.keys(incomingAllMap);
    const incomingTotal = Number(payload.summary?.grandTotalTokens) || incomingKeys.reduce((acc, k) => acc + (Number(incomingAllMap[k]?.total) || 0), 0);
    const hasIncomingBySourceData = Boolean(
      payload.dailyMapBySource &&
      typeof payload.dailyMapBySource === 'object' &&
      Object.values(payload.dailyMapBySource).some(m => m && typeof m === 'object' && Object.keys(m).length > 0)
    );
    const hasIncomingRefCost = Boolean(payload.referenceCost?.currentMonth?.totalCostUSD || payload.referenceCost?.all?.totalCostUSD);
    const hasIncomingPayloadContent = incomingKeys.length > 0 || hasIncomingBySourceData || incomingTotal > 0 || hasIncomingRefCost;
    if (hasExistingData && !hasIncomingPayloadContent && !payload.isAccountSwitched && !payload.forceReset) {
      return false;
    }

    ANTIGRAVITY_TOKEN_DATA.rawPayload = payload;
    syncTokenAccountFilterOptions(payload);

    // 若选择了指定账号或“历史未归属”，构造彻底隔离的账本视图（全量指标、热力图、按模型与费用同步切换，绝不泄漏全局总量）
    const isScopedAccountFilter = activeTokenAccountFilter !== 'all';
    let viewPayload = payload;
    if (isScopedAccountFilter) {
      const zeroCostEstimate = {
        pricedCostUSD: 0,
        pricedRequestsCount: 0,
        unpricedRequestsCount: 0,
        pricedTokens: 0,
        unpricedTokens: 0,
        coveragePercent: null,
        byModel: {},
        byCategory: {}
      };
      const zeroRefCost = {
        totalCostUSD: 0,
        inputCostUSD: 0,
        cacheCostUSD: 0,
        outputCostUSD: 0,
        inputTokens: 0,
        cacheTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        modelDisplayName: 'Gemini 3.8 Flash',
        matchedTier: { inputPerMillion: 0.75, cacheReadPerMillion: 0.075, outputPerMillion: 3.75 }
      };
      const bucket = activeTokenAccountFilter === 'unattributed'
        ? payload.unattributedUsage
        : payload.usageByAccount?.[activeTokenAccountFilter];
      if (bucket && typeof bucket === 'object') {
        const bDaily = bucket.dailyMap || {};
        const bDailyBySrc = bucket.dailyMapBySource || {
          all: bDaily,
          desktop: activeTokenAccountFilter === 'unattributed' ? bDaily : {},
          cli: {},
          legacyUnallocated: activeTokenAccountFilter === 'unattributed' ? bDaily : {}
        };
        const bModelsBySrc = bucket.dailyModelMapBySource || {
          all: {},
          desktop: {},
          cli: {}
        };
        const bCostEst = bucket.costEstimate || zeroCostEstimate;
        const bCostMonth = bucket.costEstimateCurrentMonth || bCostEst;
        const bCostBySrc = bucket.costEstimateBySource || {
          all: bCostEst,
          desktop: bCostEst,
          cli: zeroCostEstimate
        };
        const bCacheBySrc = bucket.cacheReadStatsBySource || (bucket.cacheReadStats
          ? { all: bucket.cacheReadStats, desktop: bucket.cacheReadStats, cli: null }
          : { all: null, desktop: null, cli: null });
        const bMonthCacheBySrc = bucket.currentMonthCacheReadStatsBySource || bCacheBySrc;
        viewPayload = {
          ...payload,
          scopedAccountView: true,
          firstUseDate: bucket.firstUseDate || null,
          dailyMap: bDaily,
          dailyMapBySource: bDailyBySrc,
          dailyModelMapBySource: bModelsBySrc,
          modelMetaByKey: bucket.modelMetaByKey || {},
          summary: {
            grandTotalTokens: Number(bucket.totalTokens) || 0,
            totalInputTokens: Number(bucket.totalInputTokens) || 0,
            totalOutputTokens: Number(bucket.totalOutputTokens) || 0,
            totalCacheTokens: Number(bucket.totalCacheTokens) || 0,
            todayTokens: Number(bucket.todayTokens) || 0,
            monthTokens: Number(bucket.monthTokens) || 0,
            yearTokens: Number(bucket.yearTokens) || 0,
            currentMonthInput: Number(bucket.currentMonthInput) || 0,
            currentMonthOutput: Number(bucket.currentMonthOutput) || 0,
            currentMonthCache: Number(bucket.currentMonthCache) || 0,
            activeDaysCount: Number(bucket.activeDaysCount) || Object.keys(bDaily).length,
            totalConversations: Number(bucket.totalConversations ?? bucket.callCount) || 0,
            totalSteps: Number(bucket.totalSteps ?? bucket.callCount) || 0,
            firstUseDate: bucket.firstUseDate || null,
            cacheReadStats: bucket.cacheReadStats || null,
            currentMonthCacheReadStats: bucket.currentMonthCacheReadStats || bucket.cacheReadStats || null
          },
          costEstimate: bCostEst,
          costEstimateCurrentMonth: bCostMonth,
          costEstimateBySource: bCostBySrc,
          cacheReadStatsBySource: bCacheBySrc,
          currentMonthCacheReadStatsBySource: bMonthCacheBySrc,
          referenceCost: bucket.referenceCost || {
            all: { ...zeroRefCost },
            currentMonth: { ...zeroRefCost },
            hybrid: { ...zeroRefCost },
            currentMonthHybrid: { ...zeroRefCost }
          }
        };
      } else {
        viewPayload = {
          ...payload,
          scopedAccountView: true,
          firstUseDate: null,
          dailyMap: {},
          dailyMapBySource: { all: {}, desktop: {}, cli: {}, legacyUnallocated: {} },
          dailyModelMapBySource: { all: {}, desktop: {}, cli: {} },
          modelMetaByKey: {},
          summary: {
            grandTotalTokens: 0,
            totalInputTokens: 0,
            totalOutputTokens: 0,
            totalCacheTokens: 0,
            todayTokens: 0,
            monthTokens: 0,
            yearTokens: 0,
            currentMonthInput: 0,
            currentMonthOutput: 0,
            currentMonthCache: 0,
            activeDaysCount: 0,
            totalConversations: 0,
            totalSteps: 0,
            firstUseDate: null,
            cacheReadStats: null,
            currentMonthCacheReadStats: null
          },
          costEstimate: { ...zeroCostEstimate },
          costEstimateCurrentMonth: { ...zeroCostEstimate },
          costEstimateBySource: { all: { ...zeroCostEstimate }, desktop: { ...zeroCostEstimate }, cli: { ...zeroCostEstimate } },
          cacheReadStatsBySource: { all: null, desktop: null, cli: null },
          currentMonthCacheReadStatsBySource: { all: null, desktop: null, cli: null },
          referenceCost: {
            all: { ...zeroRefCost },
            currentMonth: { ...zeroRefCost },
            hybrid: { ...zeroRefCost },
            currentMonthHybrid: { ...zeroRefCost }
          }
        };
      }
    }

    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const todayStr = formatLocalYmd(new Date());
    const normalized = core && typeof core.normalizeTokenHistoryPayload === 'function'
      ? core.normalizeTokenHistoryPayload(viewPayload, { source: activeTokenSource, todayStr, scopedAccountView: isScopedAccountFilter })
      : null;

    if (normalized) {
      ANTIGRAVITY_TOKEN_DATA.dailyMap = normalized.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = normalized.dailyMapBySource;
      ANTIGRAVITY_TOKEN_DATA.dailyModelMap = normalized.dailyModelMap || {};
      ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource = normalized.dailyModelMapBySource || (isScopedAccountFilter ? viewPayload.dailyModelMapBySource : payload.dailyModelMapBySource) || null;
      ANTIGRAVITY_TOKEN_DATA.modelMetaByKey = normalized.modelMetaByKey || (isScopedAccountFilter ? viewPayload.modelMetaByKey : payload.modelMetaByKey) || null;
      ANTIGRAVITY_TOKEN_DATA.summary = normalized.summary;
      ANTIGRAVITY_TOKEN_DATA.referenceCost = normalized.referenceCost;
      ANTIGRAVITY_TOKEN_DATA.currentPeriod = normalized.currentPeriod;
      if (isScopedAccountFilter) {
        ANTIGRAVITY_TOKEN_DATA.firstUseDate = normalized.firstUseDate || viewPayload.firstUseDate || null;
        ANTIGRAVITY_TOKEN_DATA.costEstimate = viewPayload.costEstimate;
        ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth = viewPayload.costEstimateCurrentMonth;
        ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = viewPayload.costEstimateBySource;
      } else {
        if (normalized.firstUseDate) ANTIGRAVITY_TOKEN_DATA.firstUseDate = normalized.firstUseDate;
      }
      if (normalized.updatedAt) ANTIGRAVITY_TOKEN_DATA.updatedAt = normalized.updatedAt;
    } else {
      const newMap = {};
      if (payload.dailyMap && typeof payload.dailyMap === 'object') {
        for (const [dKey, rec] of Object.entries(payload.dailyMap)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dKey) || !rec) continue;
          newMap[dKey] = {
            total: Number(rec.total) || 0,
            input: Number(rec.input) || 0,
            output: Number(rec.output) || 0,
            cache: Number(rec.cache) || 0,
            steps: Number(rec.steps) || 0
          };
        }
      }
      ANTIGRAVITY_TOKEN_DATA.dailyMap = newMap;
      if (payload.dailyMapBySource) ANTIGRAVITY_TOKEN_DATA.dailyMapBySource = payload.dailyMapBySource;
      if (payload.dailyModelMapBySource) {
        ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource = payload.dailyModelMapBySource;
        ANTIGRAVITY_TOKEN_DATA.dailyModelMap = payload.dailyModelMapBySource[activeTokenSource] || payload.dailyModelMapBySource.all || {};
      } else if (payload.dailyModelMap) {
        ANTIGRAVITY_TOKEN_DATA.dailyModelMap = payload.dailyModelMap;
      }
      if (payload.modelMetaByKey) ANTIGRAVITY_TOKEN_DATA.modelMetaByKey = payload.modelMetaByKey;
      if (payload.firstUseDate) ANTIGRAVITY_TOKEN_DATA.firstUseDate = payload.firstUseDate;
      if (payload.updatedAt) ANTIGRAVITY_TOKEN_DATA.updatedAt = payload.updatedAt;
      if (payload.currentPeriod) ANTIGRAVITY_TOKEN_DATA.currentPeriod = payload.currentPeriod;
      if (payload.referenceCost) ANTIGRAVITY_TOKEN_DATA.referenceCost = payload.referenceCost;

      const keys = Object.keys(newMap).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k) && newMap[k]?.total > 0).sort();
      const monthPrefix = todayStr.slice(0, 7);
      const yearPrefix = todayStr.slice(0, 4);
      let totalTokens = 0, todayTokens = 0, monthTokens = 0, yearTokens = 0, monthDays = 0;
      let totalInput = 0, totalOutput = 0, totalCache = 0;
      let curMonthInput = 0, curMonthOutput = 0, curMonthCache = 0;
      for (const k of keys) {
        const r = newMap[k];
        const t = Number(r.total) || 0;
        totalTokens += t;
        totalInput += Number(r.input) || 0;
        totalOutput += Number(r.output) || 0;
        totalCache += Number(r.cache) || 0;
        if (k === todayStr) todayTokens += t;
        if (k.startsWith(monthPrefix)) {
          monthTokens += t;
          curMonthInput += Number(r.input) || 0;
          curMonthOutput += Number(r.output) || 0;
          curMonthCache += Number(r.cache) || 0;
          monthDays += 1;
        }
        if (k.startsWith(yearPrefix)) yearTokens += t;
      }
      const rawSum = payload.summary || {};
      ANTIGRAVITY_TOKEN_DATA.summary = {
        grandTotalTokens: Math.max(totalTokens, Number(rawSum.grandTotalTokens) || 0),
        totalTokens: Math.max(totalTokens, Number(rawSum.grandTotalTokens) || 0),
        todayTokens: todayTokens > 0 ? todayTokens : (Number(rawSum.todayTokens) || 0),
        monthTokens: Math.max(monthTokens, Number(rawSum.monthTokens) || 0),
        yearTokens: Math.max(yearTokens, Number(rawSum.yearTokens) || 0),
        totalInputTokens: Math.max(totalInput, Number(rawSum.totalInputTokens) || 0),
        totalOutputTokens: Math.max(totalOutput, Number(rawSum.totalOutputTokens) || 0),
        totalCacheTokens: Math.max(totalCache, Number(rawSum.totalCacheTokens) || 0),
        currentMonthInput: Math.max(curMonthInput, Number(rawSum.currentMonthInput) || 0),
        currentMonthOutput: Math.max(curMonthOutput, Number(rawSum.currentMonthOutput) || 0),
        currentMonthCache: Math.max(curMonthCache, Number(rawSum.currentMonthCache) || 0),
        totalDays: keys.length,
        totalConversations: Number(rawSum.totalConversations) || keys.length,
        firstUseDate: payload.firstUseDate || rawSum.firstUseDate || null
      };
    }

    if (payload.planStatus || payload.customPlanSettings) {
      let mergedPlan = payload.planStatus || ANTIGRAVITY_TOKEN_DATA.planStatus || {};
      try {
        const email = mergedPlan.email || 'default';
        let customObj = lastSavedCustomPlan || payload.customPlanSettings || null;
        if (!customObj && typeof window !== 'undefined' && window.__AGContextMeterSettings?.customPlan) {
          customObj = window.__AGContextMeterSettings.customPlan;
        }
        if (!customObj) {
          const savedCustomRaw = localStorage?.getItem('ag_custom_plan_' + email.toLowerCase()) || localStorage?.getItem('ag_custom_plan_default');
          if (savedCustomRaw) customObj = JSON.parse(savedCustomRaw);
        }
        if (customObj && typeof customObj === 'object') {
          lastSavedCustomPlan = { ...customObj };
          try {
            const jsonStr = JSON.stringify(customObj);
            if (email && email !== 'default') localStorage?.setItem('ag_custom_plan_' + email.toLowerCase(), jsonStr);
            localStorage?.setItem('ag_custom_plan_default', jsonStr);
          } catch { }
          if (core && core.resolveEffectivePlanStatus) {
            mergedPlan = core.resolveEffectivePlanStatus(payload.rawPlanStatus || payload.planStatus, customObj, { currentEmail: email });
          }
        }
      } catch { }
      ANTIGRAVITY_TOKEN_DATA.planStatus = mergedPlan;
      ANTIGRAVITY_TOKEN_DATA.rawPlanStatus = payload.rawPlanStatus || payload.planStatus || mergedPlan;
      renderPlanDetail(mergedPlan);
    }

    if (payload.costEstimate && !isScopedAccountFilter) {
      ANTIGRAVITY_TOKEN_DATA.costEstimate = payload.costEstimate;
    }
    if (payload.costEstimateCurrentMonth && !isScopedAccountFilter) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateCurrentMonth = payload.costEstimateCurrentMonth;
    }
    if (payload.costEstimateBySource && !isScopedAccountFilter) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = payload.costEstimateBySource;
    } else if (payload.costEstimate && !isScopedAccountFilter) {
      ANTIGRAVITY_TOKEN_DATA.costEstimateBySource = {
        all: payload.costEstimate,
        desktop: payload.costEstimate,
        cli: { pricedCostUSD: 0, pricedRequestsCount: 0, unpricedRequestsCount: 0, coveragePercent: null, byModel: {} }
      };
    }

    // 重新汇总卡片统计与顶栏
    const sum = ANTIGRAVITY_TOKEN_DATA.summary;
    const totalTokens = sum.grandTotalTokens;
    const shownToday = sum.todayTokens;
    const monthTokens = sum.monthTokens;
    const yearTokens = sum.yearTokens;
    const convCount = sum.totalConversations;
    const totalDays = sum.totalDays || Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap).length;
    const avgMonth = Math.round(monthTokens / Math.max(1, totalDays));

    const fmtCardM = v => {
      const n = Number(v) || 0;
      if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
      if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
      return String(n);
    };
    const badgeAmt = el('token-amount');
    const badgeExtra = el('token-hover-extra');
    const overAmt = el('overflow-tokens-val');
    if (badgeAmt) badgeAmt.textContent = fmtCardM(totalTokens);
    if (badgeExtra) badgeExtra.textContent = t('tokens.badge.today', { val: fmtCardM(shownToday) });
    if (overAmt) overAmt.textContent = fmtCardM(totalTokens);

    const miniHm = el('token-mini-heatmap');
    if (miniHm) {
      const showHm = typeof getToolbarPrefs === 'function' ? getToolbarPrefs().miniHeatmap !== false : true;
      miniHm.hidden = !showHm;
      if (showHm) {
        const dm = ANTIGRAVITY_TOKEN_DATA?.dailyMap || data?.dailyMap || {};
        const now = new Date();
        const cells = [];
        let maxDay = 0;
        for (let i = 20; i >= 0; i--) {
          const d = new Date(now);
          d.setDate(now.getDate() - i);
          const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
          const v = Number(dm[key]?.total ?? dm[key]?.totalTokens ?? dm[key]?.tokens ?? dm[key] ?? 0) || 0;
          if (v > maxDay) maxDay = v;
          cells.push(v);
        }
        miniHm.innerHTML = cells.map(v => {
          let lvl = 0;
          if (v > 0 && maxDay > 0) {
            const r = v / maxDay;
            lvl = r > 0.75 ? 4 : r > 0.45 ? 3 : r > 0.15 ? 2 : 1;
          }
          return `<span class="token-mini-cell" data-level="${lvl}"></span>`;
        }).join('');
      }
    }

    const tTotalVal = el('t-total-val');
    const tTotalSub = el('t-total-sub');
    const tTodayVal = el('t-today-val');
    const tTodaySub = el('t-today-sub');
    const tMonthVal = el('t-month-val');
    const tMonthSub = el('t-month-sub');
    const tYearVal = el('t-year-val');
    const tYearSub = el('t-year-sub');

    if (tTotalVal) tTotalVal.textContent = fmtCardM(totalTokens);
    if (tTotalSub) tTotalSub.textContent = `${totalTokens.toLocaleString('en-US')} Tokens`;
    if (tTodayVal) tTodayVal.textContent = fmtCardM(shownToday);
    if (tTodaySub) tTodaySub.textContent = t('tokens.card.todaySub', { n: convCount });
    if (tMonthVal) tMonthVal.textContent = fmtCardM(monthTokens);
    if (tMonthSub) tMonthSub.textContent = t('tokens.card.monthSub', { val: fmtCardM(avgMonth) });
    if (tYearVal) tYearVal.textContent = fmtCardM(yearTokens);
    if (tYearSub) tYearSub.textContent = t('tokens.card.yearSub', { n: totalDays });

    const cs = sum.cacheReadStats || {
      cacheStatus: (sum.totalInputTokens > 0 || sum.totalCacheTokens > 0) ? 'hit' : 'missing',
      totalUncachedInput: Number(sum.totalInputTokens) || 0,
      totalCacheRead: Number(sum.totalCacheTokens) || 0,
      totalInput: (Number(sum.totalInputTokens) || 0) + (Number(sum.totalCacheTokens) || 0),
      totalOutput: Number(sum.totalOutputTokens) || 0,
      cacheReadPct: ((Number(sum.totalInputTokens) || 0) + (Number(sum.totalCacheTokens) || 0)) > 0
        ? Number(((Number(sum.totalCacheTokens || 0) / ((Number(sum.totalInputTokens) || 0) + (Number(sum.totalCacheTokens) || 0))) * 100).toFixed(1))
        : null,
      missingCount: 0
    };
    const tcbInp = el('tcb-input-val');
    const tcbCache = el('tcb-cache-val');
    const tcbTotInp = el('tcb-total-input-val');
    const tcbOut = el('tcb-output-val');
    const tcbRatio = el('tcb-ratio-val');
    const tcbRatioFill = el('tcb-ratio-bar-fill');
    const tcbNote = el('tcb-note');
    const unknownText = t('tokens.cache.unknown');
    if (tcbInp) tcbInp.textContent = cs.cacheStatus === 'missing' ? unknownText : fmtCardM(cs.totalUncachedInput);
    if (tcbCache) tcbCache.textContent = cs.cacheStatus === 'missing' ? unknownText : fmtCardM(cs.totalCacheRead);
    if (tcbTotInp) tcbTotInp.textContent = cs.cacheStatus === 'missing' ? unknownText : fmtCardM(cs.totalInput);
    if (tcbOut) tcbOut.textContent = fmtCardM(sum.totalOutputTokens || cs.totalOutput || 0);
    if (tcbRatio) {
      if (cs.cacheStatus === 'missing') tcbRatio.textContent = unknownText;
      else if (cs.cacheStatus === 'zero_input') tcbRatio.textContent = t('tokens.cache.na');
      else tcbRatio.textContent = cs.cacheReadPct !== null ? `${cs.cacheReadPct}%` : unknownText;
    }
    if (tcbRatioFill) {
      const pctNum = (cs.cacheStatus === 'missing' || cs.cacheStatus === 'zero_input' || cs.cacheReadPct === null)
        ? 0
        : Math.max(0, Math.min(100, Number(cs.cacheReadPct) || 0));
      tcbRatioFill.style.width = `${pctNum.toFixed(1)}%`;
    }
    if (tcbNote) {
      tcbNote.hidden = false;
      if (cs.cacheStatus === 'missing') {
        tcbNote.textContent = t('tokens.cache.missingNote');
      } else if (cs.cacheStatus === 'zero_input') {
        tcbNote.textContent = t('tokens.cache.zeroInputNote');
      } else if (cs.missingCount > 0) {
        tcbNote.textContent = t('tokens.cache.partialNote', { n: cs.missingCount });
      } else {
        tcbNote.textContent = t('tokens.cache.weightedNote');
      }
    }

    // 聚合全周期各区间预估费用
    const allDateKeys = Object.keys(ANTIGRAVITY_TOKEN_DATA.dailyMap || {});
    const nowYmd = todayStr;
    const thisMonthPrefix = nowYmd.slice(0, 7);
    const thisYearPrefix = nowYmd.slice(0, 4);

    const todayCostInfo = getDailyModelCost(ANTIGRAVITY_TOKEN_DATA.dailyMap[nowYmd], nowYmd, activeCostModel, { mode: activeCostMode });
    const todayCostCny = convertToCNY(todayCostInfo.costUSD, 'USD');

    const totalCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, allDateKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });
    const totalCostCny = convertToCNY(totalCostAgg.totalCostUSD, 'USD');

    const monthKeys = allDateKeys.filter(k => k.startsWith(thisMonthPrefix) && k <= nowYmd);
    const monthCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, monthKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });
    const monthCostCny = convertToCNY(monthCostAgg.totalCostUSD, 'USD');

    const yearKeys = allDateKeys.filter(k => k.startsWith(thisYearPrefix) && k <= nowYmd);
    const yearCostAgg = calculateIntervalCost(ANTIGRAVITY_TOKEN_DATA.dailyMap, yearKeys, activeCostModel, { mode: activeCostMode, todayStr: nowYmd });
    const yearCostCny = convertToCNY(yearCostAgg.totalCostUSD, 'USD');

    const tTotalCost = el('t-total-cost');
    const tTodayCost = el('t-today-cost');
    const tMonthCost = el('t-month-cost');
    const tYearCost = el('t-year-cost');

    const isScopedEmptyAccount = isScopedAccountFilter && totalTokens === 0;
    const noAcctCostStr = t('tokens.noAccountCost');
    if (tTotalCost) {
      tTotalCost.textContent = isScopedEmptyAccount
        ? noAcctCostStr
        : `${formatUsdMetricDisplay(totalCostAgg.totalCostUSD)}${t('tokens.dailyAvg', { val: totalCostAgg.dailyAverageUSD.toFixed(2) })}`;
      tTotalCost.title = isScopedEmptyAccount ? '' : formatUsdMetricTooltip(totalCostAgg.totalCostUSD);
    }
    if (tTodayCost) {
      tTodayCost.textContent = isScopedEmptyAccount
        ? noAcctCostStr
        : formatUsdMetricDisplay(todayCostInfo.costUSD);
      tTodayCost.title = isScopedEmptyAccount ? '' : formatUsdMetricTooltip(todayCostInfo.costUSD);
    }
    if (tMonthCost) {
      tMonthCost.textContent = isScopedEmptyAccount
        ? noAcctCostStr
        : `${formatUsdMetricDisplay(monthCostAgg.totalCostUSD)}${t('tokens.dailyAvg', { val: monthCostAgg.dailyAverageUSD.toFixed(2) })}`;
      tMonthCost.title = isScopedEmptyAccount ? '' : formatUsdMetricTooltip(monthCostAgg.totalCostUSD);
    }
    if (tYearCost) {
      tYearCost.textContent = isScopedEmptyAccount
        ? noAcctCostStr
        : `${formatUsdMetricDisplay(yearCostAgg.totalCostUSD)}${t('tokens.dailyAvg', { val: yearCostAgg.dailyAverageUSD.toFixed(2) })}`;
      tYearCost.title = isScopedEmptyAccount ? '' : formatUsdMetricTooltip(yearCostAgg.totalCostUSD);
    }

    // 规范化已完整保留输入/缓存/输出分类，执行费用视图渲染
    renderActiveCostEstimateView();
    renderModelUsageView();

    computeTimelineWindow();
    renderActiveHeatView(true);
    return true;
  }



  async function recordModelCallsRemote(calls) {
    if (!calls || !calls.length) return { ok: false, changed: false };
    try {
      const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.recordCalls === 'function')
        ? () => window.contextMeterAPI.recordCalls(calls)
        : null;
      if (!ipcFn && !hasLiveHttpBridge()) {
        return { ok: false, changed: false };
      }
      const out = await callBackendWithPriority({
        ipcCall: ipcFn,
        liveRoute: '/record-calls',
        liveBody: { calls }
      });
      const res = out.result;
      if (res && res.ok === false) {
        console.warn('Context Meter: 记录调用入账失败', res.error);
      }
      return res || { ok: false, changed: false };
    } catch (err) {
      if (err?.httpStatus) {
        console.warn(`Context Meter: 实时通道 record-calls 响应异常 HTTP ${err.httpStatus}`);
        return {
          ok: false,
          changed: false,
          status: err.httpStatus,
          ...(err.responseData?.error ? { error: err.responseData.error } : {}),
          ...(err.responseData?.phase ? { phase: err.responseData.phase } : {}),
          ...(err.responseData?.code ? { code: err.responseData.code } : {})
        };
      }
      console.warn('Context Meter: 调用入账发生异常', err);
      return { ok: false, changed: false, error: err?.message || String(err || '') };
    }
  }

  async function restoreSettingsFromHost() {
    if (state.disposed) return;
    const thisSeq = ++restoreRequestSeq;
    const startActionSeq = userActionSeq;
    try {
      let settingsRes = null;
      const currentEmail = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || 'default';

      // 权威配置同步：宿主通信桥接可用时，以宿主最新持久化配置为准，避免启动快照覆盖最新状态
      const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getSettings === 'function')
        ? () => window.contextMeterAPI.getSettings({ email: currentEmail })
        : null;
      if (ipcFn || hasLiveHttpBridge()) {
        try {
          const out = await callBackendWithPriority({
            ipcCall: ipcFn,
            liveRoute: '/get-settings',
            liveBody: { email: currentEmail }
          });
          settingsRes = out.result;
        } catch { }
      }
      if (!settingsRes?.ok && typeof window !== 'undefined' && window.__AGContextMeterSettings?.ok) {
        settingsRes = window.__AGContextMeterSettings;
      }

      // 若在网络等待期间有更新的恢复请求完成或用户发生了最新主动修改，丢弃旧回包！
      if (thisSeq < restoreRequestSeq || userActionSeq > startActionSeq) {
        return;
      }

      if (settingsRes?.ok) {
        if (settingsRes.uiPreferences?.restartVerification && typeof settingsRes.uiPreferences.restartVerification === 'object') {
          pendingRestartVerification = { ...settingsRes.uiPreferences.restartVerification };
          void refreshUnlockStatus();
        }
        if (settingsRes.contextScopeMode) {
          contextScopeMode = settingsRes.contextScopeMode === 'per_model' ? 'per_model' : 'unified';
        } else {
          const hasPerModelPrefs = settingsRes.contextPreferences && Object.values(settingsRes.contextPreferences).some(p => p && p.mode && p.mode !== 'default');
          contextScopeMode = hasPerModelPrefs ? 'per_model' : 'unified';
        }

        if (settingsRes.contextUnifiedPreference && typeof settingsRes.contextUnifiedPreference === 'object') {
          contextUnifiedPreference = { ...settingsRes.contextUnifiedPreference };
        } else {
          contextUnifiedPreference = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
        }

        if (settingsRes.contextPreferences && typeof settingsRes.contextPreferences === 'object') {
          contextPreferencesMap = { ...settingsRes.contextPreferences };
        }
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = {
            ...(window.__AGContextMeterSettings || {}),
            ok: true,
            ...(settingsRes.customPlan ? { customPlan: { ...settingsRes.customPlan } } : {}),
            uiPreferences: { ...(settingsRes.uiPreferences || {}) },
            contextScopeMode,
            contextUnifiedPreference: { ...contextUnifiedPreference },
            contextPreferences: { ...contextPreferencesMap }
          };
        }
        syncContextPreferencesCache(contextPreferencesMap);
        renderHeaderModelDropdown();
        if (!ctxDraftDirty) loadDraftFromSelectedModel(true);
        else renderCompactSessionCard();
        const savedView = settingsRes.savedHeatView || settingsRes.uiPreferences?.savedHeatView;
        if (savedView && ['daily', 'weekly', 'monthly', 'yearly', 'cum'].includes(savedView)) {
          switchHeatView(savedView, false);
        }
        const savedAutoUpdate = settingsRes.autoCheckUpdate !== undefined
          ? settingsRes.autoCheckUpdate
          : settingsRes.uiPreferences?.autoCheckUpdate;
        if (savedAutoUpdate !== undefined) {
          autoCheckUpdate = savedAutoUpdate !== false;
          const chk = el('check-auto-update');
          if (chk) chk.checked = autoCheckUpdate;
        }
        const savedLang = settingsRes.panelLanguage || settingsRes.uiPreferences?.panelLanguage;
        if (savedLang && ['zh-CN', 'zh-TW', 'en'].includes(savedLang) && savedLang !== currentPanelLanguage) {
          await applyPanelLanguage(savedLang, { persist: false });
        }
      } else {
        try {
          const localLang = localStorage?.getItem('ag_panel_language');
          if (localLang && ['zh-CN', 'zh-TW', 'en'].includes(localLang) && localLang !== currentPanelLanguage) {
            await applyPanelLanguage(localLang, { persist: false });
          }
        } catch { }
      }

      if (settingsRes?.ok && settingsRes.customPlan && typeof settingsRes.customPlan === 'object') {
        lastSavedCustomPlan = { ...settingsRes.customPlan };
        if (typeof window !== 'undefined') {
          window.__AGContextMeterSettings = {
            ...(window.__AGContextMeterSettings || {}),
            ok: true,
            customPlan: { ...settingsRes.customPlan },
            contextScopeMode,
            contextUnifiedPreference: { ...contextUnifiedPreference },
            contextPreferences: { ...contextPreferencesMap }
          };
        }

        const email = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || settingsRes.customPlan?.account || currentEmail || 'default';
        try {
          const jsonStr = JSON.stringify(settingsRes.customPlan);
          if (email && email !== 'default') localStorage?.setItem('ag_custom_plan_' + String(email).toLowerCase(), jsonStr);
          localStorage?.setItem('ag_custom_plan_default', jsonStr);
        } catch { }
        applyCustomPlanObjectLocally(settingsRes.customPlan, email);
      } else {
        // 回退检查 localStorage
        const email = ANTIGRAVITY_TOKEN_DATA.planStatus?.email || 'default';
        const key = email && email !== 'default' ? 'ag_custom_plan_' + String(email).toLowerCase() : 'ag_custom_plan_default';
        const savedRaw = localStorage?.getItem(key) || localStorage?.getItem('ag_custom_plan_default');
        if (savedRaw) {
          const parsed = JSON.parse(savedRaw);
          if (parsed && typeof parsed === 'object') {
            lastSavedCustomPlan = { ...parsed };
            applyCustomPlanObjectLocally(parsed, parsed.account || email);
          }
        }
      }
    } catch { }
  }

  let lastHistorySync = 0;
  let historySyncBusy = false;
  let historySyncPending = false;
  let historySyncPendingForce = false;
  const AUTOMATIC_HISTORY_SYNC_INTERVAL_MS = 5000;
  let automaticHistorySyncPending = false;
  let lastAutomaticHistorySync = null;
  let hasScheduledInitialUpdateCheck = false;
  let startupRestorePromise = null;

  function syncPendingAutomaticHistory() {
    if (!automaticHistorySyncPending || historySyncBusy || state.disposed) return;
    const now = Date.now();
    if (lastAutomaticHistorySync !== null && now - lastAutomaticHistorySync < AUTOMATIC_HISTORY_SYNC_INTERVAL_MS) return;
    lastAutomaticHistorySync = now;
    void syncTokenHistoryFromHost(true);
  }

  async function syncTokenHistoryFromHost(force = false) {
    if (state.disposed) return;
    if (historySyncBusy) {
      historySyncPending = true;
      if (force) historySyncPendingForce = true;
      return;
    }
    const forceFlag = Boolean(force);
    if (forceFlag) automaticHistorySyncPending = false;
    historySyncBusy = true;
    lastHistorySync = Date.now();
    try {
      const fetchHistoryAsync = async () => {
        const ipcFn = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getTokenHistory === 'function')
          ? () => window.contextMeterAPI.getTokenHistory(forceFlag)
          : null;
        if (!ipcFn && !hasLiveHttpBridge()) return null;
        try {
          const out = await callBackendWithPriority({
            ipcCall: ipcFn,
            liveRoute: '/token-history',
            liveBody: { force: forceFlag }
          });
          return out.result || null;
        } catch {
          return null;
        }
      };
      const restoreStep = startupRestorePromise
        ? startupRestorePromise
        : restoreSettingsFromHost();
      const [, res] = await Promise.all([restoreStep, fetchHistoryAsync()]);
      if (state.disposed) return;
      if (typeof window !== 'undefined' && window.__AGContextMeterHistory) {
        if (!ANTIGRAVITY_TOKEN_DATA.updatedAt && !ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens) {
          applyTokenHistoryPayload(window.__AGContextMeterHistory);
        }
      }
      if (res?.ok && res.data) {
        if (typeof window !== 'undefined') window.__AGContextMeterHistory = res.data;
        applyTokenHistoryPayload(res.data);
      }
    } catch { }
    finally {
      historySyncBusy = false;
      lastHistorySync = Date.now();
      if (!hasScheduledInitialUpdateCheck && autoCheckUpdate && !state.disposed) {
        hasScheduledInitialUpdateCheck = true;
        setTimeout(() => { if (!state.disposed) void checkAppUpdate(false); }, 4500);
      }
      if (historySyncPending && !state.disposed) {
        const nextForce = historySyncPendingForce;
        historySyncPending = false;
        historySyncPendingForce = false;
        void syncTokenHistoryFromHost(nextForce);
      } else {
        syncPendingAutomaticHistory();
      }
    }
  }

  function openGithubRepo(pathSuffix = '') {
    const url = 'https://github.com/elviscjn-cjn/antigravity-context-viewer' + pathSuffix;
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.openExternal === 'function') {
      window.contextMeterAPI.openExternal(url);
    } else {
      window.open?.(url, '_blank');
    }
  }

  let currentUpdateTrigger = 'tokens';

  function positionUpdatePopover(trigger = currentUpdateTrigger) {
    const pop = el('update-popover');
    if (!pop) return;
    const triggerBtn = trigger === 'ctx' ? el('btn-check-update-ctx') : el('btn-check-update');
    if (!triggerBtn || typeof triggerBtn.getBoundingClientRect !== 'function') return;
    const rect = triggerBtn.getBoundingClientRect();
    const winW = typeof window !== 'undefined' ? (window.innerWidth || 1024) : 1024;
    const winH = typeof window !== 'undefined' ? (window.innerHeight || 768) : 768;
    let right = Math.max(14, winW - rect.right);
    let top = rect.bottom + 8;
    if (top + 220 > winH) {
      top = Math.max(10, rect.top - 230);
    }
    pop.style.position = 'fixed';
    pop.style.top = `${snapToDevicePixel(top)}px`;
    pop.style.right = `${snapToDevicePixel(right)}px`;
    pop.style.left = 'auto';
  }

  function showUpdatePopover(trigger = currentUpdateTrigger) {
    const pop = el('update-popover');
    if (!pop) return;
    currentUpdateTrigger = trigger;
    positionUpdatePopover(trigger);
    pop.style.display = 'block';
  }

  function hideUpdatePopover() {
    const pop = el('update-popover');
    if (pop) pop.style.display = 'none';
  }

  const onUpdatePopoverResize = () => {
    const pop = el('update-popover');
    if (pop && pop.style.display === 'block') {
      positionUpdatePopover();
    }
  };
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onUpdatePopoverResize);
    earlyDisposeHooks.push(() => {
      try { window.removeEventListener?.('resize', onUpdatePopoverResize); } catch { }
    });
  }

  async function checkAppUpdate(manual = false, trigger = currentUpdateTrigger) {
    const dot = el('update-badge-dot');
    const dotCtx = el('update-badge-dot-ctx');
    const pop = el('update-popover');
    const titleEl = el('up-pop-title');
    const bodyEl = el('up-pop-body');
    const verEl = el('up-pop-ver');
    const statusEl = el('up-pop-status');
    const applyBtn = el('btn-apply-update');
    const restartBtn = el('btn-update-restart');
    const setUpdateRestartVisible = (visible) => {
      if (!restartBtn) return;
      const show = Boolean(visible && hostSupportsRestart);
      restartBtn.hidden = !show;
      if (restartBtn.style) restartBtn.style.display = show ? 'inline-block' : 'none';
    };

    // 检查桥接是否存在；若缺失则直接判定为更新功能不可用，严禁显示“最新”
    const currentVer = typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.8';
    const currentDisplayVer = formatDisplayVersion(currentVer);
    const hasIpcUpdateBridge = typeof window !== 'undefined' && typeof window.contextMeterAPI?.checkUpdate === 'function';
    const hasBridge = hasIpcUpdateBridge || (hasLiveHttpBridge() && hasLiveRouteCapability('/check-update'));
    if (!hasBridge) {
      cachedLatestRelease = null;
      if (dot) dot.style.display = 'none';
      if (dotCtx) dotCtx.style.display = 'none';
      if (titleEl) titleEl.textContent = t('update.unavailableTitle');
      if (verEl) verEl.textContent = t('update.unavailableVer', { ver: currentDisplayVer });
      if (bodyEl) bodyEl.textContent = t('update.unavailableBody');
      if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
      setUpdateRestartVisible(false);
      if (manual) showUpdatePopover(trigger);
      return;
    }

    if (manual) {
      cachedLatestRelease = null;
      showUpdatePopover(trigger);
      if (titleEl) titleEl.textContent = t('update.checkingTitle');
      if (verEl) verEl.textContent = t('update.checkingVer', { ver: currentDisplayVer });
      if (bodyEl) bodyEl.textContent = t('update.connecting');
      if (statusEl) { statusEl.style.display = 'none'; statusEl.textContent = ''; }
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
      setUpdateRestartVisible(false);
    }

    try {
      const checkReq = { force: manual, currentVersion: currentVer };
      const out = await callBackendWithPriority({
        ipcCall: hasIpcUpdateBridge ? () => window.contextMeterAPI.checkUpdate(checkReq) : null,
        liveRoute: '/check-update',
        liveBody: checkReq
      });
      const res = out.result;

      // 返回 null、非对象或 ok: false 均为检查失败，严禁显示“最新”
      if (!res || res.ok === false) {
        cachedLatestRelease = null;
        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';
        if (titleEl) titleEl.textContent = t('update.failedTitle');
        if (verEl) verEl.textContent = t('update.failedVer', { ver: currentDisplayVer });
        const errMsg = res?.error ? translateBackendText(res.error) : t('update.failedFetch');
        if (bodyEl) bodyEl.textContent = t('update.failedBody', { err: errMsg });
        if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
        setUpdateRestartVisible(false);
        if (manual) showUpdatePopover(trigger);
        return;
      }

      if (res.hasUpdate && res.latestVersion) {
        cachedLatestRelease = res;
        const nextDisplayVer = formatDisplayVersion(res.latestVersion);
        if (dot) dot.style.display = 'block';
        if (dotCtx) dotCtx.style.display = 'block';
        if (titleEl) titleEl.textContent = t('update.foundTitle');
        if (verEl) verEl.textContent = `${formatDisplayVersion(res.currentVersion || currentVer)} → ${nextDisplayVer}`;
        if (bodyEl) {
          bodyEl.textContent = t('update.foundBody', { ver: nextDisplayVer, notes: res.releaseNotes || t('update.defaultNotes') });
        }
        if (applyBtn) {
          applyBtn.disabled = false;
          applyBtn.textContent = t('update.applyNow');
          applyBtn.style.display = 'inline-block';
        }
        setUpdateRestartVisible(false);
        if (manual) showUpdatePopover(trigger);
      } else {
        cachedLatestRelease = null;
        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';
        if (titleEl) titleEl.textContent = t('update.latestTitle');
        const effectiveCurrent = res.installedVersion || res.currentVersion || currentVer;
        const effectiveDisplayVer = formatDisplayVersion(effectiveCurrent);
        if (verEl) verEl.textContent = t('update.latestVer', { ver: effectiveDisplayVer });
        const needsDiskRestart = Boolean(res.diskPendingRestart);
        if (needsDiskRestart) {
          pendingUpdateRestart = true;
        }
        const updateStatusText = needsDiskRestart
          ? t('update.diskPending', { ver: effectiveDisplayVer })
          : t('update.latestBody', { ver: effectiveDisplayVer });
        if (bodyEl) bodyEl.textContent = updateStatusText;
        if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
        setUpdateRestartVisible(needsDiskRestart);
        if (needsDiskRestart && !hostSupportsRestart && statusEl) {
          statusEl.style.display = 'block';
          statusEl.textContent = t('client.restart.hostNotSupported');
        }
        if (manual) showUpdatePopover(trigger);
      }
    } catch (err) {
      cachedLatestRelease = null;
      if (dot) dot.style.display = 'none';
      if (dotCtx) dotCtx.style.display = 'none';
      if (titleEl) titleEl.textContent = t('update.failedTitle');
      if (verEl) verEl.textContent = t('update.failedVer', { ver: currentDisplayVer });
      if (bodyEl) bodyEl.textContent = t('update.failedNetBody', { err: translateBackendText(err.message) });
      if (applyBtn) { applyBtn.style.display = 'none'; applyBtn.disabled = true; }
      setUpdateRestartVisible(false);
      if (manual) showUpdatePopover(trigger);
    }
  }

  async function applyAppUpdate() {
    const pop = el('update-popover');
    const applyBtn = el('btn-apply-update');
    const restartBtn = el('btn-update-restart');
    const statusEl = el('up-pop-status');
    const titleEl = el('up-pop-title');
    const bodyEl = el('up-pop-body');
    const verEl = el('up-pop-ver');
    const dot = el('update-badge-dot');
    const dotCtx = el('update-badge-dot-ctx');
    if (!cachedLatestRelease) return;

    if (restartBtn) {
      restartBtn.hidden = true;
      if (restartBtn.style) restartBtn.style.display = 'none';
    }
    if (applyBtn) {
      applyBtn.disabled = true;
      applyBtn.textContent = t('update.updatingBtn');
    }
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.textContent = t('update.downloading');
    }

    try {
      let res = null;
      const hasIpcApply = typeof window !== 'undefined' && typeof window.contextMeterAPI?.applyUpdate === 'function';
      const hasLiveApply = hasLiveHttpBridge() && hasLiveRouteCapability('/apply-update');
      if (hasIpcApply || hasLiveApply) {
        const out = await callBackendWithPriority({
          ipcCall: hasIpcApply ? () => window.contextMeterAPI.applyUpdate({ version: cachedLatestRelease.latestVersion }) : null,
          liveRoute: '/apply-update',
          liveBody: { version: cachedLatestRelease.latestVersion }
        });
        res = out.result;
      } else {
        throw new Error(t('update.noApi'));
      }
      if (state.disposed) return;
      if (res && res.ok) {
        const fallbackVer = typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.8';
        const nextVer = res.version || res.installedVersion || cachedLatestRelease?.latestVersion || fallbackVer;
        const nextDisplayVer = formatDisplayVersion(nextVer);
        const vEl = el('v');
        if (vEl && res.liveInjected) vEl.textContent = nextDisplayVer;

        if (dot) dot.style.display = 'none';
        if (dotCtx) dotCtx.style.display = 'none';

        const fullyHotReloaded = Boolean(res.liveInjected && res.backendHotReloaded);
        pendingUpdateRestart = !fullyHotReloaded;
        if (titleEl) titleEl.textContent = t('update.doneTitle');
        if (verEl) verEl.textContent = t('update.doneVer', { ver: nextDisplayVer });
        if (bodyEl) {
          bodyEl.textContent = fullyHotReloaded
            ? t('update.doneHotFull', { ver: nextDisplayVer })
            : (res.liveInjected ? t('update.doneHot', { ver: nextDisplayVer }) : t('update.doneDisk', { ver: nextDisplayVer }));
        }
        if (applyBtn) {
          applyBtn.textContent = t('update.btnUpdated');
          applyBtn.disabled = false;
        }
        if (restartBtn) {
          const showRestart = Boolean(!fullyHotReloaded && hostSupportsRestart);
          restartBtn.hidden = !showRestart;
          if (restartBtn.style) restartBtn.style.display = showRestart ? 'inline-block' : 'none';
        }

        if (fullyHotReloaded) {
          if (statusEl) statusEl.textContent = t('update.doneHotFull', { ver: nextDisplayVer });
          if (backendStatus.backendVersion === nextVer) {
            backendStatus.backendVersionMismatch = false;
          }
        } else if (res.liveInjected) {
          if (statusEl) statusEl.textContent = t('update.doneHot', { ver: nextDisplayVer });
        } else {
          if (statusEl) {
            statusEl.textContent = hostSupportsRestart
              ? t('update.doneDisk', { ver: nextDisplayVer })
              : `${t('update.doneDisk', { ver: nextDisplayVer })} ${t('client.restart.hostNotSupported')}`;
          }
        }
        if (typeof renderQuotaBoard === 'function') {
          renderQuotaBoard(Date.now(), { animate: false });
        }
      } else {
        if (statusEl) statusEl.textContent = t('update.failStatus', { err: translateBackendText(res?.error) || t('models.meta.archUnknown') });
        if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('update.btnRetry'); }
      }
    } catch (err) {
      if (statusEl) statusEl.textContent = t('update.errStatus', { err: translateBackendText(err.message) });
      if (applyBtn) { applyBtn.disabled = false; applyBtn.textContent = t('update.btnRetry'); }
    }
  }

  el('btn-github-repo')?.addEventListener('click', () => openGithubRepo());
  el('btn-github-repo-ctx')?.addEventListener('click', () => openGithubRepo());
  el('btn-check-update')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop && pop.style.display === 'block' && currentUpdateTrigger === 'tokens') {
      pop.style.display = 'none';
    } else {
      void checkAppUpdate(true, 'tokens');
    }
  });
  el('btn-check-update-ctx')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop && pop.style.display === 'block' && currentUpdateTrigger === 'ctx') {
      pop.style.display = 'none';
    } else {
      void checkAppUpdate(true, 'ctx');
    }
  });
  el('btn-close-update-pop')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop) pop.style.display = 'none';
  });
  el('btn-update-later')?.addEventListener('click', () => {
    const pop = el('update-popover');
    if (pop) pop.style.display = 'none';
  });
  el('btn-view-release-page')?.addEventListener('click', () => {
    openGithubRepo(cachedLatestRelease?.tagName ? `/releases/tag/${cachedLatestRelease.tagName}` : '/releases');
  });
  el('btn-apply-update')?.addEventListener('click', () => void applyAppUpdate());
  const btnUpdateRestartInit = el('btn-update-restart');
  if (btnUpdateRestartInit) {
    btnUpdateRestartInit.hidden = true;
    if (btnUpdateRestartInit.style) btnUpdateRestartInit.style.display = 'none';
    btnUpdateRestartInit.addEventListener('click', () => {
      hideUpdatePopover();
      openClientRestartConfirmFlow();
    });
  }

  el('check-auto-update')?.addEventListener('change', e => {
    autoCheckUpdate = e.target.checked;
    if (typeof window?.contextMeterAPI?.saveSettings === 'function' || hasLiveHttpBridge()) {
      void saveSettingsPayloadBridge({ autoCheckUpdate });
    }
  });

  /* @INSERT_HEATMAP_MODULE */
  function updateRingAndBubble(d, session, pct, danger, stale, incomplete) {
    const ringFill = el('ring-fill');
    const tipTitle = el('ctx-tip-title');
    const tipPct = el('ctx-tip-pct');
    const tipDetail = el('ctx-tip-detail');

    // 区分常态颜色与高占用告警状态
    let occupancy = 'normal';
    if (danger || (pct != null && pct >= 90)) {
      occupancy = 'danger';
    } else if ((pct != null && pct >= 75) || stale) {
      occupancy = 'warn';
    }
    host.setAttribute('data-occupancy', occupancy);

    // 1. 圆环进度与未知容量状态表达（未知容量绝不画成 0% 或 100%）
    if (ringFill) {
      if (d?.exceeded) {
        ringFill.setAttribute('data-ring-state', 'exceeded');
        ringFill.setAttribute('stroke-dasharray', `${RING_CIRCUMFERENCE.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`);
        ringFill.style.opacity = '1';
      } else if (pct != null) {
        ringFill.setAttribute('data-ring-state', 'determinate');
        if (pct <= 0) {
          ringFill.setAttribute('stroke-dasharray', `0 ${RING_CIRCUMFERENCE.toFixed(2)}`);
          ringFill.style.opacity = '0';
        } else {
          const arcLen = Math.max(1.8, (Math.min(100, pct) / 100) * RING_CIRCUMFERENCE);
          ringFill.setAttribute('stroke-dasharray', `${arcLen.toFixed(2)} ${RING_CIRCUMFERENCE.toFixed(2)}`);
          ringFill.style.opacity = '1';
        }
      } else {
        // 容量未知 / 仅估算 / 尚未就绪：使用均匀虚线环段表示非确定比例，不画成 0% 空环或 100% 满环
        ringFill.setAttribute('data-ring-state', d?.estimated ? 'estimated' : 'unknown');
        ringFill.setAttribute('stroke-dasharray', '3.2 4.97');
        ringFill.style.opacity = '0.55';
      }
    }

    // 2. 悬停信息气泡三层文案（标题 — 使用比例 — 用量与容量）
    if (!tipTitle || !tipPct || !tipDetail) return;

    const disp = resolveDisplayStatus(d, session);
    if (disp.isError || disp.kind === 'canceled') {
      tipTitle.textContent = disp.tipTitle;
      tipPct.textContent = disp.tipPct;
      tipDetail.textContent = disp.tipDetail;
    } else if (stale && d?.actual != null && d?.budget) {
      const usedRound = Math.min(100, Math.max(0, Math.round((d.actual / d.budget) * 100)));
      const remRound = Math.max(0, 100 - usedRound);
      tipTitle.textContent = t('tip.title.stale');
      tipPct.textContent = t('tip.pct.staleVal', { used: usedRound, rem: remRound });
      tipDetail.textContent = t('tip.detail.usedOfBudget', { used: fmtBubbleToken(d.actual), budget: fmtBubbleToken(d.budget), inc: '' });
    } else if (stale) {
      tipTitle.textContent = t('tip.title.stale');
      tipPct.textContent = t('tip.pct.staleUnknown');
      tipDetail.textContent = session?.total
        ? t('tip.detail.sessionEst', { low: fmtBubbleToken(session.total.low), high: fmtBubbleToken(session.total.high) })
        : t('tip.detail.waitBg');
    } else if (d?.actual != null && d?.budget) {
      const rawPct = pct != null ? pct : (d.actual / d.budget) * 100;
      const usedRound = rawPct > 0 && rawPct < 1 ? 1 : Math.min(100, Math.max(0, Math.round(rawPct)));
      const remRound = Math.max(0, 100 - usedRound);
      if (rawPct >= 90) {
        tipTitle.textContent = t('tip.title.high90');
        tipPct.textContent = t('tip.pct.high90', { used: usedRound, rem: remRound });
      } else if (rawPct >= 75) {
        tipTitle.textContent = t('tip.title.high75');
        tipPct.textContent = t('tip.pct.high75', { used: usedRound, rem: remRound });
      } else {
        tipTitle.textContent = t('tip.title.normal');
        tipPct.textContent = t('tip.pct.normal', { used: usedRound, rem: remRound });
      }
      tipDetail.textContent = t('tip.detail.usedOfBudget', {
        used: fmtBubbleToken(d.actual),
        budget: fmtBubbleToken(d.budget),
        inc: incomplete ? t('tip.detail.incSuffix') : ''
      });
    } else if (d?.actual != null && !d?.budget) {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.noBudget');
      tipDetail.textContent = t('tip.detail.usedNoBudget', { used: fmtBubbleToken(d.actual) });
    } else if (d?.estimated || d?.estimate != null) {
      tipTitle.textContent = t('tip.title.est');
      tipPct.textContent = t('tip.pct.estOnly');
      const budgetPart = d.budget ? t('tip.detail.estBudgetPart', { budget: fmtBubbleToken(d.budget) }) : t('tip.detail.estNoBudgetPart');
      tipDetail.textContent = t('tip.detail.estUsed', { used: fmtBubbleToken(d.estimate), budget: budgetPart });
    } else if (session?.total) {
      tipTitle.textContent = t('tip.title.est');
      tipPct.textContent = t('tip.pct.waitStats');
      tipDetail.textContent = t('tip.detail.sessionCum', { low: fmtBubbleToken(session.total.low), high: fmtBubbleToken(session.total.high) });
    } else {
      tipTitle.textContent = t('tip.title.normal');
      tipPct.textContent = t('tip.pct.notReady');
      tipDetail.textContent = t('tip.detail.readingSession');
    }

    if (state.tooltipOpen) positionContextTooltip();
  }

  function stopLiveWaitTickTimer() {
    if (state.liveWaitTickTimer) {
      clearInterval(state.liveWaitTickTimer);
      state.liveWaitTickTimer = null;
    }
  }

  function clearLivePendingRequestWait() {
    state.livePendingRequest = null;
    stopLiveWaitTickTimer();
  }
  earlyDisposeHooks.push(clearLivePendingRequestWait);

  function resolveSpeedEvaluationInput() {
    if (state.speedOverrideForTest && typeof state.speedOverrideForTest === 'object') {
      return state.speedOverrideForTest;
    }
    if (state.livePendingRequest && state.route && state.livePendingRequest.cascadeId === state.route) {
      const elapsedSec = Math.max(0, (Date.now() - state.livePendingRequest.startedAtMs) / 1000);
      return {
        phase: 'waiting',
        status: 'waiting',
        elapsedSec
      };
    }
    const d = state.latest;
    if (!d) return { phase: 'idle', status: 'idle' };
    const latestRec = resolveLatestSessionCallRecord();
    const sameActiveCall = latestRec && (!d.speed || !latestRec.outputTokens || Math.abs(Number(latestRec.outputTokens) - Number(d.speed?.outputTokens || 0)) <= 50 || latestRec.status === 'streaming');
    const trackedSamples = (latestRec && state.streamSampleTracker?.byCallId?.get?.(latestRec.callId)) || null;

    if (d.status === 'canceled' || d.errorClassification?.kind === 'canceled') {
      return {
        phase: 'canceled',
        status: 'canceled',
        outcomeStatus: 'canceled',
        ttftSec: d.speed?.ttft ?? null,
        totalDurationSec: d.speed?.duration ?? null,
        outputTokens: d.speed?.outputTokens ?? null,
        error: d.error || ''
      };
    }
    if (d.exceeded || d.network || d.error || ['failed', 'quota_exhausted', 'rate_limited', 'auth_error', 'service_unavailable'].includes(d.status)) {
      return {
        phase: 'failed',
        status: d.status || 'failed',
        outcomeStatus: d.status || 'failed',
        ttftSec: d.speed?.ttft ?? null,
        totalDurationSec: d.speed?.duration ?? null,
        outputTokens: d.speed?.outputTokens ?? null,
        error: d.error || ''
      };
    }
    if (latestRec && latestRec.status === 'streaming' && latestRec.outputTokens > 0) {
      return {
        phase: 'streaming',
        status: 'streaming',
        ttftSec: latestRec.ttftSec ?? d.speed?.ttft ?? null,
        streamingSec: latestRec.streamingSec ?? d.speed?.streamingSec ?? trackedSamples?.elapsedStreamSec ?? null,
        totalDurationSec: latestRec.durationSec ?? d.speed?.duration ?? null,
        streamSpeed: latestRec.streamingTps ?? d.speed?.streamingTps ?? null,
        overallTps: latestRec.tps ?? d.speed?.tps ?? null,
        outputTokens: latestRec.outputTokens ?? d.speed?.outputTokens ?? 0,
        totalInputTokens: latestRec.totalInputTokens ?? d.input ?? null,
        chunkCount: trackedSamples?.chunks ?? latestRec.chunkCount ?? null,
        chunkIntervalsMs: trackedSamples?.intervalsMs ?? latestRec.chunkIntervalsMs ?? null
      };
    }
    if (d.speed) {
      return {
        phase: 'final',
        status: 'final',
        ttftSec: d.speed.ttft ?? null,
        streamingSec: d.speed.streamingSec ?? null,
        totalDurationSec: d.speed.duration ?? null,
        streamSpeed: d.speed.streamingTps ?? d.speed.streamSpeed ?? null,
        overallTps: d.speed.tps ?? null,
        outputTokens: d.speed.outputTokens ?? null,
        totalInputTokens: d.speed.totalInputTokens ?? d.input ?? null,
        chunkCount: (sameActiveCall && trackedSamples?.chunks) || (sameActiveCall && latestRec?.chunkCount) || null,
        chunkIntervalsMs: (sameActiveCall && trackedSamples?.intervalsMs) || (sameActiveCall && latestRec?.chunkIntervalsMs) || null
      };
    }
    if (latestRec && (latestRec.ttftSec != null || latestRec.durationSec != null || latestRec.outputTokens > 0)) {
      return {
        phase: latestRec.status === 'streaming' ? 'streaming' : 'final',
        status: latestRec.status,
        ttftSec: latestRec.ttftSec ?? null,
        streamingSec: latestRec.streamingSec ?? null,
        totalDurationSec: latestRec.durationSec ?? null,
        streamSpeed: latestRec.streamingTps ?? null,
        overallTps: latestRec.tps ?? null,
        outputTokens: latestRec.outputTokens ?? null,
        totalInputTokens: latestRec.totalInputTokens ?? null,
        chunkCount: trackedSamples?.chunks ?? latestRec.chunkCount ?? null,
        chunkIntervalsMs: trackedSamples?.intervalsMs ?? latestRec.chunkIntervalsMs ?? null
      };
    }
    return { phase: 'idle', status: 'idle' };
  }

  function applyElv91PillTone(badgeEl, evalRes) {
    if (!badgeEl || !evalRes?.badge) return;
    const sev = evalRes.badge.severity || 'neutral';
    const cls = (sev === 'good' || sev === 'fast' || sev === 'rapid' || sev === 'epic')
      ? 'pill-good'
      : (sev === 'warn' ? 'pill-warn' : ((sev === 'danger' || sev === 'critical') ? 'pill-danger' : 'pill-muted'));
    badgeEl.className = `key-pill ${cls}`;
    badgeEl.style.color = evalRes.badge.color || '';
    badgeEl.textContent = `${evalRes.badge.glyph ? evalRes.badge.glyph + ' ' : ''}${evalRes.badge.text}`;
  }

  const SPEED_BARPLOT_BAR_COUNT = 10;
  let speedBarplotSamples = new Array(SPEED_BARPLOT_BAR_COUNT).fill(0);
  let speedBarplotLastOutputTokens = 0;
  let speedBarplotLastCallKey = '';
  let speedBarplotTimer = null;
  let speedBarplotLastEval = null;
  let speedBarplotTickPhase = 0;

  function stopSpeedBarplotTicker() {
    if (speedBarplotTimer) {
      clearInterval(speedBarplotTimer);
      speedBarplotTimer = null;
    }
  }

  function ensureSpeedBarplotBars() {
    const barplot = el('speed-barplot');
    if (!barplot) return [];
    const cur = barplot.children ? Array.from(barplot.children) : [];
    if (cur.length >= SPEED_BARPLOT_BAR_COUNT) return cur.slice(0, SPEED_BARPLOT_BAR_COUNT);
    if (typeof barplot.appendChild === 'function' && typeof document?.createElement === 'function') {
      const needed = Math.max(0, SPEED_BARPLOT_BAR_COUNT - cur.length);
      for (let i = 0; i < needed; i++) {
        const b = document.createElement('span');
        b.className = 'speed-barplot-bar';
        try { barplot.appendChild(b); } catch { }
      }
      return barplot.children ? Array.from(barplot.children).slice(0, SPEED_BARPLOT_BAR_COUNT) : [];
    }
    return cur;
  }

  function renderSpeedBarplotBars(phase, activeColor) {
    const badge = el('badge-speed');
    const barplot = el('speed-barplot');
    if (badge) {
      badge.setAttribute?.('data-phase', phase || 'idle');
      badge.setAttribute?.('data-streaming', phase === 'streaming' ? 'true' : 'false');
    }
    if (barplot?.style) barplot.style.color = activeColor || '';
    if (!barplot) return;

    const styleMode = typeof getToolbarPrefs === 'function' ? getToolbarPrefs().speedChart : 'area';
    const maxVal = Math.max(10, ...speedBarplotSamples);

    if (styleMode === 'area') {
      const W = 36, H = 14, n = speedBarplotSamples.length;
      const pts = speedBarplotSamples.map((v, i) => {
        const val = Number(v) || 0;
        const y = val > 0 ? Math.max(1.5, H - 1.5 - (val / maxVal) * (H - 3.5)) : H - 2;
        const x = n > 1 ? (i / (n - 1)) * W : W / 2;
        return [x, y];
      });
      let lineD = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const mx = ((x0 + x1) / 2).toFixed(1);
        lineD += ` Q ${x0.toFixed(1)} ${y0.toFixed(1)}, ${mx} ${((y0 + y1) / 2).toFixed(1)}`;
        if (i === pts.length - 1) lineD += ` T ${x1.toFixed(1)} ${y1.toFixed(1)}`;
      }
      const areaD = `${lineD} L ${W} ${H} L 0 ${H} Z`;
      const stroke = activeColor || 'currentColor';
      barplot.innerHTML = `<svg class="speed-areaplot" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">`
        + `<defs><linearGradient id="cb-sp-grad" x1="0" y1="0" x2="0" y2="1">`
        + `<stop offset="0%" stop-color="${stroke}" stop-opacity="0.42"/><stop offset="100%" stop-color="${stroke}" stop-opacity="0.04"/>`
        + `</linearGradient></defs>`
        + `<path d="${areaD}" fill="url(#cb-sp-grad)" stroke="none"/>`
        + `<path d="${lineD}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`
        + `</svg>`;
      return;
    }

    if (barplot.querySelector?.('.speed-areaplot')) barplot.innerHTML = '';
    const bars = ensureSpeedBarplotBars();
    if (!bars.length) return;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (!bar?.style) continue;
      const val = Number(speedBarplotSamples[i]) || 0;
      const hPct = val > 0 ? Math.max(20, Math.min(100, Math.round((val / maxVal) * 100))) : 16;
      const opac = val > 0
        ? (phase === 'streaming' ? (0.45 + (i / 9) * 0.55) : (0.38 + (i / 9) * 0.48))
        : 0.22;
      bar.style.height = `${hPct}%`;
      bar.style.opacity = opac.toFixed(2);
    }
  }

  function pushSpeedBarplotSample(val) {
    const num = Math.max(0, Number(val) || 0);
    speedBarplotSamples.shift();
    speedBarplotSamples.push(num);
  }

  function resetSpeedBarplotState() {
    stopSpeedBarplotTicker();
    speedBarplotSamples = new Array(SPEED_BARPLOT_BAR_COUNT).fill(0);
    speedBarplotLastOutputTokens = 0;
    speedBarplotLastCallKey = '';

    speedBarplotLastEval = null;
    speedBarplotTickPhase = 0;
    renderSpeedBarplotBars('idle', '');
  }

  function tickSpeedBarplotStream() {
    if (state.disposed || !speedBarplotLastEval || speedBarplotLastEval.phase !== 'streaming') {
      stopSpeedBarplotTicker();
      return;
    }
    speedBarplotTickPhase = (speedBarplotTickPhase + 1) % 6;
    const tps = Number(speedBarplotLastEval.streamSpeed) || Number(speedBarplotLastEval.overallTps) || 18;
    const baseSlice = Math.max(1, Math.round(tps * 0.24));
    const lastSample = speedBarplotSamples[SPEED_BARPLOT_BAR_COUNT - 1] || baseSlice;
    const waveFactor = [0.85, 1.0, 1.15, 0.92, 1.08, 0.96][speedBarplotTickPhase];
    const nextBar = Math.max(1, Math.round((lastSample * 0.35) + (baseSlice * 0.65 * waveFactor)));
    pushSpeedBarplotSample(nextBar);
    renderSpeedBarplotBars('streaming', speedBarplotLastEval.badge?.color || '');
  }

  function seedIdleOrFinalBarplot(evalRes) {
    const calls = Array.isArray(state.sessionCalls) ? state.sessionCalls : [];
    const recent = calls.slice(-SPEED_BARPLOT_BAR_COUNT).map(c => Number(c?.outputTokens || c?.totalTokens || 0));
    if (recent.some(v => v > 0)) {
      const padded = new Array(Math.max(0, SPEED_BARPLOT_BAR_COUNT - recent.length)).fill(0).concat(recent);
      speedBarplotSamples = padded.slice(-SPEED_BARPLOT_BAR_COUNT);
      return;
    }
    const outTok = Math.max(0, Number(evalRes?.outputTokens) || 0);
    if (outTok > 0) {
      speedBarplotSamples = new Array(SPEED_BARPLOT_BAR_COUNT).fill(0);
      speedBarplotSamples[SPEED_BARPLOT_BAR_COUNT - 1] = outTok;
    }
  }

  function updateSpeedBarplot(evalRes) {
    if (!evalRes) return;
    const phase = evalRes.phase || 'idle';
    const activeColor = evalRes.badge?.color || '';
    const latestRec = typeof resolveLatestSessionCallRecord === 'function' ? resolveLatestSessionCallRecord() : null;
    const callKey = latestRec?.callId || '';
    if (callKey && callKey !== speedBarplotLastCallKey) {
      speedBarplotLastCallKey = callKey;
      speedBarplotLastOutputTokens = 0;
    }
    speedBarplotLastEval = evalRes;

    if (phase === 'streaming') {
      const outTok = Math.max(0, Number(evalRes.outputTokens) || 0);
      if (outTok > speedBarplotLastOutputTokens) {
        const delta = outTok - speedBarplotLastOutputTokens;
        speedBarplotLastOutputTokens = outTok;
        pushSpeedBarplotSample(delta);
      } else if (outTok < speedBarplotLastOutputTokens) {
        speedBarplotLastOutputTokens = outTok;
        if (outTok > 0) pushSpeedBarplotSample(outTok);
      } else if (speedBarplotSamples.every(v => v === 0)) {
        const tps = Number(evalRes.streamSpeed) || Number(evalRes.overallTps) || 18;
        pushSpeedBarplotSample(Math.max(1, Math.round(tps * 0.24)));
      }
      if (!speedBarplotTimer && !prefersReducedMotionNow()) {
        speedBarplotTimer = setInterval(tickSpeedBarplotStream, 240);
      }
      renderSpeedBarplotBars('streaming', activeColor);
      return;
    }

    stopSpeedBarplotTicker();
    if (phase === 'final') {
      const outTok = Math.max(0, Number(evalRes.outputTokens) || 0);
      if (outTok > speedBarplotLastOutputTokens && speedBarplotSamples.some(v => v > 0)) {
        pushSpeedBarplotSample(outTok - speedBarplotLastOutputTokens);
        speedBarplotLastOutputTokens = outTok;
      } else if (speedBarplotSamples.every(v => v === 0)) {
        seedIdleOrFinalBarplot(evalRes);
      }
      renderSpeedBarplotBars('final', activeColor);
      return;
    }

    if (phase === 'idle' && speedBarplotSamples.every(v => v === 0)) {
      seedIdleOrFinalBarplot(evalRes);
    }
    renderSpeedBarplotBars(phase, activeColor);
  }

  function renderSpeedExperienceInPlace(evalRes) {
    if (!evalRes) return;
    const isEn = currentPanelLanguage === 'en';
    const isTw = currentPanelLanguage === 'zh-TW';
    const activeColor = evalRes.badge?.color || '';

    updateSpeedBarplot(evalRes);

    const speedAmount = el('speed-amount');
    const overflowSpeedVal = el('overflow-speed-val');
    const topBolt = el('badge-speed-icon');
    const cardBolt = el('speed-summary-bolt');
    if (topBolt) topBolt.style.color = activeColor;
    if (cardBolt) cardBolt.style.color = activeColor;
    if (topBolt && evalRes.badge?.glyph) topBolt.textContent = evalRes.badge.glyph;
    if (cardBolt && evalRes.badge?.glyph) cardBolt.textContent = evalRes.badge.glyph;

    const isCompact = state.layoutMode === 'compact';
    const shortSampleText = t('session.speed.shortSampleBadge');
    if (speedAmount) {
      if (evalRes.phase === 'waiting') {
        speedAmount.textContent = isCompact ? evalRes.elapsedFormatted : (isEn ? `Wait ${evalRes.elapsedFormatted}` : `等待 ${evalRes.elapsedFormatted}`);
        if (overflowSpeedVal) overflowSpeedVal.textContent = `${evalRes.elapsedFormatted}`;
      } else if (evalRes.isSampleSparse) {
        speedAmount.textContent = shortSampleText;
        if (overflowSpeedVal) overflowSpeedVal.textContent = shortSampleText;
      } else if (evalRes.streamSpeed != null) {
        speedAmount.textContent = isCompact ? `${evalRes.streamSpeed}` : `${evalRes.streamSpeed} tok/s`;
        if (overflowSpeedVal) overflowSpeedVal.textContent = `${evalRes.streamSpeed} tok/s`;
      } else if (evalRes.overallTps != null) {
        speedAmount.textContent = isCompact ? `${evalRes.overallTps}` : `${evalRes.overallTps} tok/s`;
        if (overflowSpeedVal) overflowSpeedVal.textContent = `${evalRes.overallTps} tok/s`;
      } else {
        speedAmount.textContent = isCompact ? '--' : '-- tok/s';
        if (overflowSpeedVal) overflowSpeedVal.textContent = '-- tok/s';
      }
    }

    const spBadge = el('speed-badge');
    const spVal = el('speed-val');
    const spDur = el('speed-duration');
    const spTtft = el('speed-ttft');
    const spTokens = el('speed-tokens');
    const spSub = el('speed-sub-label');
    const spTakeaway = el('speed-takeaway');
    const spToggleBtn = el('btn-speed-breakdown-toggle');
    const spBreakdownDet = el('speed-breakdown-details');
    const spBreakdownGrid = el('speed-breakdown-grid');

    const spMockTag = el('speed-mock-tag');
    if (spMockTag) {
      spMockTag.hidden = !(state.speedOverrideForTest && typeof state.speedOverrideForTest === 'object');
      if (!spMockTag.hidden) spMockTag.textContent = t('session.speed.mockTag');
    }
    if (spBadge) applyElv91PillTone(spBadge, evalRes);
    if (spVal) {
      if (evalRes.phase === 'waiting') {
        spVal.textContent = isEn ? 'Waiting' : '等待首字';
      } else if (evalRes.isSampleSparse) {
        spVal.textContent = shortSampleText;
      } else if (evalRes.streamSpeed != null) {
        spVal.textContent = `${evalRes.streamSpeed} tok/s`;
      } else if (evalRes.overallTps != null) {
        spVal.textContent = `${evalRes.overallTps} tok/s`;
      } else {
        spVal.textContent = '—';
      }
    }
    if (spDur) spDur.textContent = evalRes.durationFormatted || '—';
    if (spTtft) spTtft.textContent = evalRes.ttftFormatted || '—';
    if (spTokens) spTokens.textContent = evalRes.outputTokens != null ? `${fmt(evalRes.outputTokens)} tok` : '—';

    if (spSub) {
      if (evalRes.subLabel && evalRes.phase !== 'idle') {
        spSub.hidden = false;
        spSub.textContent = evalRes.subLabel;
      } else {
        spSub.hidden = true;
        spSub.textContent = '';
      }
    }
    if (spTakeaway) {
      const avgNote = (evalRes.phase === 'final' && evalRes.overallTps != null && (evalRes.isSampleSparse || (evalRes.streamSpeed != null && Math.abs(evalRes.overallTps - evalRes.streamSpeed) >= 5)))
        ? (isEn ? ` (Overall avg ${evalRes.overallTps} tok/s)` : (isTw ? `（整體均速 ${evalRes.overallTps} tok/s）` : `（整体均速 ${evalRes.overallTps} tok/s）`))
        : '';
      spTakeaway.textContent = `${evalRes.comment || ''}${avgNote}`;
    }

    const canShowBreakdown = evalRes.phase === 'final' || evalRes.phase === 'streaming';
    if (spToggleBtn) {
      spToggleBtn.hidden = !canShowBreakdown;
      spToggleBtn.textContent = state.speedBreakdownOpen ? t('session.speed.hideDetails') : t('session.speed.details');
      spToggleBtn.setAttribute?.('aria-expanded', state.speedBreakdownOpen ? 'true' : 'false');
    }
    if (spBreakdownDet) {
      spBreakdownDet.style.display = (canShowBreakdown && state.speedBreakdownOpen) ? 'block' : 'none';
    }
    if (spBreakdownGrid && canShowBreakdown && state.speedBreakdownOpen) {
      spBreakdownGrid.replaceChildren();
      const unk = t('session.latestCall.unknownVal');
      const eText = evalRes.efficiency?.available
        ? `${evalRes.efficiency.score} ${isEn ? 'pts' : '分'} · ${evalRes.efficiency.tier?.title || evalRes.efficiency.grade}`
        : (evalRes.efficiency?.skippedReason === 'insufficient_sample' ? t('session.speed.scoreSkippedSparse') : t('session.speed.scoreSkippedMissing'));
      const stabText = evalRes.stability?.isStable
        ? t('session.speed.stabilityOk', { n: evalRes.stability.chunks, cv: evalRes.stability.intervalCv })
        : (evalRes.stability?.reason === 'high_variance'
          ? t('session.speed.stabilityHighVar', { n: evalRes.stability.chunks, cv: evalRes.stability.intervalCv })
          : t('session.speed.stabilityUnverified'));
      const fmtTierComment = (tier, elapsed) => (tier && tier.comment) ? String(tier.comment).replace('{elapsed}', elapsed || '—') : '';
      const streamCellVal = evalRes.isSampleSparse
        ? `${shortSampleText}${evalRes.shortWindowEstimateSpeed != null ? ` (${evalRes.shortWindowEstimateSpeed} tok/s)` : ''}`
        : (evalRes.speedTier ? `${evalRes.streamSpeed} tok/s · ${evalRes.speedTier.title}` : unk);
      const cells = [
        {
          k: t('session.speed.breakdown.eScore'),
          v: eText,
          color: evalRes.efficiency?.tier?.color || null,
          note: evalRes.efficiency?.tier?.comment || ''
        },
        {
          k: t('session.speed.breakdown.ttft'),
          v: evalRes.ttftTier ? `${evalRes.ttftFormatted} · ${evalRes.ttftTier.title}${evalRes.ttftRatioPct != null ? ` (${evalRes.ttftRatioPct}%)` : ''}` : unk,
          color: evalRes.ttftTier?.color || null,
          note: fmtTierComment(evalRes.ttftTier, evalRes.ttftFormatted)
        },
        {
          k: t('session.speed.breakdown.stream'),
          v: streamCellVal,
          color: evalRes.isSampleSparse ? null : (evalRes.speedTier?.color || null),
          note: evalRes.isSampleSparse ? t('session.speed.shortWindowNote') : (evalRes.speedTier?.comment || '')
        },
        {
          k: t('session.speed.breakdown.duration'),
          v: evalRes.durationTier ? `${evalRes.durationFormatted} · ${evalRes.durationTier.title}` : unk,
          color: evalRes.durationTier?.color || null,
          note: evalRes.durationTier?.comment || ''
        },
        { k: t('session.speed.breakdown.overall'), v: evalRes.overallTps != null ? `${evalRes.overallTps} tok/s` : unk, color: null, note: '' },
        { k: t('session.speed.breakdown.stability'), v: stabText, color: evalRes.stability?.isStable ? '#10B981' : null, note: '' }
      ];
      if (evalRes.isSampleSparse && evalRes.shortWindowEstimateSpeed != null) {
        cells.splice(3, 0, {
          k: t('session.speed.shortWindowEst'),
          v: `${evalRes.shortWindowEstimateSpeed} tok/s`,
          color: null,
          note: t('session.speed.shortWindowNote')
        });
      }
      if (evalRes.efficiency?.basis) {
        const b = evalRes.efficiency.basis;
        cells.push({
          k: t('session.speed.breakdown.basis'),
          v: `N=${b.N_work} · γ=${b.gamma} · w=[${b.w1}/${b.w2}/${b.w3}]`,
          color: null,
          note: ''
        });
      }
      for (const item of cells) {
        const cell = document.createElement('div');
        cell.className = 'call-detail-cell';
        const kEl = document.createElement('span');
        kEl.className = 'call-detail-k';
        kEl.textContent = item.k;
        const vEl = document.createElement('span');
        vEl.className = 'call-detail-v';
        if (item.color) {
          const dot = document.createElement('span');
          dot.className = 'tier-color-swatch';
          dot.style.backgroundColor = item.color;
          dot.setAttribute('aria-hidden', 'true');
          vEl.appendChild(dot);
          const txtEl = document.createElement('span');
          txtEl.textContent = item.v;
          vEl.appendChild(txtEl);
        } else {
          vEl.textContent = item.v;
        }
        cell.appendChild(kEl);
        cell.appendChild(vEl);
        if (item.note) {
          const noteEl = document.createElement('span');
          noteEl.className = 'call-detail-note';
          noteEl.textContent = item.note;
          cell.appendChild(noteEl);
        }
        spBreakdownGrid.appendChild(cell);
      }
    }
    state.lastSpeedEval = evalRes;
  }

  function startLivePendingRequestWait(cascadeId) {
    const cid = cascadeId || state.route;
    if (!cid) return;
    const latestRec = resolveLatestSessionCallRecord();
    state.livePendingRequest = {
      cascadeId: cid,
      startedAtMs: Date.now(),
      baselineCallId: latestRec?.callId || null,
      baselineCount: state.count || 0
    };
    const updateWaitOnly = () => {
      if (state.disposed || !state.livePendingRequest || state.livePendingRequest.cascadeId !== state.route) {
        stopLiveWaitTickTimer();
        return;
      }
      if (typeof evaluateGenerationExperience === 'function') {
        renderSpeedExperienceInPlace(evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage));
      }
    };
    updateWaitOnly();
    stopLiveWaitTickTimer();
    state.liveWaitTickTimer = setInterval(updateWaitOnly, 1000);
  }

  function syncSpeedBadgeText() {
    if (typeof evaluateGenerationExperience === 'function') {
      const evalRes = evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage);
      renderSpeedExperienceInPlace(evalRes);
      return;
    }
    const sp = state.latest?.speed;
    const speedAmount = el('speed-amount');
    const overflowSpeedVal = el('overflow-speed-val');
    if (!speedAmount) return;
    const isCompact = state.layoutMode === 'compact';
    if (sp?.tps != null) {
      speedAmount.textContent = isCompact ? `${sp.tps}` : `${sp.tps} tok/s`;
      if (overflowSpeedVal) overflowSpeedVal.textContent = `${sp.tps} tok/s`;
    } else if (state.requestBusy) {
      const calcText = t('badge.speedCalc');
      speedAmount.textContent = isCompact ? '…' : calcText;
      if (overflowSpeedVal) overflowSpeedVal.textContent = calcText;
    } else {
      speedAmount.textContent = isCompact ? '--' : '-- tok/s';
      if (overflowSpeedVal) overflowSpeedVal.textContent = '-- tok/s';
    }
  }

  let lastCallCardLang = '';
  let timelineFetchController = null;
  let timelineFetchSeq = 0;

  function prefersReducedMotionNow() {
    try {
      return Boolean(typeof globalThis.matchMedia === 'function' && globalThis.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function formatCallTimeStr(call) {
    if (!call) return '—';
    const rawTs = call.timestamp || (call.created_at ? Date.parse(call.created_at) : NaN);
    if (!Number.isFinite(rawTs) || rawTs <= 0) return t('session.latestCall.unknownVal');
    try {
      return new Date(rawTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch {
      return new Date(rawTs).toLocaleTimeString();
    }
  }

  function formatCallModelTitle(call) {
    if (!call) return t('session.latestCall.unknownVal');
    if (call.isPlaceholderOnly && !call.isRoutedModelVerified) {
      const rawId = call.rawPlaceholderId || call.modelExactId || call.model || '';
      return rawId ? t('session.latestCall.unknownMappedModel', { id: rawId }) : t('session.latestCall.unknownVal');
    }
    const rawLbl = call.modelLabel || (call.model && !/^model_/i.test(String(call.model)) ? String(call.model) : '');
    if (rawLbl) {
      if (typeof splitModelDisplayAndEffort === 'function') {
        const split = splitModelDisplayAndEffort(rawLbl, call.effort);
        if (split.baseLabel) return split.baseLabel;
      }
      return rawLbl;
    }
    if (call.stableModelId && !/^model_placeholder_/i.test(String(call.stableModelId))) return String(call.stableModelId);
    if (call.modelExactId && !/^model_placeholder_/i.test(String(call.modelExactId))) return String(call.modelExactId);
    if (call.model && !/^model_placeholder_/i.test(String(call.model))) return String(call.model);
    if (call.rawPlaceholderId || call.modelExactId || call.model) {
      return t('session.latestCall.unknownMappedModel', { id: call.rawPlaceholderId || call.modelExactId || call.model });
    }
    return t('session.latestCall.unknownVal');
  }

  function buildCallDisplaySignature(call) {
    if (!call) return '';
    return [
      call.callId || '',
      call.outcomeStatus || call.status || '',
      call.inputTokens ?? '',
      call.cacheReadTokens ?? '',
      call.outputTokens ?? '',
      call.totalTokens ?? '',
      call.modelExactId || call.model || '',
      call.modelLabel || '',
      call.effort || '',
      call.durationSec ?? '',
      call.ttftSec ?? '',
      call.error || '',
      call.agentRole || ''
    ].join('|');
  }

  function resolveLatestSessionCallRecord() {
    if (!state.route) return null;
    const rawPool = [];
    if (Array.isArray(state.sessionCalls)) {
      for (const c of state.sessionCalls) {
        if (c) rawPool.push(c);
      }
    }
    if (Array.isArray(state.scan?.recentGeneratorCalls)) {
      for (const c of state.scan.recentGeneratorCalls) {
        if (c) rawPool.push(c);
      }
    }
    if (state.scan?.latestCallRecord) {
      rawPool.push(state.scan.latestCallRecord);
    }
    if (!rawPool.length) return null;

    const mergedById = new Map();
    const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
    for (const raw of rawPool) {
      const norm = typeof normalizeSessionCallRecord === 'function'
        ? normalizeSessionCallRecord(raw, { cascadeId: state.route, cascadeModelConfigs: configs })
        : raw;
      if (!norm || !norm.callId) continue;
      const prev = mergedById.get(norm.callId);
      if (!prev) {
        mergedById.set(norm.callId, norm);
        continue;
      }
      // 同一 callId 从不同源补齐耗时、精确模型或状态，不产生第二条
      mergedById.set(norm.callId, {
        ...prev,
        ...norm,
        modelExactId: norm.modelExactId || prev.modelExactId || null,
        modelLabel: norm.modelLabel || prev.modelLabel || null,
        effort: norm.effort || prev.effort || null,
        ttftSec: norm.ttftSec ?? prev.ttftSec ?? null,
        durationSec: norm.durationSec ?? prev.durationSec ?? null,
        tps: norm.tps ?? prev.tps ?? null,
        streamingTps: norm.streamingTps ?? prev.streamingTps ?? null,
        error: norm.error || prev.error || null,
        errorClassification: norm.errorClassification || prev.errorClassification || null,
        hasInputCacheFields: Boolean(norm.hasInputCacheFields || prev.hasInputCacheFields),
        inputTokens: norm.hasInputCacheFields ? norm.inputTokens : (prev.hasInputCacheFields ? prev.inputTokens : norm.inputTokens),
        cacheReadTokens: norm.hasInputCacheFields ? norm.cacheReadTokens : (prev.hasInputCacheFields ? prev.cacheReadTokens : norm.cacheReadTokens),
        totalInputTokens: norm.hasInputCacheFields ? norm.totalInputTokens : (prev.hasInputCacheFields ? prev.totalInputTokens : norm.totalInputTokens),
        outputTokens: Math.max(Number(norm.outputTokens) || 0, Number(prev.outputTokens) || 0) || norm.outputTokens,
        totalTokens: Math.max(Number(norm.totalTokens) || 0, Number(prev.totalTokens) || 0) || norm.totalTokens,
        timestamp: norm.timestamp || prev.timestamp || null,
        created_at: norm.created_at || prev.created_at || null,
        stepIndex: norm.stepIndex ?? prev.stepIndex ?? null
      });
    }

    const candidates = Array.from(mergedById.values());
    if (!candidates.length) return null;
    candidates.sort((a, b) => {
      const ta = Number(a.timestamp) || 0;
      const tb = Number(b.timestamp) || 0;
      if (ta !== tb) return ta - tb;
      const sa = a.stepIndex != null ? Number(a.stepIndex) : -1;
      const sb = b.stepIndex != null ? Number(b.stepIndex) : -1;
      if (sa !== sb) return sa - sb;
      if (a.status === 'streaming' && b.status !== 'streaming') return 1;
      if (b.status === 'streaming' && a.status !== 'streaming') return -1;
      return 0;
    });
    return candidates[candidates.length - 1];
  }

  function isElementActivelyInspected() {
    try {
      const det = el('latest-call-details');
      const tl = el('session-timeline-drawer');
      if (det && state.latestCallDetailOpen && typeof det.matches === 'function' && det.matches(':hover')) return true;
      if (tl && state.historyDrawerOpen && typeof tl.matches === 'function' && tl.matches(':hover')) return true;
      const activeEl = shadow?.activeElement || document?.activeElement;
      if (activeEl && ((det && det.contains?.(activeEl)) || (tl && tl.contains?.(activeEl)))) return true;
      const sel = shadow?.getSelection?.() || window?.getSelection?.();
      if (sel && String(sel.toString() || '').trim().length > 0 && sel.anchorNode) {
        const card = el('latest-call-card');
        if (card && card.contains?.(sel.anchorNode)) return true;
      }
    } catch { }
    return false;
  }

  function isCallCardReadingProtected(incomingCall) {
    if (!state.displayedCallRecord || !incomingCall) return false;
    if (state.pinnedCallRecord) return true;
    const differentCall = incomingCall.callId !== state.displayedCallRecord.callId;
    if (!differentCall) return false;
    if (state.latestCallDetailOpen && state.displayedCallRecord.status !== 'streaming') return true;
    if (isElementActivelyInspected()) return true;
    return false;
  }

  function resolveCallStatusDisplay(call) {
    const out = call?.outcomeStatus || call?.status || 'unknown';
    if (out === 'streaming') return { text: t('session.latestCall.statusStreaming'), cls: 'key-pill pill-warn' };
    if (out === 'canceled') return { text: t('session.latestCall.statusCanceled'), cls: 'key-pill pill-muted' };
    if (out === 'success' || out === 'final') return { text: t('session.latestCall.statusSuccess'), cls: 'key-pill pill-good' };
    if (out === 'quota_exhausted' || out === 'context_overflow' || out === 'exceeded' || out === 'network' || out === 'network_error' || out === 'rate_limit' || out === 'failed' || call?.error) {
      return { text: t('session.latestCall.statusFailed'), cls: 'key-pill pill-danger' };
    }
    return { text: t('session.latestCall.statusUnknown'), cls: 'key-pill pill-muted' };
  }

  function formatCallCachePctText(call) {
    if (!call) return t('session.latestCall.unknownVal');
    if (call.cacheStatus === 'missing' || !call.hasInputCacheFields) return t('session.latestCall.unknownVal');
    if (call.cacheStatus === 'zero_input') return t('session.latestCall.naVal');
    if (call.cacheReadPct !== null && call.cacheReadPct !== undefined) return `${call.cacheReadPct}%`;
    return t('session.latestCall.unknownVal');
  }

  function applyLatestCallRecordToDom(call, { playAnim = false } = {}) {
    const card = el('latest-call-card');
    if (!card) return;
    const statusPill = el('latest-call-status-pill');
    const agentPill = el('latest-call-agent-pill');
    const timeEl = el('latest-call-time');
    const modelEl = el('latest-call-model');
    const effortEl = el('latest-call-effort');
    const tokInline = el('latest-call-tokens-inline');
    const cacheInline = el('latest-call-cache-inline');
    const durInline = el('latest-call-duration-inline');
    const detailGrid = el('latest-call-detail-grid');
    const errorBox = el('latest-call-error-box');
    const bodyEl = el('latest-call-body');

    const st = resolveCallStatusDisplay(call);
    if (statusPill) {
      statusPill.textContent = st.text;
      statusPill.className = st.cls;
    }

    if (agentPill) {
      if (call.agentRole === 'subagent') {
        agentPill.hidden = false;
        agentPill.className = 'call-agent-badge is-subagent';
        agentPill.textContent = call.subagentType ? `${t('session.latestCall.agentSub')} · ${call.subagentType}` : t('session.latestCall.agentSub');
      } else if (call.attributionConfidence === 'unidentified') {
        agentPill.hidden = false;
        agentPill.className = 'call-agent-badge is-unknown';
        agentPill.textContent = t('session.latestCall.agentUnknown');
      } else {
        agentPill.hidden = false;
        agentPill.className = 'call-agent-badge';
        agentPill.textContent = t('session.latestCall.agentMain');
      }
    }

    if (timeEl) timeEl.textContent = formatCallTimeStr(call);
    const modelTitle = formatCallModelTitle(call);
    if (modelEl) {
      modelEl.textContent = modelTitle;
      modelEl.title = call.modelExactId ? `${modelTitle} (${call.modelExactId})` : modelTitle;
    }
    if (effortEl) {
      if (call.effort) {
        effortEl.hidden = false;
        effortEl.textContent = call.effort;
      } else {
        effortEl.hidden = true;
        effortEl.textContent = '';
      }
    }

    const unk = t('session.latestCall.unknownVal');
    const scoreInline = el('latest-call-score-inline');
    const callEval = (typeof evaluateGenerationExperience === 'function')
      ? evaluateGenerationExperience({
          phase: call.status === 'streaming' ? 'streaming' : (call.outcomeStatus === 'canceled' ? 'canceled' : (call.error ? 'failed' : 'final')),
          outcomeStatus: call.outcomeStatus,
          ttftSec: call.ttftSec,
          streamingSec: call.streamingSec,
          totalDurationSec: call.durationSec,
          streamSpeed: call.streamingTps ?? call.streamSpeed,
          overallTps: call.tps,
          outputTokens: call.outputTokens,
          totalInputTokens: call.totalInputTokens,
          chunkCount: call.chunkCount,
          chunkIntervalsMs: call.chunkIntervalsMs,
          intervalCv: call.intervalCv,
          sampleSource: call.sampleSource || null,
          isSyntheticPoll: call.isSyntheticPoll === true,
          error: call.error
        }, currentPanelLanguage)
      : null;

    if (scoreInline) {
      if (callEval && callEval.efficiency?.available) {
        scoreInline.hidden = false;
        scoreInline.textContent = `${callEval.efficiency.score}${currentPanelLanguage === 'en' ? ' pts' : '分'} · ${callEval.efficiency.grade}`;
        scoreInline.style.color = callEval.efficiency.tier?.color || '';
        scoreInline.style.borderColor = callEval.efficiency.tier?.color || '';
        scoreInline.title = callEval.shortTitle || '';
      } else if (call.eScore != null && call.eGrade) {
        scoreInline.hidden = false;
        scoreInline.textContent = `${call.eScore}${currentPanelLanguage === 'en' ? ' pts' : '分'} · ${call.eGrade}`;
        scoreInline.style.color = callEval?.badge?.color || '';
        scoreInline.style.borderColor = callEval?.badge?.color || '';
      } else {
        scoreInline.hidden = true;
        scoreInline.textContent = '—';
        scoreInline.style.color = '';
        scoreInline.style.borderColor = '';
      }
    }

    const inpStr = call.hasInputCacheFields && call.inputTokens !== null ? short(call.inputTokens) : unk;
    const outStr = call.outputTokens !== null && call.outputTokens !== undefined ? short(call.outputTokens) : unk;
    if (tokInline) tokInline.textContent = t('session.latestCall.inlineTokens', { inp: inpStr, out: outStr });
    if (cacheInline) cacheInline.textContent = t('session.latestCall.inlineCache', { val: formatCallCachePctText(call) });
    if (durInline) durInline.textContent = call.durationSec !== null && call.durationSec !== undefined
      ? (typeof formatHumanDuration === 'function' ? formatHumanDuration(call.durationSec, currentPanelLanguage) : `${call.durationSec}s`)
      : '—';

    if (detailGrid) {
      detailGrid.replaceChildren();
      const agentDesc = call.agentRole === 'subagent'
        ? `${t('session.latestCall.agentSub')}${call.subagentRole ? ` (${call.subagentRole})` : (call.subagentType ? ` (${call.subagentType})` : '')}${call.parentCascadeId ? ` · parent ${String(call.parentCascadeId).slice(0, 8)}` : ''}${call.parentStepIndex != null ? ` · step #${call.parentStepIndex}` : ` · ${t('session.latestCall.missingParentStep')}`}`
        : (call.attributionConfidence === 'unidentified' ? t('session.latestCall.agentUnknown') : t('session.latestCall.agentMain'));
      const fmtDurOrUnk = (v) => (v !== null && v !== undefined) ? (typeof formatHumanDuration === 'function' ? formatHumanDuration(v, currentPanelLanguage) : `${v}s`) : unk;
      const eDetailVal = callEval?.efficiency?.available
        ? `${callEval.efficiency.score} ${currentPanelLanguage === 'en' ? 'pts' : '分'} · ${callEval.efficiency.tier?.title || callEval.efficiency.grade}`
        : (call.eScore != null ? `${call.eScore} (${call.eGrade || '--'})` : (callEval?.efficiency?.skippedReason === 'insufficient_sample' ? t('session.speed.scoreSkippedSparse') : t('session.speed.scoreSkippedMissing')));
      const rawIdBadge = call.rawPlaceholderId ? ` (${t('session.latestCall.rawIdNote', { id: call.rawPlaceholderId })})` : '';
      const stableIdDisplay = (call.stableModelId && !/^model_placeholder_/i.test(String(call.stableModelId)))
        ? `${call.stableModelId}${rawIdBadge}`
        : ((call.modelExactId && !/^model_placeholder_/i.test(String(call.modelExactId)))
          ? `${call.modelExactId}${rawIdBadge}`
          : (call.rawPlaceholderId
            ? `${unk} (${t('session.latestCall.rawIdNote', { id: call.rawPlaceholderId })})`
            : (call.modelExactId || call.modelKey || unk)));
      const modelAndEffortDisplay = formatProductDisplayWithEffort(modelTitle, call.effort);
      const callStreamDisplay = callEval?.isSampleSparse
        ? `${t('session.speed.shortSampleBadge')}${callEval.shortWindowEstimateSpeed != null ? ` (${t('session.speed.shortWindowEst')}: ${callEval.shortWindowEstimateSpeed} tok/s)` : ''}`
        : ((call.streamingTps ?? call.streamSpeed) != null ? `${call.streamingTps ?? call.streamSpeed} tok/s${callEval?.speedTier ? ` · ${callEval.speedTier.title}` : ''}` : unk);
      const cells = [
        [t('session.latestCall.fieldTime'), formatCallTimeStr(call)],
        [t('session.latestCall.fieldStatus'), st.text],
        [t('session.latestCall.fieldModelId'), stableIdDisplay],
        [t('session.latestCall.fieldModelLabel'), modelAndEffortDisplay],
        [t('session.latestCall.fieldInput'), call.hasInputCacheFields && call.inputTokens !== null ? fmt(call.inputTokens) : unk],
        [t('session.latestCall.fieldCacheRead'), call.hasInputCacheFields && call.cacheReadTokens !== null ? fmt(call.cacheReadTokens) : unk],
        [t('session.latestCall.fieldTotalInput'), call.hasInputCacheFields && call.totalInputTokens !== null ? fmt(call.totalInputTokens) : unk],
        [t('session.latestCall.fieldOutput'), call.outputTokens !== null && call.outputTokens !== undefined
          ? `${fmt(call.outputTokens)}${call.thinkingTokens ? ` (${fmt(call.thinkingTokens)})` : ''}`
          : unk],
        [t('session.latestCall.fieldCacheRatio'), formatCallCachePctText(call)],
        [t('session.latestCall.fieldTtft'), `${fmtDurOrUnk(call.ttftSec)}${call.ttftRatioPct != null ? ` (${call.ttftRatioPct}%)` : ''}${callEval?.ttftTier ? ` · ${callEval.ttftTier.title}` : ''}`],
        [t('session.latestCall.fieldDuration'), `${fmtDurOrUnk(call.durationSec)}${callEval?.durationTier ? ` · ${callEval.durationTier.title}` : ''}`],
        [t('session.speed.streamRate'), callStreamDisplay],
        [t('session.speed.breakdown.overall'), call.tps !== null && call.tps !== undefined ? `${call.tps} tok/s` : unk],
        [t('session.speed.breakdown.eScore'), eDetailVal],
        [t('session.latestCall.fieldAgent'), agentDesc]
      ];
      for (const [k, v] of cells) {
        const cell = document.createElement('div');
        cell.className = 'call-detail-cell';
        const kEl = document.createElement('span');
        kEl.className = 'call-detail-k';
        kEl.textContent = k;
        const vEl = document.createElement('span');
        vEl.className = 'call-detail-v';
        vEl.textContent = v;
        cell.appendChild(kEl);
        cell.appendChild(vEl);
        detailGrid.appendChild(cell);
      }
    }

    if (errorBox) {
      if (call.error || st.cls.includes('pill-danger')) {
        errorBox.hidden = false;
        const reason = call.errorClassification?.reason || '';
        errorBox.textContent = [reason, call.error].filter(Boolean).join(' · ') || st.text;
      } else {
        errorBox.hidden = true;
        errorBox.textContent = '';
      }
    }

    if (bodyEl && playAnim && !prefersReducedMotionNow()) {
      if (state.callEnterAnimTimer) {
        clearTimeout(state.callEnterAnimTimer);
        state.callEnterAnimTimer = null;
      }
      bodyEl.classList?.remove?.('is-entering');
      void bodyEl.offsetWidth;
      bodyEl.classList?.add?.('is-entering');
      state.callEnterAnimTimer = setTimeout(() => {
        state.callEnterAnimTimer = null;
        bodyEl.classList?.remove?.('is-entering');
      }, 250);
    }
  }

  function syncLatestCallDetailsVisibility() {
    const det = el('latest-call-details');
    const row = el('latest-call-summary-row');
    if (det) det.style.display = state.latestCallDetailOpen ? 'block' : 'none';
    if (row) row.setAttribute?.('aria-expanded', state.latestCallDetailOpen ? 'true' : 'false');
  }

  function renderLatestCallCard({ fromUserAction = false, skipAnim = false } = {}) {
    const card = el('latest-call-card');
    if (!card) return;
    if (!state.route) {
      card.hidden = true;
      return;
    }

    const incoming = resolveLatestSessionCallRecord();
    const target = state.pinnedCallRecord || incoming;
    if (!target) {
      card.hidden = !state.historyDrawerOpen;
      return;
    }
    card.hidden = false;

    const newBanner = el('latest-call-new-banner');
    if (!fromUserAction && isCallCardReadingProtected(incoming)) {
      if (incoming && (!state.pendingLatestCallRecord || buildCallDisplaySignature(incoming) !== buildCallDisplaySignature(state.pendingLatestCallRecord))) {
        state.pendingLatestCallRecord = incoming;
      }
      if (newBanner) newBanner.hidden = false;
      if (state.pinnedCallRecord && lastCallCardLang !== currentPanelLanguage) {
        applyLatestCallRecordToDom(state.pinnedCallRecord, { playAnim: false });
        lastCallCardLang = currentPanelLanguage;
      }
      syncLatestCallDetailsVisibility();
      return;
    }

    if (newBanner) newBanner.hidden = true;
    state.pendingLatestCallRecord = null;

    const nextSig = buildCallDisplaySignature(target);
    const langChanged = lastCallCardLang !== currentPanelLanguage;
    if (nextSig === state.displayedCallSig && !langChanged) {
      syncLatestCallDetailsVisibility();
      return;
    }

    const hadPrev = Boolean(state.displayedCallRecord);
    const isRealReplacement = hadPrev && nextSig !== state.lastAnimatedCallSig && target.status !== 'streaming';
    const shouldAnimate = !skipAnim && isRealReplacement && nextSig !== state.displayedCallSig;

    state.displayedCallRecord = target;
    state.displayedCallSig = nextSig;
    if (target.status !== 'streaming') {
      state.lastAnimatedCallSig = nextSig;
    }
    lastCallCardLang = currentPanelLanguage;
    applyLatestCallRecordToDom(target, { playAnim: shouldAnimate });
    syncLatestCallDetailsVisibility();
  }

  function renderSessionTimeline() {
    const drawer = el('session-timeline-drawer');
    const toggleBtn = el('btn-session-history-toggle');
    if (toggleBtn) {
      toggleBtn.textContent = state.historyDrawerOpen ? t('session.timeline.hideHistory') : t('session.timeline.viewHistory');
      toggleBtn.setAttribute?.('aria-expanded', state.historyDrawerOpen ? 'true' : 'false');
    }
    if (!drawer) return;
    drawer.style.display = state.historyDrawerOpen ? 'flex' : 'none';
    if (!state.historyDrawerOpen) return;

    const sumEl = el('session-timeline-summary');
    const listEl = el('session-timeline-list');
    const unlinkedEl = el('session-timeline-unlinked');
    const moreWrap = el('session-timeline-more-wrap');
    const moreBtn = el('btn-timeline-load-more');

    if (state.timelineLoading && !state.sessionTimeline) {
      if (sumEl) sumEl.textContent = t('session.timeline.loading');
      if (listEl) listEl.replaceChildren();
      if (unlinkedEl) unlinkedEl.hidden = true;
      if (moreWrap) moreWrap.hidden = true;
      return;
    }

    const tl = state.sessionTimeline;
    if (!tl || (!tl.turns?.length && !tl.unlinkedSubagentCalls?.length)) {
      if (sumEl) sumEl.textContent = state.timelineError ? translateBackendText(state.timelineError) : t('session.timeline.empty');
      if (listEl) listEl.replaceChildren();
      if (unlinkedEl) unlinkedEl.hidden = true;
      if (moreWrap) moreWrap.hidden = true;
      return;
    }

    const turns = Array.isArray(tl.turns) ? tl.turns : [];
    const cacheText = tl.cacheSummary && tl.cacheSummary.cacheStatus !== 'missing'
      ? (tl.cacheSummary.cacheStatus === 'zero_input' ? t('session.latestCall.naVal') : `${tl.cacheSummary.cacheReadPct}%`)
      : t('session.latestCall.unknownVal');
    if (sumEl) {
      sumEl.replaceChildren();
      const sLine = document.createElement('div');
      sLine.textContent = t('session.timeline.summary', {
        turns: turns.length,
        calls: tl.totalCalls || 0,
        main: tl.mainCallsCount || 0,
        sub: tl.subagentCallsCount || 0,
        cache: cacheText
      });
      const noteLine = document.createElement('div');
      noteLine.style.marginTop = '2px';
      noteLine.textContent = t('session.timeline.windowNote');
      sumEl.appendChild(sLine);
      sumEl.appendChild(noteLine);
      if (tl.subagentNote) {
        const dbNoteLine = document.createElement('div');
        dbNoteLine.style.marginTop = '2px';
        dbNoteLine.textContent = t('session.timeline.dbMissingNote', { reason: tl.subagentNote });
        sumEl.appendChild(dbNoteLine);
      }
    }

    if (listEl) {
      const curRouteKey = state.route || '';
      const sameTimelineRoute = state.timelineRenderedRoute === curRouteKey;
      const prevScrollTop = sameTimelineRoute ? Number(listEl.scrollTop || 0) : 0;
      listEl.replaceChildren();
      state.timelineRenderedRoute = curRouteKey;
      const resolveTurnKey = (tObj) => tObj?.turnKey || `turn-${tObj?.turnIndex ?? 'x'}-${tObj?.stepIndex ?? 'na'}`;
      const descTurns = [...turns].reverse();
      if (descTurns.length > 0 && state.timelineAutoExpandedRoute !== curRouteKey) {
        state.timelineAutoExpandedRoute = curRouteKey;
        if (state.expandedTurnKeys.size === 0) {
          state.expandedTurnKeys.add(resolveTurnKey(descTurns[0]));
        }
      }
      const limit = Math.max(5, Number(state.timelinePageLimit) || 10);
      const visibleTurns = descTurns.slice(0, limit);

      const createCallRow = (call) => {
        const row = document.createElement('div');
        const isSelected = state.pinnedCallRecord && state.pinnedCallRecord.callId === call.callId;
        row.className = `timeline-call-row${call.agentRole === 'subagent' ? ' is-subagent' : ''}${isSelected ? ' is-selected' : ''}`;
        row.setAttribute('role', 'button');
        row.setAttribute('tabindex', '0');

        const main = document.createElement('div');
        main.className = 'timeline-call-main';
        const roleBadge = document.createElement('span');
        roleBadge.className = `call-agent-badge${call.agentRole === 'subagent' ? ' is-subagent' : (call.attributionConfidence === 'unidentified' ? ' is-unknown' : '')}`;
        roleBadge.textContent = call.agentRole === 'subagent'
          ? (call.subagentType ? `${t('session.latestCall.agentSub')}·${call.subagentType}` : t('session.latestCall.agentSub'))
          : (call.attributionConfidence === 'unidentified' ? t('session.latestCall.agentUnknown') : t('session.latestCall.agentMain'));
        const mName = document.createElement('span');
        mName.className = 'timeline-turn-prompt';
        const baseModelTitle = formatCallModelTitle(call);
        const effortText = call.effort ? String(call.effort).trim() : '';
        const hasEffortParen = effortText && baseModelTitle.trim().toLowerCase().endsWith(`(${effortText.toLowerCase()})`);
        mName.textContent = (effortText && !hasEffortParen) ? `${baseModelTitle} (${effortText})` : baseModelTitle;

        main.appendChild(roleBadge);
        main.appendChild(mName);

        const stats = document.createElement('div');
        stats.className = 'timeline-call-stats';
        const st = resolveCallStatusDisplay(call);
        const inpTxt = call.hasInputCacheFields ? short(call.totalInputTokens) : t('session.latestCall.unknownVal');
        const eTag = (call.eScore != null && call.eGrade)
          ? (currentPanelLanguage === 'en' ? ` · ${call.eScore}pt(${call.eGrade})` : ` · ${call.eScore}分(${call.eGrade})`)
          : '';
        if (currentPanelLanguage === 'en') {
          stats.textContent = `${formatCallTimeStr(call)} · In ${inpTxt}/Out ${short(call.outputTokens || 0)} · Cache ${formatCallCachePctText(call)}${eTag} · ${st.text}`;
        } else if (currentPanelLanguage === 'zh-TW') {
          stats.textContent = `${formatCallTimeStr(call)} · 入${inpTxt}/出${short(call.outputTokens || 0)} · 緩${formatCallCachePctText(call)}${eTag} · ${st.text}`;
        } else {
          stats.textContent = `${formatCallTimeStr(call)} · 入${inpTxt}/出${short(call.outputTokens || 0)} · 缓${formatCallCachePctText(call)}${eTag} · ${st.text}`;
        }

        row.appendChild(main);
        row.appendChild(stats);
        const inspectCall = () => {
          state.pinnedCallRecord = call;
          state.latestCallDetailOpen = true;
          renderLatestCallCard({ fromUserAction: true, skipAnim: false });
          renderSessionTimeline();
        };
        row.addEventListener('click', inspectCall);
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspectCall(); }
        });
        return row;
      };

      for (const turn of visibleTurns) {
        const turnKey = resolveTurnKey(turn);
        const isOpen = state.expandedTurnKeys.has(turnKey);
        const cardEl = document.createElement('div');
        cardEl.className = 'timeline-turn-card';

        const hdrBtn = document.createElement('button');
        hdrBtn.type = 'button';
        hdrBtn.className = 'timeline-turn-hdr';
        hdrBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');

        const left = document.createElement('div');
        left.className = 'timeline-turn-left';
        const idxEl = document.createElement('span');
        idxEl.className = 'timeline-turn-idx';
        idxEl.textContent = t('session.timeline.turnLabel', { n: turn.turnIndex });
        const rawTurnPrompt = turn.preview || turn.userPromptPreview || '';
        const promptText = typeof sanitizeTurnPreviewText === 'function' ? sanitizeTurnPreviewText(rawTurnPrompt, 120) : rawTurnPrompt;
        const promptEl = document.createElement('span');
        promptEl.className = 'timeline-turn-prompt';
        promptEl.textContent = promptText || t('session.timeline.turnNoPrompt');
        if (promptText) promptEl.title = promptText;
        left.appendChild(idxEl);
        left.appendChild(promptEl);

        const metaEl = document.createElement('span');
        metaEl.className = 'timeline-turn-meta';
        metaEl.textContent = t('session.timeline.turnSummary', {
          calls: turn.calls?.length || 0,
          inp: short(turn.inputTokens || 0),
          cap: short(turn.cacheReadTokens || 0),
          out: short(turn.outputTokens || 0)
        });

        hdrBtn.appendChild(left);
        hdrBtn.appendChild(metaEl);
        hdrBtn.addEventListener('click', () => {
          if (state.expandedTurnKeys.has(turnKey)) state.expandedTurnKeys.delete(turnKey);
          else state.expandedTurnKeys.add(turnKey);
          renderSessionTimeline();
        });
        cardEl.appendChild(hdrBtn);

        if (isOpen && Array.isArray(turn.calls)) {
          const bodyEl = document.createElement('div');
          bodyEl.className = 'timeline-turn-body';
          for (const call of turn.calls) {
            bodyEl.appendChild(createCallRow(call));
          }
          cardEl.appendChild(bodyEl);
        }
        listEl.appendChild(cardEl);
      }

      if (moreWrap && moreBtn) {
        const remaining = descTurns.length - visibleTurns.length;
        if (remaining > 0) {
          moreWrap.hidden = false;
          moreBtn.textContent = t('session.timeline.loadMore', { n: remaining });
        } else {
          moreWrap.hidden = true;
        }
      }

      if (unlinkedEl) {
        const unlinked = Array.isArray(tl.unlinkedSubagentCalls) ? tl.unlinkedSubagentCalls : [];
        if (unlinked.length > 0) {
          unlinkedEl.hidden = false;
          unlinkedEl.replaceChildren();
          const uTitle = document.createElement('div');
          uTitle.className = 'session-timeline-unlinked-title';
          uTitle.textContent = t('session.timeline.unlinkedTitle', { n: unlinked.length });
          unlinkedEl.appendChild(uTitle);
          for (const uCall of unlinked) {
            unlinkedEl.appendChild(createCallRow(uCall));
          }
        } else {
          unlinkedEl.hidden = true;
          unlinkedEl.replaceChildren();
        }
      }
      if (prevScrollTop > 0) {
        const maxScroll = Math.max(0, (listEl.scrollHeight || 0) - (listEl.clientHeight || 0));
        listEl.scrollTop = maxScroll > 0 ? Math.min(prevScrollTop, maxScroll) : prevScrollTop;
      }
    }
  }

  async function fetchSessionTimeline(id, { force = false } = {}) {
    if (!id || state.disposed || id !== state.route) return null;
    if (!force && state.timelineLoading) return null;
    const seq = ++timelineFetchSeq;
    const gen = state.generation;
    state.timelineLoading = true;
    state.timelineError = '';
    if (state.historyDrawerOpen) renderSessionTimeline();

    try {
      if (timelineFetchController) {
        try { timelineFetchController.abort(); } catch { }
      }
      timelineFetchController = typeof AbortController === 'function' ? new AbortController() : null;
      const liveCalls = Array.isArray(state.sessionCalls) ? state.sessionCalls : [];
      const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      const hasIpc = typeof window !== 'undefined' && typeof window.contextMeterAPI?.getSessionTimeline === 'function';
      let timelineData = null;

      if (hasIpc || hasLiveHttpBridge()) {
        const out = await callBackendWithPriority({
          ipcCall: hasIpc ? () => window.contextMeterAPI.getSessionTimeline(id, { force, liveCalls, cascadeModelConfigs: configs }) : null,
          liveRoute: '/session-timeline',
          liveBody: { id, force, liveCalls, cascadeModelConfigs: configs },
          liveFetchOpts: timelineFetchController ? { signal: timelineFetchController.signal } : {}
        });
        const res = out?.result;
        if (res?.ok && res.data) {
          timelineData = res.data;
        } else if (res && !res.ok) {
          state.timelineError = res.error || '';
        }
      } else if (typeof groupSessionCallsByTurns === 'function') {
        timelineData = groupSessionCallsByTurns([], liveCalls, { cascadeId: id, cascadeModelConfigs: configs });
      }

      if (gen !== state.generation || seq !== timelineFetchSeq || state.disposed) return null;
      if (timelineData) {
        state.sessionTimeline = timelineData;
        state.lastTimelineFetchAt = Date.now();
      }
    } catch (e) {
      if (e?.name !== 'AbortError' && gen === state.generation && !state.disposed) {
        state.timelineError = e?.message || String(e || '');
      }
    } finally {
      if (seq === timelineFetchSeq && !state.disposed) {
        state.timelineLoading = false;
        if (state.historyDrawerOpen) renderSessionTimeline();
      }
    }
    return state.sessionTimeline;
  }

  function scheduleLatestCallRefresh({ allowTimelineRefresh = false } = {}) {
    if (state.disposed) return;
    if (allowTimelineRefresh && state.historyDrawerOpen && state.route) {
      const latest = resolveLatestSessionCallRecord();
      const sig = buildCallDisplaySignature(latest);
      if (sig && sig !== state.lastTimelineCallSig && Date.now() - state.lastTimelineFetchAt > 1200) {
        state.lastTimelineCallSig = sig;
        void fetchSessionTimeline(state.route);
      }
    }
    renderLatestCallCard();
  }

  // 渲染上下文与全局状态（无论在主页 / 还是会话页 /c/<id>，始终保持插件栏挂载与可用）
  function render() {
    host.hidden = false;
    host.setAttribute('data-has-session', state.route ? 'true' : 'false');
    ensureHostDocked();
    if (!state.route) {
      hideContextTooltip();
      const barFill = el('bar-fill');
      if (barFill) barFill.style.width = '0%';
      const badgePctVal = el('badge-pct-val');
      if (badgePctVal) badgePctVal.textContent = '--%';
      el('amount').textContent = t('badge.noSession');
      setHoverExtra(t('badge.clickOpenCli'));
      syncSpeedBadgeText();
      syncContextModelSelectionFromState();
      renderLatestCallCard({ skipAnim: true });
      renderSessionTimeline();
      return;
    }
    renderSessionCost();

    const d = state.latest, session = state.scan?.session;
    const disp = resolveDisplayStatus(d, session);
    const stale = state.requestError || state.requestAt && Date.now() - state.requestAt > 20000;
    const incomplete = session?.unknownFiles > 0;
    const danger = disp.isError || d?.exceeded;

    let pct = null;
    if (d?.exceeded) {
      pct = 100;
    } else if (d?.percent != null && !danger && !stale) {
      pct = Math.min(100, Math.max(0, d.percent));
    } else if (d?.actual != null && d?.budget && !danger && !stale) {
      pct = Math.min(100, Math.max(0, (d.actual / d.budget) * 100));
    }

    const barColor = danger ? '#ff4d4f' : pct != null && pct >= 90 ? '#ff4d4f' : pct != null && pct >= 75 || stale || incomplete ? '#faad14' : '#69c0ff';
    const tone = danger ? '#ff9292' : stale || incomplete || d?.estimated ? '#f2c46d' : '#b7c1ff';
    host.style.setProperty('--tone', tone);
    host.style.setProperty('--bar-color', barColor);

    const barFill = el('bar-fill');
    if (barFill) barFill.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');

    updateRingAndBubble(d, session, pct, danger, stale, incomplete);

    syncContextModelSelectionFromState();

    // 若观测到的上下文预算变化且抽屉已展开或尚未读取状态，触发一次轻量同步（不再据此判定真实请求已验证）
    if (d?.budget && d.budget !== lastAutoObservedBudget && d.budget > 256000) {
      lastAutoObservedBudget = d.budget;
      if (currentUnlockStatus || (unlockDrawerBody && unlockDrawerBody.style.display === 'block')) {
        void refreshUnlockStatus();
      }
    }

    const status = disp.isError
      ? disp.statusText
      : stale ? t('badge.status.stale')
        : state.scanError ? t('badge.status.scanErr', { err: translateBackendText(state.scanError) })
          : incomplete ? t('badge.status.incomplete', { count: session.unknownFiles })
            : d?.estimated ? t('badge.status.estimated')
              : t('badge.status.normal');
    el('status').textContent = status;

    const corpus = session?.total
      ? t('badge.corpus.range', { range: range(session.total), inc: incomplete ? t('badge.corpus.incPlus') : '' })
      : state.scanBusy ? t('badge.corpus.scanning') : t('badge.corpus.pending');

    const badgePctVal = el('badge-pct-val');
    if (disp.isError || disp.kind === 'canceled') {
      el('amount').textContent = disp.amountText;
      if (badgePctVal) badgePctVal.textContent = disp.badgeText;
      setHoverExtra(disp.hoverExtra);
    } else if (stale) {
      el('amount').textContent = t('badge.delayed');
      if (badgePctVal) badgePctVal.textContent = pct != null ? `${pct.toFixed(0)}%` : '--%';
      setHoverExtra(` · ${corpus}`);
    } else if (d?.actual != null) {
      const pctStr = pct != null ? ` (${pct.toFixed(0)}%)` : '';
      el('amount').textContent = `${short(d.actual)}${pctStr}`;
      if (badgePctVal) badgePctVal.textContent = pct != null ? `${pct.toFixed(0)}%` : '--%';
      const budgetStr = d?.budget ? ` / ${short(d.budget)}` : '';
      setHoverExtra(`${budgetStr} · ${corpus}`);
    } else {
      el('amount').textContent = t('badge.actualUnknown');
      if (badgePctVal) badgePctVal.textContent = '--%';
      setHoverExtra(` · ${corpus}`);
    }

    // 渲染输出速度 (统一使用 tok/s)
    const sp = d?.speed;
    const speedBadge = el('badge-speed');
    const speedHoverExtra = el('speed-hover-extra');
    syncSpeedBadgeText();
    if (speedBadge) {
      if (sp?.tps != null) {
        if (speedHoverExtra) {
          speedHoverExtra.textContent = `${sp.duration ? ` · ${sp.duration}s` : ''}${sp.outputTokens ? ` · ${short(sp.outputTokens)} tok` : ''}`;
        }
      } else if (state.requestBusy) {
        if (speedHoverExtra) speedHoverExtra.textContent = '';
      } else {
        if (speedHoverExtra) speedHoverExtra.textContent = t('badge.speedHoverIdle');
      }
      speedBadge.removeAttribute('title');
    }

    if (el('key-summary')) {
      const keyBar = el('key-bar-fill');
      const keyBadge = el('key-badge');
      const keyUsed = el('key-used');
      const keyLimit = el('key-limit');
      const keyRemaining = el('key-remaining');
      const keyTakeaway = el('key-takeaway');

      if (keyBar) keyBar.style.width = pct != null ? `${pct}%` : (d?.exceeded ? '100%' : '0%');

      if (disp.isError || disp.kind === 'canceled') {
        if (keyBadge) {
          keyBadge.textContent = disp.keyBadgeText;
          keyBadge.className = disp.pillClass;
        }

        const usedTokenCount = d?.actual != null ? d.actual : (d?.used != null ? d.used : (d?.estimate != null ? d.estimate : (session?.total?.low ?? null)));
        const budgetTokenCount = d?.budget || (d?.serviceLimit ? d.serviceLimit : 983040);

        if (disp.isOverflow) {
          if (keyUsed) keyUsed.textContent = d.serviceLimit ? `>${short(d.serviceLimit)}` : t('key.overflowUsed');
          if (keyLimit) keyLimit.textContent = d.serviceLimit ? short(d.serviceLimit) : short(budgetTokenCount);
          if (keyRemaining) keyRemaining.textContent = t('key.overflowRem');
        } else {
          // 非超限错误：保留已有上下文用量，标明其状态，不归零、不清空
          if (keyUsed) {
            keyUsed.textContent = usedTokenCount != null ? (d?.actual != null ? `${short(usedTokenCount)}${pct != null ? ` (${pct.toFixed(1)}%)` : ''}` : t('key.estShort', { val: short(usedTokenCount) })) : '—';
          }
          if (keyLimit) keyLimit.textContent = budgetTokenCount ? short(budgetTokenCount) : '—';
          if (keyRemaining) {
            if (usedTokenCount != null && budgetTokenCount) {
              const rem = Math.max(0, budgetTokenCount - usedTokenCount);
              const remP = Math.max(0, 100 - (pct || ((usedTokenCount / budgetTokenCount) * 100)));
              keyRemaining.textContent = `${short(rem)} (${remP.toFixed(1)}%)`;
            } else {
              keyRemaining.textContent = t('key.pending');
            }
          }
        }
        if (keyTakeaway) keyTakeaway.textContent = disp.keyTakeaway;
      } else if (d?.actual != null && pct != null) {
        const limitVal = d.budget || 256000;
        const remainVal = Math.max(0, limitVal - d.actual);
        const remainPct = Math.max(0, 100 - pct);

        if (keyBadge) {
          if (pct >= 90) { keyBadge.textContent = t('key.pill.tight'); keyBadge.className = 'key-pill pill-danger'; }
          else if (pct >= 75) { keyBadge.textContent = t('key.pill.elevated'); keyBadge.className = 'key-pill pill-warn'; }
          else { keyBadge.textContent = t('key.pill.normal'); keyBadge.className = 'key-pill pill-good'; }
        }
        if (keyUsed) keyUsed.textContent = `${short(d.actual)} (${pct.toFixed(1)}%)`;
        if (keyLimit) keyLimit.textContent = short(limitVal);
        if (keyRemaining) keyRemaining.textContent = `${short(remainVal)} (${remainPct.toFixed(1)}%)`;
        if (keyTakeaway) {
          if (pct >= 90) {
            keyTakeaway.textContent = t('key.takeaway.90', { pct: pct.toFixed(1), rem: short(remainVal) });
          } else if (pct >= 75) {
            keyTakeaway.textContent = t('key.takeaway.75', { pct: pct.toFixed(1), rem: short(remainVal) });
          } else {
            keyTakeaway.textContent = t('key.takeaway.ok', { pct: pct.toFixed(1), rem: short(remainVal) });
          }
        }
      } else {
        if (keyBadge) { keyBadge.textContent = d?.estimated ? t('key.pill.est') : t('key.pill.reading'); keyBadge.className = 'key-pill pill-muted'; }
        if (keyUsed) keyUsed.textContent = d?.estimate ? t('key.estPrefix', { val: short(d.estimate) }) : (session?.total ? short(session.total.low) : '—');
        if (keyLimit) keyLimit.textContent = d?.budget ? short(d.budget) : '—';
        if (keyRemaining) keyRemaining.textContent = t('key.pending');
        if (keyTakeaway) keyTakeaway.textContent = t('key.takeaway.est');
      }
    }

    if (el('speed-summary')) {
      if (typeof evaluateGenerationExperience === 'function') {
        const evalRes = state.lastSpeedEval || evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage);
        renderSpeedExperienceInPlace(evalRes);
      } else {
        const spBadge = el('speed-badge');
        const spVal = el('speed-val');
        const spDur = el('speed-duration');
        const spTtft = el('speed-ttft');
        const spTokens = el('speed-tokens');
        const spTakeaway = el('speed-takeaway');

        if (sp?.tps != null) {
          if (spBadge) {
            if (sp.tps >= 80) { spBadge.textContent = t('speed.pill.fast'); spBadge.className = 'key-pill pill-good'; }
            else if (sp.tps >= 35) { spBadge.textContent = t('speed.pill.smooth'); spBadge.className = 'key-pill pill-good'; }
            else if (sp.tps >= 15) { spBadge.textContent = t('speed.pill.good'); spBadge.className = 'key-pill pill-warn'; }
            else { spBadge.textContent = t('speed.pill.slow'); spBadge.className = 'key-pill pill-danger'; }
          }
          if (spVal) spVal.textContent = `${sp.tps} tok/s`;
          if (spDur) spDur.textContent = sp.duration ? `${sp.duration}s` : '—';
          if (spTtft) spTtft.textContent = sp.ttft ? `${sp.ttft}s` : '—';
          if (spTokens) spTokens.textContent = `${fmt(sp.outputTokens)} tok`;
          if (spTakeaway) {
            const modelStr = d?.model ? `（${d.model}）` : '';
            const streamInfo = sp.streamingTps ? t('speed.streamPart', { tps: sp.streamingTps }) : '';
            spTakeaway.textContent = t('speed.takeaway.ok', {
              tone: sp.tps >= 35 ? t('speed.tone.smooth') : t('speed.tone.steady'),
              tps: sp.tps,
              stream: streamInfo,
              dur: sp.duration,
              tok: fmt(sp.outputTokens),
              model: modelStr
            });
          }
        } else {
          if (spBadge) { spBadge.textContent = state.requestBusy ? t('speed.pill.calc') : t('speed.pill.idle'); spBadge.className = 'key-pill pill-muted'; }
          if (spVal) spVal.textContent = '—';
          if (spDur) spDur.textContent = '—';
          if (spTtft) spTtft.textContent = '—';
          if (spTokens) spTokens.textContent = '—';
          if (spTakeaway) spTakeaway.textContent = t('speed.takeaway.idle');
        }
      }
    }

    el('model').textContent = d?.model?.startsWith('MODEL_PLACEHOLDER') ? t('tech.modelPlaceholder', { id: d.model }) : d?.model || t('tech.modelMissing');
    el('request-status').textContent = d?.exceeded ? t('tech.req.exceeded') : d?.network ? t('tech.req.network') : d?.error ? t('tech.req.failed') : d?.status === 'reported' ? t('tech.req.reported') : d?.status === 'estimated' ? t('tech.req.estimated') : t('tech.req.waiting');
    el('actual').textContent = d?.actual != null ? token(d.actual) : d?.exceeded ? t('tech.actual.exceeded', { val: fmt(d.serviceLimit || 0) }) : t('tech.actual.unknown');
    if (d?.exceeded && !d.serviceLimit) el('actual').textContent = t('tech.actual.exceededNoLim');
    el('estimate').textContent = d?.estimate ? t('tech.est.val', { val: fmt(d.estimate), note: d.exceeded ? t('tech.est.under') : t('tech.est.ref') }) : t('tech.est.none');
    el('budget').textContent = token(d?.budget);
    el('service-limit').textContent = d?.serviceLimit ? t('tech.svcLim.val', { val: fmt(d.serviceLimit) }) : t('tech.svcLim.none');
    el('percent').textContent = d?.percent != null && !danger && !stale ? t('tech.pct.val', { pct: d.percent.toFixed(1) }) : t('tech.pct.none');
    el('session-total').textContent = session?.total ? range(session.total) + (incomplete ? t('tech.plusUnknown') : '') : state.scanError ? t('tech.scanIncomplete') : t('tech.scanning');
    el('characters').textContent = session?.total ? fmt(session.total.chars) : '—';
    for (const name of ['user', 'assistant', 'thinking', 'tools', 'summaries']) el(name).textContent = session?.groups ? range(session.groups[name]) : '—';
    el('system').textContent = session?.groups ? range({ low: (session.groups.system?.low || 0) + (session.groups.definitions?.low || 0), high: (session.groups.system?.high || 0) + (session.groups.definitions?.high || 0) }) : '—';
    el('attachment-total').textContent = session?.attachmentTotal ? range(session.attachmentTotal) + (incomplete ? t('tech.plusUnknownShort') : '') : '—';
    el('steps').textContent = session?.steps != null ? t('tech.stepsVal', { steps: fmt(session.steps), user: session.userMessages, assistant: session.assistantMessages }) : t('tech.stepsNone');
    el('coverage').textContent = Array.isArray(session?.attachments)
      ? t('tech.coverageVal', {
        total: session.attachments.length,
        user: session.attachments.filter(f => f.source === 'user').length,
        assistant: session.attachments.filter(f => f.source === 'assistant').length,
        read: session.attachments.filter(f => f.chars > 0).length,
        unknown: session.unknownFiles,
        rescan: state.scanBusy ? t('tech.coverageRescan') : '',
        err: state.scanError ? t('tech.coverageErr', { err: translateBackendText(state.scanError) }) : ''
      })
      : (state.scanError ? translateBackendText(state.scanError) : t('tech.coverageScanning'));
    el('updated').textContent = t('tech.updatedVal', {
      req: state.requestAt ? new Date(state.requestAt).toLocaleTimeString() : t('tech.unread'),
      scan: state.scan ? new Date(state.scan.scannedAt).toLocaleTimeString() : t('tech.unfinished')
    });
    el('refresh').disabled = state.scanBusy;
    scheduleLatestCallRefresh({ allowTimelineRefresh: false });
    if (state.historyDrawerOpen) renderSessionTimeline();
  }

  const MAX_FLUSH_BATCH_CALLS = 500;
  const MAX_FLUSH_BATCH_BYTES = 900 * 1024;
  const MAX_LIVE_RECORD_BODY_BYTES = 1024 * 1024;
  const utf8Encoder = typeof TextEncoder === 'function' ? new TextEncoder() : null;

  function getUtf8ByteLength(str) {
    const s = String(str ?? '');
    if (utf8Encoder) return utf8Encoder.encode(s).length;
    if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') return Buffer.byteLength(s, 'utf8');
    let bytes = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
        const next = s.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { bytes += 4; i++; }
        else bytes += 3;
      } else bytes += 3;
    }
    return bytes;
  }

  const getSingleCallBodyBytes = call => 12 + getUtf8ByteLength(JSON.stringify(call));

  const getModelRank = (model, modelKey) => {
    const s = String(model || '').trim();
    if (!s) return 0;
    if (/^model_placeholder_/i.test(s)) return modelKey ? 2 : 1;
    return modelKey ? 3 : 2;
  };

  const getDateRank = call => {
    if (!call) return 0;
    const hasDate = Boolean(call.date && /^\d{4}-\d{2}-\d{2}/.test(String(call.date)));
    const isProv = call.dateIsProvisional === true || call.dateSource === 'provisional';
    if (isProv) return hasDate ? 1 : 0;
    let hasValidCreatedAt = false;
    if (call.created_at) {
      const dt = new Date(call.created_at);
      hasValidCreatedAt = !Number.isNaN(dt.getTime());
    }
    if (call.dateSource === 'transcript' && (hasDate || hasValidCreatedAt)) return 4;
    if (hasValidCreatedAt) return 3;
    if (hasDate) return 2;
    return 0;
  };

  const resolveWatermarkDate = call => {
    if (!call) return '';
    const isProv = call.dateIsProvisional === true || call.dateSource === 'provisional';
    if (!isProv && call.created_at) {
      const dt = new Date(call.created_at);
      if (!Number.isNaN(dt.getTime())) return formatLocalYmd(dt);
    }
    return (call.date && /^\d{4}-\d{2}-\d{2}/.test(String(call.date))) ? String(call.date).slice(0, 10) : '';
  };

  function rawRevIsPresent(val) {
    return val !== null && val !== '';
  }

  const extractSourceRevision = row => {
    if (!row || typeof row !== 'object') return null;
    const raw = row.sourceRevision ?? row.revision ?? row.metadataRevision;
    if (raw !== undefined && rawRevIsPresent(raw)) {
      const num = Number(raw);
      if (Number.isFinite(num)) return num;
    }
    const rawUpdated = row.updated_at ?? row.sourceUpdatedAt;
    if (rawUpdated !== undefined && rawRevIsPresent(rawUpdated)) {
      const ts = typeof rawUpdated === 'number' ? rawUpdated : Date.parse(String(rawUpdated));
      if (Number.isFinite(ts)) return ts;
    }
    return null;
  };

  const compareSourceRevision = (incRev, baseRev) => {
    const a = typeof incRev === 'number' && Number.isFinite(incRev) ? incRev : null;
    const b = typeof baseRev === 'number' && Number.isFinite(baseRev) ? baseRev : null;
    if (a === null && b === null) return 0;
    if (a !== null && b === null) return 1;
    if (a === null && b !== null) return -1;
    if (a === b) return 0;
    return a > b ? 1 : -1;
  };

  const compareWatermarkUsage = (a, b) => {
    const totDiff = (a?.tot || 0) - (b?.tot || 0);
    if (totDiff !== 0) return totDiff;
    return (a?.out || 0) - (b?.out || 0);
  };

  const canAdoptNextDate = (nextWm, prevWm) => {
    if (!prevWm) return Boolean(nextWm?.date);
    const nextDateRank = nextWm?.dateRank || 0;
    const prevDateRank = prevWm?.dateRank || 0;
    if (nextDateRank > prevDateRank) return Boolean(nextWm?.date);
    if (nextDateRank < prevDateRank) return false;
    if (!nextWm?.date) return false;
    if (!prevWm?.date) return true;
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    if (nextDateRank >= 2) {
      if (revCmp > 0 && usageCmp >= 0) return true;
      if (usageCmp > 0 && revCmp >= 0) return true;
      return nextWm.date === prevWm.date && (nextWm.createdAt || '') === (prevWm.createdAt || '') && revCmp >= 0 && usageCmp >= 0;
    }
    return nextWm.date < prevWm.date;
  };

  const getFinalCallWatermark = call => ({
    inp: call?.inputTokens || 0,
    cap: call?.cacheTokens || 0,
    tot: (call?.inputTokens || 0) + (call?.cacheTokens || 0) + (call?.outputTokens || 0),
    out: call?.outputTokens || 0,
    model: String(call?.model || '').trim(),
    modelKey: String(call?.modelKey || '').trim(),
    isPriced: Boolean(call?.isPriced),
    costUSD: Number(call?.costUSD || 0),
    date: resolveWatermarkDate(call),
    createdAt: call?.created_at ? String(call.created_at) : '',
    dateSource: call?.dateSource ? String(call.dateSource) : '',
    dateRank: getDateRank(call),
    sourceRevision: extractSourceRevision(call)
  });

  function hasWatermarkProgressed(nextWm, prevWm) {
    if (!prevWm) return true;
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    if (usageCmp > 0) return true;
    if (getModelRank(nextWm.model, nextWm.modelKey) > getModelRank(prevWm.model, prevWm.modelKey)) return true;
    if (!prevWm.modelKey && Boolean(nextWm.modelKey)) return true;
    if (!prevWm.isPriced && Boolean(nextWm.isPriced)) return true;
    const nextDateRank = nextWm.dateRank || 0;
    const prevDateRank = prevWm.dateRank || 0;
    if (nextDateRank > prevDateRank) return true;
    const usageRegressed = usageCmp < 0;
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    if (!usageRegressed && revCmp > 0) return true;
    const takeNextDate = canAdoptNextDate(nextWm, prevWm);
    if (
      takeNextDate &&
      nextDateRank >= 2 &&
      nextDateRank === prevDateRank &&
      Boolean(nextWm.date) &&
      (
        nextWm.date !== prevWm.date ||
        (nextDateRank >= 3 && Boolean(nextWm.createdAt) && nextWm.createdAt !== (prevWm.createdAt || ''))
      )
    ) {
      return true;
    }
    const hasUnacceptedDate = Boolean(prevWm.date) && Boolean(nextWm.date) && nextWm.date !== prevWm.date && !takeNextDate;
    if (!usageRegressed && revCmp >= 0 && !hasUnacceptedDate && nextWm.isPriced && !(prevWm.costUSD > 0) && nextWm.costUSD > 0) return true;
    return false;
  }

  function mergeWatermarks(prevWm, nextWm) {
    if (!prevWm) return { ...nextWm };
    const nextRank = getModelRank(nextWm.model, nextWm.modelKey);
    const prevRank = getModelRank(prevWm.model, prevWm.modelKey);
    const nextDateRank = nextWm.dateRank || 0;
    const prevDateRank = prevWm.dateRank || 0;
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    const usageRegressed = usageCmp < 0;
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    const takeNextUsage = usageCmp > 0 || (usageCmp === 0 && revCmp >= 0);
    const takeNextDate = canAdoptNextDate(nextWm, prevWm);
    const mergedSourceRevision = revCmp >= 0
      ? (nextWm.sourceRevision ?? prevWm.sourceRevision ?? null)
      : (prevWm.sourceRevision ?? null);
    let mergedCost = Math.max(prevWm.isPriced ? (prevWm.costUSD || 0) : 0, nextWm.isPriced ? (nextWm.costUSD || 0) : 0);
    if (!usageRegressed && revCmp >= 0 && nextWm.isPriced && (takeNextDate || nextWm.date === prevWm.date || !prevWm.date)) {
      mergedCost = nextWm.costUSD || 0;
    }
    return {
      inp: takeNextUsage ? (nextWm.inp ?? 0) : (prevWm.inp ?? 0),
      cap: takeNextUsage ? (nextWm.cap ?? 0) : (prevWm.cap ?? 0),
      tot: takeNextUsage ? nextWm.tot : prevWm.tot,
      out: takeNextUsage ? nextWm.out : prevWm.out,
      model: nextRank >= prevRank && nextWm.model ? nextWm.model : prevWm.model,
      modelKey: nextWm.modelKey || prevWm.modelKey || '',
      isPriced: Boolean(prevWm.isPriced || nextWm.isPriced),
      costUSD: mergedCost,
      date: takeNextDate ? nextWm.date : (prevWm.date || nextWm.date || ''),
      createdAt: takeNextDate ? (nextWm.createdAt || '') : (prevWm.createdAt || ''),
      dateSource: takeNextDate ? (nextWm.dateSource || '') : (prevWm.dateSource || ''),
      dateRank: Math.max(prevDateRank, nextDateRank),
      sourceRevision: mergedSourceRevision
    };
  }

  function mergePendingCallData(prevCall, nextCall) {
    if (!prevCall) return nextCall;
    const prevWm = getFinalCallWatermark(prevCall);
    const nextWm = getFinalCallWatermark(nextCall);
    const merged = { ...nextCall };
    const usageCmp = compareWatermarkUsage(nextWm, prevWm);
    const revCmp = compareSourceRevision(nextWm.sourceRevision, prevWm.sourceRevision);
    const takePrevUsage = usageCmp < 0 || (usageCmp === 0 && revCmp < 0);
    if (takePrevUsage) {
      merged.inputTokens = prevCall.inputTokens;
      merged.cacheTokens = prevCall.cacheTokens;
      merged.cacheReadTokens = prevCall.cacheReadTokens;
      merged.outputTokens = prevCall.outputTokens;
      merged.thinkingTokens = prevCall.thinkingTokens;
      merged.responseTokens = prevCall.responseTokens;
      merged.totalTokens = prevCall.totalTokens;
    }
    const takeNextDate = canAdoptNextDate(nextWm, prevWm);
    const takePrevDate = !takeNextDate && Boolean(prevWm.date || (prevWm.dateRank || 0) > (nextWm.dateRank || 0));
    if (takePrevDate) {
      merged.date = prevCall.date;
      merged.created_at = prevCall.created_at;
      if (prevCall.dateSource !== undefined) merged.dateSource = prevCall.dateSource;
      else delete merged.dateSource;
      merged.dateIsProvisional = prevCall.dateIsProvisional;
      if (prevCall.timestamp !== undefined) merged.timestamp = prevCall.timestamp;
    }
    if (revCmp < 0 && prevWm.sourceRevision !== null) {
      merged.sourceRevision = prevWm.sourceRevision;
    } else if (nextWm.sourceRevision !== null) {
      merged.sourceRevision = nextWm.sourceRevision;
    } else {
      delete merged.sourceRevision;
    }
    if (getModelRank(prevWm.model, prevWm.modelKey) > getModelRank(nextWm.model, nextWm.modelKey)) {
      merged.model = prevCall.model;
    }
    if (!nextWm.modelKey && prevWm.modelKey) {
      merged.modelKey = prevCall.modelKey;
    }
    if (typeof calculateRequestApiCost === 'function' && (merged.model || merged.modelKey)) {
      const recalc = calculateRequestApiCost(merged);
      if (recalc.isPriced) {
        merged.modelKey = recalc.modelKey;
        merged.isPriced = true;
        merged.costUSD = recalc.costUSD ?? 0;
      }
    } else if (!nextWm.isPriced && prevWm.isPriced) {
      merged.isPriced = prevCall.isPriced;
      merged.costUSD = prevCall.costUSD;
    } else if (nextWm.isPriced && prevWm.isPriced && (takePrevUsage || takePrevDate) && (prevWm.costUSD || 0) > (nextWm.costUSD || 0)) {
      merged.costUSD = prevCall.costUSD;
    }
    return merged;
  }

  function takeNextPendingBatch(pendingMap) {
    const chunk = [];
    const snap = [];
    let totalBytes = 12; // '{"calls":[]}'
    for (const call of pendingMap.values()) {
      if (chunk.length >= MAX_FLUSH_BATCH_CALLS) break;
      const itemBytes = getUtf8ByteLength(JSON.stringify(call));
      if (12 + itemBytes > MAX_FLUSH_BATCH_BYTES) continue;
      const addedBytes = (chunk.length > 0 ? 1 : 0) + itemBytes;
      if (chunk.length > 0 && totalBytes + addedBytes > MAX_FLUSH_BATCH_BYTES) break;
      chunk.push(call);
      snap.push({ callId: call.callId, wm: getFinalCallWatermark(call) });
      totalBytes += addedBytes;
    }
    return { chunk, snap };
  }

  function commitConfirmedEntries(entries) {
    for (const entry of entries) {
      state.quarantinedOversizeMap?.delete(entry.callId);
      const curSynced = state.syncedFinalMap.get(entry.callId);
      const nextSynced = mergeWatermarks(curSynced, entry.wm);
      state.syncedFinalMap.set(entry.callId, nextSynced);
      const curPending = state.pendingFinalCalls.get(entry.callId);
      if (curPending && !hasWatermarkProgressed(getFinalCallWatermark(curPending), nextSynced)) {
        state.pendingFinalCalls.delete(entry.callId);
      }
    }
  }

  const EXPLICIT_OVERSIZE_RE = /\b413\b|payload\s+too\s+large|entity\s+too\s+large|body\s+too\s+large|(?:payload|body|size|record|message|batch|bytes?)\b.*(?:exceeds?|exceeded|over)\b|(?:exceeds?|exceeded|over)\b.*(?:\d+\s*(?:kib|mib|kb|mb|bytes?)|(?:size|payload|body)\s*(?:limit|max))|传输体积超限|体积超限|超出上限|超过.*上限/i;

  function isExplicitOversizeError(recRes) {
    if (!recRes || typeof recRes !== 'object') return false;
    if (recRes.status === 413) return true;
    if (recRes.code === 'PAYLOAD_TOO_LARGE' || recRes.code === 'OVERSIZE' || recRes.phase === 'oversize_guard') return true;
    return EXPLICIT_OVERSIZE_RE.test(String(recRes.error || ''));
  }

  function quarantineOversizedEntry(callId, wm) {
    if (!state.quarantinedOversizeMap) state.quarantinedOversizeMap = new Map();
    const prevQuarantined = state.quarantinedOversizeMap.get(callId);
    state.quarantinedOversizeMap.set(callId, mergeWatermarks(prevQuarantined, wm));
    const curPending = state.pendingFinalCalls.get(callId);
    if (curPending && !hasWatermarkProgressed(getFinalCallWatermark(curPending), wm) && getSingleCallBodyBytes(curPending) > MAX_FLUSH_BATCH_BYTES) {
      state.pendingFinalCalls.delete(callId);
    }
  }

  async function flushPendingFinalCalls(triggerSyncEvenIfUnchanged) {
    if (triggerSyncEvenIfUnchanged && state.flushFinalsBusy) {
      state.pendingFlushForceSync = true;
    }
    if (state.flushFinalsBusy || state.disposed || !state.pendingFinalCalls?.size) return;
    if (Date.now() < (state.nextFlushRetryAt || 0)) return;
    state.flushFinalsBusy = true;
    let anySucceeded = false;
    let anyChanged = false;
    let failedDuringLoop = false;
    try {
      while (!state.disposed && state.pendingFinalCalls.size > 0) {
        if (Date.now() < (state.nextFlushRetryAt || 0)) break;
        const { chunk, snap } = takeNextPendingBatch(state.pendingFinalCalls);
        if (!chunk.length) break;
        const recRes = await recordModelCallsRemote(chunk);
        if (state.disposed) break;
        if (recRes?.ok === true) {
          anySucceeded = true;
          if (recRes.changed) anyChanged = true;
          commitConfirmedEntries(snap);
        } else {
          failedDuringLoop = true;
          state.nextFlushRetryAt = Date.now() + (document.hidden ? 15000 : 3000);
          break;
        }
      }
      if (!state.disposed && !failedDuringLoop && state.pendingFinalCalls.size > 0 && Date.now() >= (state.nextOversizeRetryAt || 0)) {
        const oversizedItems = [];
        for (const call of state.pendingFinalCalls.values()) {
          const singleBytes = getSingleCallBodyBytes(call);
          if (singleBytes > MAX_FLUSH_BATCH_BYTES) {
            oversizedItems.push({ call, singleBytes, wm: getFinalCallWatermark(call) });
          }
        }
        for (const item of oversizedItems) {
          if (state.disposed) break;
          if (!state.pendingFinalCalls.has(item.call.callId)) continue;
          const isLiveHttpMode = (typeof window !== 'undefined' && typeof window.contextMeterAPI?.recordCalls !== 'function' && hasLiveHttpBridge())
            || shouldPreferLiveHost(typeof window?.contextMeterAPI?.recordCalls === 'function', '/record-calls');
          if (isLiveHttpMode && item.singleBytes > MAX_LIVE_RECORD_BODY_BYTES) {
            quarantineOversizedEntry(item.call.callId, item.wm);
            console.warn(`Context Meter: 单条调用记录超过实时通道 1MiB 上限 (${item.singleBytes} bytes)，已隔离跳过: ${item.call.callId}`);
            continue;
          }
          const recRes = await recordModelCallsRemote([item.call]);
          if (state.disposed) break;
          if (recRes?.ok === true) {
            anySucceeded = true;
            if (recRes.changed) anyChanged = true;
            state.nextOversizeRetryAt = 0;
            commitConfirmedEntries([{ callId: item.call.callId, wm: item.wm }]);
          } else if ((isLiveHttpMode && (item.singleBytes > MAX_LIVE_RECORD_BODY_BYTES || recRes?.status === 413)) || isExplicitOversizeError(recRes)) {
            quarantineOversizedEntry(item.call.callId, item.wm);
            console.warn(`Context Meter: 超大调用记录入账被拒绝，已隔离跳过: ${item.call.callId}`);
          } else {
            failedDuringLoop = true;
            const retryAt = Date.now() + (document.hidden ? 15000 : 3000);
            state.nextOversizeRetryAt = retryAt;
            state.nextFlushRetryAt = retryAt;
            break;
          }
        }
      }
      if (!state.disposed && !failedDuringLoop && state.pendingFinalCalls.size > 0 && (state.nextOversizeRetryAt || 0) > Date.now()) {
        const { chunk: remainingNormal } = takeNextPendingBatch(state.pendingFinalCalls);
        if (!remainingNormal.length) {
          state.nextFlushRetryAt = state.nextOversizeRetryAt;
        }
      }
      if (!state.disposed && anySucceeded) {
        if (!failedDuringLoop && state.pendingFinalCalls.size === 0) {
          state.nextFlushRetryAt = 0;
          state.nextOversizeRetryAt = 0;
        }
        if (triggerSyncEvenIfUnchanged || state.pendingFlushForceSync || anyChanged) {
          state.pendingFlushForceSync = false;
          automaticHistorySyncPending = true;
          syncPendingAutomaticHistory();
        }
        if (typeof scheduleQuotaPostTurnRefresh === 'function') {
          scheduleQuotaPostTurnRefresh();
        }
      }
    } finally {
      state.flushFinalsBusy = false;
      if (anySucceeded && !state.disposed && state.pendingFinalCalls.size > 0 && Date.now() >= (state.nextFlushRetryAt || 0)) {
        void flushPendingFinalCalls(true);
      }
    }
  }

  async function requestPoll(generation, id) {

    state.requestBusy = true;
    const controller = new AbortController(); state.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const csrf = window.__APP_CONFIG__?.csrfToken; if (!csrf) throw new Error('后台尚未就绪');
      const offset = Math.max(0, state.count - 3);
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetCascadeTrajectoryGeneratorMetadata', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf }, body: JSON.stringify({ cascadeId: id, generatorMetadataOffset: offset, includeMessages: false }), signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json(); if (generation !== state.generation || state.disposed) return;
      const rows = data.generatorMetadata || [];
      state.count = rows.length ? offset + rows.length : 0;
      if (!state.sessionCallsMap) state.sessionCallsMap = new Map();
      if (!state.syncedFinalMap) state.syncedFinalMap = new Map();
      if (!state.pendingFinalCalls) state.pendingFinalCalls = new Map();
      if (!state.quarantinedOversizeMap) state.quarantinedOversizeMap = new Map();
      const wasHydrated = Boolean(state.callsHydrated);
      let hasNewOrProgressedPending = false;
      const modelConfigsList = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      for (let i = 0; i < rows.length; i++) {
        const call = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
        if (call && call.callId) {
          const prevSessionCall = state.sessionCallsMap.get(call.callId);
          const prevSynced = state.syncedFinalMap.get(call.callId);
          const prevPending = state.pendingFinalCalls.get(call.callId);
          const prevQuarantined = state.quarantinedOversizeMap.get(call.callId);
          let effectiveCall = (prevSessionCall && call.status === 'final' && prevSessionCall.status === 'final')
            ? mergePendingCallData(prevSessionCall, call)
            : call;
          const isNewLiveObservation = Boolean(
            (wasHydrated && !prevSessionCall) ||
            prevSessionCall?.liveRealtimeConfirmed === true ||
            (state.livePendingRequest && state.livePendingRequest.cascadeId === id && call.callId !== state.livePendingRequest.baselineCallId)
          );
          if (isNewLiveObservation) {
            effectiveCall = {
              ...effectiveCall,
              liveRealtimeConfirmed: true,
              liveObservedAtMs: prevSessionCall?.liveObservedAtMs || Date.now()
            };
          }
          if (prevPending && effectiveCall.status === 'final' && prevPending.status === 'final') {
            effectiveCall = mergePendingCallData(prevPending, effectiveCall);
          }
          if (effectiveCall.status === 'final') {
            if (prevSynced) {
              const effWm0 = getFinalCallWatermark(effectiveCall);
              const uCmp0 = compareWatermarkUsage(effWm0, prevSynced);
              const rCmp0 = compareSourceRevision(effWm0.sourceRevision, prevSynced.sourceRevision);
              const restoreSyncedUsage = (uCmp0 < 0 || (uCmp0 === 0 && rCmp0 < 0)) && prevSynced.inp !== undefined;
              const restoreSyncedDate = (prevSynced.dateRank || 0) >= 2 && Boolean(prevSynced.date) && !canAdoptNextDate(effWm0, prevSynced);
              const restoreSyncedRev = rCmp0 < 0 && prevSynced.sourceRevision !== null && prevSynced.sourceRevision !== undefined;
              if (restoreSyncedUsage || restoreSyncedDate || restoreSyncedRev) {
                effectiveCall = {
                  ...effectiveCall,
                  ...(restoreSyncedUsage ? {
                    inputTokens: prevSynced.inp,
                    cacheTokens: prevSynced.cap,
                    cacheReadTokens: prevSynced.cap,
                    outputTokens: prevSynced.out,
                    totalTokens: prevSynced.tot
                  } : {}),
                  ...(restoreSyncedDate ? {
                    date: prevSynced.date,
                    created_at: prevSynced.createdAt || null,
                    ...(prevSynced.dateSource ? { dateSource: prevSynced.dateSource } : {}),
                    dateIsProvisional: false
                  } : {}),
                  ...(restoreSyncedRev ? { sourceRevision: prevSynced.sourceRevision } : {})
                };
                if (restoreSyncedDate && !prevSynced.dateSource) delete effectiveCall.dateSource;
                if (typeof calculateRequestApiCost === 'function' && (effectiveCall.model || effectiveCall.modelKey)) {
                  const recalc = calculateRequestApiCost(effectiveCall);
                  if (recalc.isPriced) {
                    effectiveCall.modelKey = recalc.modelKey;
                    effectiveCall.isPriced = true;
                    effectiveCall.costUSD = recalc.costUSD ?? 0;
                  }
                }
              }
            }
            if (getDateRank(effectiveCall) === 1) {
              let earliestProvDate = effectiveCall.date ? String(effectiveCall.date).slice(0, 10) : '';
              for (const ref of [prevPending, prevSynced, prevQuarantined]) {
                const refRank = ref ? (ref.dateRank !== undefined ? ref.dateRank : getDateRank(ref)) : 0;
                const refDate = ref?.date ? String(ref.date).slice(0, 10) : '';
                if (refRank === 1 && refDate && (!earliestProvDate || refDate < earliestProvDate)) {
                  earliestProvDate = refDate;
                }
              }
              if (earliestProvDate && earliestProvDate !== String(effectiveCall.date || '').slice(0, 10)) {
                effectiveCall = { ...effectiveCall, date: earliestProvDate, created_at: null, dateSource: 'provisional', dateIsProvisional: true };
                if (typeof calculateRequestApiCost === 'function' && (effectiveCall.model || effectiveCall.modelKey)) {
                  const recalc = calculateRequestApiCost(effectiveCall);
                  if (recalc.isPriced) {
                    effectiveCall.modelKey = recalc.modelKey;
                    effectiveCall.isPriced = true;
                    effectiveCall.costUSD = recalc.costUSD ?? 0;
                  }
                }
              }
            }
          }
          state.sessionCallsMap.set(call.callId, effectiveCall);
          if (effectiveCall.status === 'final') {
            const wm = getFinalCallWatermark(effectiveCall);
            if (hasWatermarkProgressed(wm, prevSynced)) {
              if (prevQuarantined && !hasWatermarkProgressed(wm, prevQuarantined) && getSingleCallBodyBytes(effectiveCall) > MAX_FLUSH_BATCH_BYTES) {
                continue;
              }
              const prevPendingWm = prevPending ? getFinalCallWatermark(prevPending) : null;
              const progressedVsPending = hasWatermarkProgressed(wm, prevPendingWm);
              if (progressedVsPending) {
                hasNewOrProgressedPending = true;
                if (getSingleCallBodyBytes(effectiveCall) > MAX_FLUSH_BATCH_BYTES) {
                  state.nextOversizeRetryAt = 0;
                }
              }
              const notRegressedVsPending = !prevPendingWm || (
                compareWatermarkUsage(wm, prevPendingWm) >= 0 &&
                compareSourceRevision(wm.sourceRevision, prevPendingWm.sourceRevision) >= 0 &&
                canAdoptNextDate(wm, prevPendingWm) &&
                getModelRank(wm.model, wm.modelKey) >= getModelRank(prevPendingWm.model, prevPendingWm.modelKey) &&
                (wm.dateRank || 0) >= (prevPendingWm.dateRank || 0) &&
                (!prevPendingWm.modelKey || Boolean(wm.modelKey)) &&
                (!prevPendingWm.isPriced || Boolean(wm.isPriced))
              );
              if (progressedVsPending || notRegressedVsPending) {
                const nextPendingCall = prevPending ? mergePendingCallData(prevPending, effectiveCall) : effectiveCall;
                state.pendingFinalCalls.set(call.callId, nextPendingCall);
              }
            }
          }
        }
      }
      state.callsHydrated = true;
      state.sessionCalls = Array.from(state.sessionCallsMap.values());
      state.sessionCostTotal = state.sessionCalls.reduce((sum, c) => sum + (c.isPriced ? (c.costUSD || 0) : 0), 0);

      // 清除等待首字计时器（禁止用 1000ms 轮询步进时间戳伪造服务器分块流式间隔，避免误判为“输出平稳”）
      const newestPollCall = state.sessionCalls.length ? state.sessionCalls[state.sessionCalls.length - 1] : null;
      if (newestPollCall) {
        if (state.livePendingRequest && state.livePendingRequest.cascadeId === id) {
          const isNewCall = newestPollCall.callId !== state.livePendingRequest.baselineCallId;
          const gotFirstToken = (newestPollCall.outputTokens || 0) > 0 || newestPollCall.ttftSec != null || newestPollCall.status === 'final';
          if ((isNewCall && gotFirstToken) || (state.count > (state.livePendingRequest.baselineCount || 0) && gotFirstToken) || newestPollCall.error) {
            clearLivePendingRequestWait();
          }
        }
      }

      if (hasNewOrProgressedPending) {
        state.nextFlushRetryAt = 0;
      }
      if (state.pendingFinalCalls.size > 0) {
        void flushPendingFinalCalls(wasHydrated);
      }
      for (let i = rows.length - 1; i >= 0; i--) {
        const value = summarize(rows[i], { cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [] });
        if (value) {
          state.latest = withStepError(value, rows[i]);
          const callInfo = parseGeneratorCall ? parseGeneratorCall(rows[i], id, 'desktop', { cascadeModelConfigs: modelConfigsList }) : null;
          recordObservationFromSummary(state.latest, id, {
            callId: callInfo?.callId || null,
            stepCount: state.count,
            ts: Date.now()
          });
          break;
        }
      }
      state.requestAt = Date.now(); state.requestError = '';
      if (state.historyDrawerOpen) scheduleLatestCallRefresh({ allowTimelineRefresh: true });
    } catch (e) { if (generation === state.generation && !state.disposed) state.requestError = e.name === 'AbortError' ? '读取超时' : e.message; }
    finally {
      clearTimeout(timeout);
      state.controllers.delete(controller);
      if (generation === state.generation && !state.disposed) {
        state.requestBusy = false;
        const latestRecNow = resolveLatestSessionCallRecord();
        const isStreamingNow = Boolean(latestRecNow && latestRecNow.status === 'streaming');
        const nextDelay = document.hidden ? 15000 : (isStreamingNow ? 1000 : 3000);
        state.requestNext = Date.now() + nextDelay;
        render();
      }
    }
  }

  async function scan(generation, id, force = false) {
    state.scanBusy = true; render();
    try {
      let result;
      const hasIpcScan = typeof window !== 'undefined' && typeof window.contextMeterAPI?.scan === 'function';
      if (!hasIpcScan && !hasLiveHttpBridge()) {
        throw new Error('完整重启 Antigravity 后启用附件扫描');
      }
      const controller = new AbortController(); state.controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 180000);
      try {
        const out = await callBackendWithPriority({
          ipcCall: hasIpcScan ? () => window.contextMeterAPI.scan(id, force) : null,
          liveRoute: '/scan',
          liveBody: { id, force },
          liveFetchOpts: { signal: controller.signal }
        });
        result = out.result;
      } finally {
        clearTimeout(timeout);
        state.controllers.delete(controller);
      }
      if (generation !== state.generation || state.disposed) return;
      if (result?.data?.abortedStale) return;
      if (!result?.ok) throw new Error(result?.error || '扫描未返回有效结果');
      state.scan = result.data; state.scanError = '';
      if (result.data.modelCapabilitiesById && typeof result.data.modelCapabilitiesById === 'object') {
        mergeCapabilitiesMapClient(result.data.modelCapabilitiesById);
      }
      if (Array.isArray(result.data.cascadeModelConfigs) && result.data.cascadeModelConfigs.length) {
        state.cascadeModelConfigs = result.data.cascadeModelConfigs;
      }
      if (result.data.scannedAt >= state.requestAt && result.data.latest) {
        state.latest = result.data.latest;
        state.requestAt = result.data.scannedAt;
        const genSteps = Number(result.data.generatorCount);
        const msgSteps = Number(result.data.session?.userMessages || 0) + Number(result.data.session?.assistantMessages || 0);
        const resolvedStepCount = Number.isFinite(genSteps) && genSteps >= 0 ? genSteps : (msgSteps > 0 ? msgSteps : state.count);
        recordObservationFromSummary(state.latest, id, {
          callId: result.data.latestCallId || null,
          stepCount: resolvedStepCount,
          ts: Number(result.data.scannedAt || Date.now())
        });
      }
      state.latest = withStepError(state.latest);
      renderFiles(result.data.session);
      if (state.historyDrawerOpen) scheduleLatestCallRefresh({ allowTimelineRefresh: true });
    } catch (e) { if (generation === state.generation && !state.disposed) state.scanError = e.message; }
    finally { if (generation === state.generation && !state.disposed) { state.scanBusy = false; state.scanNext = Date.now() + (document.hidden ? 60000 : 20000); render(); } }
  }

  let lastAvailableModelsSync = 0;
  let availableModelsFetchInFlight = false;
  async function fetchAvailableModelsIfNeeded() {
    if (availableModelsFetchInFlight) return;
    if (typeof fetch !== 'function') return;
    const csrf = typeof window !== 'undefined' ? window.__APP_CONFIG__?.csrfToken : null;
    if (!csrf) return;
    if (Date.now() - lastAvailableModelsSync < 300000 && state.modelCapabilitiesById && Object.keys(state.modelCapabilitiesById).length > 0) {
      return;
    }
    availableModelsFetchInFlight = true;
    try {
      const response = await fetch('/exa.language_server_pb.LanguageServerService/GetAvailableModels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1', 'x-codeium-csrf-token': csrf },
        body: JSON.stringify({ forceRefresh: false })
      });
      if (!response.ok) return;
      const data = await response.json();
      const modelsObj = data?.response?.models || data?.models;
      if (!modelsObj || typeof modelsObj !== 'object') return;
      const entries = Array.isArray(modelsObj)
        ? modelsObj.map(item => [item?.model || item?.modelId || '', item])
        : Object.entries(modelsObj);
      const nextCaps = {};
      for (const [entryKey, d] of entries) {
        if (!d || typeof d !== 'object') continue;
        const rawId = String(d.model || d.modelId || entryKey || '').trim();
        if (!rawId) continue;
        const normKey = rawId.toLowerCase().replace(/^model_/, '');
        const maxTokens = Number.isSafeInteger(Number(d.maxTokens)) && Number(d.maxTokens) > 0 ? Number(d.maxTokens) : null;
        const maxOutputTokens = d.maxOutputTokens != null && Number.isSafeInteger(Number(d.maxOutputTokens)) && Number(d.maxOutputTokens) >= 0
          ? Number(d.maxOutputTokens)
          : null;
        const rec = {
          modelId: rawId,
          displayName: d.displayName || null,
          maxTokens,
          maxOutputTokens,
          thinkingBudget: d.thinkingBudget ?? null,
          minThinkingBudget: d.minThinkingBudget ?? null,
          thinkingLevel: d.thinkingLevel || null,
          supportsModelInfoOverride: typeof d.supportsModelInfoOverride === 'boolean' ? d.supportsModelInfoOverride : null,
          capabilitySource: 'get_available_models'
        };
        if (normKey) nextCaps[normKey] = rec;
        if (entryKey) nextCaps[String(entryKey).trim().toLowerCase().replace(/^model_/, '')] = rec;
      }
      if (Object.keys(nextCaps).length > 0) {
        mergeCapabilitiesMapClient(nextCaps);
        lastAvailableModelsSync = Date.now();
        if (!isContextSettingsView && activeContextTab === 'models') {
          renderModelSettingsTab();
          renderPresetSelectionUI();
        }
      }
    } catch { }
    finally {
      availableModelsFetchInFlight = false;
    }
  }
