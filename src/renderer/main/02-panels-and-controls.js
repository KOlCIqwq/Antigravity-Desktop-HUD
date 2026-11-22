  // =========================================================================
  // 模块 3: 面板、气泡与溢出菜单交互
  // =========================================================================
  function withStepError(value, metadata) {
    const error = state.scan?.session?.currentError;
    if (!error || value?.error) return value;
    const lastStep = Math.max(-1, ...(metadata?.stepIndices || []), metadata?.chatModel?.chatStartMetadata?.startStepIndex ?? -1);
    if (lastStep > error.index) return value;
    const failure = summarize({ chatModel: { retryInfos: [{ error: error.text }] } }, {
      currentModel: value?.model || state.latest?.model || '',
      cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [],
      previousValidContext: value
    });
    return {
      ...(value || {}),
      error: failure.error,
      errorClassification: failure.errorClassification,
      exceeded: failure.exceeded,
      network: failure.network,
      serviceLimit: failure.serviceLimit || value?.serviceLimit || null,
      status: failure.status,
      // 解耦：保留已有有效上下文数据，不归零、不清空
      used: value?.used ?? failure?.used ?? null,
      actual: failure.exceeded ? null : (value?.actual ?? null),
      estimate: value?.estimate ?? failure?.estimate ?? null,
      budget: value?.budget ?? failure?.budget ?? null,
      percent: failure.exceeded ? 100 : (value?.percent ?? null),
      estimated: value?.actual == null
    };
  }

  function isAnyPanelOpen() {
    return !el('panel').hidden || !el('panel-tokens').hidden || !el('panel-quota')?.hidden || !el('panel-inspector')?.hidden;
  }

  function showPanel(target) {
    const pContext = el('panel');
    const pTokens = el('panel-tokens');
    const pQuota = el('panel-quota');
    const pOverflow = el('overflow-menu');
    const bContext = el('badge');
    const bSpeed = el('badge-speed');
    const bTokens = el('badge-tokens');
    const bQuota = el('badge-quota');
    const bOverflow = el('badge-overflow');

    hideUpdatePopover();
    if (pOverflow) pOverflow.hidden = true;
    bOverflow?.setAttribute('aria-expanded', 'false');
    if (target !== 'quota' && typeof clearQuotaBarChargeAnimations === 'function') {
      clearQuotaBarChargeAnimations();
    }

    if (target === 'tokens') {
      hideContextTooltip();
      hideQuotaTooltip();
      closeColorPicker();
      pContext.hidden = true;
      if (pQuota) pQuota.hidden = true;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bQuota?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'true');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      pTokens.hidden = false;
      renderActiveHeatView(true);
      const hasCachedHistory = Boolean(ANTIGRAVITY_TOKEN_DATA.updatedAt || ANTIGRAVITY_TOKEN_DATA.summary?.grandTotalTokens);
      if (!hasCachedHistory || !lastHistorySync || (Date.now() - lastHistorySync) > 15000) {
        void syncTokenHistoryFromHost(false);
      }
      if (!accountsUiState?.overview && typeof refreshAccountsOverview === 'function') {
        void refreshAccountsOverview({ silent: true });
      } else {
        syncTokenAccountFilterOptions?.(ANTIGRAVITY_TOKEN_DATA.rawPayload);
      }
    } else if (target === 'quota') {
      hideContextTooltip();
      hideQuotaTooltip();
      closeColorPicker();
      setPlanDetailExpanded(false, { skipReposition: true });
      pContext.hidden = true;
      pTokens.hidden = true;
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'false');
      bQuota?.setAttribute('aria-expanded', 'true');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      if (pQuota) pQuota.hidden = false;
      if (typeof renderQuotaBoard === 'function') renderQuotaBoard();
      if (typeof maybeRefreshQuotaOnOpen === 'function') void maybeRefreshQuotaOnOpen();
      if (typeof renderAccountsOverviewSection === 'function') renderAccountsOverviewSection();
      if (typeof refreshAccountsOverview === 'function') void refreshAccountsOverview({ silent: true });
    } else if (target === 'context') {
      hideContextTooltip();
      hideQuotaTooltip();
      closeColorPicker();
      setPlanDetailExpanded(false, { skipReposition: true });
      pTokens.hidden = true;
      if (pQuota) pQuota.hidden = true;
      bContext.setAttribute('aria-expanded', String(activeContextAnchorId === 'badge'));
      bSpeed?.setAttribute('aria-expanded', String(activeContextAnchorId === 'badge-speed'));
      bTokens.setAttribute('aria-expanded', 'false');
      bQuota?.setAttribute('aria-expanded', 'false');
      syncHostStackingElevation(true);
      positionFloatingPanels();
      pContext.hidden = false;
      applyContextViewVisibility?.();
      if (activeContextTab === 'models' && !isContextSettingsView) {
        if (typeof syncModelListQuotaIndicators === 'function') syncModelListQuotaIndicators(null, Date.now(), true);
        void refreshUnlockStatus();
      } else if (activeContextTab === 'speed' && !isContextSettingsView) {
        renderSpeedComparisonTab?.();
      }
      if (isContextSettingsView) {
        void refreshModulesDisplay();
      }
    } else {
      setPlanDetailExpanded(false, { skipReposition: true });
      pContext.hidden = true;
      pTokens.hidden = true;
      if (pQuota) pQuota.hidden = true;
      if (el('panel-inspector') && !el('panel-inspector').hidden && typeof closeInspector === 'function') {
        closeInspector();
      }
      bContext.setAttribute('aria-expanded', 'false');
      bSpeed?.setAttribute('aria-expanded', 'false');
      bTokens.setAttribute('aria-expanded', 'false');
      bQuota?.setAttribute('aria-expanded', 'false');
      closeColorPicker();
      hidePopover();
      syncHostStackingElevation(false);
    }
  }

  let activeContextAnchorId = 'badge';
  let activeTokensAnchorId = 'badge-tokens';
  let activeQuotaAnchorId = 'badge-quota';

  function toggle(open, tab = 'context') {
    if (!open) {
      showPanel('none');
    } else {
      showPanel(tab === 'tokens' ? 'tokens' : (tab === 'quota' ? 'quota' : 'context'));
    }
  }

  function toggleContext(anchorId = 'badge') {
    if (!el('panel').hidden && activeContextAnchorId === anchorId) {
      showPanel('none');
    } else {
      activeContextAnchorId = anchorId || 'badge';
      showPanel('context');
    }
  }

  function toggleTokens(anchorId = 'badge-tokens') {
    if (!el('panel-tokens').hidden && activeTokensAnchorId === anchorId) {
      showPanel('none');
    } else {
      activeTokensAnchorId = anchorId || 'badge-tokens';
      showPanel('tokens');
    }
  }

  function toggleQuota(anchorId = 'badge-quota') {
    if (el('panel-quota') && !el('panel-quota').hidden && activeQuotaAnchorId === anchorId) {
      showPanel('none');
    } else {
      activeQuotaAnchorId = anchorId || 'badge-quota';
      showPanel('quota');
    }
  }

  function toggleOverflowMenu() {
    const pOverflow = el('overflow-menu');
    if (!pOverflow) return;
    const willOpen = pOverflow.hidden;
    showPanel('none');
    hideContextTooltip();
    hideQuotaTooltip();
    if (willOpen) positionFloatingPanels();
    pOverflow.hidden = !willOpen;
    el('badge-overflow')?.setAttribute('aria-expanded', String(willOpen));
    syncHostStackingElevation(willOpen);
  }

  // 外观调色按钮进入设置视图并直接展开颜色自定义抽屉
  el('btn-panel-palette')?.addEventListener('click', () => {
    openContextSettings?.({ openColors: true });
  });
  el('btn-panel-tokens-palette')?.addEventListener('click', () => toggleTokenColorsDrawer());

  // =========================================================================
  // 统一定制下拉组件控制器 (国家 / 订阅地区 / 币种 / 增强 Select)
  // =========================================================================
  const COUNTRY_OPTIONS = [
    { value: '未知', label: '🌐 未设置 / 自动', labelTw: '🌐 未設定 / 自動', labelEn: '🌐 Auto / Unset', code: 'AUTO', aliases: ['自动', '未知', 'none', 'auto'] },
    { value: '美国 (US)', label: '🇺🇸 美国 (US)', labelTw: '🇺🇸 美國 (US)', labelEn: '🇺🇸 United States (US)', code: 'US', aliases: ['美国', 'united states', 'usa'] },
    { value: '日本 (JP)', label: '🇯🇵 日本 (JP)', labelTw: '🇯🇵 日本 (JP)', labelEn: '🇯🇵 Japan (JP)', code: 'JP', aliases: ['日本', 'japan'] },
    { value: '韩国 (KR)', label: '🇰🇷 韩国 (KR)', labelTw: '🇰🇷 韓國 (KR)', labelEn: '🇰🇷 South Korea (KR)', code: 'KR', aliases: ['韩国', 'korea', 'south korea'] },
    { value: '中国台湾 (TW)', label: '🇹🇼 中国台湾 (TW)', labelTw: '🇹🇼 中國台灣 (TW)', labelEn: '🇹🇼 Taiwan (TW)', code: 'TW', aliases: ['台湾', 'taiwan', 'tw'] },
    { value: '中国香港 (HK)', label: '🇭🇰 中国香港 (HK)', labelTw: '🇭🇰 中國香港 (HK)', labelEn: '🇭🇰 Hong Kong (HK)', code: 'HK', aliases: ['香港', 'hong kong', 'hk'] },
    { value: '澳大利亚 (AU)', label: '🇦🇺 澳大利亚 (AU)', labelTw: '🇦🇺 澳洲 (AU)', labelEn: '🇦🇺 Australia (AU)', code: 'AU', aliases: ['澳大利亚', '澳洲', 'australia', 'au'] },
    { value: '新加坡 (SG)', label: '🇸🇬 新加坡 (SG)', labelTw: '🇸🇬 新加坡 (SG)', labelEn: '🇸🇬 Singapore (SG)', code: 'SG', aliases: ['新加坡', 'singapore', 'sg'] },
    { value: '英国 (UK)', label: '🇬🇧 英国 (UK)', labelTw: '🇬🇧 英國 (UK)', labelEn: '🇬🇧 United Kingdom (UK)', code: 'UK', aliases: ['英国', 'united kingdom', 'uk', 'gb', 'britain'] },
    { value: '德国 (DE)', label: '🇩🇪 德国 (DE)', labelTw: '🇩🇪 德國 (DE)', labelEn: '🇩🇪 Germany (DE)', code: 'DE', aliases: ['德国', 'germany', 'de'] },
    { value: '加拿大 (CA)', label: '🇨🇦 加拿大 (CA)', labelTw: '🇨🇦 加拿大 (CA)', labelEn: '🇨🇦 Canada (CA)', code: 'CA', aliases: ['加拿大', 'canada', 'ca'] },
    { value: '土耳其 (TR)', label: '🇹🇷 土耳其 (TR)', labelTw: '🇹🇷 土耳其 (TR)', labelEn: '🇹🇷 Turkey (TR)', code: 'TR', aliases: ['土耳其', 'turkey', 'tr'] },
    { value: '尼日利亚 (NG)', label: '🇳🇬 尼日利亚 (NG)', labelTw: '🇳🇬 奈及利亞 (NG)', labelEn: '🇳🇬 Nigeria (NG)', code: 'NG', aliases: ['尼日利亚', 'nigeria', 'ng'] },
    { value: '菲律宾 (PH)', label: '🇵🇭 菲律宾 (PH)', labelTw: '🇵🇭 菲律賓 (PH)', labelEn: '🇵🇭 Philippines (PH)', code: 'PH', aliases: ['菲律宾', 'philippines', 'ph'] },
    { value: '印度 (IN)', label: '🇮🇳 印度 (IN)', labelTw: '🇮🇳 印度 (IN)', labelEn: '🇮🇳 India (IN)', code: 'IN', aliases: ['印度', 'india', 'in'] },
    { value: '马来西亚 (MY)', label: '🇲🇾 马来西亚 (MY)', labelTw: '🇲🇾 馬來西亞 (MY)', labelEn: '🇲🇾 Malaysia (MY)', code: 'MY', aliases: ['马来西亚', 'malaysia', 'my'] },
    { value: '巴西 (BR)', label: '🇧🇷 巴西 (BR)', labelTw: '🇧🇷 巴西 (BR)', labelEn: '🇧🇷 Brazil (BR)', code: 'BR', aliases: ['巴西', 'brazil', 'br'] },
    { value: '中国大陆 (CN)', label: '🇨🇳 中国大陆 (CN)', labelTw: '🇨🇳 中國大陸 (CN)', labelEn: '🇨🇳 China Mainland (CN)', code: 'CN', aliases: ['中国大陆', '中国', 'china', 'cn'] }
  ];

  const CURRENCY_OPTIONS = [
    { value: 'USD', code: 'USD', symbol: '$', name: '美元', nameEn: 'US Dollar', label: 'USD ($ 美元)', labelTw: 'USD ($ 美元)', labelEn: 'USD ($ US Dollar)', aliases: ['美元', 'usd', '$', 'dollar'] },
    { value: 'KRW', code: 'KRW', symbol: '₩', name: '韩元', nameEn: 'Korean Won', label: 'KRW (₩ 韩元)', labelTw: 'KRW (₩ 韓元)', labelEn: 'KRW (₩ Won)', aliases: ['韩元', 'krw', '₩', 'won'] },
    { value: 'AUD', code: 'AUD', symbol: 'AU$', name: '澳元', nameEn: 'Australian Dollar', label: 'AUD (AU$ 澳元)', labelTw: 'AUD (AU$ 澳元)', labelEn: 'AUD (AU$ AUD)', aliases: ['澳元', '澳洲', 'aud', 'au$', 'australian'] },
    { value: 'JPY', code: 'JPY', symbol: '¥', name: '日元', nameEn: 'Japanese Yen', label: 'JPY (¥ 日元)', labelTw: 'JPY (¥ 日圓)', labelEn: 'JPY (¥ Yen)', aliases: ['日元', '日本', 'jpy', '¥', 'yen'] },
    { value: 'HKD', code: 'HKD', symbol: 'HK$', name: '港币', nameEn: 'Hong Kong Dollar', label: 'HKD (HK$ 港币)', labelTw: 'HKD (HK$ 港幣)', labelEn: 'HKD (HK$ HKD)', aliases: ['港币', '香港', 'hkd', 'hk$'] },
    { value: 'TWD', code: 'TWD', symbol: 'NT$', name: '台币', nameEn: 'New Taiwan Dollar', label: 'TWD (NT$ 台币)', labelTw: 'TWD (NT$ 新台幣)', labelEn: 'TWD (NT$ TWD)', aliases: ['台币', '台湾', 'twd', 'ntd', 'nt$'] },
    { value: 'TRY', code: 'TRY', symbol: '₺', name: '里拉', nameEn: 'Turkish Lira', label: 'TRY (₺ 里拉)', labelTw: 'TRY (₺ 里拉)', labelEn: 'TRY (₺ Lira)', aliases: ['里拉', '土耳其', 'try', '₺', 'lira'] },
    { value: 'NGN', code: 'NGN', symbol: '₦', name: '奈拉', nameEn: 'Nigerian Naira', label: 'NGN (₦ 奈拉)', labelTw: 'NGN (₦ 奈拉)', labelEn: 'NGN (₦ Naira)', aliases: ['奈拉', '尼日利亚', 'ngn', '₦', 'naira'] },
    { value: 'CNY', code: 'CNY', symbol: '¥', name: '人民币', nameEn: 'Chinese Yuan', label: 'CNY (¥ 人民币)', labelTw: 'CNY (¥ 人民幣)', labelEn: 'CNY (¥ CNY)', aliases: ['人民币', '中国', 'cny', 'rmb', '¥', 'yuan'] },
    { value: 'EUR', code: 'EUR', symbol: '€', name: '欧元', nameEn: 'Euro', label: 'EUR (€ 欧元)', labelTw: 'EUR (€ 歐元)', labelEn: 'EUR (€ Euro)', aliases: ['欧元', '欧洲', 'eur', '€', 'euro'] },
    { value: 'GBP', code: 'GBP', symbol: '£', name: '英镑', nameEn: 'British Pound', label: 'GBP (£ 英镑)', labelTw: 'GBP (£ 英鎊)', labelEn: 'GBP (£ Pound)', aliases: ['英镑', '英国', 'gbp', '£', 'pound'] },
    { value: 'SGD', code: 'SGD', symbol: 'S$', name: '新元', nameEn: 'Singapore Dollar', label: 'SGD (S$ 新元)', labelTw: 'SGD (S$ 新幣)', labelEn: 'SGD (S$ SGD)', aliases: ['新元', '新加坡', 'sgd', 's$'] },
    { value: 'CAD', code: 'CAD', symbol: 'CA$', name: '加元', nameEn: 'Canadian Dollar', label: 'CAD (CA$ 加元)', labelTw: 'CAD (CA$ 加幣)', labelEn: 'CAD (CA$ CAD)', aliases: ['加元', '加拿大', 'cad', 'ca$'] },
    { value: 'PHP', code: 'PHP', symbol: '₱', name: '比索', nameEn: 'Philippine Peso', label: 'PHP (₱ 比索)', labelTw: 'PHP (₱ 披索)', labelEn: 'PHP (₱ Peso)', aliases: ['比索', '菲律宾', 'php', '₱', 'peso'] },
    { value: 'INR', code: 'INR', symbol: '₹', name: '卢比', nameEn: 'Indian Rupee', label: 'INR (₹ 卢比)', labelTw: 'INR (₹ 盧比)', labelEn: 'INR (₹ Rupee)', aliases: ['卢比', '印度', 'inr', '₹', 'rupee'] },
    { value: 'MYR', code: 'MYR', symbol: 'RM', name: '令吉', nameEn: 'Malaysian Ringgit', label: 'MYR (RM 令吉)', labelTw: 'MYR (RM 令吉)', labelEn: 'MYR (RM Ringgit)', aliases: ['令吉', '马来西亚', 'myr', 'rm', 'ringgit'] },
    { value: 'BRL', code: 'BRL', symbol: 'R$', name: '雷亚尔', nameEn: 'Brazilian Real', label: 'BRL (R$ 雷亚尔)', labelTw: 'BRL (R$ 雷亞爾)', labelEn: 'BRL (R$ Real)', aliases: ['雷亚尔', '巴西', 'brl', 'r$', 'real'] }
  ];

  function refreshRegionPresetSelectOptions() {
    const sel = el('select-custom-region-preset');
    if (!sel || !sel.options) return;
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    const presets = core?.SUBSCRIPTION_REGIONS_PRESET || [];
    const curLang = getPanelLanguage();
    for (let i = 0; i < sel.options.length; i++) {
      const opt = sel.options[i];
      if (!opt || opt.value === '' || opt.value === 'custom') continue;
      const p = presets.find(item => item.id === opt.value);
      if (!p) continue;
      const parts = formatPresetRegionLineParts(p, curLang);
      opt.textContent = parts.full || '';
    }
  }

  function hasClass(node, cls) {
    if (!node) return false;
    if (node.classList?.contains) return node.classList.contains(cls);
    return String(node.className || '').split(/\s+/).includes(cls);
  }
  function addClass(node, cls) {
    if (!node) return;
    if (node.classList?.add) { node.classList.add(cls); return; }
    const cur = String(node.className || '').trim();
    if (!cur.split(/\s+/).includes(cls)) node.className = cur ? `${cur} ${cls}` : cls;
  }
  function removeClass(node, cls) {
    if (!node) return;
    if (node.classList?.remove) { node.classList.remove(cls); return; }
    const parts = String(node.className || '').split(/\s+/).filter(c => c !== cls);
    node.className = parts.join(' ');
  }

  // 纯同步 UI 控件回填防护守卫（仅在纯同步赋值代码块内开启，严禁跨越 await）
  let isHydratingUiControls = false;
  function runWithUiHydration(fn) {
    const prev = isHydratingUiControls;
    isHydratingUiControls = true;
    try {
      return fn();
    } finally {
      isHydratingUiControls = prev;
    }
  }

  // 兼容老调用声明
  let isRestoringSettings = false;

  // 异步时序保护：用户主动修改序列号与恢复请求版本号
  let userActionSeq = 0;
  let restoreRequestSeq = 0;

  /* @INSERT_DROPDOWN_MODULE */
  function renderPlanSummaryPriceBadge(targetSymbol, targetNum, targetCycle, targetCnyText, options = {}) {
    const priceValEl = el('plan-summary-price-val');
    const priceCnyEl = el('plan-summary-price-cny');
    const badgeEl = el('plan-summary-price-badge');
    if (!priceValEl) return;

    if (activeBadgeTimerId) {
      clearTimeout(activeBadgeTimerId);
      activeBadgeTimerId = null;
    }
    if (activeCnyTimerId) {
      clearTimeout(activeCnyTimerId);
      activeCnyTimerId = null;
    }
    if (activeBadgeRafId && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(activeBadgeRafId);
      activeBadgeRafId = null;
    }

    if (targetNum === null || targetNum === undefined) {
      const displayStr = targetSymbol || t('plan.summary.priceUnsetShort');
      if (typeof priceValEl.replaceChildren === 'function') {
        priceValEl.textContent = displayStr;
      } else {
        priceValEl.textContent = displayStr;
      }
      if (priceCnyEl) priceCnyEl.textContent = targetCnyText || '';
      if (badgeEl && badgeEl.classList) badgeEl.classList.remove('is-animating');
      lastBadgePriceState = null;
      return;
    }

    const formattedFinalNum = targetNum !== null && targetNum !== undefined
      ? (Number(targetNum) % 1 === 0 ? String(Number(targetNum)) : Number(targetNum).toFixed(2))
      : '';

    // 轻量模拟环境安全兼容
    if (typeof priceValEl.querySelector !== 'function') {
      priceValEl.textContent = `${targetSymbol}${formattedFinalNum}${targetCycle}`;
      if (priceCnyEl) priceCnyEl.textContent = targetCnyText;
      lastBadgePriceState = {
        symbol: targetSymbol,
        num: targetNum !== null ? Number(targetNum) : 0,
        cycle: targetCycle,
        cnyText: targetCnyText
      };
      return;
    }

    const hasRaf = typeof requestAnimationFrame === 'function';
    const forceDirect = options.forceDirect || !hasRaf || !lastBadgePriceState;

    if (forceDirect) {
      priceValEl.innerHTML = `<span class="badge-symbol-anim">${targetSymbol}</span><span class="badge-num-anim">${formattedFinalNum}</span><span class="badge-cycle-anim">${targetCycle}</span>`;
      if (priceCnyEl) priceCnyEl.textContent = targetCnyText;
      lastBadgePriceState = {
        symbol: targetSymbol,
        num: targetNum !== null ? Number(targetNum) : 0,
        cycle: targetCycle,
        cnyText: targetCnyText
      };
      return;
    }

    const startNum = (lastBadgePriceState && Number.isFinite(lastBadgePriceState.num))
      ? lastBadgePriceState.num
      : (Number(targetNum) || 0);
    const endNum = targetNum !== null ? Number(targetNum) : 0;
    const startSymbol = lastBadgePriceState?.symbol || targetSymbol;
    const endSymbol = targetSymbol;

    // 确保内部 DOM 结构完整
    let symbolEl = priceValEl.querySelector?.('.badge-symbol-anim');
    let numEl = priceValEl.querySelector?.('.badge-num-anim');
    let cycleEl = priceValEl.querySelector?.('.badge-cycle-anim');

    if (!symbolEl || !numEl || !cycleEl) {
      priceValEl.innerHTML = `<span class="badge-symbol-anim">${startSymbol}</span><span class="badge-num-anim">${formattedFinalNum}</span><span class="badge-cycle-anim">${targetCycle}</span>`;
      symbolEl = priceValEl.querySelector?.('.badge-symbol-anim');
      numEl = priceValEl.querySelector?.('.badge-num-anim');
      cycleEl = priceValEl.querySelector?.('.badge-cycle-anim');
    }

    if (cycleEl) cycleEl.textContent = targetCycle;

    // 1. 货币符号消散再切换动画 (Symbol Dissolve & Crossfade)
    if (startSymbol !== endSymbol && symbolEl && symbolEl.classList) {
      symbolEl.classList.remove('is-entering');
      symbolEl.classList.add('is-dissolving');

      activeBadgeTimerId = setTimeout(() => {
        symbolEl.textContent = endSymbol;
        symbolEl.classList.remove('is-dissolving');
        symbolEl.classList.add('is-entering');
        try { void symbolEl.offsetWidth; } catch { }
        setTimeout(() => {
          symbolEl.classList?.remove?.('is-entering');
        }, 180);
        activeBadgeTimerId = null;
      }, 160);
    } else if (symbolEl) {
      symbolEl.textContent = endSymbol;
    }

    // 2. CNY 折合平滑渐变
    if (priceCnyEl && priceCnyEl.textContent !== targetCnyText) {
      try {
        priceCnyEl.style.transition = 'opacity 0.18s ease';
        priceCnyEl.style.opacity = '0.2';
        activeCnyTimerId = setTimeout(() => {
          priceCnyEl.textContent = targetCnyText;
          priceCnyEl.style.opacity = '0.85';
          activeCnyTimerId = null;
        }, 140);
      } catch {
        priceCnyEl.textContent = targetCnyText;
      }
    }

    // 3. 数字滚动/递减递增动画 (Rolling Numeric Count Tween)
    if (startNum !== endNum && numEl) {
      if (badgeEl && badgeEl.classList) badgeEl.classList.add('is-animating');

      const startTime = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
      const duration = 500;
      const easeOut = t => 1 - Math.pow(1 - t, 4);

      const step = now => {
        const elapsed = Math.max(0, now - startTime);
        const progress = Math.min(1, elapsed / duration);
        const eased = easeOut(progress);
        const currentVal = startNum + (endNum - startNum) * eased;

        if (progress < 1) {
          if (endNum % 1 !== 0) {
            numEl.textContent = currentVal >= 100 ? String(Math.round(currentVal)) : currentVal.toFixed(2);
          } else {
            numEl.textContent = String(Math.round(currentVal));
          }
          activeBadgeRafId = requestAnimationFrame(step);
        } else {
          numEl.textContent = formattedFinalNum;
          if (badgeEl && badgeEl.classList) badgeEl.classList.remove('is-animating');
          activeBadgeRafId = null;
        }
      };

      activeBadgeRafId = requestAnimationFrame(step);
    } else if (numEl) {
      numEl.textContent = formattedFinalNum;
    }

    lastBadgePriceState = {

      symbol: targetSymbol,
      num: endNum,
      cycle: targetCycle,
      cnyText: targetCnyText
    };
  }

  function renderPlanDetail(ps) {
    if (!ps) return;
    const sumTxt = el('plan-summary-text');
    const tierDisplay = typeof localizePlanTierName === 'function' ? localizePlanTierName(ps.tierName || 'Pro') : (ps.tierName || 'Pro');
    if (sumTxt) {
      const modeTxt = ps.status === 'identified'
        ? t('plan.summary.identified')
        : ps.hasCustomSettings
          ? t('plan.summary.custom')
          : t('plan.summary.unknown');
      sumTxt.textContent = `${tierDisplay} · ${modeTxt} · ${t('plan.summary.justNow')}`;
    }
    // 实时联动更新黄框位置的订阅费与汇率胶囊（Ultra 等无公开统一定价时不回退 Pro $19.99）
    const curSymbol = ps.currencySymbol || '$';
    let targetSymbol = '$';
    let targetNum = null;
    let targetCycle = t('plan.summary.perMonth');
    let targetCny = '';

    if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
      targetSymbol = curSymbol;
      targetNum = 0;
      targetCycle = t('plan.summary.perMonth');
      targetCny = t('plan.summary.freeWithPlan');
    } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
      targetSymbol = curSymbol;
      targetNum = Number(ps.actualPricePaid);
      targetCycle = t('plan.summary.perMonth');
      const sec = formatSubscriptionSecondaryConversion(ps.actualPricePaid, ps.currency || 'USD', ps.region, { short: true });
      targetCny = sec ? `(${sec})` : '';
    } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
      targetSymbol = '$';
      targetNum = Number(ps.officialPriceMonthly);
      targetCycle = t('plan.summary.perMonth');
      const sec = formatSubscriptionSecondaryConversion(targetNum, 'USD', ps.region, { short: true });
      targetCny = sec ? `(${sec})` : '';
    } else {
      targetSymbol = t('plan.summary.priceUnsetShort');
      targetNum = null;
      targetCycle = '';
      targetCny = t('plan.summary.priceUnsetCny');
    }

    renderPlanSummaryPriceBadge(targetSymbol, targetNum, targetCycle, targetCny);

    const detName = el('p-det-name');
    if (detName) detName.textContent = typeof localizePlanTierName === 'function'
      ? localizePlanTierName(ps.tierName || 'Google AI Pro')
      : (ps.tierName || 'Google AI Pro');
    const detAcc = el('p-det-account');
    if (detAcc) detAcc.textContent = ps.email || t('plan.account.unknown');

    // 守卫：若当前不在 Token 统计视图或详情处于收起状态，严禁异步返回时撑开详情面板
    const cardEl = el('plan-detail-card');
    if (cardEl && (activeTokenView !== 'tokens' || !planDetailExpanded)) {
      cardEl.style.display = 'none';
      cardEl.classList?.remove?.('is-expanded');
    }

    const detCountry = el('p-det-country');
    const tagCountry = el('p-det-country-tag');
    const directCountrySel = el('direct-country-select');
    const rawCountryStr = ps.country ? String(ps.country).trim() : '';
    const isCountryUnknown = !rawCountryStr || rawCountryStr === '未知' || rawCountryStr === 'Unknown' || rawCountryStr.includes('未设置');
    const countryText = isCountryUnknown ? '未知' : rawCountryStr;
    const countryDisplay = countryText === '未知' ? t('plan.country.unknown') : (localizeRegionDisplayValue(countryText) || countryText);
    if (detCountry) detCountry.textContent = countryDisplay;
    if (tagCountry) {
      tagCountry.style.display = ps.countrySource === 'custom' ? 'inline-block' : 'none';
      tagCountry.textContent = ps.countrySource === 'custom' ? t('plan.tag.custom') : '';
    }

    const detReg = el('p-det-region');
    const tagReg = el('p-det-region-tag');
    let regText = ps.subscriptionRegion || ps.region || '未知';
    if (regText.includes('未在当前会话中获取') || regText.trim() === '未知' || regText.trim() === 'Unknown') regText = '未知';
    const regDisplay = regText === '未知' ? t('plan.region.unknown') : (localizeRegionDisplayValue(regText) || regText);
    if (detReg) detReg.textContent = regDisplay;
    if (tagReg) {
      tagReg.style.display = ps.regionSource === 'custom' ? 'inline-block' : 'none';
      tagReg.textContent = ps.regionSource === 'custom' ? t('plan.tag.custom') : '';
    }

    const detCur = el('p-det-currency');
    const tagCur = el('p-det-currency-tag');
    const directCurSel = el('direct-currency-select');
    const curText = ps.currency || 'USD';
    if (detCur) detCur.textContent = curText;
    if (tagCur) {
      tagCur.style.display = ps.currencySource === 'custom' ? 'inline-block' : 'none';
      tagCur.textContent = ps.currencySource === 'custom' ? t('plan.tag.custom') : '';
    }

    // 使用纯同步回填守卫同步更新详情面板内的下拉控件值
    runWithUiHydration(() => {
      if (directCountrySel) {
        if (countryText !== '未知' && directCountrySel.options) {
          const exists = Array.from(directCountrySel.options).some(o => o.value === countryText);
          if (!exists && typeof document.createElement === 'function') {
            const opt = document.createElement('option');
            opt.value = countryText;
            opt.textContent = '🌐 ' + (localizeRegionDisplayValue(countryText) || countryText);
            directCountrySel.appendChild?.(opt);
          }
        }
        directCountrySel.value = countryText;
      }
      if (directCurSel) {
        directCurSel.value = curText === 'NTD' ? 'TWD' : curText;
      }
    });

    // 刷新国家、订阅地区与币种直接选择器标签与选中高亮
    if (typeof refreshDirectCountryDisplay === 'function') {
      refreshDirectCountryDisplay(countryText);
    }
    if (typeof refreshDirectRegionDisplay === 'function') {
      refreshDirectRegionDisplay(regText);
    }
    if (typeof refreshDirectCurrencyDisplay === 'function') {
      refreshDirectCurrencyDisplay(curText);
    }

    const detAcq = el('p-det-acq');
    const tagAcq = el('p-det-acq-tag');
    if (detAcq) detAcq.textContent = localizeAcquisitionSource(ps.acquisitionSource || ps.acquisitionSourceName);
    if (tagAcq) {
      const isPromo = ps.acquisitionSource && ps.acquisitionSource !== 'normal_paid';
      tagAcq.style.display = isPromo ? 'inline-block' : 'none';
      tagAcq.textContent = isPromo ? t('plan.tag.promo') : '';
    }

    const detPrice = el('p-det-price');
    const tagPrice = el('p-det-price-tag');
    const isPresetMode = ps.priceMode === 'preset';
    const btnModePreset = el('btn-mode-preset');
    const btnModeCustom = el('btn-mode-custom');
    if (btnModePreset) setPillActive(btnModePreset, isPresetMode);
    if (btnModeCustom) setPillActive(btnModeCustom, !isPresetMode);

    if (detPrice) {
      const cycleText = localizeBillingCycleLabel(ps.billingCycle);
      const acqLabel = localizeAcquisitionSource(ps.acquisitionSource || ps.acquisitionSourceName);
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        detPrice.textContent = `${curSymbol}0 · ${cycleText}`;
      } else if (ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        const secPart = formatSubscriptionSecondaryConversion(ps.actualPricePaid, ps.currency || 'USD', ps.region, { detail: true });
        const paidFormatted = Number(ps.actualPricePaid) % 1 === 0 ? Number(ps.actualPricePaid) : Number(ps.actualPricePaid).toFixed(2);
        detPrice.textContent = secPart ? `${curSymbol}${paidFormatted} · ${cycleText} (${secPart})` : `${curSymbol}${paidFormatted} · ${cycleText}`;
      } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
        detPrice.textContent = `${t('plan.tag.publicRef')} $${ps.officialPriceMonthly}${t('plan.summary.perMonth')}`;
      } else {
        detPrice.textContent = `${acqLabel} · ${t('plan.priceUnsetNote')}`;
      }
    }
    if (tagPrice) {
      tagPrice.style.display = 'inline-block';
      if (ps.actualPricePaid === 0 || ps.isZeroExtraCost) {
        tagPrice.textContent = t('plan.tag.manualFree');
      } else if (ps.priceMode === 'custom' || ps.priceSource === 'custom') {
        tagPrice.textContent = t('plan.tag.userPaid');
      } else if (ps.priceSource === 'preset_region' && ps.actualPricePaid !== null && ps.actualPricePaid !== undefined) {
        tagPrice.textContent = t('plan.tag.official');
      } else if (ps.officialPriceMonthly !== null && ps.officialPriceMonthly !== undefined) {
        tagPrice.textContent = t('plan.tag.publicRef');
      } else {
        tagPrice.textContent = t('plan.tag.unset');
      }
    }

    const dtVal = el('p-dt-validity');
    const ddVal = el('p-det-validity');
    if (dtVal && ddVal) {
      if (ps.validEndDate) {
        dtVal.style.display = 'block';
        ddVal.style.display = 'block';
        ddVal.textContent = ps.isExpired
          ? t('plan.validity.expired', { date: ps.validEndDate })
          : t('plan.validity.active', { date: ps.validEndDate });
        ddVal.style.color = ps.isExpired ? '#ef4444' : 'var(--ag-text-secondary)';
      } else {
        dtVal.style.display = 'none';
        ddVal.style.display = 'none';
      }
    }

    const dtNote = el('p-dt-note');
    const ddNote = el('p-det-note');
    if (dtNote && ddNote) {
      if (ps.customNote) {
        dtNote.style.display = 'block';
        ddNote.style.display = 'block';
        ddNote.textContent = String(ps.customNote);
      } else {
        dtNote.style.display = 'none';
        ddNote.style.display = 'none';
      }
    }

    const pPrompt = el('p-det-prompt-credits');
    const pFlow = el('p-det-flow-credits');
    if (pPrompt && ps.promptCredits) {
      const promptTxt = `Prompt Credits: ${t('plan.credits.avail', { avail: ps.promptCredits.available ?? '—', monthly: ps.promptCredits.monthly ?? '—' })}`;
      pPrompt.textContent = promptTxt;
      const pLegacy = el('p-det-credits');
      if (pLegacy) pLegacy.textContent = promptTxt;
    }
    if (pFlow && ps.flowCredits) {
      pFlow.textContent = t('plan.credits.avail', { avail: ps.flowCredits?.available ?? '—', monthly: ps.flowCredits?.monthly ?? '—' });
    }
    const detTime = el('p-det-time');
    if (detTime) {
      const timeStr = ps.updatedAt ? new Date(ps.updatedAt).toLocaleString() : '—';
      const verifyStr = ps.pricingTableVerifiedDate ? ` · ${ps.pricingTableVerifiedDate}` : '';
      detTime.textContent = `${timeStr}${verifyStr}`;
    }
  }

  function setPillActive(node, active) {
    if (!node) return;
    node.classList?.toggle?.('active', active);
    const cur = node.getAttribute('class') || 'switch-pill-btn';
    if (active) {
      if (!cur.includes('active')) node.setAttribute('class', (cur + ' active').trim());
    } else {
      node.setAttribute('class', cur.replace(/\bactive\b/g, '').trim());
    }
  }

  function formatCompactTokenCount(v) {
    const n = Number(v) || 0;
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(n);
  }

  // 数据源切换（全部 / 桌面 / CLI）与分账号账本筛选
  let activeTokenSource = 'all';
  let activeTokenAccountFilter = 'all'; // 'all' | 'unattributed' | 'acct_xxx'
  const accountsUiState = {
    overview: null,
    toolsPreview: null,
    feedback: '',
    feedbackTone: 'info',
    busy: false,
    removeModal: {
      open: false,
      email: '',
      scopeKey: '',
      isActive: false,
      busy: false,
      error: ''
    }
  };
  function resetAccountScopedViewOffsets() {
    heatPageOffset = 0;
    heatMonthOffset = 0;
    heatYearOffset = 0;
    modelUsageOffsetDays = 0;
    modelUsageLockedKey = null;
    modelUsageHoveredKey = null;
    if (typeof resetCumSelectionState === 'function') resetCumSelectionState();
  }
  function switchTokenSource(src) {
    activeTokenSource = src;
    try { localStorage?.setItem('ag_token_source_v1', src); } catch { }
    if (typeof resetCumSelectionState === 'function') resetCumSelectionState();
    setPillActive(el('src-tab-all'), src === 'all');
    setPillActive(el('src-tab-desktop'), src === 'desktop');
    setPillActive(el('src-tab-cli'), src === 'cli');

    if (ANTIGRAVITY_TOKEN_DATA.rawPayload) {
      applyTokenHistoryPayload(ANTIGRAVITY_TOKEN_DATA.rawPayload);
    } else {
      const bySrc = ANTIGRAVITY_TOKEN_DATA.dailyMapBySource || {};
      const srcMap = bySrc[src] || bySrc.all || ANTIGRAVITY_TOKEN_DATA.dailyMap;
      ANTIGRAVITY_TOKEN_DATA.dailyMap = srcMap;
      const mBySrc = ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource || {};
      ANTIGRAVITY_TOKEN_DATA.dailyModelMap = mBySrc[src] || mBySrc.all || ANTIGRAVITY_TOKEN_DATA.dailyModelMap || {};
      renderActiveHeatView(true);
      renderActiveCostEstimateView();
      renderModelUsageView();
    }
  }
  el('src-tab-all')?.addEventListener('click', () => switchTokenSource('all'));
  el('src-tab-desktop')?.addEventListener('click', () => switchTokenSource('desktop'));
  el('src-tab-cli')?.addEventListener('click', () => switchTokenSource('cli'));

  // 视图切换（Token 统计 / API 等值估算）
  let activeTokenView = 'tokens';

  // 费用面板紧凑摘要与展开详情切换
  let costDetailsExpanded = false;
  function toggleCostDetails(expand) {
    if (expand === undefined) costDetailsExpanded = !costDetailsExpanded;
    else costDetailsExpanded = Boolean(expand);

    const pane = el('cost-details-pane');
    const btn = el('btn-cost-details-toggle');
    const pTokens = el('panel-tokens');

    if (pane) {
      pane.style.display = costDetailsExpanded ? 'block' : 'none';
      if (costDetailsExpanded) pane.style.animation = 'agFadeIn .2s cubic-bezier(0.16,1,0.3,1)';
    }
    if (btn) btn.textContent = costDetailsExpanded ? t('cost.btnCollapse') : t('cost.btnExpand');
    if (pTokens) {
      const isCompact = activeTokenView === 'cost' && !costDetailsExpanded;
      pTokens.classList?.toggle?.('cost-compact-view', isCompact);
      const curCls = pTokens.getAttribute?.('class') || '';
      if (isCompact) {
        if (!curCls.includes('cost-compact-view')) pTokens.setAttribute?.('class', (curCls + ' cost-compact-view').trim());
      } else {
        pTokens.setAttribute?.('class', curCls.replace(/\bcost-compact-view\b/g, '').trim());
      }
    }
    positionFloatingPanels();
  }
  el('cost-details-pane');
  el('cost-non-paid-badge');
  el('cost-scope-desc');
  el('tokens-main-view');
  el('btn-cost-details-toggle')?.addEventListener('click', () => toggleCostDetails());
  el('btn-cost-details-collapse')?.addEventListener('click', () => toggleCostDetails(false));
  el('btn-cost-fill-sub')?.addEventListener('click', () => {
    switchTokenView('tokens');
    setPlanDetailExpanded(true);
    togglePlanCustomForm(true);
  });
  toggleCostDetails(false);

  // 按模型 Token 统计状态与视图渲染
  let modelUsagePeriodDays = 7;
  let modelUsageOffsetDays = 0;
  let modelUsageGroupBy = 'model';
  let modelUsageMetric = 'total';
  let modelUsageHideUnattr = false;
  let modelUsageScaleMode = 'mixed'; // 'mixed' | 'linear'
  let modelUsageLockedKey = null;
  let modelUsageHoveredKey = null;
  const OTHER_SERIES_KEY = '__other_series__';

  function formatModelDateShort(dateStr) {
    const parts = String(dateStr || '').split('-').map(Number);
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n))) return dateStr || '';
    const [y, m, d] = parts;
    if (currentPanelLanguage === 'en') {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${months[m - 1] || m} ${d}`;
    }
    return `${m}/${String(d).padStart(2, '0')}`;
  }

  function formatModelRangeLabel(startStr, endStr) {
    const sp = String(startStr || '').split('-').map(Number);
    const ep = String(endStr || '').split('-').map(Number);
    if (sp.length !== 3 || ep.length !== 3) return `${startStr} – ${endStr}`;
    if (currentPanelLanguage === 'en') {
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      if (sp[0] === ep[0] && sp[1] === ep[1]) {
        return `${months[sp[1] - 1]} ${sp[2]} – ${ep[2]}, ${ep[0]}`;
      }
      if (sp[0] === ep[0]) {
        return `${months[sp[1] - 1]} ${sp[2]} – ${months[ep[1] - 1]} ${ep[2]}, ${ep[0]}`;
      }
      return `${months[sp[1] - 1]} ${sp[2]}, ${sp[0]} – ${months[ep[1] - 1]} ${ep[2]}, ${ep[0]}`;
    }
    return sp[0] === ep[0]
      ? `${startStr} – ${String(ep[1]).padStart(2, '0')}-${String(ep[2]).padStart(2, '0')}`
      : `${startStr} – ${endStr}`;
  }

  function setClassFlag(node, cls, active) {
    if (!node || !node.classList) return;
    if (active) node.classList.add(cls);
    else node.classList.remove(cls);
  }

  function applyModelSeriesFocusHighlight() {
    const focusKey = modelUsageHoveredKey || modelUsageLockedKey || null;
    const barsEl = el('model-usage-bars');
    const legendEl = el('model-usage-legend');
    if (barsEl && barsEl.children) {
      for (const col of Array.from(barsEl.children)) {
        for (const child of Array.from(col.children || [])) {
          if (String(child.className || '').includes('model-usage-stack')) {
            for (const seg of Array.from(child.children || [])) {
              const k = seg.getAttribute?.('data-series-key');
              setClassFlag(seg, 'is-dimmed', Boolean(focusKey && k !== focusKey));
            }
          }
        }
      }
    }
    if (legendEl && legendEl.children) {
      for (const card of Array.from(legendEl.children)) {
        const k = card.getAttribute?.('data-series-key');
        setClassFlag(card, 'is-dimmed', Boolean(focusKey && k !== focusKey));
        setClassFlag(card, 'is-locked', Boolean(modelUsageLockedKey && k === modelUsageLockedKey));
      }
    }
  }

  function renderModelUsageView() {
    const viewEl = el('model-usage-view');
    if (!viewEl) return;

    setPillActive(el('model-period-7d'), modelUsagePeriodDays === 7);
    setPillActive(el('model-period-30d'), modelUsagePeriodDays === 30);
    setPillActive(el('model-group-model'), modelUsageGroupBy === 'model');
    setPillActive(el('model-group-variant'), modelUsageGroupBy === 'variant');
    setPillActive(el('model-metric-total'), modelUsageMetric === 'total');
    setPillActive(el('model-metric-nocache'), modelUsageMetric === 'noCache');
    setPillActive(el('model-scale-mixed'), modelUsageScaleMode === 'mixed');
    setPillActive(el('model-scale-linear'), modelUsageScaleMode === 'linear');

    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    if (!core || typeof core.summarizeModelUsageWindow !== 'function') return;

    const todayStr = formatLocalYmd(new Date());
    const todayDate = new Date(todayStr + 'T00:00:00');
    const endDt = new Date(todayDate.getTime() - modelUsageOffsetDays * 86400000);
    const endDate = formatLocalYmd(endDt);

    const bySrcModel = ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource || {};
    const dailyModelMap = bySrcModel[activeTokenSource] || bySrcModel.all || ANTIGRAVITY_TOKEN_DATA.dailyModelMap || {};

    const isLightTone = host.getAttribute?.('data-theme') === 'light' || host.getAttribute?.('data-panel-tone') === 'light';
    const themeAccent = customColors?.tokenAccent || (typeof heatPreset !== 'undefined' && heatPreset !== 'purple' && typeof getEffectiveHeatmapScale === 'function'
      ? getEffectiveHeatmapScale()[3]
      : '');
    const summary = core.summarizeModelUsageWindow(dailyModelMap, {
      periodDays: modelUsagePeriodDays,
      endDate,
      groupBy: modelUsageGroupBy,
      metric: modelUsageMetric,
      hideUnattributed: modelUsageHideUnattr,
      theme: isLightTone ? 'light' : 'dark',
      accentColor: themeAccent || undefined,
      modelMetaByKey: ANTIGRAVITY_TOKEN_DATA.modelMetaByKey,
      unattributedLabel: t('modelsUsage.unattributed')
    });

    // 长尾折叠：图例大于 6 项时保留 Top 5 独立颜色 + 第 6 项「其他模型/档位」
    let effectiveLegend = Array.isArray(summary.legend) ? summary.legend.slice() : [];
    const foldedKeys = new Set();
    if (effectiveLegend.length > 6) {
      const top5 = effectiveLegend.slice(0, 5);
      const tail = effectiveLegend.slice(5);
      let otherTokens = 0;
      let otherSteps = 0;
      tail.forEach(item => {
        foldedKeys.add(item.key);
        otherTokens += Number(item.tokens) || 0;
        otherSteps += Number(item.steps) || 0;
      });
      const winTot = Math.max(1, Number(summary.windowTotalTokens) || 0);
      const otherPct = (otherTokens / winTot) * 100;
      top5.push({
        key: '__other_series__',
        label: t('modelsUsage.otherSeries'),
        color: '#71717a',
        tokens: otherTokens,
        steps: otherSteps,
        pct: otherPct,
        pctLabel: otherPct < 0.1 && otherTokens > 0 ? '<0.1%' : `${otherPct.toFixed(1)}%`
      });
      effectiveLegend = top5;
    }

    if (modelUsageLockedKey && !effectiveLegend.some(it => it.key === modelUsageLockedKey)) {
      modelUsageLockedKey = null;
    }

    const rangeLbl = el('model-usage-range-label');
    if (rangeLbl) rangeLbl.textContent = formatModelRangeLabel(summary.startDate, summary.endDate);
    const winTotEl = el('model-usage-window-total');
    if (winTotEl) winTotEl.textContent = `${formatCompactTokenCount(summary.windowTotalTokens)} Tokens`;

    const unattrBtn = el('model-toggle-unattr');
    if (unattrBtn) {
      const showBtn = summary.hasUnattributed || modelUsageHideUnattr;
      unattrBtn.style.display = showBtn ? 'inline-flex' : 'none';
      setPillActive(unattrBtn, modelUsageHideUnattr);
      unattrBtn.textContent = modelUsageHideUnattr ? t('modelsUsage.showUnattr') : t('modelsUsage.hideUnattr');
    }

    const firstUse = ANTIGRAVITY_TOKEN_DATA.firstUseDate || ANTIGRAVITY_TOKEN_DATA.summary?.firstUseDate || null;
    const allModelDates = Object.keys(dailyModelMap || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    const earliestKnown = allModelDates[0] && (!firstUse || allModelDates[0] < firstUse) ? allModelDates[0] : firstUse;
    const prevBtn = el('btn-model-win-prev');
    const nextBtn = el('btn-model-win-next');
    if (prevBtn) prevBtn.disabled = Boolean(earliestKnown && summary.startDate <= earliestKnown);
    if (nextBtn) nextBtn.disabled = modelUsageOffsetDays <= 0;

    const chartPxHeight = 140;
    const env = typeof core.resolveScaleEnvelope === 'function'
      ? core.resolveScaleEnvelope(summary.maxDayTotal, 'dailyBar')
      : { tier: '500M', anchor: 500e6, hCap: 1.0, refTicks: [1e6, 10e6, 100e6, 500e6], overflowThreshold: 500e6 };

    const gridWrap = el('model-usage-gridlines');
    const maxLblEl = el('model-chart-max-lbl');
    if (gridWrap) {
      const childrenArr = Array.from(gridWrap.children || []);
      const baseLines = [];
      childrenArr.forEach(node => {
        const cls = String(node.className || '');
        if (cls.includes('model-usage-tick-line')) {
          node.remove?.();
        } else {
          baseLines.push(node);
        }
      });
      if (modelUsageScaleMode === 'mixed' && typeof core.mapBarHeightPx === 'function') {
        gridWrap.style.display = 'block';
        baseLines.forEach(gl => { gl.style.display = 'none'; });
        const ticks = Array.isArray(env.refTicks) ? env.refTicks : [];
        const lastTick = ticks.length ? ticks[ticks.length - 1] : 0;
        ticks.forEach(tVal => {
          if (!(tVal > 0)) return;
          const pos = core.mapBarHeightPx(tVal, env, chartPxHeight, { mode: 'mixed', scaleKind: 'dailyBar' });
          const tickLine = document.createElement('div');
          tickLine.className = 'model-usage-tick-line';
          tickLine.style.bottom = `${pos.height.toFixed(1)}px`;
          const tickLbl = document.createElement('span');
          tickLbl.className = 'model-usage-tick-lbl';
          const isOverflowTop = Boolean(env.overflow && tVal === lastTick);
          tickLbl.textContent = isOverflowTop ? `${formatCompactTokenCount(tVal)}+` : formatCompactTokenCount(tVal);
          tickLine.appendChild(tickLbl);
          gridWrap.appendChild(tickLine);
        });
        if (maxLblEl) {
          maxLblEl.textContent = (env.overflow && summary.maxDayTotal > 0)
            ? formatCompactTokenCount(summary.maxDayTotal)
            : '';
        }
      } else {
        gridWrap.style.display = 'flex';
        gridWrap.style.flexDirection = 'column';
        gridWrap.style.justifyContent = 'space-between';
        baseLines.forEach(gl => { gl.style.display = 'block'; });
        if (maxLblEl) {
          maxLblEl.textContent = summary.maxDayTotal > 0 ? formatCompactTokenCount(summary.maxDayTotal) : '';
        }
      }
    } else if (maxLblEl) {
      maxLblEl.textContent = summary.maxDayTotal > 0 ? formatCompactTokenCount(summary.maxDayTotal) : '';
    }

    const barsEl = el('model-usage-bars');
    const xaxisEl = el('model-usage-xaxis');
    const legendEl = el('model-usage-legend');
    const emptyEl = el('model-usage-empty');
    const chartWrap = el('model-usage-chart-wrap');

    const hasAnyData = summary.windowTotalTokens > 0;
    if (emptyEl) emptyEl.style.display = hasAnyData ? 'none' : 'block';
    if (chartWrap) chartWrap.style.display = hasAnyData ? 'block' : 'none';
    if (chartWrap) chartWrap.setAttribute('data-scale-mode', modelUsageScaleMode);
    if (chartWrap) chartWrap.setAttribute('data-scale-tier', env.tier || '');

    const isCompact30 = modelUsagePeriodDays === 30;
    if (barsEl) {
      if (isCompact30) barsEl.classList?.add('compact-30');
      else barsEl.classList?.remove('compact-30');
      barsEl.replaceChildren();
    }
    if (xaxisEl) {
      if (isCompact30) xaxisEl.classList?.add('compact-30');
      else xaxisEl.classList?.remove('compact-30');
      xaxisEl.replaceChildren();
    }

    const anchorIndices = isCompact30
      ? new Set([0, 7, 14, 21, 29])
      : new Set([0, 1, 2, 3, 4, 5, 6]);
    const focusKey = modelUsageHoveredKey || modelUsageLockedKey || null;

    summary.days.forEach((day, idx) => {
      if (barsEl) {
        const col = document.createElement('div');
        col.className = 'model-usage-col';
        col.setAttribute('data-date', day.date);
        col.setAttribute('data-tokens', String(day.total || 0));

        // 折叠长尾段并保持真实 Top 顺序（column-reverse 下 index 0 在零基线底部）
        const segList = [];
        let otherSegTok = 0;
        (day.segments || []).forEach(seg => {
          if (foldedKeys.has(seg.key)) {
            otherSegTok += Number(seg.tokens) || 0;
          } else {
            segList.push({ ...seg, value: Number(seg.tokens) || 0 });
          }
        });
        if (otherSegTok > 0) {
          segList.push({
            key: '__other_series__',
            label: t('modelsUsage.otherSeries'),
            color: '#71717a',
            tokens: otherSegTok,
            value: otherSegTok,
            pct: day.total > 0 ? (otherSegTok / day.total) * 100 : 0
          });
        }
        // 点击锁定单系列时将该系列移至 0 基线底部（数组首位）
        if (modelUsageLockedKey) {
          const lockIdx = segList.findIndex(s => s.key === modelUsageLockedKey);
          if (lockIdx > 0) {
            const [lockedSeg] = segList.splice(lockIdx, 1);
            segList.unshift(lockedSeg);
          }
        }

        if (day.total > 0 && summary.maxDayTotal > 0 && segList.length > 0) {
          const barInfo = typeof core.mapBarHeightPx === 'function'
            ? core.mapBarHeightPx(day.total, env, chartPxHeight, { mode: modelUsageScaleMode, linearMax: summary.maxDayTotal, scaleKind: 'dailyBar' })
            : { height: Math.max(4, (day.total / summary.maxDayTotal) * chartPxHeight), overflow: false };
          const totalH = barInfo.height;
          const stack = document.createElement('div');
          stack.className = `model-usage-stack${barInfo.overflow && modelUsageScaleMode === 'mixed' ? ' is-overflow' : ''}`;
          stack.style.height = `${totalH.toFixed(4)}px`;
          stack.setAttribute('data-total-height', totalH.toFixed(4));

          const alloc = typeof core.allocateStackedSegmentHeights === 'function'
            ? core.allocateStackedSegmentHeights(segList, totalH, 1.5)
            : segList.map(s => ({ ...s, heightPx: (s.value / Math.max(1, day.total)) * totalH, rawRatio: s.value / Math.max(1, day.total) }));

          alloc.forEach(seg => {
            const segEl = document.createElement('div');
            segEl.className = `model-usage-seg${focusKey && seg.key !== focusKey ? ' is-dimmed' : ''}`;
            segEl.setAttribute('data-series-key', seg.key);
            segEl.setAttribute('data-raw-pct', (seg.rawRatio * 100).toFixed(2));
            segEl.style.height = `${seg.heightPx.toFixed(4)}px`;
            segEl.style.background = seg.color;
            stack.appendChild(segEl);
          });
          col.appendChild(stack);
        } else {
          const emptyBar = document.createElement('div');
          emptyBar.className = 'model-usage-empty-bar';
          col.appendChild(emptyBar);
        }

        const showBarPop = () => {
          const hp = el('heat-pop');
          const hpDate = el('heat-pop-date');
          const hpVal = el('heat-pop-val');
          const hpDet = el('heat-pop-det');
          if (!hp || !hpDate || !hpVal || !hpDet) return;
          hpDate.textContent = day.date + (day.date === todayStr ? t('heat.today') : '');
          hpVal.textContent = day.total > 0 ? `${formatCompactTokenCount(day.total)} Tokens` : '0 Tokens';
          hpDet.replaceChildren();
          if (day.segments.length > 0) {
            hpDet.style.display = 'flex';
            hpDet.style.flexDirection = 'column';
            hpDet.style.gap = '3px';
            day.segments.slice(0, 6).forEach(seg => {
              const row = document.createElement('div');
              row.style.display = 'flex';
              row.style.justifyContent = 'space-between';
              row.style.alignItems = 'center';
              row.style.gap = '10px';
              row.style.fontSize = '10.5px';
              const left = document.createElement('span');
              left.style.display = 'inline-flex';
              left.style.alignItems = 'center';
              left.style.gap = '5px';
              const dot = document.createElement('span');
              dot.style.display = 'inline-block';
              dot.style.width = '6px';
              dot.style.height = '6px';
              dot.style.borderRadius = '999px';
              dot.style.background = seg.color;
              const nm = document.createElement('span');
              nm.textContent = seg.label;
              left.appendChild(dot);
              left.appendChild(nm);
              const right = document.createElement('span');
              right.textContent = `${formatCompactTokenCount(seg.tokens)} (${Math.round(seg.pct * 10) / 10}%)`;
              row.appendChild(left);
              row.appendChild(right);
              hpDet.appendChild(row);
            });
          } else {
            hpDet.style.display = 'none';
          }
          const r = col.getBoundingClientRect();
          hp.style.left = `${r.left + r.width / 2}px`;
          hp.style.top = `${r.top - 6}px`;
          hp.style.opacity = '1';
        };
        col.addEventListener('mouseenter', showBarPop);
        col.addEventListener('mouseleave', hidePopover);
        col.addEventListener('click', showBarPop);
        barsEl.appendChild(col);
      }

      if (xaxisEl) {
        const lbl = document.createElement('div');
        lbl.className = 'model-usage-xlabel';
        lbl.textContent = anchorIndices.has(idx) ? formatModelDateShort(day.date) : '';
        xaxisEl.appendChild(lbl);
      }
    });

    if (legendEl) {
      legendEl.replaceChildren();
      effectiveLegend.forEach(item => {
        const card = document.createElement('div');
        card.className = `model-legend-item${focusKey && item.key !== focusKey ? ' is-dimmed' : ''}${modelUsageLockedKey === item.key ? ' is-locked' : ''}`;
        card.setAttribute('data-series-key', item.key);
        const bar = document.createElement('div');
        bar.className = 'model-legend-bar';
        bar.style.background = item.color;

        const textWrap = document.createElement('div');
        textWrap.className = 'model-legend-text';

        const nameEl = document.createElement('div');
        nameEl.className = 'model-legend-name';
        nameEl.textContent = item.label;
        nameEl.title = item.label;

        const valRow = document.createElement('div');
        valRow.className = 'model-legend-val-row';

        const pctEl = document.createElement('span');
        pctEl.className = 'model-legend-pct';
        pctEl.textContent = item.pctLabel;

        const metaEl = document.createElement('span');
        metaEl.className = 'model-legend-meta';
        metaEl.textContent = `${formatCompactTokenCount(item.tokens)} · ${t('modelsUsage.stepsSuffix', { n: item.steps })}`;

        valRow.appendChild(pctEl);
        valRow.appendChild(metaEl);
        textWrap.appendChild(nameEl);
        textWrap.appendChild(valRow);
        card.appendChild(bar);
        card.appendChild(textWrap);

        card.addEventListener('mouseenter', () => {
          modelUsageHoveredKey = item.key;
          applyModelSeriesFocusHighlight();
        });
        card.addEventListener('mouseleave', () => {
          if (modelUsageHoveredKey === item.key) modelUsageHoveredKey = null;
          applyModelSeriesFocusHighlight();
        });
        card.addEventListener('click', () => {
          modelUsageLockedKey = (modelUsageLockedKey === item.key) ? null : item.key;
          renderModelUsageView();
        });
        legendEl.appendChild(card);
      });
    }
  }

  function switchTokenView(v) {
    activeTokenView = v;
    // 离开 Token 统计视图时关闭订阅详情与表单
    setPlanDetailExpanded(false, { skipReposition: true });
    if (typeof hidePopover === 'function') hidePopover();

    setPillActive(el('tok-view-tokens'), v === 'tokens');
    setPillActive(el('tok-view-models'), v === 'models');
    setPillActive(el('tok-view-cost'), v === 'cost');
    const costCard = el('cost-estimate-card');
    const modelView = el('model-usage-view');
    const tokensMain = el('tokens-main-view');
    const statCards = el('token-stat-cards');
    const planBar = el('plan-summary-bar');
    const titleTokens = el('panel-tokens-title');
    const pTokens = el('panel-tokens');

    if (costCard) {
      costCard.style.display = v === 'cost' ? 'block' : 'none';
      if (v === 'cost') costCard.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
    }
    if (modelView) {
      modelView.style.display = v === 'models' ? 'block' : 'none';
      if (v === 'models') {
        modelView.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
        renderModelUsageView();
      }
    }
    if (tokensMain) {
      tokensMain.style.display = v === 'tokens' ? 'block' : 'none';
      if (v === 'tokens') tokensMain.style.animation = 'agFadeIn .18s cubic-bezier(0.16,1,0.3,1)';
    }
    if (statCards) statCards.style.display = v === 'tokens' ? 'grid' : 'none';
    if (planBar) planBar.style.display = v === 'tokens' ? 'flex' : 'none';
    if (titleTokens) {
      titleTokens.textContent = v === 'cost'
        ? t('tokens.titleCost')
        : v === 'models'
          ? t('tokens.titleModels')
          : t('tokens.title');
    }

    if (pTokens) {
      const isCompact = v === 'cost' && !costDetailsExpanded;
      pTokens.classList?.toggle?.('cost-compact-view', isCompact);
      const curCls = pTokens.getAttribute?.('class') || '';
      if (isCompact) {
        if (!curCls.includes('cost-compact-view')) pTokens.setAttribute?.('class', (curCls + ' cost-compact-view').trim());
      } else {
        pTokens.setAttribute?.('class', curCls.replace(/\bcost-compact-view\b/g, '').trim());
      }
    }
    positionFloatingPanels();
  }
  el('tok-view-tokens')?.addEventListener('click', () => switchTokenView('tokens'));
  el('tok-view-models')?.addEventListener('click', () => switchTokenView('models'));
  el('tok-view-cost')?.addEventListener('click', () => switchTokenView('cost'));
  el('model-period-7d')?.addEventListener('click', () => {
    modelUsagePeriodDays = 7;
    modelUsageOffsetDays = 0;
    renderModelUsageView();
  });
  el('model-period-30d')?.addEventListener('click', () => {
    modelUsagePeriodDays = 30;
    modelUsageOffsetDays = 0;
    renderModelUsageView();
  });
  el('model-group-model')?.addEventListener('click', () => {
    modelUsageGroupBy = 'model';
    renderModelUsageView();
  });
  el('model-group-variant')?.addEventListener('click', () => {
    modelUsageGroupBy = 'variant';
    renderModelUsageView();
  });
  el('model-metric-total')?.addEventListener('click', () => {
    modelUsageMetric = 'total';
    renderModelUsageView();
  });
  el('model-metric-nocache')?.addEventListener('click', () => {
    modelUsageMetric = 'noCache';
    renderModelUsageView();
  });

  el('model-scale-mixed')?.addEventListener('click', () => {
    modelUsageScaleMode = 'mixed';
    renderModelUsageView();
  });
  el('model-scale-linear')?.addEventListener('click', () => {
    modelUsageScaleMode = 'linear';
    renderModelUsageView();
  });
  el('model-toggle-unattr')?.addEventListener('click', () => {
    modelUsageHideUnattr = !modelUsageHideUnattr;
    renderModelUsageView();
  });
  el('btn-model-win-prev')?.addEventListener('click', () => {
    modelUsageOffsetDays += modelUsagePeriodDays;
    renderModelUsageView();
  });
  el('btn-model-win-next')?.addEventListener('click', () => {
    modelUsageOffsetDays = Math.max(0, modelUsageOffsetDays - modelUsagePeriodDays);
    renderModelUsageView();
  });

  // =========================================================================
  // 一键启动 CLI 模式（当前项目目录绑定 + 中文/空格路径兼容 + 错误提示）
  // =========================================================================
  let cliLaunchBusy = false;
  let cliToastTimer = null;
  let lastCliLaunchResult = null;

  function showCliToast(message, isError = false) {
    const toast = el('cli-launch-toast');
    if (!toast) return;
    if (cliToastTimer) {
      clearTimeout(cliToastTimer);
      cliToastTimer = null;
    }
    toast.hidden = false;
    toast.setAttribute('data-tone', isError ? 'error' : 'info');
    toast.textContent = message;
    cliToastTimer = setTimeout(() => {
      toast.hidden = true;
      cliToastTimer = null;
    }, isError ? 5200 : 3200);
  }

  async function triggerLaunchCli(customOpts = {}) {
    if (cliLaunchBusy) {
      showCliToast(t('cli.busy'), false);
      return { ok: false, error: t('cli.busy') };
    }
    cliLaunchBusy = true;
    const btn = el('badge-cli');
    const label = el('cli-label');
    btn?.setAttribute('data-busy', 'true');
    if (label) label.textContent = '…';
    try {
      if (typeof document !== 'undefined' && document.activeElement?.blur) {
        document.activeElement.blur();
      }
    } catch { }

    const hostBounds = {
      x: typeof window !== 'undefined' ? (window.screenX || 0) : 0,
      y: typeof window !== 'undefined' ? (window.screenY || 0) : 0,
      width: typeof window !== 'undefined' ? (window.outerWidth || window.innerWidth || 1200) : 1200,
      height: typeof window !== 'undefined' ? (window.outerHeight || window.innerHeight || 800) : 800
    };

    const reqOpts = {
      cascadeId: state.route || undefined,
      cwd: customOpts.cwd !== undefined ? customOpts.cwd : (state.scan?.workspacePath || undefined),
      hostBounds,
      ...customOpts
    };
    try {
      let res = null;
      const ipcFn = typeof window !== 'undefined' && typeof window.contextMeterAPI?.launchCli === 'function'
        ? () => window.contextMeterAPI.launchCli(reqOpts)
        : null;
      if (ipcFn || hasLiveHttpBridge()) {
        try {
          const out = await callBackendWithPriority({
            ipcCall: ipcFn,
            liveRoute: '/launch-cli',
            liveBody: reqOpts
          });
          res = out.result;
        } catch (err) {
          res = { ok: false, error: err?.message || t('cli.notFound') };
        }
      } else {
        res = { ok: false, code: 'NO_BRIDGE', error: t('cli.noBridge') };
      }

      lastCliLaunchResult = res;
      if (res && res.ok) {
        const om = el('overflow-menu');
        if (om) om.hidden = true;
        showCliToast(t('cli.launched', { cwd: res.cwd || t('cli.defaultCwd') }), false);
        return res;
      } else {
        const errMsg = res?.error ? translateBackendText(res.error) : t('cli.notFound');
        showCliToast(t('cli.failed', { err: errMsg }), true);
        return res || { ok: false, error: errMsg };
      }
    } catch (err) {
      const errMsg = err?.message ? translateBackendText(err.message) : t('cli.exception');
      lastCliLaunchResult = { ok: false, error: errMsg };
      showCliToast(t('cli.failed', { err: errMsg }), true);
      return lastCliLaunchResult;
    } finally {
      cliLaunchBusy = false;
      btn?.removeAttribute('data-busy');
      btn?.removeAttribute('data-pressed');
      if (label) label.textContent = 'CLI';
    }
  }

  const badgeCliEl = el('badge-cli');
  if (badgeCliEl) {
    const releasePress = () => {
      badgeCliEl.removeAttribute('data-pressed');
    };
    badgeCliEl.addEventListener('pointerdown', () => {
      badgeCliEl.setAttribute('data-pressed', 'true');
    });
    badgeCliEl.addEventListener('pointerup', releasePress);
    badgeCliEl.addEventListener('pointercancel', releasePress);
    badgeCliEl.addEventListener('mouseleave', releasePress);
    badgeCliEl.addEventListener('blur', releasePress);
    badgeCliEl.addEventListener('click', () => {
      releasePress();
      void triggerLaunchCli();
    });
  }
  el('overflow-cli-btn')?.addEventListener('click', () => { void triggerLaunchCli(); });

  function isUnifiedDrawerRoutingEnabled() {
    if (typeof window === 'undefined') return false;
    if (window.__AG_METER_UNIFIED_DRAWER__ === false) return false;
    if (window.__AG_METER_UNIFIED_DRAWER__ === true) return true;
    return typeof HTMLElement === 'function' && typeof window.requestAnimationFrame === 'function';
  }

  el('badge-quota')?.addEventListener('click', () => {
    if (isUnifiedDrawerRoutingEnabled() && typeof toggleUnifiedInspector === 'function') {
      toggleUnifiedInspector({ tab: 'quota' });
      return;
    }
    toggleQuota('badge-quota');
  });
  el('badge').addEventListener('click', () => {
    if (isUnifiedDrawerRoutingEnabled() && typeof toggleUnifiedInspector === 'function') {
      toggleUnifiedInspector({ tab: 'live', sub: 'overview' });
      return;
    }
    toggleContext('badge');
  });
  el('badge-speed')?.addEventListener('click', () => {
    if (isUnifiedDrawerRoutingEnabled() && typeof toggleUnifiedInspector === 'function') {
      toggleUnifiedInspector({ tab: 'history', sub: 'speed' });
      return;
    }
    toggleContext('badge-speed');
  });
  el('badge-tokens').addEventListener('click', () => {
    if (isUnifiedDrawerRoutingEnabled() && typeof toggleUnifiedInspector === 'function') {
      toggleUnifiedInspector({ tab: 'history', sub: 'usage' });
      return;
    }
    toggleTokens('badge-tokens');
  });
  el('badge-overflow')?.addEventListener('click', toggleOverflowMenu);
  el('overflow-quota-btn')?.addEventListener('click', () => {
    if (isUnifiedDrawerRoutingEnabled() && typeof toggleUnifiedInspector === 'function') {
      toggleUnifiedInspector({ tab: 'quota' });
      return;
    }
    activeQuotaAnchorId = 'badge-overflow';
    showPanel('quota');
  });
  el('overflow-speed-btn')?.addEventListener('click', () => {
    if (isUnifiedDrawerRoutingEnabled() && typeof toggleUnifiedInspector === 'function') {
      toggleUnifiedInspector({ tab: 'history', sub: 'speed' });
      return;
    }
    activeContextAnchorId = 'badge-overflow';
    showPanel('context');
  });
  el('overflow-tokens-btn')?.addEventListener('click', () => {
    if (isUnifiedDrawerRoutingEnabled() && typeof toggleUnifiedInspector === 'function') {
      toggleUnifiedInspector({ tab: 'history', sub: 'usage' });
      return;
    }
    activeTokensAnchorId = 'badge-overflow';
    showPanel('tokens');
  });
  el('close').addEventListener('click', () => showPanel('none'));
  el('close-tokens')?.addEventListener('click', () => showPanel('none'));
  el('close-quota')?.addEventListener('click', () => showPanel('none'));
  el('badge-quota')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });

  // 上下文圆环与模型额度双环悬停/键盘聚焦气泡（面板打开时不通过悬停误切，必须通过显式左键点击切换）
  el('badge').addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen()) {
      showContextTooltip();
    }
  });
  el('badge').addEventListener('mouseleave', () => {
    hideContextTooltip();
  });
  el('badge').addEventListener('focus', () => {
    if (!isAnyPanelOpen()) showContextTooltip();
  });
  el('badge').addEventListener('blur', () => {
    hideContextTooltip();
  });
  el('badge-quota')?.addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen()) {
      showQuotaTooltip();
    }
  });
  el('badge-quota')?.addEventListener('mouseleave', () => {
    hideQuotaTooltip();
  });
  el('badge-quota')?.addEventListener('focus', () => {
    if (!isAnyPanelOpen()) showQuotaTooltip();
  });
  el('badge-quota')?.addEventListener('blur', () => {
    hideQuotaTooltip();
  });
  el('badge-speed')?.addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen()) showSpeedTooltip();
  });
  el('badge-speed')?.addEventListener('mouseleave', hideSpeedTooltip);
  el('badge-speed')?.addEventListener('focus', () => {
    if (!isAnyPanelOpen()) showSpeedTooltip();
  });
  el('badge-speed')?.addEventListener('blur', hideSpeedTooltip);
  el('badge-tokens')?.addEventListener('mouseenter', () => {
    if (!isAnyPanelOpen()) showTokensTooltip();
  });
  el('badge-tokens')?.addEventListener('mouseleave', hideTokensTooltip);
  el('badge-tokens')?.addEventListener('focus', () => {
    if (!isAnyPanelOpen()) showTokensTooltip();
  });
  el('badge-tokens')?.addEventListener('blur', hideTokensTooltip);

  el('theme-toggle')?.addEventListener('click', cycleTheme);
  el('theme-toggle-tokens')?.addEventListener('click', cycleTheme);
  el('badge').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-tokens').addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });
  el('badge-speed')?.addEventListener('contextmenu', e => { e.preventDefault(); cycleTheme(); });

  // =========================================================================
  // 模块 3: 上下文面板分页、设置视图、模型产品偏好、重启验证与速度对比
  // =========================================================================
  const btnTabSession = el('tab-ctx-session');
  const btnTabModels = el('tab-ctx-models');
  const btnTabSpeed = el('tab-ctx-speed');
  const btnTabSettings = el('tab-ctx-settings');
  const paneSession = el('pane-ctx-session');
  const paneModels = el('pane-ctx-models');
  const paneSpeed = el('pane-ctx-speed');
  const paneSettings = el('pane-ctx-settings');
  const ctxTabsBar = el('ctx-tabs-bar');
  const btnCtxSettings = el('btn-ctx-settings');
  const btnCtxSettingsBack = el('btn-ctx-settings-back');
  const btnGotoModelSettings = el('btn-goto-model-settings');
  const btnCardGotoSpeed = el('btn-card-goto-speed');
  const btnCtxBackCurrent = el('btn-ctx-back-current');
  const ctxCompactSavedEl = el('ctx-compact-saved');
  const ctxCompactClientEl = el('ctx-compact-client');

  const btnToggleUnlockDetails = el('btn-toggle-unlock-details');
  const unlockDrawerBody = el('unlock-drawer-body');
  const unlockDrawerArrow = el('unlock-drawer-arrow');
  const unlockBadge = el('unlock-badge');
  const unlockStatusDesc = el('unlock-status-desc');
  const ctxClientStatusText = el('ctx-client-status-text');
  const ctxRestartMismatchNote = el('ctx-restart-mismatch-note');
  const btnRestartHost = el('btn-restart-host');
  const ctxManualRestartNote = el('ctx-manual-restart-note');
  const ctxRestartConfirm = el('ctx-restart-confirm');
  const btnRestartCancel = el('btn-restart-cancel');
  const btnRestartConfirmGo = el('btn-restart-confirm-go');
  const ctxRestartFeedback = el('ctx-restart-feedback');
  const globalRestartModal = el('global-restart-modal');
  const modalRestartTitle = el('modal-restart-title');
  const modalRestartText = el('modal-restart-text');
  const modalRestartFeedback = el('modal-restart-feedback');
  const btnModalRestartCancel = el('btn-modal-restart-cancel');
  const btnModalRestartConfirm = el('btn-modal-restart-confirm');

  const btnApplyUnlock = el('btn-apply-unlock');
  const btnRestoreUnlock = el('btn-restore-unlock');
  const btnRefreshUnlock = el('btn-refresh-unlock');
  const unlockResultBox = el('unlock-result-box');
  const unlockResultText = el('unlock-result-text');
  const unlockResultActions = el('unlock-result-actions');
  const btnUnlockResultRestart = el('btn-unlock-result-restart');
  const btnUnlockResultRetry = el('btn-unlock-result-retry');
  const unlockResultManual = el('unlock-result-manual');
  const unlockMetaMode = el('unlock-meta-mode');
  const unlockMetaTarget = el('unlock-meta-target');
  const unlockMetaArch = el('unlock-meta-arch');
  const unlockMetaBackup = el('unlock-meta-backup');
  const linkUnlockAuthor = el('link-unlock-author');
  const btnCopyUnlockLink = el('btn-copy-unlock-link');
  const unlockLinkToast = el('unlock-link-toast');

  const ctxModelSelect = el('ctx-model-select');
  const ctxModelSelectorRoleEl = el('ctx-model-selector-role');
  const ctxModelDropdownLabelEl = el('ctx-model-dropdown-label');
  const ctxModelListEl = el('ctx-model-list');
  const ctxConflictBanner = el('ctx-conflict-banner');
  const ctxConflictRows = el('ctx-conflict-rows');
  const ctxCardVendorDot = el('ctx-card-vendor-dot');
  const ctxCardVendorName = el('ctx-card-vendor-name');
  const ctxCardQuotaSlot = el('ctx-card-quota-slot');
  const ctxCardProductName = el('ctx-card-product-name');
  const ctxCardEffortsList = el('ctx-card-efforts-list');
  const ctxCardSessionEffort = el('ctx-card-session-effort');
  const ctxCardSavedEl = el('ctx-card-saved');
  const ctxCardRequestEl = el('ctx-card-request');
  const ctxCardClientEl = el('ctx-card-client');
  const ctxCardClientTagEl = el('ctx-card-client-tag');
  const ctxCardObservedBudgetEl = el('ctx-card-observed-budget');
  const ctxCardPreRestartBudgetEl = el('ctx-card-pre-restart-budget');
  const ctxCardServiceLimitEl = el('ctx-card-service-limit');
  const ctxCardConvoEl = el('ctx-card-convo');
  const ctxCardDiagnosisEl = el('ctx-card-diagnosis');
  const ctxCardObservedSpeedEl = el('ctx-card-observed-speed');
  const ctxCardHintsEl = el('ctx-card-hints');
  const ctxCapWindowEl = el('ctx-cap-window');
  const ctxCapOutputEl = el('ctx-cap-output');
  const ctxCapModelMaxEl = el('ctx-cap-model-max');
  const ctxCapClientPolicyEl = el('ctx-cap-client-policy');
  const ctxCapDefaultEl = el('ctx-cap-default');
  const ctxCapRangeEl = el('ctx-cap-range');
  const ctxCapFormulaEl = el('ctx-cap-formula');
  const ctxRefSavedEl = el('ctx-ref-saved');
  const ctxRefSentEl = el('ctx-ref-sent');
  const ctxRefAdoptedEl = el('ctx-ref-adopted');
  const ctxUnifiedProjEl = el('ctx-unified-projection');
  const ctxCardTierCapsRowEl = el('ctx-card-tier-caps-row');
  const ctxCardTierCapsEl = el('ctx-card-tier-caps');
  const ctxPresetModelMaxSubEl = el('ctx-preset-modelmax-sub');

  const ctxPresetGrid = el('ctx-preset-grid');
  const ctxCustomInput = el('ctx-custom-limit-input');
  const ctxValidationEl = el('ctx-limit-validation');
  const btnSaveModelCtx = el('btn-save-model-ctx');
  const btnResetModelCtx = el('btn-reset-model-ctx');
  const ctxResetNoticeEl = el('ctx-reset-notice');

  // 双模式控件与精简展示元素
  const btnModeUnified = el('btn-ctx-mode-unified');
  const btnModePerModel = el('btn-ctx-mode-per-model');
  const ctxModelsToolbar = el('ctx-models-toolbar');
  const ctxSummaryModeEl = el('ctx-summary-mode');
  const ctxSummaryModelEl = el('ctx-summary-model');
  const ctxSummaryLengthEl = el('ctx-summary-length');
  const ctxSummaryStatusPillEl = el('ctx-summary-status-pill');

  const CTX_DEFAULT_TOKENS = 256000;
  const CTX_MIN_ENGINEERING_TOKENS = 16384;
  const CTX_MAX_ENGINEERING_TOKENS = 2097152;
  const CTX_ACTIVE_TAB_KEY = 'ag_ctx_active_tab';
  const CTX_PRE_RESTART_OBS_KEY = 'ag_ctx_pre_restart_obs_v1';

  const VENDOR_ORDER = ['Google', 'Anthropic', 'OpenAI', '其他'];
  const VENDOR_DOT_COLORS = {
    Google: 'var(--ag-custom-speed, var(--ag-speed-default, #38bdf8))',
    Anthropic: 'var(--ag-ring-warn, #f59e0b)',
    OpenAI: 'var(--ag-custom-token-accent, var(--ag-token-accent-default, #a78bfa))',
    '其他': 'var(--ag-text-muted, #8a8a94)'
  };

  let activeContextTab = 'session';
  try {
    const savedTab = localStorage?.getItem(CTX_ACTIVE_TAB_KEY);
    if (savedTab === 'session' || savedTab === 'models' || savedTab === 'speed') {
      activeContextTab = savedTab;
    }
  } catch { }
  let isContextSettingsView = false;

  let currentUnlockStatus = null;
  let unlockStatusFetchError = false;
  let isUnlocking = false;
  let lastPartialReason = '';
  let unlockReqSeq = 0;
  let contextPrefSaveSeq = 0;
  let contextPreferencesMap = {};
  let contextScopeMode = 'unified'; // 'unified' | 'per_model'
  let contextUnifiedPreference = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  try {
    const bootSettings = (typeof window !== 'undefined' && window.__AGContextMeterSettings?.ok)
      ? window.__AGContextMeterSettings
      : null;
    if (typeof window !== 'undefined' && window.__AGContextPreferences && typeof window.__AGContextPreferences === 'object') {
      contextPreferencesMap = { ...window.__AGContextPreferences };
    } else if (bootSettings?.contextPreferences && typeof bootSettings.contextPreferences === 'object') {
      contextPreferencesMap = { ...bootSettings.contextPreferences };
    } else if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
      const rawPrefs = localStorage.getItem('ag-context-preferences');
      if (rawPrefs) contextPreferencesMap = JSON.parse(rawPrefs) || {};
    }
    const initMode = (typeof window !== 'undefined' && window.__AGContextScopeMode)
      || bootSettings?.contextScopeMode
      || (typeof localStorage !== 'undefined' && localStorage?.getItem?.('ag-context-scope-mode'))
      || '';
    if (initMode === 'unified' || initMode === 'per_model') {
      contextScopeMode = initMode;
    } else if (Object.values(contextPreferencesMap).some(p => p && p.mode && p.mode !== 'default')) {
      contextScopeMode = 'per_model';
    }
    if (typeof window !== 'undefined' && window.__AGContextUnifiedPreference && typeof window.__AGContextUnifiedPreference === 'object') {
      contextUnifiedPreference = { ...window.__AGContextUnifiedPreference };
    } else if (bootSettings?.contextUnifiedPreference && typeof bootSettings.contextUnifiedPreference === 'object') {
      contextUnifiedPreference = { ...bootSettings.contextUnifiedPreference };
    } else if (typeof localStorage !== 'undefined' && localStorage?.getItem) {
      const rawUni = localStorage.getItem('ag-context-unified-preference');
      if (rawUni) contextUnifiedPreference = JSON.parse(rawUni) || contextUnifiedPreference;
    }
  } catch { }

  function getContextScopeMode() {
    return contextScopeMode || 'unified';
  }

  function getContextUnifiedPreference() {
    return contextUnifiedPreference || { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  }

  function syncContextPreferencesCache(map) {
    try {
      if (typeof window !== 'undefined') {
        const cleanMap = { ...(map || {}) };
        const cleanUni = { ...(contextUnifiedPreference || {}) };
        window.__AGContextPreferences = cleanMap;
        window.__AGContextScopeMode = contextScopeMode;
        window.__AGContextUnifiedPreference = cleanUni;
        if (window.__AGContextMeterSettings && typeof window.__AGContextMeterSettings === 'object') {
          window.__AGContextMeterSettings = {
            ...window.__AGContextMeterSettings,
            contextPreferences: cleanMap,
            contextScopeMode,
            contextUnifiedPreference: cleanUni
          };
        }
        localStorage?.setItem('ag-context-preferences', JSON.stringify(cleanMap));
        localStorage?.setItem('ag-context-scope-mode', contextScopeMode);
        localStorage?.setItem('ag-context-unified-preference', JSON.stringify(cleanUni));
      }
    } catch { }
  }
  let activeSessionModelKey = null;
  let activeSessionProductKey = null;
  let activeSessionEffort = null;
  let activeSessionModelConfirmed = false;
  let selectedEditModelKey = null;
  let selectedProductKey = null;
  let manualModelSelection = false;
  let ctxDraft = { mode: 'default', limitTokens: CTX_DEFAULT_TOKENS };
  let ctxDraftDirty = false;
  let lastAutoObservedBudget = 0;
  let needsRestartAfterApply = false;
  let pendingUpdateRestart = false;
  let pendingRestartVerification = null;
  let restartTimeoutTimer = null;
  let hostSupportsRestart = true;
  let restartMismatchNotice = '';

  const observedByModelId = new Map();
  let preRestartSnapshot = null;
  try {
    const rawPre = localStorage?.getItem(CTX_PRE_RESTART_OBS_KEY);
    if (rawPre) preRestartSnapshot = JSON.parse(rawPre);
  } catch { }

  let speedRangeDays = '7';
  let speedOriginFilter = 'all';
  let speedMetric = 'tps';
  let selectedSpeedExactModelId = null;
  let ctxHeaderDropdownCtrl = null;
  let speedModelDropdownCtrl = null;

  function formatKShort(tokens) {
    const n = Number(tokens);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (typeof formatTokensK === 'function') return formatTokensK(n);
    return short(n);
  }

  function formatMonthDayTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return '';
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${mm}-${dd} ${hh}:${mi}`;
  }

  function formatEffortZh(effort) {
    if (!effort) return '';
    const lang = typeof getPanelLanguage === 'function' ? getPanelLanguage() : 'zh-CN';
    if (typeof formatEffortLabel === 'function') return formatEffortLabel(effort, lang);
    return String(effort);
  }

  /**
   * 合并模型产品名与档位后缀，严格剥离尾部重复档位括号，避免出现 "(High) (High)"。
   */
  function formatProductDisplayWithEffort(rawLabel, explicitEffort = null) {
    const text = String(rawLabel || '').trim();
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : null;
    if (core && typeof core.splitModelDisplayAndEffort === 'function') {
      const split = core.splitModelDisplayAndEffort(text, explicitEffort || null);
      const base = split.baseLabel || text;
      const eff = explicitEffort || split.effort;
      if (!eff) return base;
      const effDisp = formatEffortZh(eff);
      if (!effDisp) return base;
      return `${base} (${effDisp})`;
    }
    if (!explicitEffort) return text;
    const effDisp = formatEffortZh(explicitEffort);
    if (!effDisp) return text;
    const low = text.toLowerCase();
    const rawEff = String(explicitEffort).trim().toLowerCase();
    if (low.endsWith(`(${rawEff})`) || low.endsWith(`(${effDisp.toLowerCase()})`)) {
      return text;
    }
    return `${text} (${effDisp})`;
  }

  function groupProductSafe(input) {
    if (typeof groupModelProduct === 'function') return groupModelProduct(input || {});
    const rawId = String(input?.modelId || input?.label || 'unknown').trim();
    const low = rawId.toLowerCase();
    const vendor = low.includes('claude') ? 'Anthropic' : (low.includes('gpt') || low.includes('o1') || low.includes('o3')) ? 'OpenAI' : (low.includes('gemini') ? 'Google' : '其他');
    return { productKey: low, productLabel: input?.label || rawId, vendor, effort: input?.effort || null };
  }

  function resolveStableModelKeyClient(rawOrLatest) {
    if (!rawOrLatest) return null;
    if (typeof resolveStableModelId === 'function') {
      const resolved = resolveStableModelId(rawOrLatest, state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []);
      if (resolved) return resolved;
    }
    if (typeof rawOrLatest === 'string') {
      const s = rawOrLatest.trim().toLowerCase();
      return s || null;
    }
    const str = String(rawOrLatest.modelId || rawOrLatest.modelRaw || rawOrLatest.model || '').trim().toLowerCase();
    return str || null;
  }
