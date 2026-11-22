  // =========================================================================
  // Module 5: Model Quota Dashboard (ELV-34) — topbar ring entry, shared pool grouping, multi-state machine, and scheduled refresh
  // =========================================================================
  const QUOTA_REFRESH_FG_MS = 60000;
  const QUOTA_REFRESH_BG_MS = 180000;
  const QUOTA_STALE_MS = 180000;
  const QUOTA_ANIM_DURATION_MS = 220;
  const QUOTA_CAL_STORAGE_PREFIX = 'ag_quota_token_cal_v2_';
  const quotaState = {
    accountScopeKey: null,
    collectorVersion: null,
    snapshot: null,
    rawInput: null,
    browsePoolKey: null,
    busy: false,
    lastFetchedAtMs: null,
    lastSuccessAtMs: null,
    nextRefreshAtMs: null,
    error: null,
    errorKind: null,
    consecutiveErrors: 0,
    lastResetRequeryKey: null,
    autoPaused: false
  };
  quotaStateInitialized = true;
  let quotaAutoTimer = null;
  let quotaResetTimer = null;
  let quotaPostTurnTimer = null;
  let quotaFeedbackTimer = null;
  let quotaInFlightPromise = null;
  let quotaAbortController = null;
  const QUOTA_BAR_CHARGE_DURATION_MS = 720;
  let quotaRefreshSpinAnim = null;
  let quotaBarChargeTimer = null;
  let quotaBarChargePlaying = false;
  const quotaAnimRafs = new Set();
  const quotaActiveChargeRefs = new Set();
  const quotaNumAnimState = new WeakMap();
  const quotaNodeRefsMap = new WeakMap();
  let quotaCalibrationScope = null;
  let quotaCalibrationMap = {};
  let quotaLastEstComputeSig = '';
  let quotaCachedEstByKey = null;
  let quotaLastSnapshotSig = null;
  let quotaPendingSmoothAnim = false;
  let quotaBadgeLastHasFraction = false;

  function isQuotaReducedMotion() {
    try {
      return Boolean(typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return false;
    }
  }

  function clearQuotaBarChargeAnimations() {
    if (quotaBarChargeTimer) {
      clearTimeout(quotaBarChargeTimer);
      quotaBarChargeTimer = null;
    }
    quotaBarChargePlaying = false;
    for (const ref of quotaActiveChargeRefs) {
      if (ref?.track) removeQuotaAttrIfPresent(ref.track, 'data-charging');
      if (ref?.chargeStage) setQuotaHiddenIfChanged(ref.chargeStage, true);
    }
    quotaActiveChargeRefs.clear();
  }

  function triggerQuotaBarsChargeAnimation(targets) {
    if (!Array.isArray(targets) || !targets.length) return false;
    // Do not stack or restart multiple plays while animation is running; delegate to static indicator under reduced motion
    if (quotaBarChargePlaying || isQuotaReducedMotion()) return false;
    const panelQuotaEl = el('panel-quota');
    if (!panelQuotaEl || panelQuotaEl.hidden) return false;

    const validRefs = [];
    for (const ref of targets) {
      if (ref && ref.chargeEligible && ref.track && ref.chargeStage) {
        validRefs.push(ref);
      }
    }
    if (!validRefs.length) return false;

    for (const ref of validRefs) {
      removeQuotaAttrIfPresent(ref.track, 'data-charging');
      setQuotaHiddenIfChanged(ref.chargeStage, false);
      quotaActiveChargeRefs.add(ref);
    }
    // Trigger only a single overall visibility commit so subsequent CSS keyframes start smoothly from 0%
    if (typeof panelQuotaEl.offsetHeight === 'number') void panelQuotaEl.offsetHeight;
    for (const ref of validRefs) {
      setQuotaAttrIfChanged(ref.track, 'data-charging', 'true');
    }

    quotaBarChargePlaying = true;
    quotaBarChargeTimer = setTimeout(() => {
      clearQuotaBarChargeAnimations();
    }, QUOTA_BAR_CHARGE_DURATION_MS + 30);
    return true;
  }

  function triggerQuotaRefreshIconSpin() {
    if (isQuotaReducedMotion()) return;
    const btn = el('btn-quota-refresh');
    const icon = btn?.querySelector?.('.quota-refresh-icon');
    if (!icon || typeof icon.animate !== 'function') return;
    if (quotaRefreshSpinAnim && quotaRefreshSpinAnim.playState === 'running') return;
    try {
      const anim = icon.animate(
        [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
        { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'none' }
      );
      quotaRefreshSpinAnim = anim;
      const clearRef = () => {
        if (quotaRefreshSpinAnim === anim) quotaRefreshSpinAnim = null;
      };
      anim.onfinish = clearRef;
      anim.oncancel = clearRef;
    } catch { }
  }

  function clearQuotaAnimations() {
    for (const rafId of quotaAnimRafs) {
      if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    }
    quotaAnimRafs.clear();
    clearQuotaBarChargeAnimations();
    if (quotaRefreshSpinAnim) {
      try { quotaRefreshSpinAnim.cancel(); } catch { }
      quotaRefreshSpinAnim = null;
    }
  }

  function clearQuotaTimers() {
    if (quotaAutoTimer) { clearTimeout(quotaAutoTimer); quotaAutoTimer = null; }
    if (quotaResetTimer) { clearTimeout(quotaResetTimer); quotaResetTimer = null; }
    if (quotaPostTurnTimer) { clearTimeout(quotaPostTurnTimer); quotaPostTurnTimer = null; }
    if (quotaFeedbackTimer) { clearTimeout(quotaFeedbackTimer); quotaFeedbackTimer = null; }
    clearQuotaAnimations();
    try { quotaAbortController?.abort?.(); } catch { }
    quotaAbortController = null;
  }

  function loadQuotaCalibrationForScope(scopeKey) {
    const clean = scopeKey ? String(scopeKey).trim() : 'anonymous';
    if (quotaCalibrationScope === clean) return quotaCalibrationMap;
    quotaCalibrationScope = clean;
    quotaCalibrationMap = {};
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(`${QUOTA_CAL_STORAGE_PREFIX}${clean}`);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') quotaCalibrationMap = parsed;
        }
      }
    } catch { }
    return quotaCalibrationMap;
  }

  function saveQuotaCalibrationForScope(scopeKey, nextMap) {
    const clean = scopeKey ? String(scopeKey).trim() : 'anonymous';
    quotaCalibrationScope = clean;
    quotaCalibrationMap = nextMap && typeof nextMap === 'object' ? nextMap : {};
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(`${QUOTA_CAL_STORAGE_PREFIX}${clean}`, JSON.stringify(quotaCalibrationMap));
      }
    } catch { }
  }

  // Write to DOM only when value actually changes to avoid repeated Text node replacement or attribute resets causing reflow and flicker
  function setQuotaTextIfChanged(node, text) {
    if (!node) return;
    const next = text == null ? '' : String(text);
    if (node.textContent !== next) node.textContent = next;
  }

  function setQuotaHiddenIfChanged(node, hidden) {
    if (!node) return;
    const next = Boolean(hidden);
    if (Boolean(node.hidden) !== next) node.hidden = next;
  }

  function setQuotaAttrIfChanged(node, name, val) {
    if (!node) return;
    const next = String(val);
    if (getChildAttr(node, name) !== next) node.setAttribute(name, next);
  }

  function removeQuotaAttrIfPresent(node, name) {
    if (!node) return;
    if (getChildAttr(node, name) !== null) node.removeAttribute?.(name);
  }

  function setQuotaClassIfChanged(node, cls) {
    if (!node) return;
    const next = String(cls || '');
    if (node.className !== next) node.className = next;
  }

  function hideQuotaRefreshFeedback() {
    if (quotaFeedbackTimer) { clearTimeout(quotaFeedbackTimer); quotaFeedbackTimer = null; }
    const fb = el('quota-refresh-feedback');
    if (fb) setQuotaHiddenIfChanged(fb, true);
  }

  function showQuotaUpToDateFeedback() {
    const fb = el('quota-refresh-feedback');
    if (!fb) return;
    if (quotaFeedbackTimer) { clearTimeout(quotaFeedbackTimer); quotaFeedbackTimer = null; }
    setQuotaTextIfChanged(fb, t('quota.refresh.upToDate'));
    setQuotaHiddenIfChanged(fb, false);
    quotaFeedbackTimer = setTimeout(() => {
      quotaFeedbackTimer = null;
      if (!state.disposed && el('quota-refresh-feedback')) {
        setQuotaHiddenIfChanged(el('quota-refresh-feedback'), true);
      }
    }, 1800);
  }

  function computeQuotaVisualSignature(view) {
    if (!view || !Array.isArray(view.pools)) return 'empty';
    const parts = [
      view.currentModel?.productKey || '',
      view.activeStatus || '',
      view.badge?.fraction == null ? 'null' : view.badge.fraction.toFixed(4)
    ];
    for (const p of view.pools) {
      const bStr = (p.buckets || []).map(b => `${b.bucketId}:${b.remainingFraction == null ? 'null' : b.remainingFraction.toFixed(4)}:${b.resetAtMs || ''}`).join(',');
      parts.push(`${p.poolKey}=${p.status}=${bStr}`);
    }
    return parts.join('|');
  }

  function formatQuotaNumPctValue(pctVal) {
    if (!Number.isFinite(pctVal)) return '';
    const clamped = Math.max(0, Math.min(100, pctVal));
    if (clamped === 0) return '0%';
    if (clamped > 0 && clamped < 1) return `${Math.max(0.1, Math.round(clamped * 10) / 10)}%`;
    return `${Math.round(clamped)}%`;
  }

  function animateQuotaPercentNode(node, targetFrac, animate, fallbackText = '') {
    if (!node) return;
    const prevState = quotaNumAnimState.get(node) || { rafId: 0, currentPct: null, targetPct: null };
    if (targetFrac == null || !Number.isFinite(Number(targetFrac))) {
      if (prevState.rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(prevState.rafId);
        quotaAnimRafs.delete(prevState.rafId);
      }
      quotaNumAnimState.set(node, { rafId: 0, currentPct: null, targetPct: null });
      setQuotaTextIfChanged(node, fallbackText);
      return;
    }

    const targetPct = Math.max(0, Math.min(100, Number(targetFrac) * 100));
    const canAnimate = Boolean(
      animate &&
      !isQuotaReducedMotion() &&
      typeof requestAnimationFrame === 'function' &&
      prevState.currentPct !== null &&
      Math.abs(targetPct - prevState.currentPct) >= 0.05
    );

    if (!canAnimate) {
      if (prevState.rafId && prevState.targetPct !== null && Math.abs(prevState.targetPct - targetPct) < 0.05) {
        return;
      }
      if (prevState.rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(prevState.rafId);
        quotaAnimRafs.delete(prevState.rafId);
      }
      quotaNumAnimState.set(node, { rafId: 0, currentPct: targetPct, targetPct });
      setQuotaTextIfChanged(node, formatQuotaNumPctValue(targetPct));
      return;
    }

    if (prevState.rafId && prevState.targetPct !== null && Math.abs(prevState.targetPct - targetPct) < 0.05) {
      return;
    }

    if (prevState.rafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(prevState.rafId);
      quotaAnimRafs.delete(prevState.rafId);
    }

    const startPct = prevState.currentPct;
    const startTs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const animObj = { rafId: 0, currentPct: startPct, targetPct };
    quotaNumAnimState.set(node, animObj);

    const step = (nowTs) => {
      if (state.disposed) {
        quotaAnimRafs.delete(animObj.rafId);
        animObj.rafId = 0;
        return;
      }
      const curNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const rawT = Math.min(1, Math.max(0, (curNow - startTs) / QUOTA_ANIM_DURATION_MS));
      const eased = 1 - Math.pow(1 - rawT, 3);
      const val = startPct + (targetPct - startPct) * eased;
      animObj.currentPct = val;
      setQuotaTextIfChanged(node, formatQuotaNumPctValue(val));
      if (rawT < 1) {
        animObj.rafId = requestAnimationFrame(step);
        quotaAnimRafs.add(animObj.rafId);
      } else {
        quotaAnimRafs.delete(animObj.rafId);
        animObj.rafId = 0;
        animObj.currentPct = targetPct;
        setQuotaTextIfChanged(node, formatQuotaNumPctValue(targetPct));
      }
    };
    animObj.rafId = requestAnimationFrame(step);
    quotaAnimRafs.add(animObj.rafId);
  }

  function resetQuotaState(opts = {}) {
    clearQuotaTimers();
    if (opts.clearAccountScope !== false) {
      quotaState.accountScopeKey = null;
      quotaCalibrationScope = null;
      quotaCalibrationMap = {};
    }
    quotaLastEstComputeSig = '';
    quotaCachedEstByKey = null;
    quotaLastSnapshotSig = null;
    quotaPendingSmoothAnim = false;
    quotaBadgeLastHasFraction = false;
    quotaState.snapshot = null;
    quotaState.rawInput = null;
    quotaState.browsePoolKey = null;
    quotaState.busy = false;
    quotaState.lastFetchedAtMs = null;
    quotaState.lastSuccessAtMs = null;
    quotaState.nextRefreshAtMs = null;
    quotaState.error = null;
    quotaState.errorKind = null;
    quotaState.consecutiveErrors = 0;
    quotaState.lastResetRequeryKey = null;
    quotaInFlightPromise = null;
    renderQuotaBoard();
  }

  function refreshQuotaTokenEstimates() {
    quotaLastEstComputeSig = '';
    quotaCachedEstByKey = null;
    if (!state.disposed && (quotaState.snapshot || quotaState.rawInput)) {
      renderQuotaBoard(Date.now(), { animate: false });
    }
  }

  function handleQuotaAccountSwitch(nextScopeKey, opts = {}) {
    const cleanNext = nextScopeKey ? String(nextScopeKey).trim() : null;
    const prev = quotaState.accountScopeKey;
    const changed = Boolean(cleanNext && prev && cleanNext !== prev);
    if (changed || opts.forceRefresh) {
      resetQuotaState({ clearAccountScope: true });
      if (cleanNext) quotaState.accountScopeKey = cleanNext;
      if (!state.disposed) void syncQuotaFromHost(true);
      return true;
    }
    if (cleanNext && !prev) {
      quotaState.accountScopeKey = cleanNext;
    }
    return false;
  }

  function getQuotaStatusLabelText(statusKey) {
    const keyMap = {
      available: 'quota.state.available',
      low: 'quota.state.low',
      exhausted: 'quota.state.exhausted',
      no_permission: 'quota.state.no_permission',
      stale: 'quota.state.stale',
      error: 'quota.state.error',
      unknown: 'quota.state.unknown'
    };
    return t(keyMap[statusKey] || 'quota.state.unknown');
  }

  function getQuotaShortBadgeText(statusKey) {
    const keyMap = {
      exhausted: 'quota.short.exhausted',
      no_permission: 'quota.short.no_permission',
      error: 'quota.short.error',
      stale: 'quota.short.stale',
      unknown: 'quota.short.unknown'
    };
    return keyMap[statusKey] ? t(keyMap[statusKey]) : '';
  }

  function getQuotaPillClass(statusKey) {
    if (statusKey === 'available') return 'pill-good';
    if (statusKey === 'low' || statusKey === 'stale') return 'pill-warn';
    if (statusKey === 'exhausted' || statusKey === 'error') return 'pill-danger';
    if (statusKey === 'no_permission') return 'pill-info';
    return 'pill-muted';
  }

  function formatQuotaDateTime(ms) {
    if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return t('quota.time.unknown');
    const d = new Date(Number(ms));
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${mo}-${da} ${hh}:${mi}:${ss}`;
  }

  function formatCountdownMsCompact(ms) {
    if (!Number.isFinite(Number(ms))) return t('quota.time.unknown');
    if (ms <= 0) return '0s';
    const sec = Math.ceil(ms / 1000);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (currentPanelLanguage === 'en') {
      if (d > 0) return `${d}d ${h}h`;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m`;
      return `${s}s`;
    }
    const hrUnit = currentPanelLanguage === 'zh-TW' ? '小時' : '小时';
    if (d > 0) return `${d}天${h}${hrUnit}`;
    if (h > 0) return `${h}${hrUnit}${m}分`;
    if (m > 0) return `${m}分`;
    return `${s}秒`;
  }

  function formatQuotaWindowTitle(bucket) {
    if (!bucket) return '';
    if (currentPanelLanguage === 'en') {
      if (bucket.windowKey === '5h') return '5h Window';
      if (bucket.windowKey === 'weekly') return 'Weekly Window';
      if (bucket.windowKey === 'daily') return 'Daily Window';
      return 'Primary Quota';
    }
    if (currentPanelLanguage === 'zh-TW') {
      if (bucket.windowKey === '5h') return '5小時限額';
      if (bucket.windowKey === 'weekly') return '每週限額';
      if (bucket.windowKey === 'daily') return '每日限額';
      return '目前主限額';
    }
    return bucket.windowLabel || '周期限额';
  }

  let lastKnownQuotaModelInput = null;
  function getActiveQuotaModelInput() {
    let resolved = null;
    if (activeSessionModelConfirmed && (activeSessionModelKey || activeSessionProductKey)) {
      const cfgList = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      const activeKeyLower = String(activeSessionModelKey || '').trim().toLowerCase();
      const matched = activeKeyLower ? cfgList.find(c =>
        String(c?.modelId || '').trim().toLowerCase() === activeKeyLower ||
        String(c?.modelOrAlias?.model || '').trim().toLowerCase() === activeKeyLower
      ) : null;
      if (matched) resolved = matched;
      else {
        resolved = {
          modelId: activeSessionModelKey || '',
          label: state.latest?.model || activeSessionModelKey || activeSessionProductKey,
          productKey: activeSessionProductKey || ''
        };
      }
    } else if (state.latest?.modelId || state.latest?.model) {
      resolved = {
        modelId: state.latest.modelId || state.latest.model,
        label: state.latest.model || state.latest.modelId
      };
    }
    if (resolved && (resolved.modelId || resolved.label || resolved.productKey)) {
      lastKnownQuotaModelInput = resolved;
      return resolved;
    }
    if (lastKnownQuotaModelInput) return lastKnownQuotaModelInput;
    const snapModel = quotaState.snapshot?.currentModel;
    if (snapModel?.productKey || snapModel?.productLabel) {
      return {
        modelId: snapModel.productKey || '',
        label: snapModel.productLabel || snapModel.productKey || '',
        productKey: snapModel.productKey || ''
      };
    }
    return null;
  }

  function attachTokenEstimatesToQuotaView(view, nowMs) {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    if (!view || !Array.isArray(view.pools) || !core?.applyQuotaTokenEstimates) return view;
    const scopeKey = quotaState.accountScopeKey || view.accountScopeKey || 'anonymous';
    const usageEvents = Array.isArray(ANTIGRAVITY_TOKEN_DATA.recentModelUsage) ? ANTIGRAVITY_TOKEN_DATA.recentModelUsage : [];
    const coverageStartMs = ANTIGRAVITY_TOKEN_DATA.quotaUsageCoverageStartMs ?? null;
    const lastEvTs = usageEvents.length ? Number(usageEvents[usageEvents.length - 1]?.ts || 0) : 0;
    const poolSig = view.pools.map(p => `${p.poolKey}:${(p.buckets || []).map(b => `${b.bucketId}=${b.remainingFraction ?? 'n'}`).join(',')}`).join(';');
    const computeSig = `${scopeKey}|${view.fetchedAtMs || 0}|${coverageStartMs ?? 'null'}|${usageEvents.length}|${lastEvTs}|${poolSig}`;

    if (quotaLastEstComputeSig === computeSig && quotaCachedEstByKey) {
      const enrichedPools = view.pools.map(p => {
        const nextBuckets = (p.buckets || []).map(b => {
          const bKey = `${p.poolKey}::${b.bucketId || b.windowKey}`;
          return quotaCachedEstByKey[bKey] ? { ...b, tokenEstimate: quotaCachedEstByKey[bKey] } : b;
        });
        const pb = p.primaryBucket ? (nextBuckets.find(b => b.bucketId === p.primaryBucket.bucketId) || nextBuckets[0] || p.primaryBucket) : (nextBuckets[0] || null);
        return { ...p, buckets: nextBuckets, primaryBucket: pb, tokenEstimate: pb?.tokenEstimate || p.tokenEstimate || null };
      });
      return { ...view, pools: enrichedPools };
    }

    const calMap = loadQuotaCalibrationForScope(scopeKey);
    const applied = core.applyQuotaTokenEstimates(view, {
      accountScopeKey: scopeKey,
      usageEvents,
      historyCoverageStartMs: coverageStartMs,
      calibrationMap: calMap,
      nowMs: view.fetchedAtMs || nowMs
    });
    if (applied?.nextCalibrationMap) {
      saveQuotaCalibrationForScope(scopeKey, applied.nextCalibrationMap);
    }
    const cacheObj = {};
    for (const p of (applied?.snapshot?.pools || [])) {
      for (const b of (p.buckets || [])) {
        cacheObj[`${p.poolKey}::${b.bucketId || b.windowKey}`] = b.tokenEstimate || null;
      }
    }
    quotaLastEstComputeSig = computeSig;
    quotaCachedEstByKey = cacheObj;
    return applied?.snapshot || view;
  }

  function computeEffectiveQuotaView(nowMs = Date.now()) {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const currentModelInput = getActiveQuotaModelInput();

    // 1. Prefer recomputing via buildModelQuotaSnapshot from rawInput (supports test-injected raw responses or local config changes)
    if (quotaState.rawInput && core?.buildModelQuotaSnapshot) {
      const built = core.buildModelQuotaSnapshot({
        ...quotaState.rawInput,
        currentModel: currentModelInput,
        browsePoolKey: quotaState.browsePoolKey,
        fetchMeta: {
          fetchedAtMs: quotaState.lastSuccessAtMs ?? quotaState.lastFetchedAtMs,
          nextRefreshAtMs: quotaState.nextRefreshAtMs,
          staleThresholdMs: QUOTA_STALE_MS,
          error: quotaState.error,
          errorKind: quotaState.errorKind
        },
        nowMs
      });
      return attachTokenEstimatesToQuotaView(built, nowMs);
    }

    // 2. Refresh view state from standardized main-process snapshot combined with current session model and live nowMs
    const base = quotaState.snapshot;
    if (!base) {
      const hasErr = Boolean(quotaState.error);
      return {
        schemaVersion: 1,
        syncState: hasErr ? 'error' : 'unknown',
        fetchedAtMs: quotaState.lastSuccessAtMs ?? quotaState.lastFetchedAtMs,
        nextRefreshAtMs: quotaState.nextRefreshAtMs,
        staleThresholdMs: QUOTA_STALE_MS,
        lastError: quotaState.error,

        errorKind: quotaState.errorKind,
        currentModel: currentModelInput ? { productLabel: String(currentModelInput.label || currentModelInput.modelId) } : null,
        activeStatus: hasErr ? 'error' : 'unknown',
        activeStatusLabel: getQuotaStatusLabelText(hasErr ? 'error' : 'unknown'),
        badge: {
          text: getQuotaShortBadgeText(hasErr ? 'error' : 'unknown'),
          tag: hasErr ? t('quota.retry') : '',
          fraction: null,
          status: hasErr ? 'error' : 'unknown',
          statusLabel: getQuotaStatusLabelText(hasErr ? 'error' : 'unknown')
        },
        activeReset: { hasResetTime: false, resetTimeText: null, countdownText: null, isResetPassed: false },
        browsePoolKey: quotaState.browsePoolKey,
        planTierName: ANTIGRAVITY_TOKEN_DATA.planStatus?.tierName || null,
        pools: []
      };
    }

    const updatedPools = (base.pools || []).map(p => {
      const nextBuckets = (p.buckets || []).map(b => {
        if (!b.resetTimeIso || !core?.formatQuotaResetMeta) return { ...b };
        const rm = core.formatQuotaResetMeta(b.resetTimeIso, nowMs);
        return {
          ...b,
          hasResetTime: rm.hasResetTime,
          resetAtMs: rm.resetAtMs,
          resetTimeText: rm.resetTimeText,
          countdownText: rm.countdownText,
          isResetPassed: rm.isResetPassed
        };
      });
      const sel = (typeof selectPrimaryQuotaBucket === 'function')
        ? selectPrimaryQuotaBucket(nextBuckets)
        : (() => {
            const priced = nextBuckets.filter(b => b.remainingFraction !== null).sort((a, b) => a.remainingFraction - b.remainingFraction);
            return { primaryBucket: priced[0] || nextBuckets[0] || null, selectionReason: priced.length <= 1 ? 'single_window' : 'tighter_window' };
          })();
      const pb = sel.primaryBucket || p.primaryBucket || null;
      return {
        ...p,
        buckets: nextBuckets,
        primaryBucket: pb,
        selectionReason: sel.selectionReason || p.selectionReason || 'single_window',
        remainingFraction: pb?.remainingFraction ?? p.remainingFraction ?? null,
        percentText: pb?.percentText ?? p.percentText ?? null,
        isExhausted: pb ? Boolean(pb.isExhausted || pb.remainingFraction === 0) : Boolean(p.isExhausted),
        hasResetTime: Boolean(pb?.hasResetTime ?? p.hasResetTime),
        resetTimeIso: pb?.resetTimeIso ?? p.resetTimeIso ?? null,
        resetAtMs: pb?.resetAtMs ?? p.resetAtMs ?? null,
        resetTimeText: pb?.resetTimeText ?? p.resetTimeText ?? null,
        countdownText: pb?.countdownText ?? p.countdownText ?? null,
        isResetPassed: Boolean(pb?.isResetPassed ?? p.isResetPassed)
      };
    });

    // Re-match pool and model for live-switched session model
    const tStr = currentModelInput
      ? String(currentModelInput.modelId || currentModelInput.label || '').trim().toLowerCase()
      : '';
    const tStripped = tStr.replace(/^model_/, '');
    let matchedPool = null;
    let matchedModel = null;
    if (tStr) {
      for (const p of updatedPools) {
        for (const m of (p.models || [])) {
          const allIds = [...(m.modelIds || []), ...(m.aliases || [])].map(x => String(x).toLowerCase());
          if (allIds.some(id => id === tStr || id.replace(/^model_/, '') === tStripped)) {
            matchedPool = p;
            matchedModel = m;
            break;
          }
          if (m.productLabel && m.productLabel.toLowerCase() === tStr) {
            matchedPool = p;
            matchedModel = m;
            break;
          }
          if (m.productKey && currentModelInput?.productKey && m.productKey === currentModelInput.productKey) {
            matchedPool = p;
            matchedModel = m;
            break;
          }
        }
        if (matchedPool) break;
      }
      if (!matchedPool && core?.getSharedQuotaGroupKey) {
        const gKey = core.getSharedQuotaGroupKey(currentModelInput);
        matchedPool = updatedPools.find(p => p.poolKey === gKey) || null;
        if (matchedPool) matchedModel = matchedPool.models?.[0] || null;
      }
    }

    const lastOkMs = quotaState.lastSuccessAtMs ?? base.fetchedAtMs ?? null;
    const ageExpired = lastOkMs !== null && (nowMs - lastOkMs > QUOTA_STALE_MS);
    const anyResetPassed = updatedPools.some(p => p.isResetPassed && p.remainingFraction === 0);
    const hasAnyPool = updatedPools.some(p => p.remainingFraction !== null || p.noPermission);
    let syncState = 'unknown';
    if (!hasAnyPool && quotaState.error) syncState = 'error';
    else if (hasAnyPool && (quotaState.error || ageExpired || anyResetPassed)) syncState = 'stale';
    else if (hasAnyPool) syncState = 'fresh';

    let activeStatus = 'unknown';
    let badgeText = t('quota.short.unknown');
    let badgeTag = '';
    let activeFraction = null;
    let activeReset = { hasResetTime: false, resetTimeText: null, countdownText: null, isResetPassed: false };

    if (syncState === 'error') {
      activeStatus = 'error';
      badgeText = t('quota.short.error');
      badgeTag = t('quota.retry');
    } else if (matchedModel?.noPermission || matchedPool?.noPermission) {
      activeStatus = 'no_permission';
      badgeText = t('quota.short.no_permission');
    } else if (matchedPool) {
      activeFraction = matchedPool.remainingFraction;
      activeReset = {
        hasResetTime: matchedPool.hasResetTime,
        resetTimeIso: matchedPool.resetTimeIso,
        resetAtMs: matchedPool.resetAtMs,
        resetTimeText: matchedPool.resetTimeText,
        countdownText: matchedPool.countdownText,
        isResetPassed: matchedPool.isResetPassed
      };
      if (matchedPool.remainingFraction === null) {
        activeStatus = syncState === 'stale' ? 'stale' : 'unknown';
        badgeText = t(syncState === 'stale' ? 'quota.short.stale' : 'quota.short.unknown');
      } else if (matchedPool.isExhausted || matchedPool.remainingFraction === 0) {
        activeStatus = syncState === 'stale' ? 'stale' : 'exhausted';
        badgeText = t('quota.short.exhausted');
        badgeTag = matchedPool.primaryBucket?.windowShort || '';
      } else {
        activeStatus = syncState === 'stale' ? 'stale' : (matchedPool.remainingFraction <= 0.2 ? 'low' : 'available');
        badgeText = core?.formatQuotaPercentText ? core.formatQuotaPercentText(matchedPool.remainingFraction) : matchedPool.percentText;
        badgeTag = syncState === 'stale' ? t('quota.short.stale') : (matchedPool.primaryBucket?.windowShort || '');
      }
    } else if (syncState === 'stale') {
      activeStatus = 'stale';
      badgeText = t('quota.short.stale');
    }

    return attachTokenEstimatesToQuotaView({
      ...base,
      syncState,
      fetchedAtMs: lastOkMs,
      nextRefreshAtMs: quotaState.nextRefreshAtMs,
      lastError: quotaState.error,
      errorKind: quotaState.errorKind,
      currentModel: matchedModel
        ? {
          productKey: matchedModel.productKey,
          productLabel: matchedModel.productLabel,
          poolKey: matchedPool.poolKey,
          poolTitle: matchedPool.title,
          noPermission: matchedModel.noPermission,
          unavailabilityReason: matchedModel.unavailabilityReason,
          noticeText: matchedModel.noticeText
        }
        : (currentModelInput ? { productLabel: String(currentModelInput.label || currentModelInput.modelId), poolKey: null, poolTitle: null } : base.currentModel),
      activeStatus,
      activeStatusLabel: getQuotaStatusLabelText(activeStatus),
      badge: {
        text: badgeText,
        tag: badgeTag,
        fraction: activeFraction,
        status: activeStatus,
        statusLabel: getQuotaStatusLabelText(activeStatus)
      },
      activeReset,
      browsePoolKey: quotaState.browsePoolKey || matchedPool?.poolKey || updatedPools[0]?.poolKey || null,
      pools: updatedPools
    }, nowMs);
  }

  function formatBucketTokenEstimateLine(est) {
    if (!est || est.estSource === 'unavailable' || est.estSource === 'unknown') return '';
    if (est.estBasis === 'exhausted' || est.estSource === 'exhausted' || est.estRemainingTokens === 0) {
      return t('quota.est.exhausted');
    }
    if (est.estBasis === 'incomplete_samples' || est.estSource === 'incomplete') {
      return t('quota.est.incomplete');
    }
    if (est.estBasis === 'calibration_expired' || est.estSource === 'expired') {
      return t('quota.est.expired');
    }
    if (est.estBasis === 'coverage_incomplete') {
      return t('quota.est.coverageIncomplete');
    }
    if (est.estRemainingTokens != null && est.estRemainingShort) {
      let basisKey = 'quota.est.basisCached';
      if (est.estBasis === 'stale_with_divergence' || est.estSource === 'unreliable_cached') {
        basisKey = 'quota.est.basisStaleDivergence';
      } else if (est.estBasis === 'delta_calibrated' && est.estSource === 'delta') {
        basisKey = 'quota.est.basisDelta';
      } else if (est.estBasis === 'cycle_estimated' && est.estSource === 'cycle') {
        basisKey = 'quota.est.basisCycle';
      }
      const mainPart = t('quota.est.approx', { tokens: est.estRemainingShort });
      const basisPart = t(basisKey);
      const mixedPart = est.mixedPoolModels ? ` (${t('quota.est.mixedModels')})` : '';
      const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
      const usedShort = est.cycleTokensUsed > 0 && core?.formatApproxTokensShort
        ? core.formatApproxTokensShort(est.cycleTokensUsed)
        : null;
      return usedShort
        ? `${mainPart} · ${basisPart}${mixedPart} · ${t('quota.est.cycleUsed', { used: usedShort })}`
        : `${mainPart} · ${basisPart}${mixedPart}`;
    }
    return t('quota.est.waiting');
  }

  function getChildAttr(node, name) {
    if (!node) return null;
    if (typeof node.getAttribute === 'function') return node.getAttribute(name);
    return node.attributes?.[name] ?? null;
  }

  function reconcileQuotaChildOrder(container, desiredNodes) {
    const cur = Array.from(container.children || []);
    const sameOrder = cur.length === desiredNodes.length && cur.every((n, idx) => n === desiredNodes[idx]);
    if (sameOrder) return;
    if (typeof container.removeChild === 'function' && typeof container.insertBefore === 'function') {
      const wantSet = new Set(desiredNodes);
      for (const ch of cur) {
        if (!wantSet.has(ch)) container.removeChild(ch);
      }
      for (let i = 0; i < desiredNodes.length; i++) {
        const node = desiredNodes[i];
        const atIdx = container.children[i] || null;
        if (atIdx !== node) {
          container.insertBefore(node, atIdx);
        }
      }
      return;
    }
    if (typeof container.replaceChildren === 'function') {
      container.replaceChildren(...desiredNodes);
    } else {
      if (Array.isArray(container.children)) container.children.length = 0;
      for (const n of desiredNodes) container.appendChild?.(n);
    }
  }

  function renderQuotaBucketsContainer(container, buckets, statusOverride = null, opts = {}) {
    if (!container) return;
    const list = Array.isArray(buckets) ? buckets : [];
    const animate = Boolean(opts.animate);
    const nowMs = Number.isFinite(Number(opts.nowMs)) ? Number(opts.nowMs) : Date.now();
    if (!list.length) {
      reconcileQuotaChildOrder(container, []);
      return;
    }

    const existingRows = new Map();
    for (const child of Array.from(container.children || [])) {
      const bKey = getChildAttr(child, 'data-bucket-key');
      if (bKey) existingRows.set(bKey, child);
    }

    const desiredRows = [];
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      const bKey = String(b.bucketId || b.windowKey || `b-${i}`);

      let row = existingRows.get(bKey);
      let refs = row ? quotaNodeRefsMap.get(row) : null;

      if (!row || !refs) {
        row = document.createElement('div');
        row.className = 'quota-bucket-row';
        row.setAttribute('data-bucket-key', bKey);

        const meta = document.createElement('div');
        meta.className = 'quota-bucket-meta';

        const nameEl = document.createElement('span');
        nameEl.className = 'quota-bucket-name';

        const valEl = document.createElement('span');
        valEl.className = 'quota-bucket-val';
        const pctEl = document.createElement('span');
        pctEl.className = 'quota-pct-num';
        const resetEl = document.createElement('span');
        resetEl.className = 'quota-reset-span';
        valEl.appendChild(pctEl);
        valEl.appendChild(resetEl);

        meta.appendChild(nameEl);
        meta.appendChild(valEl);

        const track = document.createElement('div');
        track.className = 'quota-bar-track';
        const fillEl = document.createElement('div');
        fillEl.className = 'quota-bar-fill';
        track.appendChild(fillEl);

        // Independent charging animation layer: clipped within actual percentage width; never drops base to zero or fills to 100%
        const chargeStage = document.createElement('div');
        chargeStage.className = 'quota-bar-charge-stage';
        chargeStage.hidden = true;
        const chargeFill = document.createElement('div');
        chargeFill.className = 'quota-bar-charge-fill';
        const chargeSheen = document.createElement('div');
        chargeSheen.className = 'quota-bar-charge-sheen';
        chargeStage.appendChild(chargeFill);
        chargeStage.appendChild(chargeSheen);
        track.appendChild(chargeStage);

        const estEl = document.createElement('div');
        estEl.className = 'quota-bucket-est';
        estEl.hidden = true;

        row.appendChild(meta);
        row.appendChild(track);
        row.appendChild(estEl);
        refs = {
          nameEl,
          pctEl,
          resetEl,
          track,
          fillEl,
          chargeStage,
          chargeFill,
          chargeSheen,
          chargeRef: { track, chargeStage, chargeEligible: false },
          estEl
        };
        quotaNodeRefsMap.set(row, refs);
      }

      const { nameEl, pctEl, resetEl, track, fillEl, chargeStage, chargeRef, estEl } = refs;
      if (nameEl) setQuotaTextIfChanged(nameEl, formatQuotaWindowTitle(b));

      if (pctEl) {
        if (statusOverride === 'no_permission') {
          animateQuotaPercentNode(pctEl, null, false, t('quota.short.no_permission'));
        } else if (b.remainingFraction == null) {
          animateQuotaPercentNode(pctEl, null, false, t('quota.time.unknown'));
        } else {
          animateQuotaPercentNode(pctEl, b.remainingFraction, animate, b.percentText);
        }
      }

      if (resetEl) {
        const resetSuffix = b.hasResetTime
          ? ` · ${b.resetTimeText}${b.countdownText ? ` (${b.isResetPassed ? b.countdownText : formatCountdownMsCompact((b.resetAtMs || 0) - nowMs)})` : ''}`
          : ` · ${t('quota.time.reset')}: ${t('quota.time.unknown')}`;
        setQuotaTextIfChanged(resetEl, resetSuffix);
      }

      if (fillEl) {
        const bStatus = statusOverride || (b.remainingFraction == null
          ? 'unknown'
          : (b.isExhausted || b.remainingFraction === 0 ? 'exhausted' : (b.remainingFraction <= 0.2 ? 'low' : 'available')));
        const scaleVal = b.remainingFraction == null ? 0 : Math.max(0, Math.min(1, b.remainingFraction));
        const scaleStr = scaleVal.toFixed(4);
        const stageWidthStr = `${(scaleVal * 100).toFixed(2)}%`;
        setQuotaAttrIfChanged(fillEl, 'data-status', bStatus);
        if (getChildAttr(fillEl, 'data-fraction') !== scaleStr) {
          fillEl.setAttribute('data-fraction', scaleStr);
          if (typeof fillEl.style?.setProperty === 'function') {
            fillEl.style.setProperty('--quota-scale', scaleStr);
          }
          if (fillEl.style) {
            fillEl.style.transform = `scaleX(${scaleStr})`;
          }
        }
        const chargeEligible = Boolean(
          statusOverride !== 'no_permission' &&
          bStatus !== 'no_permission' &&
          bStatus !== 'unknown' &&
          b.remainingFraction != null &&
          Number.isFinite(Number(b.remainingFraction)) &&
          scaleVal > 0
        );
        if (chargeStage) {
          setQuotaAttrIfChanged(chargeStage, 'data-status', bStatus);
          if (getChildAttr(chargeStage, 'data-fraction') !== scaleStr) {
            chargeStage.setAttribute('data-fraction', scaleStr);
            if (chargeStage.style) {
              chargeStage.style.width = stageWidthStr;
            }
          }
        }
        if (track) {
          setQuotaAttrIfChanged(track, 'data-charge-eligible', chargeEligible ? 'true' : 'false');
          if (!chargeEligible) {
            removeQuotaAttrIfPresent(track, 'data-charging');
            if (chargeStage) setQuotaHiddenIfChanged(chargeStage, true);
            if (chargeRef) quotaActiveChargeRefs.delete(chargeRef);
          }
        }
        if (chargeRef) {
          chargeRef.chargeEligible = chargeEligible;
          if (chargeEligible && Array.isArray(opts.chargeTargets)) {
            opts.chargeTargets.push(chargeRef);
          }
        }
      }

      if (estEl) {
        const estText = statusOverride === 'no_permission' ? '' : formatBucketTokenEstimateLine(b.tokenEstimate);
        if (estText) {
          setQuotaHiddenIfChanged(estEl, false);
          setQuotaTextIfChanged(estEl, estText);
        } else {
          setQuotaHiddenIfChanged(estEl, true);
          setQuotaTextIfChanged(estEl, '');
        }
      }
      desiredRows.push(row);
    }

    reconcileQuotaChildOrder(container, desiredRows);
  }

  function renderQuotaBoard(nowMs = Date.now(), renderOpts = {}) {
    const viewQuotaBody = el('view-quota');
    const savedScrollTop = (viewQuotaBody && typeof viewQuotaBody.scrollTop === 'number') ? viewQuotaBody.scrollTop : null;
    const view = computeEffectiveQuotaView(nowMs);
    const currentSig = computeQuotaVisualSignature(view);
    const chargeBarTargets = renderOpts.chargeBars ? [] : null;
    const shouldAnimate = Boolean(
      renderOpts.animate !== undefined
        ? renderOpts.animate
        : (quotaPendingSmoothAnim && quotaLastSnapshotSig !== null && currentSig !== quotaLastSnapshotSig)
    );
    if (renderOpts.consumeAnim !== false && quotaPendingSmoothAnim) {
      quotaPendingSmoothAnim = false;
    }
    quotaLastSnapshotSig = currentSig;

    // 1. Render topbar ring entry and narrow-screen overflow menu item (must include short value/status text, not color alone)
    const bQuota = el('badge-quota');
    const qFill = el('quota-ring-fill');
    const qVal = el('quota-badge-val');
    const qTag = el('quota-badge-tag');
    const oQuotaVal = el('overflow-quota-val');
    const qRefreshDot = el('quota-refresh-dot');
    if (qRefreshDot) setQuotaHiddenIfChanged(qRefreshDot, !quotaState.busy);

    const matchedQuotaPool = (view.pools || []).find(p => p.poolKey === view.currentModel?.poolKey)
      || (view.pools || []).find(p => p.poolKey === quotaState.browsePoolKey)
      || (view.pools || []).find(p => Array.isArray(p.buckets) && p.buckets.some(b => b.remainingFraction != null))
      || null;

    if (bQuota) {
      const effectiveStatus = (view.activeStatus === 'unknown' && matchedQuotaPool)
        ? ((matchedQuotaPool.remainingFraction != null && matchedQuotaPool.remainingFraction <= 0.2) ? 'low' : 'available')
        : (view.activeStatus || 'unknown');
      setQuotaAttrIfChanged(bQuota, 'data-quota-state', effectiveStatus);
      const tipModel = view.currentModel?.productLabel || t('quota.current.unmatched');
      const matchedPoolObj = (view.pools || []).find(p => p.poolKey === view.currentModel?.poolKey) || null;
      const reasonMap = {
        tighter_window: currentPanelLanguage === 'en' ? 'tightest window' : (currentPanelLanguage === 'zh-TW' ? '最緊縮視窗優先' : '最紧缩窗口优先'),
        tie_window: currentPanelLanguage === 'en' ? '5h priority on tie' : (currentPanelLanguage === 'zh-TW' ? '同餘量優先短視窗' : '同余量优先短窗口'),
        single_window: currentPanelLanguage === 'en' ? 'single window' : (currentPanelLanguage === 'zh-TW' ? '單一限額視窗' : '单一限额窗口')
      };
      const winLines = (matchedPoolObj?.buckets || []).map(b => {
        const wTag = b.windowShort || formatQuotaWindowTitle(b);
        const wReset = b.hasResetTime ? `${b.resetTimeText} (${formatCountdownMsCompact((b.resetAtMs || 0) - nowMs)})` : t('quota.time.unknown');
        return `${wTag}: ${b.percentText || t('quota.time.unknown')} (${wReset})`;
      });
      const selNote = matchedPoolObj?.primaryBucket
        ? `${matchedPoolObj.primaryBucket.windowShort || formatQuotaWindowTitle(matchedPoolObj.primaryBucket)} · ${reasonMap[matchedPoolObj.selectionReason] || ''}`
        : '';
      const updatedStr = view.fetchedAtMs ? new Date(view.fetchedAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : t('quota.time.unknown');
      const poolHeader = matchedPoolObj?.title ? ` · ${matchedPoolObj.title}` : '';
      const tipReset = view.activeReset?.hasResetTime
        ? `${view.activeReset.resetTimeText} (${formatCountdownMsCompact((view.activeReset.resetAtMs || 0) - nowMs)})`
        : t('quota.time.unknown');
      const nextTitle = [
        `${tipModel}${poolHeader} · ${view.activeStatusLabel} (${view.badge.text})${selNote ? ` [${selNote}]` : ''}`,
        winLines.length ? winLines.join(' | ') : `${t('quota.time.reset')}: ${tipReset}`,
        `${currentPanelLanguage === 'en' ? 'Updated' : '更新'}: ${updatedStr}`
      ].filter(Boolean).join('\n');
      bQuota.removeAttribute('title');
      setQuotaAttrIfChanged(bQuota, 'aria-label', `${t('badge.quota.aria')}: ${view.badge.text} (${view.activeStatusLabel})`);
    }
    const poolBuckets = matchedQuotaPool?.buckets || [];
    const b5h = poolBuckets.find(b => b.windowKey === '5h' && b.remainingFraction != null) || null;
    const bWeek = poolBuckets.find(b => b.windowKey === 'weekly' && b.remainingFraction != null) || null;
    const hasConcentricDual = Boolean(b5h && bWeek);
    // Outer ring (r=8) = 7d (weekly) quota, inner ring (r=4.5) = 5h quota
    const OUTER_CIRC = 2 * Math.PI * 8;
    const INNER_CIRC = 2 * Math.PI * 4.5;
    const outerFraction = bWeek ? bWeek.remainingFraction : view.badge.fraction;
    const innerFraction = b5h ? b5h.remainingFraction : view.badge.fraction;

    const quotaLevelColor = (frac, highColor) => {
      if (frac == null) return '';
      if (frac <= 0.25) return '#ef4444';
      if (frac <= 0.59) return '#f59e0b';
      return highColor;
    };

    const qSvg = el('quota-ring-svg');
    const qAnimPref = typeof getToolbarPrefs === 'function' ? getToolbarPrefs().quotaAnim : 'wave';
    if (qSvg) qSvg.classList.toggle('is-instant', qAnimPref === 'instant');

    const prev5h = globalThis.__agPrevQuota5h;
    const prev7d = globalThis.__agPrevQuota7d;
    const decreased = (prev5h != null && innerFraction != null && innerFraction < prev5h - 0.001)
      || (prev7d != null && outerFraction != null && outerFraction < prev7d - 0.001);
    if (innerFraction != null) globalThis.__agPrevQuota5h = innerFraction;
    if (outerFraction != null) globalThis.__agPrevQuota7d = outerFraction;

    if (decreased && qSvg && qAnimPref === 'wave') {
      qSvg.classList.remove('is-quota-wave');
      void qSvg.getBoundingClientRect?.();
      qSvg.classList.add('is-quota-wave');
    }

    if (qFill) {
      if (outerFraction == null) {
        const nextDash = view.activeStatus === 'unknown' ? '12 38.27' : `0 ${OUTER_CIRC.toFixed(2)}`;
        setQuotaAttrIfChanged(qFill, 'stroke-dasharray', nextDash);
        setQuotaAttrIfChanged(qFill, 'stroke-dashoffset', '0');
        qFill.style.stroke = '';
        quotaBadgeLastHasFraction = false;
      } else {
        const clampedFrac = Math.max(0, Math.min(1, outerFraction));
        const offsetStr = (OUTER_CIRC * (1 - clampedFrac)).toFixed(2);
        const dashStr = `${OUTER_CIRC.toFixed(2)} ${OUTER_CIRC.toFixed(2)}`;
        if (!quotaBadgeLastHasFraction && qFill.style && typeof qFill.getBoundingClientRect === 'function') {
          qFill.style.transition = 'none';
          qFill.setAttribute('stroke-dasharray', dashStr);
          qFill.setAttribute('stroke-dashoffset', offsetStr);
          qFill.getBoundingClientRect();
          qFill.style.transition = '';
        } else {
          setQuotaAttrIfChanged(qFill, 'stroke-dasharray', dashStr);
          setQuotaAttrIfChanged(qFill, 'stroke-dashoffset', offsetStr);
        }
        qFill.style.stroke = quotaLevelColor(clampedFrac, '#0A84FF');
        quotaBadgeLastHasFraction = true;
      }
    }
    const qInnerTrack = el('quota-ring-inner-track');
    const qInnerFill = el('quota-ring-inner-fill');
    if (qInnerTrack || qInnerFill) {
      if (qInnerTrack) setQuotaHiddenIfChanged(qInnerTrack, false);
      if (qInnerFill) {
        setQuotaHiddenIfChanged(qInnerFill, false);
        if (innerFraction == null) {
          setQuotaAttrIfChanged(qInnerFill, 'stroke-dasharray', `0 ${INNER_CIRC.toFixed(2)}`);
          setQuotaAttrIfChanged(qInnerFill, 'stroke-dashoffset', '0');
          qInnerFill.style.stroke = '';
        } else {
          const clampedInner = Math.max(0, Math.min(1, innerFraction));
          setQuotaAttrIfChanged(qInnerFill, 'stroke-dasharray', `${INNER_CIRC.toFixed(2)} ${INNER_CIRC.toFixed(2)}`);
          setQuotaAttrIfChanged(qInnerFill, 'stroke-dashoffset', (INNER_CIRC * (1 - clampedInner)).toFixed(2));
          qInnerFill.style.stroke = quotaLevelColor(clampedInner, '#22c55e');
        }
      }
    }
    if (qVal) {
      const hasNumericPct = view.activeStatus !== 'exhausted' && view.activeStatus !== 'no_permission' && view.activeStatus !== 'error' && (innerFraction != null || outerFraction != null || view.badge.fraction != null);
      if (hasNumericPct) {
        const primaryFrac = hasConcentricDual ? b5h.remainingFraction : (innerFraction ?? outerFraction ?? view.badge.fraction);
        const primaryTxt = `${Math.round(primaryFrac * 100)}%`;
        animateQuotaPercentNode(qVal, primaryFrac, shouldAnimate, primaryTxt);
      } else {
        let dispVal = view.badge.text;
        if (view.activeStatus === 'exhausted') dispVal = t('quota.short.exhausted');
        else if (view.activeStatus === 'no_permission') dispVal = t('quota.short.no_permission');
        else if (view.activeStatus === 'error') dispVal = t('quota.short.error');
        else if (view.activeStatus === 'unknown' || view.badge.fraction == null) {
          dispVal = view.activeStatus === 'stale' ? t('quota.short.stale') : t('quota.short.unknown');
        }
        animateQuotaPercentNode(qVal, null, false, dispVal);
      }
    }
    if (qTag) {
      let dispTag = view.badge.tag;
      if (hasConcentricDual) {
        dispTag = `${Math.round(bWeek.remainingFraction * 100)}%`;
      }
      if (view.activeStatus === 'error') dispTag = t('quota.retry');
      else if (view.activeStatus === 'stale' && view.badge.fraction != null) dispTag = t('quota.short.stale');
      if (dispTag) {
        setQuotaHiddenIfChanged(qTag, false);
        setQuotaTextIfChanged(qTag, dispTag);
      } else {
        setQuotaHiddenIfChanged(qTag, true);
        setQuotaTextIfChanged(qTag, '');
      }
    }
    if (oQuotaVal) {
      const dispTxt = view.badge.fraction != null && view.activeStatus !== 'exhausted' && view.activeStatus !== 'no_permission' && view.activeStatus !== 'error'
        ? view.badge.text
        : (qVal ? qVal.textContent : view.badge.text);
      const dispTag = (qTag && !qTag.hidden) ? qTag.textContent : '';
      setQuotaTextIfChanged(oQuotaVal, dispTag ? `${dispTxt} · ${dispTag}` : dispTxt);
    }

    const qTipTitle = el('quota-tip-title');
    const qTipRows = el('quota-tip-rows');
    const qTipSub = el('quota-tip-sub');
    if (qTipTitle) setQuotaTextIfChanged(qTipTitle, t('quota.tip.title'));
    if (qTipRows && typeof document?.createElement === 'function') {
      qTipRows.replaceChildren();
      const addTipRow = (labelTxt, valTxt, toneCls) => {
        const row = document.createElement('div');
        row.className = 'quota-tip-row';
        const lSpan = document.createElement('span');
        lSpan.className = 'quota-tip-label';
        lSpan.textContent = labelTxt;
        const vSpan = document.createElement('span');
        vSpan.className = `quota-tip-val${toneCls ? ` ${toneCls}` : ''}`;
        vSpan.textContent = valTxt;
        row.appendChild(lSpan);
        row.appendChild(vSpan);
        qTipRows.appendChild(row);
      };
      if (hasConcentricDual) {
        const t5h = b5h.hasResetTime ? ` (${formatCountdownMsCompact((b5h.resetAtMs || 0) - nowMs)})` : '';
        const t7d = bWeek.hasResetTime ? ` (${formatCountdownMsCompact((bWeek.resetAtMs || 0) - nowMs)})` : '';
        addTipRow('Outer · 7d', `${bWeek.percentText || '--'}${t7d}`, 'is-7d');
        addTipRow('Inner · 5h', `${b5h.percentText || '--'}${t5h}`, 'is-5h');
      } else if (poolBuckets.length) {
        for (const b of poolBuckets.slice(0, 2)) {
          const bReset = b.hasResetTime ? ` (${formatCountdownMsCompact((b.resetAtMs || 0) - nowMs)})` : '';
          addTipRow(b.windowShort || formatQuotaWindowTitle(b), `${b.percentText || '--'}${bReset}`, b.windowKey === 'weekly' ? 'is-7d' : 'is-5h');
        }
      } else {
        addTipRow(t('quota.tip.primary'), `${view.badge.text} · ${view.activeStatusLabel}`, '');
      }
    }
    if (qTipSub) {
      const mLabel = view.currentModel?.productLabel || t('quota.current.unmatched');
      const pTitle = matchedQuotaPool?.title ? ` · ${matchedQuotaPool.title}` : '';
      setQuotaTextIfChanged(qTipSub, `${mLabel}${pTitle}`);
    }
    if (state.quotaTooltipOpen) positionQuotaTooltip();

    // 2. Render refresh button and banner (preserve existing text, width, and card data during request to prevent flicker and layout shift)
    const btnRefresh = el('btn-quota-refresh');
    const txtRefresh = el('quota-refresh-text');
    if (btnRefresh) {
      if (Boolean(btnRefresh.disabled) !== Boolean(quotaState.busy)) {
        btnRefresh.disabled = Boolean(quotaState.busy);
      }
      setQuotaAttrIfChanged(btnRefresh, 'data-busy', quotaState.busy ? 'true' : 'false');
    }
    if (txtRefresh) {
      setQuotaTextIfChanged(txtRefresh, t('quota.refresh.btn'));
    }

    const tierPill = el('quota-plan-tier-pill');
    if (tierPill) {
      const tierTxt = view.planTierName || ANTIGRAVITY_TOKEN_DATA.planStatus?.tierName || '';
      if (tierTxt && tierTxt !== '未知') {
        setQuotaHiddenIfChanged(tierPill, false);
        setQuotaTextIfChanged(tierPill, tierTxt);
      } else {
        setQuotaHiddenIfChanged(tierPill, true);
      }
    }

    const bannerEl = el('quota-banner');
    const bannerTextEl = el('quota-banner-text');
    const bannerRetryBtn = el('btn-quota-banner-retry');
    const bannerRestartBtn = el('btn-quota-banner-restart');
    if (bannerEl && bannerTextEl) {
      const currentVer = METER_RENDERER_VERSION;
      const isBridgeMissing = quotaState.errorKind === 'bridge_unavailable';
      const observedBackendVer = backendStatus.backendVersion || quotaState.collectorVersion || null;
      const isStaleCollectorAfterUpdate = Boolean(
        pendingUpdateRestart &&
        (!quotaState.collectorVersion || quotaState.collectorVersion !== currentVer) &&
        (Boolean(quotaState.error) || view.activeStatus === 'no_permission' || view.activeStatus === 'unknown')
      );
      const isExplicitBackendMismatch = Boolean(
        !isBridgeMissing &&
        !isStaleCollectorAfterUpdate &&
        observedBackendVer &&
        observedBackendVer !== currentVer &&
        (backendStatus.hotReloadFallback || pendingUpdateRestart || backendStatus.backendVersionMismatch)
      );
      const needsRestartAction = isBridgeMissing || isStaleCollectorAfterUpdate || isExplicitBackendMismatch;
      if (bannerRestartBtn) {
        setQuotaHiddenIfChanged(bannerRestartBtn, !(needsRestartAction && hostSupportsRestart));
      }
      if (bannerRetryBtn) {
        setQuotaHiddenIfChanged(bannerRetryBtn, isBridgeMissing);
      }

      if (isBridgeMissing) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const msg = hostSupportsRestart
          ? t('quota.bridgeMissing')
          : `${t('quota.bridgeMissing')} ${t('client.restart.hostNotSupported')}`;
        setQuotaTextIfChanged(bannerTextEl, msg);
      } else if (isStaleCollectorAfterUpdate) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const msg = hostSupportsRestart
          ? t('quota.pendingRestartBanner')
          : `${t('quota.pendingRestartBanner')} ${t('client.restart.hostNotSupported')}`;
        setQuotaTextIfChanged(bannerTextEl, msg);
      } else if (isExplicitBackendMismatch) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const baseMsg = t('quota.backendMismatchBanner', {
          uiVer: currentVer,
          backendVer: `v${observedBackendVer}`,
          source: backendStatus.backendSource || 'host'
        });
        const msg = hostSupportsRestart ? baseMsg : `${baseMsg} ${t('client.restart.hostNotSupported')}`;
        setQuotaTextIfChanged(bannerTextEl, msg);
      } else if (view.syncState === 'error' && view.lastError) {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'error');
        setQuotaTextIfChanged(bannerTextEl, t('quota.errorBanner', { reason: view.lastError }));
      } else if (view.syncState === 'stale') {
        setQuotaHiddenIfChanged(bannerEl, false);
        setQuotaAttrIfChanged(bannerEl, 'data-tone', 'warn');
        const staleReason = view.lastError
          || (view.pools.some(p => p.isResetPassed && p.remainingFraction === 0) ? t('quota.resetPassReason') : t('quota.ageExpiredReason'));
        setQuotaTextIfChanged(bannerTextEl, t('quota.staleBanner', { reason: staleReason }));
      } else {
        setQuotaHiddenIfChanged(bannerEl, true);
      }
    }

    // Three-column timestamp display: Data Updated / Next Auto-Refresh / Current Quota Reset
    const tUpd = el('quota-time-updated');
    const tNext = el('quota-time-next');
    const tReset = el('quota-time-reset');
    if (tUpd) {
      const updStr = formatQuotaDateTime(view.fetchedAtMs);
      setQuotaTextIfChanged(tUpd, updStr);
      if (tUpd.title !== updStr) tUpd.title = updStr;
    }
    if (tNext) {
      const prevNextText = String(tNext.textContent || '').trim();
      const hasValidNextText = Boolean(prevNextText && prevNextText !== '—' && prevNextText !== t('quota.time.unknown') && prevNextText !== t('quota.refresh.busy'));
      let nextStr = null;
      if (quotaState.busy) {
        if (!hasValidNextText) nextStr = t('quota.refresh.busy');
      } else if (quotaState.autoPaused) {
        nextStr = t('quota.time.paused');
      } else if (Number.isFinite(Number(quotaState.nextRefreshAtMs))) {
        const nextDiff = quotaState.nextRefreshAtMs - nowMs;
        if (nextDiff > 0) {
          nextStr = `${formatQuotaDateTime(quotaState.nextRefreshAtMs).slice(6)} (${formatCountdownMsCompact(nextDiff)})`;
        } else if (!hasValidNextText) {
          nextStr = t('quota.refresh.busy');
        }
      } else {
        nextStr = t('quota.time.unknown');
      }
      if (nextStr !== null) {
        setQuotaTextIfChanged(tNext, nextStr);
        if (tNext.title !== nextStr) tNext.title = nextStr;
      }
    }
    if (tReset) {
      let resetStr = t('quota.time.unknown');
      if (view.activeReset?.hasResetTime) {
        const diffText = view.activeReset.isResetPassed
          ? t('quota.resetPassReason')
          : formatCountdownMsCompact((view.activeReset.resetAtMs || 0) - nowMs);
        resetStr = `${view.activeReset.resetTimeText} (${diffText})`;
      }
      setQuotaTextIfChanged(tReset, resetStr);
      if (tReset.title !== resetStr) tReset.title = resetStr;
    }

    // Current session model overview card
    const curModelEl = el('quota-cur-model');
    const curPoolEl = el('quota-cur-pool');
    const curEstEl = el('quota-cur-est');
    const curStatusEl = el('quota-cur-status');
    const curAlertEl = el('quota-cur-alert');
    const curBucketsEl = el('quota-cur-buckets');

    const matchedPoolObj = view.pools.find(p => p.poolKey === view.currentModel?.poolKey);

    if (curModelEl) {
      setQuotaTextIfChanged(curModelEl, view.currentModel?.productLabel || t('quota.current.unmatched'));
    }
    if (curPoolEl) {
      setQuotaTextIfChanged(curPoolEl, view.currentModel?.poolTitle ? `${view.currentModel.poolTitle}` : '');
    }
    if (curEstEl) {
      const curEstText = !view.currentModel?.noPermission && matchedPoolObj?.primaryBucket?.tokenEstimate
        ? formatBucketTokenEstimateLine(matchedPoolObj.primaryBucket.tokenEstimate)
        : '';
      if (curEstText) {
        setQuotaHiddenIfChanged(curEstEl, false);
        setQuotaTextIfChanged(curEstEl, curEstText);
      } else {
        setQuotaHiddenIfChanged(curEstEl, true);
        setQuotaTextIfChanged(curEstEl, '');
      }
    }
    if (curStatusEl) {
      setQuotaClassIfChanged(curStatusEl, `key-pill ${getQuotaPillClass(view.activeStatus)}`);
      setQuotaTextIfChanged(curStatusEl, getQuotaStatusLabelText(view.activeStatus));
    }
    if (curAlertEl) {
      if (view.currentModel?.noPermission && view.currentModel?.unavailabilityReason) {
        setQuotaHiddenIfChanged(curAlertEl, false);
        setQuotaAttrIfChanged(curAlertEl, 'data-kind', 'noperm');
        setQuotaTextIfChanged(curAlertEl, view.currentModel.unavailabilityReason);
      } else if (
        view.currentModel?.noticeText &&
        !/^(?:new|beta|preview|updated|notice|recommended)$/i.test(String(view.currentModel.noticeText).trim())
      ) {
        setQuotaHiddenIfChanged(curAlertEl, false);
        setQuotaAttrIfChanged(curAlertEl, 'data-kind', 'notice');
        setQuotaTextIfChanged(curAlertEl, `Notice: ${view.currentModel.noticeText}`);
      } else {
        setQuotaHiddenIfChanged(curAlertEl, true);
      }
    }
    if (curBucketsEl) {
      renderQuotaBucketsContainer(
        curBucketsEl,
        matchedPoolObj?.buckets || [],
        view.currentModel?.noPermission ? 'no_permission' : null,
        { animate: shouldAnimate, nowMs, chargeTargets: view.currentModel?.noPermission ? null : chargeBarTargets }
      );
    }

    // Shared quota pool list (reuse existing DOM cards in place; never destroy and rebuild whole block; compatible with lightweight mock DOM)
    const listEl = el('quota-pools-list');
    if (listEl) {
      if (!view.pools.length) {
        let emptyEl = Array.from(listEl.children || []).find(ch => String(ch.className || '').includes('quota-pools-empty-state')) || null;
        if (!emptyEl) {
          emptyEl = document.createElement('div');
          emptyEl.className = 'quota-pools-empty-state';
          if (emptyEl.style) emptyEl.style.cssText = 'font-size:11px;color:var(--ag-text-muted);padding:10px;text-align:center;border:1px dashed var(--ag-border-subcard);border-radius:7px';
        }
        setQuotaTextIfChanged(emptyEl, t('quota.pools.empty'));
        reconcileQuotaChildOrder(listEl, [emptyEl]);
      } else {
        const existingCards = new Map();
        for (const ch of Array.from(listEl.children || [])) {
          const pk = getChildAttr(ch, 'data-pool-key');
          if (pk) existingCards.set(pk, ch);
        }

        const desiredCards = [];
        for (let pIdx = 0; pIdx < view.pools.length; pIdx++) {
          const pool = view.pools[pIdx];
          const isCurrentPool = Boolean(view.currentModel?.poolKey && pool.poolKey === view.currentModel.poolKey);
          const isBrowsing = Boolean(view.browsePoolKey && pool.poolKey === view.browsePoolKey);

          let card = existingCards.get(pool.poolKey);
          let refs = card ? quotaNodeRefsMap.get(card) : null;

          if (!card || !refs) {
            card = document.createElement('div');
            card.className = 'quota-pool-card';
            card.setAttribute('data-pool-key', pool.poolKey);
            card.addEventListener('click', () => {
              quotaState.browsePoolKey = pool.poolKey;
              renderQuotaBoard(Date.now(), { animate: false });
            });

            const top = document.createElement('div');
            top.className = 'quota-pool-top';
            const titleEl = document.createElement('div');
            titleEl.className = 'quota-pool-title';
            const tagsEl = document.createElement('div');
            tagsEl.className = 'quota-pool-tags';
            const curTagEl = document.createElement('span');
            curTagEl.className = 'quota-current-tag';
            curTagEl.hidden = true;
            const stPill = document.createElement('span');
            stPill.className = 'key-pill quota-pool-status-pill';
            tagsEl.appendChild(curTagEl);
            tagsEl.appendChild(stPill);
            top.appendChild(titleEl);
            top.appendChild(tagsEl);

            const reasonEl = document.createElement('div');
            reasonEl.className = 'quota-pool-reason';
            if (reasonEl.style) reasonEl.style.cssText = 'font-size:10.5px;color:var(--ag-text-muted);margin-bottom:4px';
            reasonEl.hidden = true;

            const bucketsBox = document.createElement('div');
            bucketsBox.className = 'quota-buckets-list';

            const chipsBox = document.createElement('div');
            chipsBox.className = 'quota-models-chips';

            card.appendChild(top);
            card.appendChild(reasonEl);

            card.appendChild(bucketsBox);
            card.appendChild(chipsBox);
            refs = { titleEl, curTagEl, stPill, reasonEl, bucketsBox, chipsBox };
            quotaNodeRefsMap.set(card, refs);
          }

          const { titleEl, curTagEl, stPill, reasonEl, bucketsBox, chipsBox } = refs;

          if (isCurrentPool) setQuotaAttrIfChanged(card, 'data-active-current', 'true');
          else removeQuotaAttrIfPresent(card, 'data-active-current');
          if (isBrowsing) setQuotaAttrIfChanged(card, 'data-browsing', 'true');
          else removeQuotaAttrIfPresent(card, 'data-browsing');

          if (titleEl) setQuotaTextIfChanged(titleEl, pool.title);
          if (curTagEl) {
            if (isCurrentPool) {
              setQuotaHiddenIfChanged(curTagEl, false);
              setQuotaTextIfChanged(curTagEl, t('quota.current.tag'));
            } else {
              setQuotaHiddenIfChanged(curTagEl, true);
            }
          }
          if (stPill) {
            const pStatus = pool.noPermission ? 'no_permission' : (pool.status || 'unknown');
            setQuotaClassIfChanged(stPill, `key-pill quota-pool-status-pill ${getQuotaPillClass(pStatus)}`);
            const pctStr = !pool.noPermission && pool.percentText && pool.percentText !== '未知' ? ` · ${pool.percentText}` : '';
            setQuotaTextIfChanged(stPill, `${getQuotaStatusLabelText(pStatus)}${pctStr}`);
          }

          if (pool.noPermission && pool.unavailabilityReason) {
            if (reasonEl) {
              setQuotaHiddenIfChanged(reasonEl, false);
              setQuotaTextIfChanged(reasonEl, pool.unavailabilityReason);
            }
            if (bucketsBox) {
              setQuotaHiddenIfChanged(bucketsBox, true);
              renderQuotaBucketsContainer(bucketsBox, [], null, { animate: false, nowMs });
            }
          } else {
            if (reasonEl) setQuotaHiddenIfChanged(reasonEl, true);
            if (bucketsBox) {
              if (pool.buckets && pool.buckets.length) {
                setQuotaHiddenIfChanged(bucketsBox, false);
                renderQuotaBucketsContainer(bucketsBox, pool.buckets, null, { animate: shouldAnimate, nowMs, chargeTargets: chargeBarTargets });
              } else {
                setQuotaHiddenIfChanged(bucketsBox, true);
                renderQuotaBucketsContainer(bucketsBox, [], null, { animate: false, nowMs });
              }
            }
          }

          if (chipsBox) {
            const modelsList = Array.isArray(pool.models) ? pool.models : [];
            if (!modelsList.length) {
              setQuotaHiddenIfChanged(chipsBox, true);
            } else {
              setQuotaHiddenIfChanged(chipsBox, false);
              const chipsSig = modelsList.map(m => `${m.productKey}:${m.productLabel}:${(m.efforts || []).join('/')}:${m.noPermission ? 1 : 0}:${m.noticeText || ''}:${view.currentModel?.productKey === m.productKey ? 1 : 0}:${t('quota.short.no_permission')}`).join(';');
              if (getChildAttr(chipsBox, 'data-chips-sig') !== chipsSig) {
                chipsBox.setAttribute('data-chips-sig', chipsSig);
                const chipNodes = [];
                for (const m of modelsList) {
                  const chip = document.createElement('span');
                  chip.className = 'quota-model-chip';
                  if (view.currentModel?.productKey && m.productKey === view.currentModel.productKey) {
                    chip.setAttribute('data-current-model', 'true');
                  }
                  const lbl = document.createElement('span');
                  lbl.textContent = m.productLabel;
                  chip.appendChild(lbl);
                  if (m.efforts && m.efforts.length) {
                    const ef = document.createElement('span');
                    ef.className = 'quota-chip-efforts';
                    ef.textContent = `(${m.efforts.join('/')})`;
                    chip.appendChild(ef);
                  }
                  if (m.noPermission) {
                    const np = document.createElement('span');
                    np.className = 'quota-chip-noperm';
                    np.textContent = t('quota.short.no_permission');
                    chip.appendChild(np);
                  } else if (m.noticeText) {
                    const nt = document.createElement('span');
                    nt.className = 'quota-chip-notice';
                    nt.title = m.noticeText;
                    nt.textContent = m.noticeTitle || 'Notice';
                    chip.appendChild(nt);
                  }
                  chipNodes.push(chip);
                }
                reconcileQuotaChildOrder(chipsBox, chipNodes);
              }
            }
          }
          desiredCards.push(card);
        }
        reconcileQuotaChildOrder(listEl, desiredCards);
      }
    }

    if (
      savedScrollTop !== null &&
      savedScrollTop > 0 &&
      viewQuotaBody &&
      el('panel-quota') &&
      !el('panel-quota').hidden &&
      Math.abs((viewQuotaBody.scrollTop || 0) - savedScrollTop) > 1
    ) {
      viewQuotaBody.scrollTop = savedScrollTop;
    }

    if (renderOpts.chargeBars) {
      if (isQuotaReducedMotion()) {
        showQuotaUpToDateFeedback();
      } else if (chargeBarTargets && chargeBarTargets.length > 0) {
        triggerQuotaBarsChargeAnimation(chargeBarTargets);
      }
    }

    syncModelListQuotaIndicators(view, nowMs);
    scheduleQuotaResetConfirmIfNeeded(view, nowMs);
  }

  function scheduleQuotaResetConfirmIfNeeded(view, nowMs = Date.now()) {
    if (state.disposed) return;
    if (quotaResetTimer) { clearTimeout(quotaResetTimer); quotaResetTimer = null; }
    // Find nearest future resetAtMs and schedule auto-refresh at reset +2s; if reset just passed without confirmed refetch, schedule an immediate confirmation
    let soonestFutureMs = null;
    let passedKey = null;
    for (const p of (view.pools || [])) {
      for (const b of (p.buckets || [])) {
        if (!b.hasResetTime || !Number.isFinite(b.resetAtMs)) continue;
        if (b.resetAtMs > nowMs) {
          if (soonestFutureMs === null || b.resetAtMs < soonestFutureMs) soonestFutureMs = b.resetAtMs;
        } else if (b.remainingFraction === 0) {
          const rKey = `${p.poolKey}:${b.bucketId}:${b.resetTimeIso}`;
          if (quotaState.lastResetRequeryKey !== rKey) {
            passedKey = rKey;
          }
        }
      }
    }
    if (passedKey && !quotaState.busy) {
      quotaState.lastResetRequeryKey = passedKey;
      quotaResetTimer = setTimeout(() => { void syncQuotaFromHost(true); }, 1500);
      return;
    }
    if (soonestFutureMs !== null) {
      const waitMs = Math.min(2147483000, Math.max(2000, soonestFutureMs - nowMs + 2000));
      quotaResetTimer = setTimeout(() => { void syncQuotaFromHost(true); }, waitMs);
    }
  }

  function scheduleQuotaAutoRefresh(delayMs = null) {
    if (state.disposed) return;
    if (quotaAutoTimer) { clearTimeout(quotaAutoTimer); quotaAutoTimer = null; }
    const isWindowActive = host.getAttribute('data-window-active') !== 'false' && (typeof document === 'undefined' || !document.hidden);
    let interval = delayMs;
    if (!Number.isFinite(interval) || interval <= 0) {
      if (quotaState.consecutiveErrors > 0) {
        const backoff = quotaState.snapshot ? [10000, 20000, 60000, 120000] : [3000, 6000, 15000, 30000];
        interval = backoff[Math.min(backoff.length - 1, quotaState.consecutiveErrors - 1)];
      } else {
        interval = isWindowActive ? QUOTA_REFRESH_FG_MS : QUOTA_REFRESH_BG_MS;
      }
    }
    quotaState.nextRefreshAtMs = Date.now() + interval;
    quotaAutoTimer = setTimeout(() => {
      quotaAutoTimer = null;
      if (!state.disposed) void syncQuotaFromHost(false, { silent: true });
    }, interval);
  }

  function onQuotaWindowFocus() {
    if (state.disposed) return;
    quotaState.autoPaused = false;
    const elapsed = quotaState.lastFetchedAtMs ? (Date.now() - quotaState.lastFetchedAtMs) : Infinity;
    if (elapsed >= 20000 && !quotaState.busy) {
      void syncQuotaFromHost(false, { silent: true });
    } else {
      scheduleQuotaAutoRefresh();
    }
  }

  function onQuotaWindowBlur() {
    if (state.disposed) return;
    scheduleQuotaAutoRefresh(QUOTA_REFRESH_BG_MS);
  }

  function scheduleQuotaPostTurnRefresh() {
    if (state.disposed) return;
    if (quotaPostTurnTimer) clearTimeout(quotaPostTurnTimer);
    quotaPostTurnTimer = setTimeout(() => {
      quotaPostTurnTimer = null;
      const elapsed = quotaState.lastFetchedAtMs ? (Date.now() - quotaState.lastFetchedAtMs) : Infinity;
      if (!state.disposed && !quotaState.busy && elapsed > 5000) {
        void syncQuotaFromHost(true);
      }
    }, 1500);
  }

  async function maybeRefreshQuotaOnOpen() {
    const elapsed = quotaState.lastFetchedAtMs ? (Date.now() - quotaState.lastFetchedAtMs) : Infinity;
    if (!quotaState.snapshot || elapsed > 15000) {
      await syncQuotaFromHost(false);
    }
  }

  function mergeQuotaConfigsPreservingCapabilities(prevConfigs, nextConfigs) {
    if (!Array.isArray(nextConfigs) || !nextConfigs.length) return Array.isArray(prevConfigs) ? prevConfigs : [];
    const prevById = new Map();
    if (Array.isArray(prevConfigs)) {
      for (const item of prevConfigs) {
        const key = String(item?.model || item?.modelId || item?.modelOrAlias?.model || '').trim().toLowerCase();
        if (key) prevById.set(key, item);
      }
    }
    return nextConfigs.map(cfg => {
      if (!cfg || typeof cfg !== 'object') return cfg;
      const key = String(cfg.model || cfg.modelId || cfg.modelOrAlias?.model || '').trim().toLowerCase();
      const prev = key ? prevById.get(key) : null;
      if (!prev) return cfg;
      const merged = { ...cfg };
      for (const field of ['maxTokens', 'maxOutputTokens', 'thinkingBudget', 'minThinkingBudget', 'thinkingLevel', 'supportsModelInfoOverride', 'capabilitySource']) {
        if ((merged[field] == null || merged[field] === '') && prev[field] != null && prev[field] !== '') {
          merged[field] = prev[field];
        }
      }
      return merged;
    });
  }

  async function syncQuotaFromHost(force = false, meta = {}) {
    if (state.disposed) return null;
    if (quotaInFlightPromise) {
      return quotaInFlightPromise;
    }

    const isManual = Boolean(meta.manual);
    const isSilent = Boolean(meta.silent) && !isManual;
    if (isManual) triggerQuotaRefreshIconSpin();
    const runner = (async () => {
      const prevSig = computeQuotaVisualSignature(computeEffectiveQuotaView(Date.now()));
      quotaState.busy = true;
      renderQuotaBoard(Date.now(), { animate: false, consumeAnim: false });
      let payload = null;
      let rpcErr = null;
      let missingBridge = false;
      let usedBackendSource = null;
      const reqStartMs = Date.now();
      try {
        const hasIpcGetQuota = typeof window !== 'undefined' && typeof window.contextMeterAPI?.getQuota === 'function';
        const hasLivePort = hasLiveHttpBridge() && hasLiveRouteCapability('/quota');
        if (!hasIpcGetQuota && !hasLivePort) {
          missingBridge = true;
          rpcErr = t('quota.bridgeMissing');
        } else {
          quotaAbortController = typeof AbortController !== 'undefined' ? new AbortController() : null;
          const liveBody = {
            force: Boolean(force),
            origin: typeof window !== 'undefined' ? (window.location?.origin || undefined) : undefined
          };
          const out = await callBackendWithPriority({
            ipcCall: hasIpcGetQuota ? () => window.contextMeterAPI.getQuota({ force: Boolean(force) }) : null,
            liveRoute: '/quota',
            liveBody,
            liveFetchOpts: { signal: quotaAbortController?.signal }
          });
          usedBackendSource = out.source;
          let resObj = out.result;
          if (!resObj?.ok || resObj?.data?.ok === false) {
            try {
              if (usedBackendSource === 'live-host' && hasIpcGetQuota) {
                const alt = await window.contextMeterAPI.getQuota({ force: Boolean(force) });
                if (alt?.ok && alt.data?.ok !== false) {
                  resObj = alt;
                  usedBackendSource = 'electron-ipc';
                }
              } else if (usedBackendSource === 'electron-ipc' && hasLivePort) {
                const alt = await postLiveHttpEndpoint('/quota', liveBody, { signal: quotaAbortController?.signal });
                if (alt?.ok && alt.data?.ok !== false) {
                  resObj = alt;
                  usedBackendSource = 'live-host';
                }
              }
            } catch { }
          }
          if (resObj?.ok && resObj.data) {
            payload = resObj.data;
          } else if (resObj?.error) {
            rpcErr = resObj.error;
          }
        }
      } catch (e) {
        if (e?.name !== 'AbortError') {
          rpcErr = e?.message || '请求模型额度失败';
        }
      } finally {
        quotaAbortController = null;
      }

      if (state.disposed) return null;
      const nowMs = Date.now();
      const quotaDurationMs = nowMs - reqStartMs;
      quotaState.busy = false;
      quotaState.lastFetchedAtMs = nowMs;

      if (payload) {
        if (payload.accountSwitched || (payload.accountScopeKey && quotaState.accountScopeKey && payload.accountScopeKey !== quotaState.accountScopeKey)) {
          clearQuotaBarChargeAnimations();
          quotaState.snapshot = null;
          quotaState.rawInput = null;
          quotaState.browsePoolKey = null;
          quotaState.lastResetRequeryKey = null;
          quotaLastEstComputeSig = '';
          quotaCachedEstByKey = null;
        }
        if (payload.accountScopeKey) quotaState.accountScopeKey = payload.accountScopeKey;
        if (payload.collectorVersion) quotaState.collectorVersion = payload.collectorVersion;
        if (usedBackendSource) {
          syncObservedBackendMeta(usedBackendSource, payload, quotaDurationMs);
          if (backendStatus.backendVersion === METER_RENDERER_VERSION && !backendStatus.backendVersionMismatch) {
            pendingUpdateRestart = false;
          }
        }

        if (payload.ok !== false) {
          quotaState.snapshot = payload.snapshot || null;
          quotaState.rawInput = null;
          quotaState.lastSuccessAtMs = payload.lastSuccessAtMs || payload.fetchedAtMs || nowMs;
          quotaState.error = null;
          quotaState.errorKind = null;
          quotaState.consecutiveErrors = 0;
          if (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0) {
            state.cascadeModelConfigs = mergeQuotaConfigsPreservingCapabilities(
              payload.accountSwitched ? [] : state.cascadeModelConfigs,
              payload.cascadeModelConfigs
            );
            renderHeaderModelDropdown();
            syncContextModelSelectionFromState();
            if (!isContextSettingsView && activeContextTab === 'models') {
              renderModelSettingsTab();
            }
          }
        } else {
          quotaState.error = payload.error || '刷新失败';
          quotaState.errorKind = payload.errorKind || 'network';
          quotaState.consecutiveErrors += 1;
          if (payload.snapshot && !quotaState.snapshot) {
            quotaState.snapshot = payload.snapshot;
          }
        }
      } else if (rpcErr) {
        quotaState.error = rpcErr;
        quotaState.errorKind = missingBridge ? 'bridge_unavailable' : 'network';
        quotaState.consecutiveErrors += 1;
      }

      const nextView = computeEffectiveQuotaView(nowMs);
      const nextSig = computeQuotaVisualSignature(nextView);
      const hasDataChanged = nextSig !== prevSig;
      const requestSucceeded = Boolean(payload && payload.ok !== false && !rpcErr && !quotaState.error);
      const shouldAnimateChange = Boolean(hasDataChanged && !quotaState.error && prevSig !== 'empty' && !isSilent);
      const panelQuotaEl = el('panel-quota');
      const shouldChargeBars = Boolean(isManual && requestSucceeded && panelQuotaEl && !panelQuotaEl.hidden);
      quotaPendingSmoothAnim = shouldAnimateChange;
      if (!hasDataChanged && isManual && requestSucceeded) {
        showQuotaUpToDateFeedback();
      } else if (hasDataChanged || !requestSucceeded) {
        hideQuotaRefreshFeedback();
      }

      if (missingBridge) {
        clearQuotaTimers();
        quotaState.nextRefreshAtMs = null;
      } else {
        scheduleQuotaAutoRefresh();
      }
      if (typeof refreshAccountsOverview === 'function') {
        void refreshAccountsOverview({ silent: !isManual, refreshAllRemote: Boolean(isManual) });
      }
      renderQuotaBoard(nowMs, { animate: shouldAnimateChange, chargeBars: shouldChargeBars });
      return quotaState.snapshot;
    })();

    quotaInFlightPromise = runner;
    try {
      return await runner;
    } finally {
      if (quotaInFlightPromise === runner) quotaInFlightPromise = null;
    }
  }

  el('btn-speed-breakdown-toggle')?.addEventListener('click', () => {
    state.speedBreakdownOpen = !state.speedBreakdownOpen;
    if (typeof evaluateGenerationExperience === 'function') {
      renderSpeedExperienceInPlace(evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage));
    }
    positionFloatingPanels();
  });

  el('latest-call-summary-row')?.addEventListener('click', () => {
    state.latestCallDetailOpen = !state.latestCallDetailOpen;
    if (!state.latestCallDetailOpen && state.pinnedCallRecord) {
      state.pinnedCallRecord = null;
      renderSessionTimeline();
    }
    if (!state.latestCallDetailOpen && state.pendingLatestCallRecord) {
      renderLatestCallCard({ fromUserAction: true });
    } else {
      syncLatestCallDetailsVisibility();
    }
    positionFloatingPanels();
  });
  el('latest-call-summary-row')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      el('latest-call-summary-row')?.click();
    }
  });
  el('latest-call-new-banner')?.addEventListener('click', () => {
    state.pinnedCallRecord = null;
    state.pendingLatestCallRecord = null;
    renderLatestCallCard({ fromUserAction: true });
    if (state.historyDrawerOpen) renderSessionTimeline();
    positionFloatingPanels();
  });
  el('btn-session-history-toggle')?.addEventListener('click', () => {
    state.historyDrawerOpen = !state.historyDrawerOpen;
    if (!state.historyDrawerOpen && state.pinnedCallRecord) {
      state.pinnedCallRecord = null;
      renderLatestCallCard({ fromUserAction: true, skipAnim: true });
    }
    renderSessionTimeline();
    if (state.historyDrawerOpen && state.route) {
      void fetchSessionTimeline(state.route, { force: !state.sessionTimeline });
    }
    positionFloatingPanels();
  });
  el('btn-timeline-load-more')?.addEventListener('click', () => {
    state.timelinePageLimit = (Number(state.timelinePageLimit) || 10) + 10;
    renderSessionTimeline();
    positionFloatingPanels();
  });

  el('btn-quota-refresh')?.addEventListener('click', () => {
    void syncQuotaFromHost(true, { manual: true });
  });
  el('btn-quota-banner-retry')?.addEventListener('click', () => {
    void syncQuotaFromHost(true, { manual: true });
  });

  // =========================================================================
  // Multi-account ledger filter, account switching, ELV-57 quota comparison table, and ELV-52 keepalive guard rendering
  // =========================================================================

  function syncTokenAccountFilterOptions(payload = null) {
    const sel = el('token-account-select');
    const noteEl = el('token-account-scope-note');
    if (!sel) return;
    const isEn = currentPanelLanguage === 'en';
    const isTw = currentPanelLanguage === 'zh-TW';
    const ov = accountsUiState.overview;
    const acctList = Array.isArray(ov?.accounts) ? ov.accounts : [];
    const usageMap = payload?.usageByAccount || ANTIGRAVITY_TOKEN_DATA.rawPayload?.usageByAccount || {};
    const curScope = payload?.accountScopeKey || ov?.activeAccountScopeKey || '';

    const knownMap = new Map();
    for (const a of acctList) {
      knownMap.set(a.accountScopeKey, a.maskedEmail || a.email || a.accountScopeKey);
    }
    for (const scopeK of Object.keys(usageMap)) {
      if (!knownMap.has(scopeK)) knownMap.set(scopeK, scopeK);
    }

    const optsHtml = [];
    optsHtml.push({ val: 'all', label: t('accounts.filterAll') });
    for (const [scopeK, disp] of knownMap.entries()) {
      const isCur = scopeK === curScope;
      const suffix = isCur ? ` (${t('accounts.activeTag')})` : '';
      optsHtml.push({ val: scopeK, label: `${disp}${suffix}` });
    }
    optsHtml.push({ val: 'unattributed', label: t('accounts.filterUnattributed') });

    const prevVal = activeTokenAccountFilter || 'all';
    sel.replaceChildren();
    for (const item of optsHtml) {
      const opt = document.createElement('option');
      opt.value = item.val;
      opt.textContent = item.label;
      if (item.val === prevVal) opt.selected = true;
      sel.appendChild(opt);
    }
    if (!optsHtml.some(o => o.val === prevVal)) {
      activeTokenAccountFilter = 'all';
      sel.value = 'all';
    } else {
      sel.value = prevVal;
    }

    if (noteEl) {
      if (activeTokenAccountFilter === 'unattributed') {
        const unAttrTot = Number(payload?.unattributedUsage?.totalTokens ?? ANTIGRAVITY_TOKEN_DATA.rawPayload?.unattributedUsage?.totalTokens ?? 0);
        noteEl.textContent = isEn
          ? `Unattributed history (${formatTokensK(unAttrTot)}): offline Desktop/CLI/IDE files without verified email.`
          : (isTw ? `歷史未歸屬 (${formatTokensK(unAttrTot)})：無帳號依據的舊檔案不計入當前帳號。` : `历史未归属 (${formatTokensK(unAttrTot)}): 无账号依据的旧文件不计入当前账号。`);
      } else if (activeTokenAccountFilter !== 'all') {
        const b = usageMap[activeTokenAccountFilter];
        const bTot = Number(b?.totalTokens || 0);
        const kaReqs = Number(b?.keepaliveRequests || 0);
        const kaTok = Number(b?.keepaliveTokens || 0);
        if (bTot <= 0 && kaReqs <= 0) {
          noteEl.textContent = t('accounts.filterNoData');
        } else if (kaReqs > 0) {
          noteEl.textContent = t('accounts.filterKeepaliveNote', { reqs: kaReqs, tok: formatTokensK(kaTok) });
        } else {
          noteEl.textContent = isEn ? 'Isolated account ledger (zero cross-account mixing).' : (isTw ? '單帳號獨立帳本（零跨號混算）。' : '单账号独立账本（零跨号混算）。');
        }
      } else {
        const attrCount = Object.keys(usageMap).length;
        noteEl.textContent = attrCount > 0
          ? (isEn ? `${attrCount} attributed account(s) + isolated legacy history.` : (isTw ? `含 ${attrCount} 個已歸屬帳號 + 獨立未歸屬歷史。` : `含 ${attrCount} 个已归属账号 + 独立未归属历史。`))
          : '';
      }
    }
    if (typeof enhancedDropdowns !== 'undefined' && enhancedDropdowns?.get) {
      enhancedDropdowns.get('token-account-select')?.refresh?.();
    }
  }

  el('token-account-select')?.addEventListener('change', (ev) => {
    activeTokenAccountFilter = ev.target?.value || 'all';
    resetAccountScopedViewOffsets();
    if (ANTIGRAVITY_TOKEN_DATA.rawPayload) {
      applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
    }
  });

  function isEditingAutoSwitchDraft() {
    try {
      const ae = shadow?.activeElement;
      if (!ae) return false;
      const body = el('auto-switch-config-body');
      return Boolean(body && body.contains?.(ae));
    } catch {
      return false;
    }
  }

  function renderAccountsOverviewSection() {
    const ov = accountsUiState.overview || {
      accounts: [],
      autoSwitch: {},
      autoSwitchStatus: { state: 'disabled' },
      keepalive: {},
      keepaliveState: {},
      quotaIntervals: [],
      protocolEvidence: {
        checkedVersion: '2.32.1',
        rpcCountChecked: 375,
        conclusion: '在已检查的 Antigravity 2.32.1 语言服务 375 个 RPC 和响应中，未发现明确的 Prompt Cache 续期或 TTL 接口，响应亦未见 cacheWriteTokens 或 cacheTtl；因此不展示虚构到期倒计时，缓存保活保持待验证/默认关闭。',
        minimalExperimentPlan: {
          targetModel: 'Gemini 4 Hydrogen (High)',
          totalRequestsPlanned: 5,
          groupB: '实验组（3 次请求，含 1 次 "ok" 心跳）对比对照组（2 次请求，无保活），约 20K 固定只读前缀、预计总输出 60~150 tok，待维护者确认后再发实验请求。'
        }
      }
    };
    const isEn = currentPanelLanguage === 'en';
    const isTw = currentPanelLanguage === 'zh-TW';

    // 1. Tool button visibility and feedback banner
    const toolsBtn = el('btn-acct-import-tools');
    if (toolsBtn) {
      toolsBtn.hidden = !(accountsUiState.toolsPreview?.available && (accountsUiState.toolsPreview.count || 0) > 0);
    }
    const fbEl = el('quota-acct-feedback');
    const lr = ov.autoSwitchStatus?.lastResult;
    const rawLastErr = (lr?.ok === false && lr?.error) ? lr.error : ov.autoSwitchStatus?.lastError;
    const formatPersistedError = (raw) => {
      if (!raw) return '';
      const txt = typeof translateBackendText === 'function' ? translateBackendText(raw) : String(raw);
      if (lr?.rolledBack && !/(回滚|回滾|rolled back)/i.test(txt)) {
        return t('accounts.lastSwitchRolledBack', { detail: txt });
      }
      return txt;
    };
    const hasRecentPersistedResult = Boolean(
      !accountsUiState.feedback
      && !accountsUiState.busy
      && lr
      && (lr.ok === false || (lr.atMs != null && Math.abs(Date.now() - Number(lr.atMs)) <= 15 * 60 * 1000))
    );
    let displayFeedback = accountsUiState.feedback || '';
    let displayTone = accountsUiState.feedbackTone;
    if (!displayFeedback && hasRecentPersistedResult) {
      if (lr.ok === false) {
        displayFeedback = formatPersistedError(rawLastErr || t('accounts.actionFail'));
        displayTone = 'error';
      } else if (lr.ok === true && (lr.message || lr.toEmail)) {
        displayFeedback = lr.message
          ? (typeof translateBackendText === 'function' ? translateBackendText(lr.message) : lr.message)
          : t('accounts.lastSwitchedTo', { email: lr.toEmail });
        displayTone = 'success';
      }
    }
    if (fbEl) {
      fbEl.hidden = !displayFeedback;
      fbEl.textContent = displayFeedback;
      fbEl.className = `quota-acct-feedback${displayTone === 'error' ? ' is-error' : (displayTone === 'success' ? ' is-success' : '')}`;
    }

    // 2. Account list
    const listEl = el('quota-accounts-list');
    if (listEl) {
      const prevScrollTop = Number(listEl.scrollTop || 0);
      listEl.replaceChildren();
      const accts = Array.isArray(ov.accounts) ? ov.accounts : [];
      if (!accts.length) {
        const empty = document.createElement('div');
        empty.className = 'quota-muted-note';
        empty.textContent = t('accounts.empty');
        listEl.appendChild(empty);
      } else {
        for (const acc of accts) {
          const card = document.createElement('div');
          card.className = `quota-acct-card${acc.isActive ? ' is-active' : ''}`;
          const topRow = document.createElement('div');
          topRow.className = 'quota-subcard-row';
          const left = document.createElement('span');
          left.className = 'quota-acct-email';
          left.textContent = `${acc.email}${acc.tierId ? ` · ${acc.tierId}` : ''}`;
          left.title = acc.email;
          const right = document.createElement('div');
          right.className = 'quota-subsec-actions';
          if (acc.hasRefreshToken) {
            const refBtn = document.createElement('button');
            refBtn.className = 'switch-pill-btn quota-acct-refresh-btn';
            refBtn.type = 'button';
            refBtn.disabled = accountsUiState.busy;
            refBtn.textContent = t('accounts.retryQuota');
            refBtn.addEventListener('click', () => void performAccountAction('refresh_quota', { email: acc.email }));
            right.appendChild(refBtn);
          }
          if (acc.isActive) {
            const pill = document.createElement('span');
            pill.className = 'key-pill pill-good';
            pill.textContent = t('accounts.activeTag');
            right.appendChild(pill);
          } else {
            const swBtn = document.createElement('button');
            swBtn.className = 'switch-pill-btn';
            swBtn.type = 'button';
            swBtn.disabled = accountsUiState.busy || Boolean(accountsUiState.removeModal?.busy) || !acc.hasRefreshToken || Boolean(acc.authInvalid);
            swBtn.textContent = t('accounts.switchBtn');
            swBtn.addEventListener('click', () => void performAccountAction('switch', { email: acc.email }));
            right.appendChild(swBtn);
          }
          const rmBtn = document.createElement('button');
          rmBtn.className = 'quota-acct-remove-btn';
          rmBtn.type = 'button';
          rmBtn.disabled = accountsUiState.busy || Boolean(accountsUiState.removeModal?.busy);
          rmBtn.textContent = t('accounts.removeBtn');
          if (rmBtn.dataset) rmBtn.dataset.removeEmail = acc.email;
          rmBtn.addEventListener('click', () => openRemoveAccountModal(acc));
          right.appendChild(rmBtn);
          topRow.appendChild(left);
          topRow.appendChild(right);
          card.appendChild(topRow);

          const poolSummaries = (acc.quotaSnapshot?.pools || []).map(p => {
            const pName = p.poolKey === 'shared_gemini_main' ? 'Hydrogen' : (p.poolKey === 'shared_3p_pool' ? 'Claude/3P' : (p.poolKey === 'shared_gemini_argon' ? 'Argon' : 'Carbon'));
            const pVal = p.noPermission
              ? t('accounts.poolNoAccess')
              : (p.percentText && p.percentText !== '未知' ? p.percentText : t('accounts.poolUnknown'));
            return `${pName}: ${pVal}`;
          });
          const metaRow = document.createElement('div');
          metaRow.className = 'quota-acct-meta';
          const updRaw = acc.lastQuotaUpdatedAtMs ? new Date(acc.lastQuotaUpdatedAtMs).toLocaleTimeString() : '—';
          const upd = (acc.quotaSnapshot && acc.lastQuotaError && acc.lastQuotaUpdatedAtMs)
            ? t('accounts.lastSnapshotTime', { time: updRaw })
            : updRaw;
          const authNote = acc.authInvalid ? ` · ${t('accounts.reauthRequired')}` : '';
          const emptyPoolText = acc.lastQuotaError ? t('accounts.poolPending') : t('accounts.poolUnknown');
          metaRow.textContent = `${poolSummaries.length ? poolSummaries.join(' | ') : emptyPoolText} · ${upd}${authNote}`;
          card.appendChild(metaRow);
          if (acc.lastQuotaError) {
            const errRow = document.createElement('div');
            errRow.className = 'quota-acct-error';
            const meta = acc.lastQuotaErrorMeta;
            const detailParts = [];
            if (meta?.stage) detailParts.push(meta.stage);
            if (meta?.targetHost) detailParts.push(meta.targetHost);
            if (meta?.httpStatus != null) detailParts.push(`HTTP ${meta.httpStatus}`);
            const translatedErr = typeof translateBackendText === 'function' ? translateBackendText(acc.lastQuotaError) : acc.lastQuotaError;
            const detailStr = detailParts.length ? `[${detailParts.join(' · ')}] ${translatedErr}` : translatedErr;
            errRow.textContent = t('accounts.quotaStageErr', { detail: detailStr });
            card.appendChild(errRow);
          }
          listEl.appendChild(card);
        }
      }
      if (prevScrollTop > 0) {
        const maxScroll = Math.max(0, (listEl.scrollHeight || 0) - (listEl.clientHeight || 0));
        listEl.scrollTop = maxScroll > 0 ? Math.min(prevScrollTop, maxScroll) : prevScrollTop;
      }
    }

    // 3. Auto-switch status and control backfill (skip overwriting inputs while editing to protect drafts)
    const stPill = el('auto-switch-status-pill');
    const lastNote = el('auto-switch-last-note');
    const stKeys = new Set(['disabled', 'watching', 'pending_debounce', 'waiting_idle', 'cooldown', 'switching', 'all_candidates_exhausted', 'blocked_untrusted_quota', 'error']);
    if (stPill) {
      const sKey = ov.autoSwitchStatus?.state || (ov.autoSwitch?.enabled ? 'watching' : 'disabled');
      stPill.textContent = stKeys.has(sKey) ? t(`accounts.status.${sKey}`) : sKey;
      stPill.className = `key-pill ${sKey === 'watching' ? 'pill-good' : (sKey === 'error' || sKey === 'all_candidates_exhausted' ? 'pill-warn' : 'pill-muted')}`;
    }
    if (lastNote) {
      if (rawLastErr) {
        lastNote.textContent = formatPersistedError(rawLastErr);
      } else if (lr?.ok === false) {
        lastNote.textContent = formatPersistedError(t('accounts.actionFail'));
      } else {
        lastNote.textContent = lr?.toEmail ? t('accounts.lastSwitchedTo', { email: lr.toEmail }) : '';
      }
    }

    if (!isEditingAutoSwitchDraft()) {
      const cfg = ov.autoSwitch || {};
      const chk = el('chk-auto-switch-enabled');
      const poolSel = el('sel-auto-switch-pool');
      const modeSel = el('sel-auto-switch-mode');
      const winSel = el('sel-auto-switch-window');
      const thInp = el('inp-auto-switch-threshold');
      if (chk) chk.checked = Boolean(cfg.enabled);
      if (poolSel && cfg.poolKey) poolSel.value = cfg.poolKey;
      if (modeSel && cfg.metricMode) modeSel.value = cfg.metricMode;
      if (winSel && cfg.windowKey) winSel.value = cfg.windowKey;
      if (thInp && cfg.thresholdPct != null) thInp.value = String(cfg.thresholdPct);
      if (typeof enhancedDropdowns !== 'undefined' && enhancedDropdowns?.get) {
        enhancedDropdowns.get('sel-auto-switch-pool')?.refresh?.();
        enhancedDropdowns.get('sel-auto-switch-mode')?.refresh?.();
        enhancedDropdowns.get('sel-auto-switch-window')?.refresh?.();
      }

      const candWrap = el('auto-switch-candidates-list');
      if (candWrap) {
        candWrap.replaceChildren();
        const selectedSet = new Set(Array.isArray(cfg.candidates) ? cfg.candidates : []);
        for (const acc of (ov.accounts || [])) {
          const lbl = document.createElement('label');
          lbl.className = 'auto-switch-cand-chip';
          const box = document.createElement('input');
          box.type = 'checkbox';
          box.value = acc.email;
          box.checked = selectedSet.has(acc.email);
          box.className = 'auto-switch-cand-checkbox';
          const span = document.createElement('span');
          span.textContent = acc.maskedEmail || acc.email;
          lbl.appendChild(box);
          lbl.appendChild(span);
          candWrap.appendChild(lbl);
        }
      }
    }

    // 4. ELV-57 quota change comparison table
    const cmpEl = el('quota-compare-list');
    if (cmpEl) {
      cmpEl.replaceChildren();
      const intervals = Array.isArray(ov.quotaIntervals) ? ov.quotaIntervals.slice(0, 8) : [];
      if (!intervals.length) {
        const emp = document.createElement('div');
        emp.className = 'quota-muted-note';
        emp.textContent = t('quota.compareEmpty');
        cmpEl.appendChild(emp);
      } else {
        for (const iv of intervals) {
          const card = document.createElement('div');
          card.className = 'quota-compare-card';
          const deltaLabel = iv.deltaPp < 0
            ? (isEn ? `-${Math.abs(iv.deltaPp)} pp` : (isTw ? `下降 ${Math.abs(iv.deltaPp)} 個百分點` : `下降 ${Math.abs(iv.deltaPp)} 个百分点`))
            : (iv.deltaPp > 0 ? (isEn ? `+${iv.deltaPp} pp` : (isTw ? `回升 ${iv.deltaPp} 個百分點` : `回升 ${iv.deltaPp} 个百分点`)) : (isEn ? '0 pp' : (isTw ? '無變化' : '无变化')));
          const splitText = iv.splitReason
            ? (t(`quota.split.${iv.splitReason}`) !== `quota.split.${iv.splitReason}` ? t(`quota.split.${iv.splitReason}`) : iv.splitReason)
            : '';
          const splitBadge = splitText ? ` [${splitText}]` : '';
          const sTime = new Date(iv.startAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const eTime = new Date(iv.endAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          const head = document.createElement('div');
          head.className = 'quota-subcard-row';
          head.innerHTML = '';
          const hLeft = document.createElement('strong');
          hLeft.textContent = `${iv.poolTitle} (${iv.windowShort || iv.windowKey}) · ${iv.startRemainingPct}% → ${iv.endRemainingPct}% (${deltaLabel})`;
          const hRight = document.createElement('span');
          hRight.className = 'quota-acct-meta';
          hRight.textContent = `${sTime}–${eTime}${splitBadge}`;
          head.appendChild(hLeft);
          head.appendChild(hRight);

          const body = document.createElement('div');
          body.className = 'quota-acct-meta';
          body.textContent = isEn
            ? `Account: ${iv.email} · Local reqs: ${iv.requestCount} | Uncached In: ${formatTokensK(iv.uncachedInputTokens)} · Cache Read: ${formatTokensK(iv.cacheReadTokens)} · Out: ${formatTokensK(iv.outputTokens)}${iv.hasSamplingGap ? ' · Sampling gap split' : ''}`
            : (isTw
              ? `帳號: ${iv.email} · 本機請求 ${iv.requestCount} 次 | 未快取輸入 ${formatTokensK(iv.uncachedInputTokens)} · 快取讀取 ${formatTokensK(iv.cacheReadTokens)} · 輸出 ${formatTokensK(iv.outputTokens)}${iv.hasSamplingGap ? ' · 含採樣缺口已切分' : ''}`
              : `账号: ${iv.email} · 本机请求 ${iv.requestCount} 次 | 未缓存输入 ${formatTokensK(iv.uncachedInputTokens)} · 缓存读取 ${formatTokensK(iv.cacheReadTokens)} · 输出 ${formatTokensK(iv.outputTokens)}${iv.hasSamplingGap ? ' · 含采样缺口已切分' : ''}`);
          card.appendChild(head);
          card.appendChild(body);
          cmpEl.appendChild(card);
        }
      }
    }

    // 5. ELV-52 keepalive protocol evidence and safety controls
    const kaPill = el('keepalive-status-pill');
    const kaProto = el('keepalive-protocol-summary');
    const kaExp = el('keepalive-experiment-summary');
    const kaRun = el('keepalive-runtime-note');
    const kaStopBtn = el('btn-keepalive-stop');
    const ka = ov.keepalive || {};
    const ks = ov.keepaliveState || {};
    if (kaPill) {
      kaPill.textContent = ks.running
        ? (isEn ? 'Running' : (isTw ? '保活執行中' : '保活运行中'))
        : (isEn ? 'Unverified · Off' : (isTw ? '待驗證 · 預設關閉' : '待验证 · 默认关闭'));
      kaPill.className = `key-pill ${ks.running ? 'pill-warn' : 'pill-muted'}`;
    }
    if (kaProto && ov.protocolEvidence) {
      kaProto.textContent = t('keepalive.protocolSummary', {
        ver: ov.protocolEvidence.checkedVersion || '2.32.1',
        rpcs: ov.protocolEvidence.rpcCountChecked || 375
      });
    }
    if (kaExp && ov.protocolEvidence?.minimalExperimentPlan) {
      const plan = ov.protocolEvidence.minimalExperimentPlan;
      kaExp.textContent = t('keepalive.experimentSummary', {
        reqs: plan.totalRequestsPlanned || 5,
        model: plan.targetModel || 'Gemini 4 Hydrogen (High)'
      });
    }
    if (kaRun) {
      const blockedTxt = ks.blockedReason && typeof translateBackendText === 'function' ? translateBackendText(ks.blockedReason) : ks.blockedReason;
      const stopTxt = ks.stopReason && typeof translateBackendText === 'function' ? translateBackendText(ks.stopReason) : ks.stopReason;
      kaRun.textContent = blockedTxt
        ? t('keepalive.blockedReason', { reason: blockedTxt })
        : (stopTxt ? t('keepalive.stopReason', { reason: stopTxt }) : t('keepalive.defaultNote'));
    }
    if (kaStopBtn) kaStopBtn.hidden = !ks.running;


    syncTokenAccountFilterOptions(ANTIGRAVITY_TOKEN_DATA.rawPayload);
    if (accountsUiState.removeModal?.open) renderAccountRemoveModal();
  }

  async function refreshAccountsOverview({ silent = true, refreshAllRemote = false } = {}) {
    if (state.disposed) return null;
    try {
      const hasIpc = typeof window !== 'undefined' && typeof window.contextMeterAPI?.getAccountsOverview === 'function';
      const hasLive = hasLiveHttpBridge() && hasLiveRouteCapability('/accounts-overview');
      if (!hasIpc && !hasLive) return null;
      if (refreshAllRemote) {
        const res = await callBackendWithPriority({
          ipcCall: typeof window?.contextMeterAPI?.accountsAction === 'function'
            ? () => window.contextMeterAPI.accountsAction({ action: 'refresh_quota' })
            : null,
          liveRoute: '/accounts-action',
          liveBody: { action: 'refresh_quota' }
        });
        const out = res?.result || {};
        const data = out.overview || out;
        if (data?.accounts) accountsUiState.overview = data;
        if (out.ok === false) {
          const errRaw = out.error || out.message || t('accounts.actionFail');
          accountsUiState.feedback = typeof translateBackendText === 'function' ? translateBackendText(errRaw) : errRaw;
          accountsUiState.feedbackTone = 'error';
        } else if (out.ok === true && accountsUiState.feedbackTone === 'error') {
          const msgRaw = out.message || t('accounts.actionDone');
          accountsUiState.feedback = typeof translateBackendText === 'function' ? translateBackendText(msgRaw) : msgRaw;
          accountsUiState.feedbackTone = 'success';
        }
      } else {
        const res = await callBackendWithPriority({
          ipcCall: hasIpc ? () => window.contextMeterAPI.getAccountsOverview() : null,
          liveRoute: '/accounts-overview',
          liveBody: {}
        });
        const data = res?.result;
        if (data?.ok) accountsUiState.overview = data;
      }
      if (!accountsUiState.toolsPreview) {
        const prevRes = await callBackendWithPriority({
          ipcCall: typeof window?.contextMeterAPI?.accountsAction === 'function'
            ? () => window.contextMeterAPI.accountsAction({ action: 'preview_tools' })
            : null,
          liveRoute: '/accounts-action',
          liveBody: { action: 'preview_tools' }
        }).catch(() => null);
        if (prevRes?.result?.ok) accountsUiState.toolsPreview = prevRes.result;
      }
      renderAccountsOverviewSection();
      return accountsUiState.overview;
    } catch (e) {
      if (!silent) {
        accountsUiState.feedback = e.message;
        accountsUiState.feedbackTone = 'error';
        renderAccountsOverviewSection();
      }
      return null;
    }
  }

  function renderAccountRemoveModal() {
    const modal = el('account-remove-modal');
    const titleEl = el('modal-account-remove-title');
    const textEl = el('modal-account-remove-text');
    const fbEl = el('modal-account-remove-feedback');
    const cancelBtn = el('btn-modal-account-remove-cancel');
    const confirmBtn = el('btn-modal-account-remove-confirm');
    const st = accountsUiState.removeModal || {};
    if (!modal) return;
    modal.hidden = !st.open;
    if (!st.open) return;
    if (titleEl) titleEl.textContent = t('accounts.removeModal.title');
    if (textEl) {
      textEl.textContent = st.isActive
        ? t('accounts.removeModal.bodyActive', { email: st.email || '' })
        : t('accounts.removeModal.body', { email: st.email || '' });
    }
    if (fbEl) {
      fbEl.hidden = !st.error;
      fbEl.textContent = st.error || '';
    }
    if (cancelBtn) {
      cancelBtn.textContent = t('accounts.removeModal.cancel');
      cancelBtn.disabled = Boolean(st.busy);
    }
    if (confirmBtn) {
      confirmBtn.textContent = st.busy ? t('accounts.removeModal.removing') : t('accounts.removeModal.confirm');
      confirmBtn.disabled = Boolean(st.busy) || !st.email;
    }
  }

  function openRemoveAccountModal(acc) {
    if (!acc || !acc.email || accountsUiState.busy || accountsUiState.removeModal?.busy) return;
    const scopeKey = acc.accountScopeKey || String(acc.email).trim().toLowerCase();
    accountsUiState.removeModal = {
      open: true,
      email: acc.email,
      scopeKey,
      isActive: Boolean(acc.isActive),
      busy: false,
      error: ''
    };
    renderAccountRemoveModal();
  }

  function closeRemoveAccountModal(forceClose = false) {
    if (!forceClose && accountsUiState.removeModal?.busy) return;
    accountsUiState.removeModal = {
      open: false,
      email: '',
      scopeKey: '',
      isActive: false,
      busy: false,
      error: ''
    };
    renderAccountRemoveModal();
  }

  async function confirmRemoveAccountModal() {
    const st = accountsUiState.removeModal;
    if (!st?.open || !st.email || st.busy || accountsUiState.busy) return null;
    const targetEmail = st.email;
    const targetScopeKey = st.scopeKey || String(targetEmail).trim().toLowerCase();
    st.busy = true;
    st.error = '';
    renderAccountRemoveModal();
    renderAccountsOverviewSection();
    try {
      const out = await performAccountAction('remove', { email: targetEmail });
      if (out && out.ok) {
        const effectiveRemovedScope = out.removedScopeKey || targetScopeKey;
        closeRemoveAccountModal(true);
        accountsUiState.feedback = t('accounts.removeSuccess', { email: targetEmail });
        accountsUiState.feedbackTone = 'success';
        if (activeTokenAccountFilter && activeTokenAccountFilter === effectiveRemovedScope) {
          activeTokenAccountFilter = 'all';
          resetAccountScopedViewOffsets();
        }
        if (ANTIGRAVITY_TOKEN_DATA.rawPayload) {
          applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
        }
        renderAccountsOverviewSection();
        void refreshAccountsOverview({ silent: true });
        void syncTokenHistoryFromHost(true);
        return out;
      }
      const errDetail = translateBackendText(out?.error || t('accounts.actionFail'));
      accountsUiState.removeModal = {
        ...accountsUiState.removeModal,
        open: true,
        busy: false,
        error: t('accounts.removeModal.failed', { detail: errDetail })
      };
      renderAccountRemoveModal();
      return out || { ok: false, error: errDetail };
    } catch (err) {
      const errDetail = translateBackendText(err?.message || t('accounts.actionFail'));
      accountsUiState.removeModal = {
        ...accountsUiState.removeModal,
        open: true,
        busy: false,
        error: t('accounts.removeModal.failed', { detail: errDetail })
      };
      renderAccountRemoveModal();
      return { ok: false, error: errDetail };
    }
  }

  el('btn-modal-account-remove-cancel')?.addEventListener('click', () => closeRemoveAccountModal());
  el('btn-modal-account-remove-confirm')?.addEventListener('click', () => void confirmRemoveAccountModal());
  el('account-remove-modal')?.addEventListener('click', (ev) => {
    if (ev.target === el('account-remove-modal')) closeRemoveAccountModal();
  });

  async function performAccountAction(action, extraPayload = {}) {
    if (accountsUiState.busy) return null;
    accountsUiState.busy = true;
    accountsUiState.feedback = t('accounts.actionBusy');
    accountsUiState.feedbackTone = 'info';
    renderAccountsOverviewSection();
    try {
      const res = await callBackendWithPriority({
        ipcCall: typeof window?.contextMeterAPI?.accountsAction === 'function'
          ? () => window.contextMeterAPI.accountsAction({ action, ...extraPayload })
          : null,
        liveRoute: '/accounts-action',
        liveBody: { action, ...extraPayload }
      });
      const out = res?.result || {};
      if (out.overview) accountsUiState.overview = out.overview;
      const isOk = out.ok === true;
      const isPartialOAuthQuotaWarn = isOk && action === 'oauth_login' && out.quotaOk === false && Boolean(out.quotaError);
      const rawFb = isPartialOAuthQuotaWarn
        ? `${out.account?.email ? `${out.account.email} ` : ''}${translateBackendText(out.quotaError)}`
        : (isOk
          ? (out.message || t('accounts.actionDone'))
          : (out.error || out.message || t('accounts.actionFail')));
      accountsUiState.feedback = typeof translateBackendText === 'function' ? translateBackendText(rawFb) : rawFb;
      accountsUiState.feedbackTone = isOk ? (isPartialOAuthQuotaWarn ? 'info' : 'success') : 'error';
      if (action === 'switch' && isOk) {
        void syncQuotaFromHost(true, { manual: false });
        void syncTokenHistoryFromHost(true);
      }
      return out;
    } catch (e) {
      const errTxt = e.message || t('accounts.actionFail');
      accountsUiState.feedback = typeof translateBackendText === 'function' ? translateBackendText(errTxt) : errTxt;
      accountsUiState.feedbackTone = 'error';
      return { ok: false, error: e.message };
    } finally {
      accountsUiState.busy = false;
      renderAccountsOverviewSection();
    }
  }

  el('btn-acct-import-current')?.addEventListener('click', () => void performAccountAction('import_current'));
  el('btn-acct-import-tools')?.addEventListener('click', () => void performAccountAction('import_tools'));
  el('btn-acct-oauth-add')?.addEventListener('click', () => void performAccountAction('oauth_login'));
  el('btn-keepalive-stop')?.addEventListener('click', () => void performAccountAction('stop_keepalive', { reason: 'manual_button' }));
  el('btn-save-auto-switch')?.addEventListener('click', () => {
    const enabled = Boolean(el('chk-auto-switch-enabled')?.checked);
    const poolKey = el('sel-auto-switch-pool')?.value || 'shared_gemini_main';
    const metricMode = el('sel-auto-switch-mode')?.value || 'remaining_pct';
    const windowKey = el('sel-auto-switch-window')?.value || 'primary';
    const thresholdPct = Number(el('inp-auto-switch-threshold')?.value) || 10;
    const candidates = Array.from(shadow.querySelectorAll('.auto-switch-cand-checkbox:checked')).map(n => n.value);
    void performAccountAction('update_auto_switch', {
      config: { enabled, poolKey, metricMode, windowKey, thresholdPct, candidates }
    });
  });
  const btnQuotaBannerRestartInit = el('btn-quota-banner-restart');
  if (btnQuotaBannerRestartInit) {
    btnQuotaBannerRestartInit.hidden = true;
    btnQuotaBannerRestartInit.addEventListener('click', () => {
      openClientRestartConfirmFlow();
    });
  }
  renderQuotaBoard();

  let quotaTickCounter = 0;
  let hasTriggeredInitialQuotaSync = false;
  function tick() {
    if (state.disposed || (globalThis.__AGContextMeterActiveHost && globalThis.__AGContextMeterActiveHost !== host)) {
      earlyForceDispose();
      return;
    }
    if (!host.isConnected) {
      ensureHostDocked();
    }
    const id = route();
    if (id !== state.route) {
      for (const controller of state.controllers) controller.abort(); state.controllers.clear(); state.generation++;
      if (timelineFetchController) {
        try { timelineFetchController.abort(); } catch { }
        timelineFetchController = null;
      }
      if (state.callRenderTimer) { clearTimeout(state.callRenderTimer); state.callRenderTimer = null; }
      if (state.callEnterAnimTimer) { clearTimeout(state.callEnterAnimTimer); state.callEnterAnimTimer = null; }
      clearLivePendingRequestWait();
      if (state.sessionCallsMap) state.sessionCallsMap.clear();
      if (state.expandedTurnKeys) state.expandedTurnKeys.clear();
      Object.assign(state, {
        route: id, count: 0, latest: null, sessionCalls: [], sessionCostTotal: 0,
        callsHydrated: false, requestAt: 0, requestError: '', requestBusy: false, requestNext: 0,
        scanBusy: false, scanNext: 0, scanError: '', scan: null,
        displayedCallRecord: null, displayedCallSig: '', pendingLatestCallRecord: null,
        pinnedCallRecord: null, latestCallDetailOpen: false, lastAnimatedCallSig: '',
        historyDrawerOpen: false, sessionTimeline: null, timelineLoading: false,
        timelineError: '', timelinePageLimit: 10, timelineAutoExpandedRoute: null, timelineRenderedRoute: null,
        lastTimelineFetchAt: 0, lastTimelineCallSig: '',
        speedBreakdownOpen: false, streamSampleTracker: null, lastSpeedEval: null, speedOverrideForTest: null
      });
      // Avoid colliding with the 15s periodic history refresh right after switching sessions; if already synced, reserve at least a 7s window for the current session to load first
      if (lastHistorySync > 0) {
        lastHistorySync = Math.max(lastHistorySync, Date.now() - 8000);
      }
      toggle(false); hideContextTooltip(); hideQuotaTooltip(); resetSpeedBarplotState(); renderFiles(null); render();
    }
    if (id && !state.requestBusy && Date.now() >= state.requestNext) void requestPoll(state.generation, id);
    if (id && !state.scanBusy && Date.now() >= state.scanNext) void scan(state.generation, id);
    if (!state.disposed && state.pendingFinalCalls?.size && !state.flushFinalsBusy && Date.now() >= (state.nextFlushRetryAt || 0)) {
      void flushPendingFinalCalls(false);
    }
    syncPendingAutomaticHistory();
    if (!hasTriggeredInitialQuotaSync) {
      hasTriggeredInitialQuotaSync = true;
      if (!quotaState.snapshot && !quotaState.busy && !quotaInFlightPromise) {
        void syncQuotaFromHost(false);
      }
    }
    if (Date.now() - lastHistorySync > 15000) {
      const isInitialSync = lastHistorySync === 0;
      lastHistorySync = Date.now();
      void syncTokenHistoryFromHost(false);
      if (!isInitialSync && activeContextTab === 'models' && !isContextSettingsView) {
        void fetchAvailableModelsIfNeeded();
      }
    }
    quotaTickCounter = (quotaTickCounter + 1) % 2;
    if (quotaTickCounter === 0 && el('panel-quota') && !el('panel-quota').hidden) {
      renderQuotaBoard(Date.now());
    }
  }

  const timer = setInterval(tick, 500);
  // Listen to SPA route changes; clear stale state and start new session collection in a microtask on switch to eliminate stale data between polls
  let routeHookScheduled = false;
  const scheduleImmediateRouteTick = () => {
    if (routeHookScheduled || state.disposed) return;
    routeHookScheduled = true;
    Promise.resolve().then(() => {
      routeHookScheduled = false;
      if (!state.disposed && route() !== state.route) tick();
    });
  };
  let origPushState = null;
  let origReplaceState = null;
  let wrappedPushState = null;
  let wrappedReplaceState = null;
  if (typeof globalThis.addEventListener === 'function') {
    globalThis.addEventListener('popstate', scheduleImmediateRouteTick);
  }
  if (typeof globalThis.history === 'object' && globalThis.history) {
    if (typeof globalThis.history.pushState === 'function') {
      origPushState = globalThis.history.pushState;
      wrappedPushState = function (...args) {
        const res = origPushState.apply(this, args);
        scheduleImmediateRouteTick();
        return res;
      };
      try { globalThis.history.pushState = wrappedPushState; } catch { wrappedPushState = null; }
    }
    if (typeof globalThis.history.replaceState === 'function') {
      origReplaceState = globalThis.history.replaceState;
      wrappedReplaceState = function (...args) {
        const res = origReplaceState.apply(this, args);
        scheduleImmediateRouteTick();
        return res;
      };
      try { globalThis.history.replaceState = wrappedReplaceState; } catch { wrappedReplaceState = null; }
    }
  }
  async function verifyHotReloadAndRefreshQuota() {
    if (state.disposed) return null;
    if (typeof window !== 'undefined' && typeof window.contextMeterAPI?.getRuntimeInfo === 'function') {
      try {
        const rt = await window.contextMeterAPI.getRuntimeInfo();
        if (rt && rt.ok && rt.backendVersion) {
          backendStatus.ipcBackendVersion = String(rt.backendVersion);
        }
      } catch { }
    }
    if (hasLiveHttpBridge() && shouldPreferLiveHost(typeof window?.contextMeterAPI?.getQuota === 'function', '/runtime-info')) {
      try {
        const liveRt = await postLiveHttpEndpoint('/runtime-info', {});
        if (liveRt && liveRt.ok) {
          syncObservedBackendMeta('live-host', liveRt);
        }
      } catch {
        backendStatus.liveHealthy = false;
      }
    }
    const snap = await syncQuotaFromHost(true);
    return {
      rendererVersion: METER_RENDERER_VERSION,
      backendSource: backendStatus.backendSource,
      backendVersion: backendStatus.backendVersion,
      backendPid: backendStatus.backendPid,
      ipcBackendVersion: backendStatus.ipcBackendVersion,
      liveHostVersion: backendStatus.liveHostVersion,
      hotReloadFallback: backendStatus.hotReloadFallback,
      backendVersionMismatch: backendStatus.backendVersionMismatch,
      pendingUpdateRestart,
      quotaAttempted: Boolean(quotaState.lastFetchedAtMs),
      quotaOk: Boolean(snap && !quotaState.error),
      quotaActiveStatus: computeEffectiveQuotaView(Date.now()).activeStatus,
      lastQuotaDurationMs: backendStatus.lastQuotaDurationMs
    };
  }

  function captureHotReloadState() {
    if (inheritedHotReloadState) return inheritedHotReloadState;
    const pCtx = el('panel');
    const pTokens = el('panel-tokens');
    const pQuota = el('panel-quota');
    const openPanel = (pQuota && !pQuota.hidden) ? 'quota'
      : ((pTokens && !pTokens.hidden) ? 'tokens'
        : ((pCtx && !pCtx.hidden) ? 'context' : 'none'));
    const scrollTops = {};
    for (const sId of ['panel', 'panel-tokens', 'panel-quota', 'ctx-model-list', 'quota-view-body']) {
      const n = el(sId);
      if (n && Number(n.scrollTop) > 0) scrollTops[sId] = Number(n.scrollTop);
    }
    const openDrawers = [];
    for (const btnId of [
      'btn-toggle-details', 'btn-toggle-card-details', 'btn-toggle-unlock-details',
      'btn-toggle-enhance-details', 'btn-toggle-proxy', 'btn-toggle-colors', 'btn-toggle-token-colors'
    ]) {
      if (el(btnId)?.getAttribute?.('aria-expanded') === 'true') {
        openDrawers.push(btnId);
      }
    }
    return {
      capturedAt: Date.now(),
      openPanel,
      activeContextTab,
      isContextSettingsView,
      browsePoolKey: quotaState.browsePoolKey || null,
      scrollTops,
      openDrawers,
      drafts: {
        proxyInputDirty: Boolean(proxyInputDirty),
        proxyUrl: inputProxyUrl ? inputProxyUrl.value : null,
        proxyBypass: inputProxyBypass ? inputProxyBypass.value : null,
        ctxDraftDirty: Boolean(ctxDraftDirty),
        ctxCustomValue: ctxCustomInput ? ctxCustomInput.value : null,
        enhanceTierDirty: Boolean(enhanceTierDirty),
        selectedEnhanceTier: selectedEnhanceTier ?? null,
        enhanceTitleDirty: Boolean(enhanceTitleDirty),
        enhanceTitleDraft: enhanceTitleDraft ?? null
      }
    };
  }

  function applyInheritedHotReloadState(saved) {
    if (!saved || typeof saved !== 'object' || state.disposed) return;
    const d = saved.drafts || {};
    if (d.proxyInputDirty) {
      if (inputProxyUrl && typeof d.proxyUrl === 'string') inputProxyUrl.value = d.proxyUrl;
      if (inputProxyBypass && typeof d.proxyBypass === 'string') inputProxyBypass.value = d.proxyBypass;
      proxyInputDirty = true;
      syncProxySaveButtonState();
    }
    if (d.ctxDraftDirty && ctxCustomInput && typeof d.ctxCustomValue === 'string') {
      ctxCustomInput.value = d.ctxCustomValue;
      ctxDraftDirty = true;
    }
    if (d.enhanceTierDirty && d.selectedEnhanceTier != null) {
      selectedEnhanceTier = d.selectedEnhanceTier;
      enhanceTierDirty = true;
    }
    if (d.enhanceTitleDirty && d.enhanceTitleDraft != null) {
      enhanceTitleDraft = d.enhanceTitleDraft;
      if (enhanceChineseTitleCheck && typeof d.enhanceTitleDraft === 'boolean') {
        enhanceChineseTitleCheck.checked = d.enhanceTitleDraft;
      }
      enhanceTitleDirty = true;
    }
    if (d.enhanceTierDirty || d.enhanceTitleDirty) {
      renderEnhanceSectionUI();
    }
    if (saved.browsePoolKey) {
      quotaState.browsePoolKey = saved.browsePoolKey;
    }
    if (saved.openPanel && saved.openPanel !== 'none') {
      showPanel(saved.openPanel);
      if (saved.openPanel === 'context' && saved.activeContextTab) {
        switchContextTab(saved.activeContextTab);
      } else if (saved.openPanel === 'context' && saved.isContextSettingsView) {
        switchContextTab('settings');
      }
    }
    if (Array.isArray(saved.openDrawers)) {
      for (const btnId of saved.openDrawers) {
        const btn = el(btnId);
        if (btn && btn.getAttribute?.('aria-expanded') !== 'true') {
          try { btn.click(); } catch { }
        }
      }
    }
    const scrollTops = saved.scrollTops || {};
    const restoreScrolls = () => {
      if (state.disposed) return;
      for (const [sId, topVal] of Object.entries(scrollTops)) {
        const node = el(sId);
        if (node && Number(topVal) > 0) node.scrollTop = Number(topVal);
      }
    };
    restoreScrolls();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(restoreScrolls);
    }
    setTimeout(restoreScrolls, 40);
    setTimeout(restoreScrolls, 140);
  }

  /* @INSERT_INSPECTOR_MODULE */

  globalThis.__AGContextMeter = {
    version: METER_RENDERER_VERSION,
    ensureAlive: () => {
      if (state.disposed) return false;
      ensureHostDocked();
      render();
      return true;
    },
    theme: () => resolveTheme(),
    setTheme: mode => { currentThemeMode = mode; try { localStorage.setItem('ag_theme_mode', mode); } catch { }; applyTheme(); },
    getCustomColors: () => ({ ...customColors }),
    setCustomColor,
    resetCustomColors,
    resetHeatmapLevels,
    getHeatPreset: () => heatPreset,
    setHeatPreset,
    getHeatPalette: () => getEffectiveHeatmapScale(),
    getActivePickerSlot: () => activePickerSlot,
    openColorPicker,
    closeColorPicker,
    applyTokenHistoryPayload,
    applyPickerHex,
    setTokenHistoryForTest: payload => applyTokenHistoryPayload(payload),
    getPlanDetailExpanded: () => planDetailExpanded,
    setPlanDetailExpanded,
    switchTokenView,
    switchHeatView: view => switchHeatView(view),
    getActiveHeatView: () => activeHeatView,
    renderHeatmapMonthly: () => renderHeatmapMonthly(),
    renderHeatmapYearly: () => renderHeatmapYearly(),
    checkUpdate: manual => checkAppUpdate(manual),
    applyUpdate: () => applyAppUpdate(),
    getLatestRelease: () => cachedLatestRelease,
    openGithubRepo: path => openGithubRepo(path),
    updateHeatTabThumb: () => updateHeatTabThumb(),
    getPlanSettings: () => ({
      country: ANTIGRAVITY_TOKEN_DATA.planStatus?.country || '未知',
      subscriptionRegion: ANTIGRAVITY_TOKEN_DATA.planStatus?.subscriptionRegion || ANTIGRAVITY_TOKEN_DATA.planStatus?.region || '未知',
      region: ANTIGRAVITY_TOKEN_DATA.planStatus?.region || '未知',
      currency: ANTIGRAVITY_TOKEN_DATA.planStatus?.currency || 'USD',
      currencySymbol: ANTIGRAVITY_TOKEN_DATA.planStatus?.currencySymbol || '$',
      actualPricePaid: ANTIGRAVITY_TOKEN_DATA.planStatus?.actualPricePaid ?? null,
      lastSaveResult
    }),
    setCountry: val => applyDirectCountrySelection(val),
    setCurrency: val => applyDirectCurrencySelection(val),
    restoreSettingsFromHost,
    syncTokenHistoryFromHost,
    launchCli: opts => triggerLaunchCli(opts),
    getLastCliLaunchResult: () => lastCliLaunchResult,
    getTimelineWindow: () => {
      const w = computeTimelineWindow();
      return {
        firstUseDate: w.firstStr,
        winStart: formatLocalYmd(w.winStart),
        winEnd: formatLocalYmd(w.winEnd),
        totalDays: w.totalDays,
        canPrev: w.canPrev,
        canNext: w.canNext
      };
    },
    repositionPanelsForTest: () => positionFloatingPanels(),
    getLayoutMode: () => state.layoutMode,
    setAvailableWidthForTest: width => {
      const next = computeNextLayoutMode(width, state.layoutMode);
      applyLayoutMode(next);
      return state.layoutMode;
    },
    findTopRightClusterForTest: () => findTopRightCluster(),
    syncWindowControlsOverlayForTest: () => syncWindowControlsOverlay(),
    computeWindowControlsWidthForTest: el => computeWindowControlsWidth(el),
    getContextPreferencesState: () => ({
      activeSessionModelKey,
      activeSessionProductKey,
      selectedEditModelKey,
      selectedProductKey,
      activeContextTab,
      isContextSettingsView,
      draft: { ...ctxDraft },
      contextPreferences: { ...contextPreferencesMap },
      unlockStatus: currentUnlockStatus ? { ...currentUnlockStatus } : null,
      pendingRestartVerification: pendingRestartVerification ? { ...pendingRestartVerification } : null,
      needsRestartAfterApply
    }),
    setContextLatestForTest: (latestObj, configs = [], capabilitiesById = null) => {
      if (capabilitiesById && typeof capabilitiesById === 'object') mergeCapabilitiesMapClient(capabilitiesById);
      if (Array.isArray(configs) && configs.length) state.cascadeModelConfigs = configs;
      state.latest = latestObj;
      if (latestObj && (state.route || state.activeConversationId)) {
        recordObservationFromSummary(latestObj, state.route || state.activeConversationId, { ts: latestObj.ts || Date.now() });
      }
      manualModelSelection = false;
      render();
      return { activeSessionModelKey, activeSessionProductKey, selectedEditModelKey, selectedProductKey, draft: { ...ctxDraft } };
    },
    setModelCapabilitiesForTest: (capabilitiesById) => {
      mergeCapabilitiesMapClient(capabilitiesById);
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    getBudgetTrackerTracesForTest: () => (budgetTracker && typeof budgetTracker.exportDiagnosticTraces === 'function')
      ? budgetTracker.exportDiagnosticTraces()
      : [],
    switchContextTabForTest: (tab) => switchContextTab(tab),
    openContextSettingsForTest: (opts) => openContextSettings(opts),
    setSpeedRecordsForTest: (records, calls = []) => {
      ANTIGRAVITY_TOKEN_DATA.speedRecords = Array.isArray(records) ? records : [];
      if (Array.isArray(calls)) state.sessionCalls = calls;
      if (!isContextSettingsView && activeContextTab === 'speed') renderSpeedComparisonTab();
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    setRestartVerificationForTest: (ver, preSnapshot = null) => {
      pendingRestartVerification = ver ? { ...ver } : null;
      if (preSnapshot) preRestartSnapshot = preSnapshot;
      if (!isContextSettingsView && activeContextTab === 'models') renderModelSettingsTab();
    },
    getKnownModelProductsForTest: () => getKnownModelProducts(),
    refreshUnlockStatusForTest: () => refreshUnlockStatus(),
    refreshEnhanceStatusForTest: () => refreshEnhanceStatus(),
    getEnhanceStateForTest: () => ({
      currentBrandTitle,
      selectedEnhanceTier,
      enhanceTitleDraft,
      enhanceTierDirty,
      enhanceTitleDirty,
      proxyInputDirty,
      currentProxyEnabled,
      hasPendingLsReload,
      currentEnhanceStatus: currentEnhanceStatus ? { ...currentEnhanceStatus } : null
    }),
    getUnlockUiStateForTest: () => ({
      hostSupportsRestart,
      needsRestartAfterApply,
      resultBoxDisplay: unlockResultBox?.style?.display || '',
      resultRestartHidden: btnUnlockResultRestart ? btnUnlockResultRestart.hidden : null,
      resultRetryHidden: btnUnlockResultRetry ? btnUnlockResultRetry.hidden : null,
      resultManualHidden: unlockResultManual ? unlockResultManual.hidden : null,
      headerRestartHidden: btnRestartHost ? btnRestartHost.hidden : null
    }),
    getContextScopeModeForTest: () => getContextScopeMode(),
    setContextScopeModeForTest: mode => setScopeMode(mode),
    getContextUnifiedPreferenceForTest: () => getContextUnifiedPreference(),
    getPanelLanguage: () => getPanelLanguage(),
    setPanelLanguage: (lang, opts) => applyPanelLanguage(lang, opts),
    restoreSettingsForTest: () => restoreSettingsFromHost(),
    translateForTest: (key, vars) => t(key, vars),
    applyStaticTranslationsForTest: (rootNode) => applyStaticPanelTranslations(rootNode),
    getModelQuotaStateForTest: (nowMs) => ({
      state: {
        accountScopeKey: quotaState.accountScopeKey,
        collectorVersion: quotaState.collectorVersion,
        browsePoolKey: quotaState.browsePoolKey,
        busy: quotaState.busy,
        lastFetchedAtMs: quotaState.lastFetchedAtMs,
        lastSuccessAtMs: quotaState.lastSuccessAtMs,
        nextRefreshAtMs: quotaState.nextRefreshAtMs,
        error: quotaState.error,
        errorKind: quotaState.errorKind,
        activeSessionModelKey
      },
      view: computeEffectiveQuotaView(Number.isFinite(nowMs) ? nowMs : Date.now())
    }),
    setPendingUpdateRestartForTest: (val) => {
      pendingUpdateRestart = Boolean(val);
      renderQuotaBoard(Date.now(), { animate: false });
    },
    setQuotaSnapshotForTest: (payload, nowMs) => {
      const tNow = Number.isFinite(nowMs) ? nowMs : Date.now();
      if (!payload) {
        resetQuotaState({ clearAccountScope: true });
        return computeEffectiveQuotaView(tNow);
      }
      const prevSig = computeQuotaVisualSignature(computeEffectiveQuotaView(tNow));
      if (payload.accountSwitched || (payload.accountScopeKey && quotaState.accountScopeKey && payload.accountScopeKey !== quotaState.accountScopeKey)) {
        resetQuotaState({ clearAccountScope: true });
      }
      if (payload.accountScopeKey) quotaState.accountScopeKey = payload.accountScopeKey;
      quotaState.error = payload.error || null;
      quotaState.errorKind = payload.errorKind || (payload.error ? 'network' : null);
      if (payload.fetchedAtMs !== undefined) quotaState.lastFetchedAtMs = payload.fetchedAtMs;
      if (payload.lastSuccessAtMs !== undefined) quotaState.lastSuccessAtMs = payload.lastSuccessAtMs;
      if (payload.nextRefreshAtMs !== undefined) quotaState.nextRefreshAtMs = payload.nextRefreshAtMs;
      if (payload.userStatusRes || payload.quotaSummaryRes || payload.cascadeModelConfigs) {
        const fallbackCfgs = (Array.isArray(state.cascadeModelConfigs) && state.cascadeModelConfigs.length > 0)
          ? state.cascadeModelConfigs
          : null;
        quotaState.rawInput = {
          userStatusRes: payload.userStatusRes || null,
          quotaSummaryRes: payload.quotaSummaryRes || null,
          cascadeModelConfigs: (Array.isArray(payload.cascadeModelConfigs) && payload.cascadeModelConfigs.length > 0)
            ? payload.cascadeModelConfigs
            : fallbackCfgs,
          planStatus: payload.planStatus || ANTIGRAVITY_TOKEN_DATA.planStatus || null
        };
        quotaState.snapshot = null;
        if (!payload.error && payload.lastSuccessAtMs === undefined) quotaState.lastSuccessAtMs = tNow;
      } else if (payload.snapshot !== undefined) {
        quotaState.snapshot = payload.snapshot;
        quotaState.rawInput = null;
        if (!payload.error && payload.lastSuccessAtMs === undefined && payload.snapshot?.fetchedAtMs) {
          quotaState.lastSuccessAtMs = payload.snapshot.fetchedAtMs;
        }
      }
      const nextSig = computeQuotaVisualSignature(computeEffectiveQuotaView(tNow));
      const shouldAnimate = Boolean(prevSig !== 'empty' && nextSig !== prevSig && !quotaState.error);
      renderQuotaBoard(tNow, { animate: shouldAnimate });
      return computeEffectiveQuotaView(tNow);
    },
    refreshQuotaForTest: (force = false, meta = {}) => syncQuotaFromHost(Boolean(force), meta),
    selectQuotaPoolBrowseForTest: (poolKey) => {
      quotaState.browsePoolKey = poolKey || null;
      renderQuotaBoard();
      return { browsePoolKey: quotaState.browsePoolKey, activeSessionModelKey };
    },
    showQuotaPanelForTest: (open = true) => {
      showPanel(open ? 'quota' : 'none');
      return !el('panel-quota')?.hidden;
    },
    snapshot: () => ({ route: state.route, count: state.count, latest: state.latest, scan: state.scan, requestError: state.requestError, scanError: state.scanError, scanBusy: state.scanBusy, layoutMode: state.layoutMode, sessionCalls: state.sessionCalls, sessionCostTotal: state.sessionCostTotal }),
    captureHotReloadState,
    verifyHotReloadAndRefreshQuota,
    getBackendStatusForTest: () => ({
      ...backendStatus,
      collectorVersion: quotaState.collectorVersion,
      pendingUpdateRestart,
      hasLiveHttpBridge: hasLiveHttpBridge(),
      shouldPreferLiveHost: shouldPreferLiveHost(typeof window?.contextMeterAPI?.getQuota === 'function', '/quota')
    }),
    getRuntimeVersionReport: () => ({
      rendererVersion: METER_RENDERER_VERSION,
      backendSource: backendStatus.backendSource,
      backendVersion: backendStatus.backendVersion,
      backendPid: backendStatus.backendPid,
      ipcBackendVersion: backendStatus.ipcBackendVersion,
      liveHostVersion: backendStatus.liveHostVersion,
      hotReloadFallback: backendStatus.hotReloadFallback,
      backendVersionMismatch: backendStatus.backendVersionMismatch,
      lastQuotaDurationMs: backendStatus.lastQuotaDurationMs
    }),
    getLatestCallCardStateForTest: () => ({
      route: state.route,
      displayedCall: state.displayedCallRecord,
      pendingLatestCall: state.pendingLatestCallRecord,
      pinnedCall: state.pinnedCallRecord,
      detailOpen: state.latestCallDetailOpen,
      historyOpen: state.historyDrawerOpen,
      bannerVisible: Boolean(el('latest-call-new-banner') && !el('latest-call-new-banner').hidden),
      isEntering: Boolean(el('latest-call-body')?.classList?.contains?.('is-entering'))
    }),
    setSessionCallsForTest: (calls, opts = {}) => {
      if (opts.route && state.route !== opts.route) {
        state.route = opts.route;
        state.displayedCallRecord = null;
        state.displayedCallSig = '';
        state.pendingLatestCallRecord = null;
        state.pinnedCallRecord = null;
        state.latestCallDetailOpen = false;
        state.lastAnimatedCallSig = '';
      }
      if (!state.sessionCallsMap) state.sessionCallsMap = new Map();
      if (opts.replace) state.sessionCallsMap.clear();
      for (const c of (Array.isArray(calls) ? calls : [])) {
        if (c && c.callId) state.sessionCallsMap.set(c.callId, c);
      }
      state.sessionCalls = Array.from(state.sessionCallsMap.values());
      render();
      return {
        displayedCall: state.displayedCallRecord,
        pendingLatestCall: state.pendingLatestCallRecord,
        bannerVisible: Boolean(el('latest-call-new-banner') && !el('latest-call-new-banner').hidden)
      };
    },
    setSessionTimelineForTest: (tl) => {
      state.sessionTimeline = tl;
      if (state.historyDrawerOpen) renderSessionTimeline();
    },
    toggleSessionHistoryForTest: (open) => {
      state.historyDrawerOpen = open !== undefined ? Boolean(open) : !state.historyDrawerOpen;
      renderSessionTimeline();
      return state.historyDrawerOpen;
    },
    setSpeedEvaluationForTest: (mockInput, opts = {}) => {
      state.speedOverrideForTest = mockInput || null;
      if (opts.openBreakdown !== undefined) state.speedBreakdownOpen = Boolean(opts.openBreakdown);
      if (typeof evaluateGenerationExperience === 'function') {
        const res = evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage);
        renderSpeedExperienceInPlace(res);
        return res;
      }
      return null;
    },
    getSpeedPanelStateForTest: () => ({
      badgeText: el('speed-badge')?.textContent || '',
      badgeColor: el('speed-badge')?.style?.color || '',
      boltColor: el('badge-speed-icon')?.style?.color || '',
      summaryBoltColor: el('speed-summary-bolt')?.style?.color || '',
      speedVal: el('speed-val')?.textContent || '',
      durationVal: el('speed-duration')?.textContent || '',
      ttftVal: el('speed-ttft')?.textContent || '',
      tokensVal: el('speed-tokens')?.textContent || '',
      subLabel: el('speed-sub-label')?.textContent || '',
      takeaway: el('speed-takeaway')?.textContent || '',
      breakdownOpen: state.speedBreakdownOpen,
      lastEval: state.lastSpeedEval
    }),
    getTokenCacheBreakdownForTest: () => ({
      input: el('tcb-input-val')?.textContent || '',
      cacheRead: el('tcb-cache-val')?.textContent || '',
      totalInput: el('tcb-total-input-val')?.textContent || '',
      output: el('tcb-output-val')?.textContent || '',
      ratio: el('tcb-ratio-val')?.textContent || '',
      ratioBarWidth: el('tcb-ratio-bar-fill')?.style?.width || '',
      note: el('tcb-note')?.textContent || ''
    }),
    getModelUsageScaleForTest: () => ({
      scaleMode: modelUsageScaleMode,
      lockedKey: modelUsageLockedKey,
      setScaleMode: (m) => { modelUsageScaleMode = m === 'linear' ? 'linear' : 'mixed'; renderModelUsageView(); },
      setLockedKey: (k) => { modelUsageLockedKey = k || null; renderModelUsageView(); }
    }),
    getCumulativeViewStateForTest: () => ({
      summary: _lastCumSummary,
      lockedKey: cumLockedKey,
      expandedWeekKey: cumExpandedWeekKey,
      linkedDailyDate: cumLinkedDailyDate,
      pressEscape: () => escape({ key: 'Escape' })
    }),
    setTokenAccountFilterForTest: (scopeKey) => {
      activeTokenAccountFilter = scopeKey || 'all';
      resetAccountScopedViewOffsets();
      if (ANTIGRAVITY_TOKEN_DATA.rawPayload) applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
      return activeTokenAccountFilter;
    },
    getRemoveAccountModalStateForTest: () => ({ ...(accountsUiState.removeModal || {}) }),
    openRemoveAccountModalForTest: (acc) => openRemoveAccountModal(acc),
    confirmRemoveAccountModalForTest: () => confirmRemoveAccountModal(),
    closeRemoveAccountModalForTest: () => closeRemoveAccountModal(),
    setAccountsOverviewForTest: (overview) => {
      accountsUiState.overview = overview || null;
      renderAccountsOverviewSection();
      return accountsUiState.overview;
    },
    getAccountsPanelStateForTest: () => ({
      activeFilter: activeTokenAccountFilter,
      filterOptions: Array.from(el('token-account-select')?.children || []).map(o => ({ val: o.value, label: o.textContent })),
      scopeNote: el('token-account-scope-note')?.textContent || '',
      feedback: accountsUiState.feedback || '',
      feedbackTone: accountsUiState.feedbackTone || 'info',
      accountCount: el('quota-accounts-list')?.children?.length || 0,
      compareCount: el('quota-compare-list')?.children?.length || 0,
      autoSwitchStatus: el('auto-switch-status-pill')?.textContent || '',
      keepaliveStatus: el('keepalive-status-pill')?.textContent || ''
    }),
    openInspectorForTest: (opts) => openInspector(opts),
    toggleUnifiedInspectorForTest: (opts) => toggleUnifiedInspector(opts),
    closeInspectorForTest: (opts) => closeInspector(opts),
    setInspectorDeepDiveForTest: (dd, tab = 'live', sub = null) => {
      inspectorState.deepDive = dd || null;
      inspectorState.loading = false;
      inspectorState.error = '';
      inspectorState.open = true;

      if (el('panel-inspector')) {
        el('panel-inspector').hidden = false;
        el('panel-inspector').classList?.add?.('is-open');
      }
      switchInspectorTab(tab, sub);
      return inspectorState;
    },
    setInspectorInsightsForTest: (ins) => {
      inspectorState.insights = ins || null;
      inspectorState.insightsLoading = false;
      inspectorState.insightsError = '';
      inspectorState.open = true;
      if (el('panel-inspector')) {
        el('panel-inspector').hidden = false;
        el('panel-inspector').classList?.add?.('is-open');
      }
      switchInspectorTab('history', 'sessions');
      return inspectorState;
    },
    getInspectorStateForTest: () => ({
      open: Boolean(inspectorState.open),
      tab: inspectorState.tab,
      liveSub: inspectorState.liveSub,
      historySub: inspectorState.historySub,
      gearOpen: Boolean(inspectorState.gearOpen),
      targetCascadeId: inspectorState.targetCascadeId,
      hasDeepDive: Boolean(inspectorState.deepDive),
      hasInsights: Boolean(inspectorState.insights),
      bodyHtmlLen: el('insp-body')?.innerHTML?.length || 0
    }),
    isDisposedForTest: () => Boolean(state.disposed),
    dispose() {
      earlyForceDispose();
      closeInspector?.({ instant: true });
      clearQuotaTimers();
      stopSpeedBarplotTicker();
      clearInterval(timer);
      clearLivePendingRequestWait();
      if (timelineFetchController) {
        try { timelineFetchController.abort(); } catch { }
        timelineFetchController = null;
      }
      if (state.callRenderTimer) { clearTimeout(state.callRenderTimer); state.callRenderTimer = null; }
      if (state.callEnterAnimTimer) { clearTimeout(state.callEnterAnimTimer); state.callEnterAnimTimer = null; }
      try { globalThis.removeEventListener?.('popstate', scheduleImmediateRouteTick); } catch { }
      try {
        if (wrappedPushState && globalThis.history?.pushState === wrappedPushState && origPushState) {
          globalThis.history.pushState = origPushState;
        }
        if (wrappedReplaceState && globalThis.history?.replaceState === wrappedReplaceState && origReplaceState) {
          globalThis.history.replaceState = origReplaceState;
        }
      } catch { }
      syncHostStackingElevation(false);
      try { uninstallRequestInterceptor(); } catch { }
      try { themeObserver?.disconnect(); } catch { }
      try {
        window.removeEventListener?.('mousemove', onPointerMove);
        window.removeEventListener?.('mouseup', onPointerUp);
      } catch { }
      document.removeEventListener('click', outside);
      document.removeEventListener('keydown', escape);
      try { document.getElementById('ag-wco-spacer')?.remove?.(); } catch { }
      try { document.getElementById('ag-topbar-host-fix')?.remove?.(); } catch { }
      host.remove();
    }
  };
  syncPanelLanguageButtons(currentPanelLanguage);
  applyStaticPanelTranslations(shadow);
  refreshRegionPresetSelectOptions();
  renderEnhanceSectionUI();
  if (inheritedHotReloadState) {
    applyInheritedHotReloadState(inheritedHotReloadState);
  }
  startupRestorePromise = restoreSettingsFromHost().finally(() => {
    startupRestorePromise = null;
    if (inheritedHotReloadState) {
      applyInheritedHotReloadState(inheritedHotReloadState);
      inheritedHotReloadState = null;
    }
  });
  installRequestInterceptor();
  __chartsReady = true;
  render();
  tick();
})();

