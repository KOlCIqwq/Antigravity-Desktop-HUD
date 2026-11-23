  function isOpaqueModelToken(raw) {
    const s = String(raw || '').trim();
    if (!s) return true;
    if (/^(?:model_placeholder_|placeholder[-_]|model_)/i.test(s)) return true;
    return !/[A-Z\s()]/.test(s);
  }

  function buildLookupKeysForModel(val) {
    const clean = String(val || '').trim().toLowerCase();
    if (!clean) return [];
    const stripped = clean.replace(/^model_/, '');
    const keys = [clean, stripped];
    const mPh = stripped.match(/placeholder[_-]?(m\d+)$/);
    if (mPh) keys.push(`model_placeholder_${mPh[1]}`, `placeholder-${mPh[1]}`, mPh[1]);
    return Array.from(new Set(keys));
  }

  function lookupModelDisplayLabel(call, cascadeModelConfigs = [], availableModelDetails = null) {
    const rawCandidates = [
      call?.modelExactId,
      call?.modelOrAlias?.model,
      call?.modelId,
      call?.chatModel?.modelId,
      call?.modelRaw,
      call?.model
    ].filter(v => typeof v === 'string' && v.trim());

    const candKeySet = new Set();
    for (const rc of rawCandidates) {
      for (const k of buildLookupKeysForModel(rc)) candKeySet.add(k);
    }
    if (candKeySet.size === 0) return '';

    if (Array.isArray(cascadeModelConfigs)) {
      for (const cfg of cascadeModelConfigs) {
        if (!cfg || typeof cfg !== 'object') continue;
        const lbl = String(cfg.label || cfg.displayName || '').trim();
        if (!lbl || isOpaqueModelToken(lbl)) continue;
        const cfgKeys = [
          ...buildLookupKeysForModel(cfg.modelId),
          ...buildLookupKeysForModel(cfg.modelOrAlias?.model),
          ...buildLookupKeysForModel(cfg.model)
        ];
        if (cfgKeys.some(k => candKeySet.has(k))) return lbl;
      }
    }

    if (availableModelDetails && typeof availableModelDetails === 'object') {
      for (const ck of candKeySet) {
        const direct = availableModelDetails[ck];
        const directName = String(direct?.displayName || direct?.label || '').trim();
        if (directName && !isOpaqueModelToken(directName)) return directName;
      }
      for (const [aKey, detail] of Object.entries(availableModelDetails)) {
        if (!detail || typeof detail !== 'object') continue;
        const dName = String(detail.displayName || detail.label || '').trim();
        if (!dName || isOpaqueModelToken(dName)) continue;
        const dKeys = [
          ...buildLookupKeysForModel(aKey),
          ...buildLookupKeysForModel(detail.modelId),
          ...buildLookupKeysForModel(detail.normalizedId)
        ];
        if (dKeys.some(k => candKeySet.has(k))) return dName;
      }
    }

    for (const ck of candKeySet) {
      if (MODEL_USAGE_ID_FALLBACK_LABELS[ck]) return MODEL_USAGE_ID_FALLBACK_LABELS[ck];
    }
    return '';
  }

  function resolveModelUsageBucket(call, cascadeModelConfigs = [], availableModelDetails = null) {
    if (!call || typeof call !== 'object') {
      return { modelKey: UNATTRIBUTED_MODEL_KEY, modelLabel: null, variantKey: UNATTRIBUTED_MODEL_KEY, variantLabel: null, isAttributed: false };
    }
    const rawStr = String(call.model || call.modelLabel || call.modelExactId || call.modelId || '').trim();
    if (!rawStr) {
      return { modelKey: UNATTRIBUTED_MODEL_KEY, modelLabel: null, variantKey: UNATTRIBUTED_MODEL_KEY, variantLabel: null, isAttributed: false };
    }
    const resolvedStable = resolveStableModelId(call, cascadeModelConfigs);
    const dynamicOrFallbackLabel = lookupModelDisplayLabel(
      { ...call, modelExactId: call.modelExactId || resolvedStable },
      cascadeModelConfigs,
      availableModelDetails
    );
    const explicitHumanLabel = (call.modelLabel && !isOpaqueModelToken(call.modelLabel))
      ? String(call.modelLabel).trim()
      : (call.chatModel?.modelDisplayName && !isOpaqueModelToken(call.chatModel.modelDisplayName))
        ? String(call.chatModel.modelDisplayName).trim()
        : '';
    const effectiveLabel = dynamicOrFallbackLabel || explicitHumanLabel || (!isOpaqueModelToken(rawStr) ? rawStr : '');
    const probeText = `${effectiveLabel} ${rawStr} ${resolvedStable || ''}`.trim();
    const probeLower = probeText.toLowerCase();

    // Dedicated mapping for Orchestrator and Worker sub-models:
    // - gemini-flash-worker-agy / M669 / Gemini 4 Hydrogen (Orchestrator) -> Gemini 4 Hydrogen, effort (Orchestrator)
    // - Orchestrator (Carbon / Argon) -> dedicated Orchestrator model family, expanded by tier Carbon / Argon
    if (
      probeLower.includes('worker-agy') ||
      /\bm669\b/.test(probeLower) ||
      (probeLower.includes('hydrogen') && probeLower.includes('orchestrator'))
    ) {
      return {
        modelKey: 'gemini-4-hydrogen',
        modelLabel: 'Gemini 4 Hydrogen',
        variantKey: 'gemini-4-hydrogen:orchestrator',
        variantLabel: 'Gemini 4 Hydrogen (Orchestrator)',
        isAttributed: true
      };
    }

    if (
      probeLower.includes('orchestrator') ||
      /\b(?:model_placeholder_|placeholder[-_])?m(?:667|668|681)\b/.test(probeLower)
    ) {
      let tier = null;
      let tierLabel = null;
      const lblLower = effectiveLabel.toLowerCase();
      if (lblLower.includes('carbon') || probeLower.includes('carbon') || /\b(?:model_placeholder_|placeholder[-_])?m(?:667|670)\b/.test(probeLower)) {
        tier = 'carbon';
        tierLabel = 'Orchestrator (Carbon)';
      } else if (lblLower.includes('argon') || probeLower.includes('argon') || /\b(?:model_placeholder_|placeholder[-_])?m(?:668|681)\b/.test(probeLower)) {
        tier = 'argon';
        tierLabel = 'Orchestrator (Argon)';
      }
      return {
        modelKey: 'orchestrator',
        modelLabel: 'Orchestrator',
        variantKey: tier ? `orchestrator:${tier}` : 'orchestrator',
        variantLabel: tierLabel || 'Orchestrator',
        isAttributed: true
      };
    }

    let modelKey = (effectiveLabel ? normalizeModelId(effectiveLabel) : null) || normalizeModelId(rawStr) || normalizeModelId(probeText);
    if (!modelKey && probeLower.includes('gpt-oss')) {
      modelKey = 'gpt-oss-120b';
    }
    const prod = groupModelProduct({
      modelId: resolvedStable || call.modelExactId || call.modelId || rawStr,
      label: effectiveLabel,
      effort: call.effort
    });
    if (!modelKey) {
      const slug = String(prod.productLabel || effectiveLabel || resolvedStable || rawStr)
        .toLowerCase()
        .replace(/^model_/, '')
        .replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '');
      modelKey = slug || UNATTRIBUTED_MODEL_KEY;
    }
    if (modelKey === UNATTRIBUTED_MODEL_KEY) {
      return { modelKey: UNATTRIBUTED_MODEL_KEY, modelLabel: null, variantKey: UNATTRIBUTED_MODEL_KEY, variantLabel: null, isAttributed: false };
    }
    const modelLabel = MODEL_PRODUCT_DISPLAY_NAMES[modelKey] || prod.productLabel || modelKey;
    let effort = prod.effort || null;
    if (!effort) {
      const effProbe = `${effectiveLabel} ${rawStr} ${resolvedStable || ''}`;
      const mEff = effProbe.match(/[:\-_\s(（](x[-_]?high|extra[-_]?high|low|medium|high|minimal|max)[)）]?(?=$|\s)/i);
      if (mEff) effort = formatEffortLabel(mEff[1]);
    }
    const variantKey = effort ? `${modelKey}:${effort.toLowerCase().replace(/\s+/g, '')}` : modelKey;
    const variantLabel = effort ? `${modelLabel} (${effort})` : modelLabel;
    return {
      modelKey,
      modelLabel,
      variantKey,
      variantLabel,
      isAttributed: true
    };
  }

  function shiftIsoDateDays(dateStr, deltaDays) {
    const parts = String(dateStr || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return '';
    const d = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2] + deltaDays));
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function parseHexRgb(hexStr) {
    const clean = String(hexStr || '').trim().replace(/^#/, '');
    if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
    const n = parseInt(clean, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function shiftHexShade(hexStr, amount) {
    const rgb = parseHexRgb(hexStr);
    if (!rgb) return hexStr;
    const amt = Math.max(-0.6, Math.min(0.6, Number(amount) || 0));
    const mix = (ch) => amt >= 0
      ? Math.round(ch + (255 - ch) * amt)
      : Math.round(ch * (1 + amt));
    const to2 = v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0');
    return `#${to2(mix(rgb.r))}${to2(mix(rgb.g))}${to2(mix(rgb.b))}`;
  }

  function resolveBaseModelColor(baseKey, rankIdx = 0, options = {}) {
    const isLight = options.theme === 'light';
    const fixedTable = isLight ? MODEL_FIXED_COLORS_LIGHT : MODEL_FIXED_COLORS_DARK;
    const palette = isLight ? MODEL_FALLBACK_PALETTE_LIGHT : MODEL_FALLBACK_PALETTE_DARK;
    const accentHex = parseHexRgb(options.accentColor) ? String(options.accentColor).trim() : null;

    if (baseKey === 'gemini-4-hydrogen' && accentHex) {
      return accentHex;
    }
    if (fixedTable[baseKey]) return fixedTable[baseKey];
    if (baseKey.startsWith('claude-')) {
      return baseKey.includes('sonnet') ? fixedTable['claude-sonnet-5-5'] : fixedTable['claude-opus-5-5'];
    }
    if (baseKey.includes('gpt')) return fixedTable['gpt-oss-120b'];
    if (baseKey.includes('flash')) return fixedTable['gemini-3.8-flash'];
    if (baseKey.includes('argon')) return fixedTable['gemini-4-argon'];
    if (baseKey.includes('carbon')) return fixedTable['gemini-4-carbon'];
    if (baseKey.includes('orchestrator')) return fixedTable['orchestrator'];
    if (baseKey.includes('hydrogen')) return accentHex || fixedTable['gemini-4-hydrogen'];
    let hash = 0;
    for (let i = 0; i < baseKey.length; i++) {
      hash = (hash * 31 + baseKey.charCodeAt(i)) >>> 0;
    }
    return palette[(rankIdx + hash) % palette.length];
  }

  function getModelChartColor(key, rankIdx = 0, options = {}) {
    const isLight = options.theme === 'light';
    const fixedTable = isLight ? MODEL_FIXED_COLORS_LIGHT : MODEL_FIXED_COLORS_DARK;
    if (key === UNATTRIBUTED_MODEL_KEY) return fixedTable[UNATTRIBUTED_MODEL_KEY];

    const parts = String(key || '').split(':');
    const baseKey = parts[0] || String(key || '');
    const effortPart = (parts[1] || '').toLowerCase();
    const baseColor = resolveBaseModelColor(baseKey, rankIdx, options);

    if (!effortPart) return baseColor;
    // Differentiate effort tiers or special roles (e.g. Orchestrator) within the same model family using lightness steps of the same hue
    const shadeOffsetByEffort = isLight
      ? { xhigh: -0.24, extrahigh: -0.24, max: -0.24, orchestrator: -0.14, carbon: -0.14, high: -0.05, medium: 0.16, argon: 0.16, low: 0.34, minimal: 0.42 }
      : { xhigh: -0.22, extrahigh: -0.22, max: -0.22, orchestrator: -0.12, carbon: -0.14, high: -0.04, medium: 0.18, argon: 0.16, low: 0.34, minimal: 0.42 };
    const offset = shadeOffsetByEffort[effortPart];
    return offset !== undefined ? shiftHexShade(baseColor, offset) : baseColor;
  }

  /**
   * Aggregate per-day, per-model token distribution and legend shares for a given day window (7d/30d) and grouping granularity
   */
  function summarizeModelUsageWindow(dailyModelMap = {}, options = {}) {
    const periodDays = Number(options.periodDays) === 30 ? 30 : 7;
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(String(options.endDate || ''))
      ? String(options.endDate)
      : formatLocalDateKeyCompat(new Date());
    const startDate = shiftIsoDateDays(endDate, -(periodDays - 1));
    const groupBy = options.groupBy === 'variant' ? 'variant' : 'model';
    const metric = options.metric === 'noCache' ? 'noCache' : 'total';
    const hideUnattributed = Boolean(options.hideUnattributed);
    const metaMap = (options.modelMetaByKey && typeof options.modelMetaByKey === 'object') ? options.modelMetaByKey : {};

    const resolveMetricVal = (rec) => {
      if (!rec) return 0;
      const inp = Number(rec.input) || 0;
      const out = Number(rec.output) || 0;
      const cac = Number(rec.cache) || 0;
      const tot = Number(rec.total) || (inp + out + cac);
      return metric === 'noCache' ? Math.max(0, inp + out) : Math.max(0, tot);
    };

    const windowTotalsByGroup = new Map();
    const dayBucketsList = [];
    let unattributedTokens = 0;
    let windowTotalTokens = 0;
    let windowTotalSteps = 0;

    const customBuckets = Array.isArray(options.bucketKeys) && options.bucketKeys.length ? options.bucketKeys : null;
    const bucketList = customBuckets || Array.from({ length: periodDays }, (_, i) => shiftIsoDateDays(startDate, i));

    for (const dStr of bucketList) {
      const dayRaw = (dailyModelMap && dailyModelMap[dStr] && typeof dailyModelMap[dStr] === 'object') ? dailyModelMap[dStr] : {};
      const dayGrouped = new Map();
      let dayTotal = 0;

      for (const [rawKey, rec] of Object.entries(dayRaw)) {
        if (!rec || typeof rec !== 'object') continue;
        const val = resolveMetricVal(rec);
        const inp = Number(rec.input) || 0;
        const out = Number(rec.output) || 0;
        const cac = Number(rec.cache) || 0;
        const steps = Number(rec.steps) || 0;
        if (val <= 0 && steps <= 0) continue;

        const isUnattr = rawKey === UNATTRIBUTED_MODEL_KEY;
        if (isUnattr) unattributedTokens += val;
        if (isUnattr && hideUnattributed) continue;

        const meta = metaMap[rawKey] || null;
        let gKey = rawKey;
        let gLabel = rawKey;
        if (isUnattr) {
          gKey = UNATTRIBUTED_MODEL_KEY;
          gLabel = options.unattributedLabel || '未标明模型';
        } else if (groupBy === 'model') {
          gKey = meta?.modelKey || rawKey.split(':')[0] || rawKey;
          gLabel = meta?.modelLabel || MODEL_PRODUCT_DISPLAY_NAMES[gKey] || gKey;
        } else {
          gKey = rawKey;
          gLabel = meta?.variantLabel || meta?.modelLabel || rawKey;
        }

        const prevDay = dayGrouped.get(gKey) || { key: gKey, label: gLabel, tokens: 0, input: 0, output: 0, cache: 0, steps: 0 };
        prevDay.tokens += val;
        prevDay.input += inp;
        prevDay.output += out;
        prevDay.cache += cac;
        prevDay.steps += steps;
        dayGrouped.set(gKey, prevDay);
        dayTotal += val;

        const prevWin = windowTotalsByGroup.get(gKey) || { key: gKey, label: gLabel, tokens: 0, input: 0, output: 0, cache: 0, steps: 0 };
        prevWin.tokens += val;
        prevWin.input += inp;
        prevWin.output += out;
        prevWin.cache += cac;
        prevWin.steps += steps;
        windowTotalsByGroup.set(gKey, prevWin);
        windowTotalTokens += val;
        windowTotalSteps += steps;
      }

      dayBucketsList.push({ date: dStr, total: dayTotal, grouped: dayGrouped });
    }

    // Sort: identified models by descending window total; unidentified models pinned at the bottom
    const sortedWin = Array.from(windowTotalsByGroup.values()).sort((a, b) => {
      if (a.key === UNATTRIBUTED_MODEL_KEY && b.key !== UNATTRIBUTED_MODEL_KEY) return 1;
      if (b.key === UNATTRIBUTED_MODEL_KEY && a.key !== UNATTRIBUTED_MODEL_KEY) return -1;
      return b.tokens - a.tokens || a.label.localeCompare(b.label);
    });

    const colorByKey = new Map();
    const orderByKey = new Map();
    const usedColors = new Set();
    const themeOpt = options.theme === 'light' ? 'light' : 'dark';
    const fallbackPalette = themeOpt === 'light' ? MODEL_FALLBACK_PALETTE_LIGHT : MODEL_FALLBACK_PALETTE_DARK;
    const colorOpts = { theme: themeOpt, accentColor: options.accentColor || null };
    sortedWin.forEach((item, idx) => {
      orderByKey.set(item.key, idx);
      let color = getModelChartColor(item.key, idx, colorOpts);
      if (item.key !== UNATTRIBUTED_MODEL_KEY && usedColors.has(color)) {
        const isVariant = item.key.includes(':');
        if (isVariant) {
          color = shiftHexShade(color, themeOpt === 'light' ? 0.12 : -0.12);
        }
        if (usedColors.has(color)) {
          const alt = fallbackPalette.find(c => !usedColors.has(c));
          if (alt) color = alt;
        }
      }
      usedColors.add(color);
      colorByKey.set(item.key, color);
    });

    const formatPctLabel = (pct) => {
      if (pct <= 0) return '0%';
      if (pct < 0.1) return '<0.1%';
      const rounded = Math.round(pct * 10) / 10;
      return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
    };

    const legend = sortedWin.map(item => {
      const pct = windowTotalTokens > 0 ? (item.tokens / windowTotalTokens) * 100 : 0;
      const cacheStats = computeCacheReadStats({
        inputTokens: item.input,
        cacheReadTokens: item.cache,
        outputTokens: item.output,
        hasInputCacheFields: (item.input > 0 || item.cache > 0 || item.output > 0)
      });
      return {
        ...item,
        color: colorByKey.get(item.key) || '#71717a',
        pct,
        pctLabel: formatPctLabel(pct),
        cacheReadPct: cacheStats.cacheReadPct,
        cacheStatus: cacheStats.cacheStatus
      };
    });

    let maxDayTotal = 0;
    const days = dayBucketsList.map(d => {
      if (d.total > maxDayTotal) maxDayTotal = d.total;
      const segs = Array.from(d.grouped.values())
        .filter(s => s.tokens > 0)
        .sort((a, b) => (orderByKey.get(a.key) ?? 999) - (orderByKey.get(b.key) ?? 999))
        .map(s => {
          const segCache = computeCacheReadStats({
            inputTokens: s.input,
            cacheReadTokens: s.cache,
            outputTokens: s.output,
            hasInputCacheFields: (s.input > 0 || s.cache > 0 || s.output > 0)
          });
          return {
            ...s,
            color: colorByKey.get(s.key) || '#71717a',
            pct: d.total > 0 ? (s.tokens / d.total) * 100 : 0,
            cacheReadPct: segCache.cacheReadPct
          };
        });
      return {
        date: d.date,
        total: d.total,
        segments: segs
      };
    });

    return {
      periodDays,
      startDate,
      endDate,
      groupBy,
      metric,
      hideUnattributed,
      days,
      legend,
      maxDayTotal,
      windowTotalTokens,
      windowTotalSteps,
      hasUnattributed: unattributedTokens > 0,
      unattributedTokens
    };
  }

  function formatLocalDateKeyCompat(d) {
    const dt = d instanceof Date ? d : new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  /**
   * Normalize input, cache-read, and output tokens for a single call or summary object.
   * Verified against local transcript.jsonl, chatModel.usage, and pricing_ledger:
   * Antigravity records inputTokens/input_tokens as uncached new input and cacheReadTokens/cache_read_tokens as cache read;
   * they are mutually exclusive, so normalized totalInput = uncachedInput + cacheRead.
   * Subtract cacheRead only when inputIncludesCache === true is explicitly set, avoiding double counting.
   */
  function normalizeCallInputCacheTokens(rec) {
    if (!rec || typeof rec !== 'object') {
      return {
        hasInputCacheFields: false,
        uncachedInput: null,
        cacheRead: null,
        totalInput: null,
        output: null,
        totalTokens: null
      };
    }

    const rawInp = rec.inputTokens ?? rec.input_tokens ?? rec.input;
    const rawCap = rec.cacheReadTokens ?? rec.cacheTokens ?? rec.cache_read_tokens ?? rec.cached ?? rec.cache;
    const rawOut = rec.outputTokens ?? rec.output_tokens ?? rec.output;
    const explicitMissing = rec.hasInputCacheFields === false;

    const hasInp = !explicitMissing && rawInp !== undefined && rawInp !== null && Number.isFinite(Number(rawInp));
    const hasCap = !explicitMissing && rawCap !== undefined && rawCap !== null && Number.isFinite(Number(rawCap));
    const hasOut = rawOut !== undefined && rawOut !== null && Number.isFinite(Number(rawOut));

    // Never fabricate 0 for missing values when a record has no input or cache fields at all
    if (!hasInp && !hasCap) {
      const rawTot = rec.totalTokens ?? rec.total;
      const totVal = rawTot !== undefined && rawTot !== null && Number.isFinite(Number(rawTot)) ? Math.max(0, Number(rawTot)) : null;
      return {
        hasInputCacheFields: false,
        uncachedInput: null,
        cacheRead: null,
        totalInput: null,
        output: hasOut ? Math.max(0, Number(rawOut)) : null,
        totalTokens: totVal
      };
    }

    // Proto3 JSON omits zero-valued fields: when at least one input/cache field is present, treat the omitted counterpart as 0
    const inpVal = hasInp ? Math.max(0, Number(rawInp)) : 0;
    const capVal = hasCap ? Math.max(0, Number(rawCap)) : 0;
    const outVal = hasOut ? Math.max(0, Number(rawOut)) : 0;

    let uncachedInput;
    let totalInput;
    if (rec.inputIncludesCache === true) {
      totalInput = Math.max(inpVal, capVal);
      uncachedInput = Math.max(0, totalInput - capVal);
    } else {
      uncachedInput = inpVal;
      totalInput = inpVal + capVal;
    }

    const rawTot = rec.totalTokens ?? rec.total;
    const computedTot = totalInput + outVal;
    const totalTokens = rawTot !== undefined && rawTot !== null && Number.isFinite(Number(rawTot)) && Number(rawTot) > 0
      ? Math.max(Number(rawTot), computedTot)
      : computedTot;

    return {
      hasInputCacheFields: true,
      uncachedInput,
      cacheRead: capVal,
      totalInput,
      output: hasOut ? outVal : null,
      totalTokens
    };
  }

  /**
   * Compute cache-read ratio for a single call or bucket record.
   * Returns null for both cacheReadRatio and cacheReadPct when fields are missing or denominator is 0 (never fabricates 0%).
   */
  function computeCacheReadStats(rec) {
    const norm = normalizeCallInputCacheTokens(rec);
    if (!norm.hasInputCacheFields || norm.totalInput === null || norm.cacheRead === null) {
      return {
        ...norm,
        cacheReadRatio: null,
        cacheReadPct: null,
        cacheStatus: 'missing'
      };
    }
    if (norm.totalInput <= 0) {
      return {
        ...norm,
        cacheReadRatio: null,
        cacheReadPct: null,
        cacheStatus: 'zero_input'
      };
    }
    const ratio = Math.max(0, Math.min(1, norm.cacheRead / norm.totalInput));
    const pct = Number((ratio * 100).toFixed(1));
    return {
      ...norm,
      cacheReadRatio: ratio,
      cacheReadPct: pct,
      cacheStatus: norm.cacheRead > 0 ? 'hit' : 'zero_cache'
    };
  }

  /**
   * Aggregate weighted cache-read percentage and request cache-hit rate over reliable denominators.
   * - cacheReadPct: sum(cacheRead) / sum(totalInput), never average per-call percentages directly.
   * - requestHitPct: cache-hit requests / evaluable requests (valid only when denominator > 0).
   */
  function summarizeCacheReadStats(records = []) {
    const list = Array.isArray(records) ? records : [];
    let totalUncachedInput = 0;
    let totalCacheRead = 0;
    let totalInput = 0;
    let totalOutput = 0;
    let evaluatedRequestCount = 0;
    let cacheHitRequestCount = 0;
    let missingCount = 0;
    let zeroInputCount = 0;

    for (const r of list) {
      const st = computeCacheReadStats(r);
      if (st.output !== null) totalOutput += st.output;
      if (st.cacheStatus === 'missing') {
        missingCount++;
        continue;
      }
      if (st.cacheStatus === 'zero_input') {
        zeroInputCount++;
        continue;
      }
      evaluatedRequestCount++;
      totalUncachedInput += st.uncachedInput;
      totalCacheRead += st.cacheRead;
      totalInput += st.totalInput;
      if (st.cacheStatus === 'hit') {
        cacheHitRequestCount++;
      }
    }

    const cacheReadRatio = totalInput > 0 ? Math.max(0, Math.min(1, totalCacheRead / totalInput)) : null;
    const cacheReadPct = cacheReadRatio !== null ? Number((cacheReadRatio * 100).toFixed(1)) : null;
    const requestHitRatio = evaluatedRequestCount > 0 ? cacheHitRequestCount / evaluatedRequestCount : null;
    const requestHitPct = requestHitRatio !== null ? Number((requestHitRatio * 100).toFixed(1)) : null;
    const cacheStatus = totalInput > 0
      ? (totalCacheRead > 0 ? 'hit' : 'zero_cache')
      : (missingCount > 0 && zeroInputCount === 0 ? 'missing' : (zeroInputCount > 0 ? 'zero_input' : 'missing'));

    return {
      totalUncachedInput,
      totalCacheRead,
      totalInput,
      totalOutput,
      cacheReadRatio,
      cacheReadPct,
      cacheStatus,
      evaluatedRequestCount,
      cacheHitRequestCount,
      requestHitRatio,
      requestHitPct,
      missingCount,
      zeroInputCount
    };
  }

  /**
   * Compute cache-read percentage from daily summary Map (reusing the same weighted formula; legacy records without breakdown are excluded from denominator)
   * @param {Object} dailyMap
   * @param {string} [datePrefix=''] - Date prefix filter (e.g. '2026-11')
   */
  function summarizeDailyMapCacheStats(dailyMap = {}, datePrefix = '') {
    if (!dailyMap || typeof dailyMap !== 'object') {
      return summarizeCacheReadStats([]);
    }
    const items = [];
    for (const [k, rec] of Object.entries(dailyMap)) {
      if (datePrefix && !String(k).startsWith(datePrefix)) continue;
      if (!rec || typeof rec !== 'object') continue;
      const inp = Number(rec.input || 0);
      const cap = Number(rec.cache || 0);
      const out = Number(rec.output || 0);
      const tot = Number(rec.total || 0);
      const hasSplit = inp > 0 || cap > 0 || (tot > 0 && inp + cap + out === tot);
      items.push(hasSplit
        ? { inputTokens: inp, cacheReadTokens: cap, outputTokens: out, totalTokens: tot, hasInputCacheFields: true }
        : { totalTokens: tot, hasInputCacheFields: false }
      );
    }
    return summarizeCacheReadStats(items);
  }

  /**
   * Normalize a single session call record (shared by latest-call card, turn timeline, and cache stats).
   */
  function normalizeSessionCallRecord(raw, options = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];
    const callId = String(raw.callId || extractCallId(raw, raw.cascadeId || options.cascadeId || null, raw.stepIndex ?? null) || '').trim();
    if (!callId) return null;

    const availableModels = options.availableModels || options.userStatus?.availableModels || null;
    const phInfo = resolvePlaceholderModelInfo(raw, cascadeConfigs, availableModels);
    const bucket = resolveModelUsageBucket(raw, cascadeConfigs);
    const modelExactId = raw.modelExactId || resolveStableModelId(raw, cascadeConfigs) || null;
    const rawCandidateLabel = raw.modelLabel
      || phInfo.displayName
      || bucket.modelLabel
      || (raw.model && !/^model_/i.test(String(raw.model)) ? String(raw.model) : null)
      || (phInfo.isPlaceholder && !phInfo.isMapped ? null : modelExactId);
    const effortCandidate = raw.effort || phInfo.effort || (bucket.variantKey && bucket.variantKey.includes(':') ? bucket.variantKey.split(':')[1] : null);
    const splitDisp = splitModelDisplayAndEffort(rawCandidateLabel, effortCandidate);
    const modelLabel = (phInfo.isPlaceholder && !phInfo.isMapped)
      ? null
      : (splitDisp.baseLabel || bucket.modelLabel || modelExactId || null);
    const effort = splitDisp.effort ? formatEffortLabel(splitDisp.effort) : null;
    const cacheStats = computeCacheReadStats(raw);

    const rawError = String(raw.error || '').trim();
    const errorClassification = raw.errorClassification || (rawError
      ? classifyRequestError(rawError, {
        currentModel: modelLabel || raw.model || '',
        cascadeModelConfigs: cascadeConfigs,
        userStatus: options.userStatus || null
      })
      : null);

    let outcomeStatus = raw.outcomeStatus || (raw.status === 'streaming' ? 'streaming' : 'success');
    if (rawError && (!raw.outcomeStatus || raw.outcomeStatus === 'success')) {
      const k = errorClassification?.kind || 'failed';
      outcomeStatus = k === 'context_overflow' ? 'exceeded' : (k === 'network_error' ? 'network' : (k === 'unknown' || k === 'none' ? 'failed' : k));
    }

    const ttftSec = raw.ttftSec !== undefined && raw.ttftSec !== null && Number.isFinite(Number(raw.ttftSec))
      ? Number(Number(raw.ttftSec).toFixed(2))
      : null;
    const streamingSec = raw.streamingSec !== undefined && raw.streamingSec !== null && Number.isFinite(Number(raw.streamingSec))
      ? Number(Number(raw.streamingSec).toFixed(2))
      : null;
    let durationSec = raw.durationSec !== undefined && raw.durationSec !== null && Number.isFinite(Number(raw.durationSec))
      ? Number(Number(raw.durationSec).toFixed(2))
      : null;
    if (durationSec === null && (ttftSec !== null || streamingSec !== null)) {
      durationSec = Number(((ttftSec || 0) + (streamingSec || 0)).toFixed(2));
    }
    const outNum = cacheStats.output ?? 0;
    let tps = raw.tps !== undefined && raw.tps !== null && Number.isFinite(Number(raw.tps)) && Number(raw.tps) > 0
      ? Number(Number(raw.tps).toFixed(1))
      : null;
    if (tps === null && outNum > 0 && durationSec !== null && durationSec > 0) {
      tps = Number((outNum / durationSec).toFixed(1));
    }
    let streamingTps = raw.streamingTps !== undefined && raw.streamingTps !== null && Number.isFinite(Number(raw.streamingTps)) && Number(raw.streamingTps) > 0
      ? Number(Number(raw.streamingTps).toFixed(1))
      : null;
    if (streamingTps === null && outNum > 0 && streamingSec !== null && streamingSec > 0.05) {
      streamingTps = Number((outNum / streamingSec).toFixed(1));
    }

    let ts = Number(raw.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) {
      ts = raw.created_at ? Date.parse(raw.created_at) : NaN;
    }
    if (!Number.isFinite(ts) || ts <= 0) ts = null;

    const rawStep = raw.stepIndex ?? raw.step_index;
    const stepIndex = rawStep !== undefined && rawStep !== null && rawStep !== '' && Number.isInteger(Number(rawStep)) && Number(rawStep) >= 0
      ? Number(rawStep)
      : null;

    const thinkingTokens = raw.thinkingTokens !== undefined && raw.thinkingTokens !== null && Number.isFinite(Number(raw.thinkingTokens))
      ? Math.max(0, Number(raw.thinkingTokens))
      : null;

    const agentRole = raw.agentRole === 'subagent' || Boolean(raw.parentCascadeId)
      ? 'subagent'
      : (raw.agentRole === 'unknown' ? 'unknown' : 'main');
    const hasSessionEvidence = Boolean(raw.cascadeId || options.cascadeId || raw.parentCascadeId);
    const attributionConfidence = raw.attributionConfidence || (
      agentRole === 'subagent'
        ? (raw.parentStepIndex != null ? 'verified_tool_output' : (raw.parentCascadeId ? 'verified_db_meta' : 'unidentified'))
        : ((agentRole === 'unknown' || !hasSessionEvidence) ? 'unidentified' : 'main')
    );

    const streamingTpsRounded = streamingTps;
    const expScore = raw.status === 'streaming'
      ? { available: false, score: null, grade: null, ruleVersion: ELV91_SCORE_RULE_VERSION }
      : calculateExperienceScore({
          outputTokens: cacheStats.output,
          totalInputTokens: cacheStats.totalInput,
          inputTokens: cacheStats.uncachedInput,
          ttftSec,
          streamingSec,
          totalDurationSec: durationSec,
          streamSpeed: streamingTpsRounded
        });
    const stabInfo = computeStreamStability({
      chunkCount: raw.chunkCount != null ? Number(raw.chunkCount) : (Array.isArray(raw.chunkTimestamps) ? raw.chunkTimestamps.length : null),
      chunkIntervalsMs: Array.isArray(raw.chunkIntervalsMs) ? raw.chunkIntervalsMs : null,
      intervalCv: raw.intervalCv,
      streamingSec
    });
    const ttftRatioPct = (ttftSec !== null && durationSec !== null && durationSec > 0)
      ? Number(Math.min(100, Math.max(0, (ttftSec / durationSec) * 100)).toFixed(1))
      : null;

    return {
      callId,
      cascadeId: raw.cascadeId || options.cascadeId || null,
      parentCascadeId: raw.parentCascadeId || null,
      rootCascadeId: raw.rootCascadeId || null,
      parentStepIndex: raw.parentStepIndex !== undefined && raw.parentStepIndex !== null ? Number(raw.parentStepIndex) : null,
      agentRole,
      subagentType: raw.subagentType || null,
      subagentRole: raw.subagentRole || null,
      attributionConfidence,
      source: raw.source || 'desktop',
      stepIndex,
      model: raw.model || modelLabel || phInfo.rawPlaceholderId || modelExactId || '',
      modelKey: raw.modelKey || (bucket.isAttributed ? bucket.modelKey : null),
      rawModelId: raw.rawModelId || phInfo.rawId || null,
      rawPlaceholderId: raw.rawPlaceholderId || phInfo.rawPlaceholderId || null,
      stableModelId: raw.stableModelId || phInfo.stableModelId || null,
      isPlaceholderOnly: Boolean(raw.isPlaceholderOnly ?? (phInfo.isPlaceholder && !phInfo.isMapped)),
      isRoutedModelVerified: Boolean(raw.isRoutedModelVerified ?? phInfo.isRoutedModelVerified),
      modelMappingSource: raw.modelMappingSource || phInfo.mappingSource,
      modelExactId,
      modelLabel,
      effort,
      inputTokens: cacheStats.uncachedInput,
      cacheReadTokens: cacheStats.cacheRead,
      totalInputTokens: cacheStats.totalInput,
      outputTokens: cacheStats.output,
      thinkingTokens,
      totalTokens: cacheStats.totalTokens,
      hasInputCacheFields: cacheStats.hasInputCacheFields,
      cacheReadRatio: cacheStats.cacheReadRatio,
      cacheReadPct: cacheStats.cacheReadPct,
      cacheStatus: cacheStats.cacheStatus,
      ttftSec,
      streamingSec,
      durationSec,
      ttftRatioPct,
      tps,
      streamingTps,
      streamSpeed: streamingTps,
      chunkCount: stabInfo.chunks,
      chunkIntervalsMs: Array.isArray(raw.chunkIntervalsMs) ? raw.chunkIntervalsMs : null,
      intervalCv: stabInfo.intervalCv,
      isStableStream: stabInfo.isStable,
      scoreRuleVersion: expScore.ruleVersion || ELV91_SCORE_RULE_VERSION,
      eScore: raw.eScore !== undefined ? raw.eScore : expScore.score,
      eGrade: raw.eGrade !== undefined ? raw.eGrade : expScore.grade,
      status: raw.status === 'streaming' ? 'streaming' : 'final',
      outcomeStatus,
      ...(rawError ? { error: rawError, errorClassification } : {}),
      isEstimated: Boolean(raw.isEstimated),
      date: raw.date || (ts ? formatLocalDateKeyCompat(new Date(ts)) : null),
      dateIsProvisional: Boolean(raw.dateIsProvisional),
      created_at: raw.created_at || null,
      timestamp: ts
    };
  }

  /**
   * Strip XML/system wrapper tags (e.g. <USER_REQUEST>, <ADDITIONAL_METADATA>) from turn title previews;
   * applies only to frontend display previews without mutating any underlying raw records.
   */
  function sanitizeTurnPreviewText(rawText, maxLen = 120) {
    if (rawText == null) return '';
    let text = String(rawText);
    // Also handle HTML-escaped forms and remove paired or truncated residual system metadata blocks
    text = text.replace(/&lt;\s*(\/?)\s*(USER_REQUEST|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE|SYSTEM_INSTRUCTION)\b[^&]*&gt;/gi, '<$1$2>');
    text = text.replace(/<\s*(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE|SYSTEM_INSTRUCTION)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
    text = text.replace(/<\s*(ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE|SYSTEM_INSTRUCTION)\b[^>]*>[\s\S]*$/gi, ' ');
    text = text.replace(/<\s*\/?\s*(USER_REQUEST|ADDITIONAL_METADATA|USER_SETTINGS_CHANGE|EPHEMERAL_MESSAGE|SYSTEM_INSTRUCTION)\b[^>]*>/gi, ' ');
    text = text.replace(/\s+/g, ' ').trim();
    const limit = Number.isFinite(Number(maxLen)) && Number(maxLen) > 0 ? Math.floor(Number(maxLen)) : 120;
    return text.slice(0, limit);
  }

  /**
   * Group main-agent calls and verifiable subagent calls in the current session by user turn.
   * Never guess parent-child ownership by timestamp proximity: unlinked subagent calls are placed in a separate unlinkedSubagentCalls list.
   */
  function groupSessionCallsByTurns(turnMarkers = [], calls = [], options = {}) {
    const cascadeId = options.cascadeId || null;
    const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];

    // 1. Normalize all calls and deduplicate by callId (keep the more complete record)
    const dedupMap = new Map();
    for (const raw of (Array.isArray(calls) ? calls : [])) {
      const norm = normalizeSessionCallRecord(raw, { cascadeId, cascadeModelConfigs: cascadeConfigs, userStatus: options.userStatus });
      if (!norm) continue;
      const prev = dedupMap.get(norm.callId);
      if (!prev) {
        dedupMap.set(norm.callId, norm);
      } else {
        const prevTot = prev.totalTokens ?? -1;
        const nextTot = norm.totalTokens ?? -1;
        const preferNext = (prev.status === 'streaming' && norm.status === 'final')
          || nextTot > prevTot
          || (nextTot === prevTot && !prev.modelExactId && Boolean(norm.modelExactId))
          || (nextTot === prevTot && prev.durationSec === null && norm.durationSec !== null);
        if (preferNext) {
          dedupMap.set(norm.callId, {
            ...prev,
            ...norm,
            modelExactId: norm.modelExactId || prev.modelExactId,
            modelLabel: norm.modelLabel || prev.modelLabel,
            effort: norm.effort || prev.effort,
            ttftSec: norm.ttftSec ?? prev.ttftSec,
            streamingSec: norm.streamingSec ?? prev.streamingSec,
            durationSec: norm.durationSec ?? prev.durationSec,
            tps: norm.tps ?? prev.tps,
            streamingTps: norm.streamingTps ?? prev.streamingTps,
            parentCascadeId: norm.parentCascadeId || prev.parentCascadeId,
            parentStepIndex: norm.parentStepIndex ?? prev.parentStepIndex,
            subagentType: norm.subagentType || prev.subagentType,
            subagentRole: norm.subagentRole || prev.subagentRole,
            attributionConfidence: norm.parentStepIndex != null ? norm.attributionConfidence : prev.attributionConfidence
          });
        }
      }
    }

    const allCalls = Array.from(dedupMap.values());
    allCalls.sort((a, b) => {
      const tsA = a.timestamp || 0;
      const tsB = b.timestamp || 0;
      if (tsA !== tsB) return tsA - tsB;
      const sa = a.stepIndex ?? Number.MAX_SAFE_INTEGER;
      const sb = b.stepIndex ?? Number.MAX_SAFE_INTEGER;
      return sa - sb;
    });

    // 2. Build normalized user turn boundaries (sorted ascending by stepIndex)
    const sortedTurns = (Array.isArray(turnMarkers) ? turnMarkers : [])
      .filter(t => t && (Number.isInteger(Number(t.stepIndex)) || t.timestamp || t.created_at))
      .map((t, idx) => {
        const stepIdx = Number.isInteger(Number(t.stepIndex)) ? Number(t.stepIndex) : null;
        const ts = Number(t.timestamp) || (t.created_at ? Date.parse(t.created_at) : NaN);
        return {
          turnIndex: idx + 1,
          stepIndex: stepIdx,
          timestamp: Number.isFinite(ts) && ts > 0 ? ts : null,
          created_at: t.created_at || null,
          source: t.source || 'USER_EXPLICIT',
          preview: t.preview ? sanitizeTurnPreviewText(t.preview, 120) : ''
        };
      })
      .sort((a, b) => {
        if (a.stepIndex !== null && b.stepIndex !== null && a.stepIndex !== b.stepIndex) {
          return a.stepIndex - b.stepIndex;
        }
        return (a.timestamp || 0) - (b.timestamp || 0);
      })
      .map((t, idx) => ({ ...t, turnIndex: idx + 1 }));

    const buckets = sortedTurns.map(t => ({
      ...t,
      calls: [],
      isImplicitInitial: false
    }));
    const preTurnCalls = [];
    const unlinkedSubagentCalls = [];

    const findTurnByStep = (stepIdx) => {
      if (stepIdx === null || stepIdx === undefined || !buckets.length) return -1;
      let matchedIdx = -1;
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].stepIndex !== null && buckets[i].stepIndex <= stepIdx) {
          matchedIdx = i;
        }
      }
      return matchedIdx;
    };

    const findTurnByTimestamp = (ts) => {
      if (!ts || !buckets.length) return -1;
      let matchedIdx = -1;
      for (let i = 0; i < buckets.length; i++) {
        if (buckets[i].timestamp && buckets[i].timestamp <= ts + 2000) {
          matchedIdx = i;
        }
      }
      return matchedIdx;
    };

    for (const c of allCalls) {
      if (c.agentRole === 'subagent') {
        if (c.parentStepIndex !== null && c.parentStepIndex !== undefined) {
          const tIdx = findTurnByStep(c.parentStepIndex);
          if (tIdx >= 0) {
            buckets[tIdx].calls.push(c);
            continue;
          }
        }
        unlinkedSubagentCalls.push(c);
        continue;
      }

      // Main-agent calls: strictly prefer locating turn by stepIndex
      let targetIdx = -1;
      if (c.stepIndex !== null && (!cascadeId || !c.cascadeId || String(c.cascadeId).toLowerCase() === String(cascadeId).toLowerCase())) {
        targetIdx = findTurnByStep(c.stepIndex);
      } else if (c.timestamp && !c.dateIsProvisional) {
        targetIdx = findTurnByTimestamp(c.timestamp);
      }
      if (targetIdx >= 0) {
        buckets[targetIdx].calls.push(c);
      } else {
        preTurnCalls.push(c);
      }
    }

    const finalizeTurnBucket = (b) => {
      const cacheSummary = summarizeCacheReadStats(b.calls);
      let mainCallCount = 0;
      let subagentCallCount = 0;
      let errorCount = 0;
      let totalTokens = 0;
      let hasTotalTokens = false;
      let latestTimestamp = b.timestamp || null;
      for (const c of b.calls) {
        if (c.agentRole === 'subagent') subagentCallCount++;
        else mainCallCount++;
        if (c.outcomeStatus && c.outcomeStatus !== 'success' && c.outcomeStatus !== 'streaming') {
          errorCount++;
        }
        if (c.totalTokens !== null && c.totalTokens !== undefined) {
          totalTokens += c.totalTokens;
          hasTotalTokens = true;
        }
        if (c.timestamp && (!latestTimestamp || c.timestamp > latestTimestamp)) {
          latestTimestamp = c.timestamp;
        }
      }
      return {
        turnIndex: b.turnIndex,
        stepIndex: b.stepIndex,
        timestamp: b.timestamp,
        created_at: b.created_at,
        latestTimestamp,
        preview: b.preview || '',
        isImplicitInitial: Boolean(b.isImplicitInitial),
        callCount: b.calls.length,
        mainCallCount,
        subagentCallCount,
        errorCount,
        inputTokens: cacheSummary.evaluatedRequestCount > 0 ? cacheSummary.totalUncachedInput : null,
        cacheReadTokens: cacheSummary.evaluatedRequestCount > 0 ? cacheSummary.totalCacheRead : null,
        totalInputTokens: cacheSummary.evaluatedRequestCount > 0 ? cacheSummary.totalInput : null,
        outputTokens: b.calls.some(c => c.outputTokens !== null) ? cacheSummary.totalOutput : null,
        totalTokens: hasTotalTokens ? totalTokens : null,
        cacheReadRatio: cacheSummary.cacheReadRatio,
        cacheReadPct: cacheSummary.cacheReadPct,
        cacheStatus: cacheSummary.cacheStatus,
        calls: b.calls
      };
    };

    const resultTurns = [];
    if (preTurnCalls.length > 0) {
      resultTurns.push(finalizeTurnBucket({
        turnIndex: 0,
        stepIndex: 0,
        timestamp: preTurnCalls[0]?.timestamp || null,
        created_at: preTurnCalls[0]?.created_at || null,
        preview: '',
        isImplicitInitial: true,
        calls: preTurnCalls
      }));
    }
    for (const b of buckets) {
      resultTurns.push(finalizeTurnBucket(b));
    }

    const overallCacheSummary = summarizeCacheReadStats(allCalls);
    return {
      cascadeId,
      turns: resultTurns,
      unlinkedSubagentCalls,
      totalCalls: allCalls.length,
      mainCallsCount: allCalls.filter(c => c.agentRole !== 'subagent').length,
      subagentCallsCount: allCalls.filter(c => c.agentRole === 'subagent').length,
      cacheSummary: overallCacheSummary,
      latestCall: allCalls.length ? allCalls[allCalls.length - 1] : null
    };
  }
