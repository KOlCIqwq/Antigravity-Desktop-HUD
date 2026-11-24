  // =========================================================================
  // Prototype B "Quiet Inspector" right slide-out unified inspector
  // 1-to-1 Top Bar Routing · Concise Inset Cards · Animations · Hover Tooltips
  // =========================================================================
  const inspectorState = {
    open: false,
    tab: 'live', // 'live' | 'quota' | 'history'
    liveSub: 'overview', // 'overview' | 'browser' | 'activity'
    historySub: 'usage', // 'usage' | 'speed' | 'sessions'
    gearOpen: false,
    overrideFeedback: '',
    overrideFeedbackError: false,
    targetCascadeId: null,
    loading: false,
    error: '',
    deepDive: null,
    insightsLoading: false,
    insightsError: '',
    insights: null,
    // Live -> Overview Trend
    trendGranularity: 'turn', // 'step' | 'turn'
    trendMode: 'total', // 'total' | 'delta'
    pinnedTrendIdx: null,
    // Live -> Browser
    browserMode: 'grouped', // 'grouped' | 'dna'
    browserStepLimit: null,
    browserSearch: '',
    browserToolSort: 'size',
    browserAssistantFilter: 'all',
    browserFilter: 'all', // 'all' | 'chat' | 'tools' | 'errors'
    browserExpandedGroups: new Set(['assistant', 'user']),
    browserExpandedItems: new Set(),
    browserRawItems: new Set(),
    // Live -> Activity
    actSection: 'files', // 'files' | 'commands' | 'events' | 'timeline'
    fileFilter: 'all',
    fileSort: 'churn', // 'churn' | 'touches' | 'name'
    fileSearch: '',
    expandedFiles: new Set(),
    cmdStatusFilter: 'all',
    cmdSort: 'recent', // 'recent' | 'slowest' | 'errors'
    cmdProgramFilter: '',
    cmdSearch: '',
    expandedCmds: new Set(),
    eventFilter: 'all',
    // History
    usageRange: '7d', // '1d' | '7d' | '30d'
    speedRange: 'all', // '7d' | '30d' | 'all'
    costExpanded: false,
    insightsRange: '30d',
    insightsSearch: '',
    insightsSort: 'recent',
    insightsTagFilter: null,
    expandedSessionParents: new Set()
  };

  function escHtml(val) {
    return String(val ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function basenameOf(p) {
    if (!p) return '';
    const s = String(p).replace(/[\\/]+$/, '');
    const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    return i >= 0 ? s.slice(i + 1) : s;
  }

  function fmtDurMs(ms) {
    if (ms == null || !Number.isFinite(Number(ms))) return '—';
    const v = Number(ms);
    if (v < 1000) return `${Math.round(v)}ms`;
    if (v < 60000) return `${(v / 1000).toFixed(1)}s`;
    const m = Math.floor(v / 60000);
    const s = Math.round((v % 60000) / 1000);
    return `${m}m${s}s`;
  }

  function fmtUsd(usd) {
    if (usd == null || !Number.isFinite(Number(usd))) return '—';
    const v = Number(usd);
    if (v === 0) return '$0.00';
    if (v < 0.01) return `$${v.toFixed(4)}`;
    return `$${v.toFixed(2)}`;
  }

  function fmtPct1(ratio) {
    if (ratio == null || !Number.isFinite(Number(ratio))) return '—';
    return `${(Number(ratio) * 100).toFixed(1)}%`;
  }

  function fmtRelTime(ms) {
    if (!ms || !Number.isFinite(Number(ms))) return '—';
    try {
      const d = new Date(Number(ms));
      const loc = currentPanelLanguage === 'en' ? 'en-US' : (currentPanelLanguage === 'zh-TW' ? 'zh-TW' : 'zh-CN');
      return d.toLocaleString(loc, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return '—'; }
  }

  function getInspectorColor(bucket) {
    const map = {
      systemPrompt: '#5E5CE6',
      tools: '#32ADE6',
      skills: '#FF375F',
      subagents: '#30B0C7',
      plugins: '#FF9F0A',
      chatMessages: '#30D158',
      user: '#0A84FF',
      assistant: '#5E5CE6',
      tool_result: '#30D158',
      summary: '#FF9F0A',
      system: '#8E8E93',
      error: '#FF453A'
    };
    return map[bucket] || '#8E8E93';
  }

  function describeTrendFlag(fl) {
    if (fl === 'checkpoint') return { title: 'Context Compaction', desc: 'Context summarized / compacted at checkpoint' };
    if (fl === 'model_switch') return { title: 'Model Switch', desc: 'Active model changed in this step/turn' };
    if (fl === 'skill_load') return { title: 'Skill Loaded', desc: 'A skill (SKILL.md) was loaded into context' };
    if (fl === 'subagent') return { title: 'Subagent', desc: 'Subagent delegated or resumed' };
    if (fl === 'error') return { title: 'Error', desc: 'Request or tool execution error occurred' };
    return { title: String(fl || 'Event'), desc: '' };
  }

  function renderFlagSvg(fl) {
    const color = fl === 'error' ? '#FF453A' : fl === 'checkpoint' ? '#FF9F0A' : fl === 'model_switch' ? '#0A84FF' : fl === 'skill_load' ? '#FF375F' : '#30B0C7';
    if (fl === 'checkpoint') {
      return `<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round"><path d="M2 3h8M3.5 6h5M2 9h8"/></svg>`;
    }
    if (fl === 'model_switch') {
      return `<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h8L8 2M10 8H2l2 2"/></svg>`;
    }
    if (fl === 'skill_load') {
      return `<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round"><path d="M6 1.5L7.3 4.7L10.5 6L7.3 7.3L6 10.5L4.7 7.3L1.5 6L4.7 4.7Z"/></svg>`;
    }
    if (fl === 'subagent') {
      return `<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="${color}" stroke-width="1.6" stroke-linecap="round"><circle cx="3" cy="3" r="1.4"/><circle cx="9" cy="9" r="1.4"/><path d="M3 4.4V7a2 2 0 0 0 2 2h2.6"/></svg>`;
    }
    return `<svg viewBox="0 0 12 12" width="10" height="10" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round"><path d="M6 2.5v4.5"/><circle cx="6" cy="9.2" r="0.6" fill="${color}"/></svg>`;
  }

  function normalizeInspectorRoute(tabName, subName) {
    const legacy = {
      overview: ['live', 'overview'],
      browser: ['live', 'browser'],
      activity: ['live', 'activity'],
      fleet: ['live', 'overview'],
      insights: ['history', 'sessions']
    };
    if (legacy[tabName]) return legacy[tabName];
    const tab = (tabName === 'quota' || tabName === 'history') ? tabName : 'live';
    if (tab === 'live') {
      const sub = (subName === 'overview' || subName === 'browser' || subName === 'activity')
        ? subName
        : (inspectorState.liveSub || 'overview');
      return ['live', sub];
    }
    if (tab === 'history') {
      const sub = (subName === 'usage' || subName === 'speed' || subName === 'sessions')
        ? subName
        : (inspectorState.historySub || 'usage');
      return ['history', sub];
    }
    return ['quota', null];
  }

  // =========================================================================
  // Floating Graph Hover Tooltip Engine
  // =========================================================================
  function hideInspectorChartTooltip() {
    const tip = el('insp-chart-tooltip');
    if (!tip) return;
    tip.classList?.remove?.('is-visible');
    tip.hidden = true;
  }

  function showInspectorChartTooltipForTarget(targetEl) {
    const tip = el('insp-chart-tooltip');
    const dialog = shadow.querySelector?.('.ag-inspector-dialog') || el('panel-inspector')?.querySelector?.('.ag-inspector-dialog');
    if (!tip || !targetEl) return;
    const title = targetEl.getAttribute?.('data-tip-title') || '';
    const meta = targetEl.getAttribute?.('data-tip-meta') || '';
    if (!title && !meta) return;

    tip.innerHTML = `<div class="insp-tip-title">${escHtml(title)}</div>${meta ? `<div class="insp-tip-meta">${escHtml(meta)}</div>` : ''}`;
    tip.hidden = false;

    if (dialog && typeof targetEl.getBoundingClientRect === 'function' && typeof dialog.getBoundingClientRect === 'function') {
      const dRect = dialog.getBoundingClientRect();
      const tRect = targetEl.getBoundingClientRect();
      const tipW = Math.min(250, Math.max(150, tip.offsetWidth || 180));
      const tipH = tip.offsetHeight || 48;
      let left = (tRect.left - dRect.left) + (tRect.width / 2) - (tipW / 2);
      left = Math.max(10, Math.min((dRect.width || 500) - tipW - 10, left));
      let top = (tRect.top - dRect.top) - tipH - 8;
      if (top < 8) top = (tRect.bottom - dRect.top) + 8;
      if (tip.style) {
        tip.style.left = `${Math.round(left)}px`;
        tip.style.top = `${Math.round(top)}px`;
      }
    }
    tip.classList?.add?.('is-visible');
  }

  // =========================================================================
  // Skeleton / Empty / Error / Header
  // =========================================================================
  function renderInspectorSkeleton(pane) {
    pane.innerHTML = `<div class="insp-tab-enter">
      <div class="insp-skel insp-skel-comp"></div>
      <div class="insp-skel-grid" aria-busy="true" aria-label="${escHtml(t('inspector.loading'))}">
        <div class="insp-skel insp-skel-kpi"></div>
        <div class="insp-skel insp-skel-kpi"></div>
      </div>
      <div class="insp-skel insp-skel-trend"></div>
    </div>`;
  }

  function renderInspectorEmpty(pane, showSessionsCta = false) {
    pane.innerHTML = `<div class="insp-tab-enter"><div class="insp-card">
      <div class="insp-empty-state">
        <svg class="insp-empty-icon" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 3L3 8l9 5 9-5-9-5z"></path>
          <path d="M3 12.5l9 5 9-5"></path>
          <path d="M3 17l9 5 9-5"></path>
        </svg>
        <div>${escHtml(t('inspector.noSessionHint'))}</div>
        ${showSessionsCta ? `<button class="insp-mini-btn is-primary" type="button" data-insp-go-sessions="1">${escHtml(t('inspector.openInsights'))}</button>` : ''}
      </div>
    </div></div>`;
    pane.querySelector('[data-insp-go-sessions]')?.addEventListener('click', () => switchInspectorTab('history', 'sessions'));
  }

  function renderInspectorError(pane, message, retryFn) {
    pane.innerHTML = `<div class="insp-tab-enter">
      <div class="insp-error-card" role="alert">
        <span>${escHtml(message)}</span>
        <button class="insp-mini-btn" type="button" data-insp-retry="1">${escHtml(t('inspector.retry'))}</button>
      </div>
    </div>`;
    pane.querySelector('[data-insp-retry]')?.addEventListener('click', retryFn);
  }

  function syncInspectorTargetHeader() {
    const badgeEl = el('inspector-session-badge');
    const backBtn = el('btn-inspector-back-current');
    const activeCid = inspectorState.targetCascadeId || state.route || '';
    if (badgeEl) {
      const title = inspectorState.deepDive?.title || state.latest?.model || (activeCid ? activeCid.slice(0, 8) : t('inspector.noSession'));
      badgeEl.textContent = activeCid ? `${title} · ${activeCid.slice(0, 8)}` : t('inspector.noSession');
    }
    if (backBtn) {
      backBtn.hidden = !(state.route && inspectorState.targetCascadeId && inspectorState.targetCascadeId.toLowerCase() !== state.route.toLowerCase());
    }
  }

  // =========================================================================
  // Data Fetchers
  // =========================================================================
  async function fetchInspectorDeepDive(force = false) {
    const cid = inspectorState.targetCascadeId || state.route;
    if (!cid) {
      inspectorState.deepDive = null;
      inspectorState.error = '';
      renderInspectorActiveTab();
      return null;
    }
    const hasIpc = typeof window !== 'undefined' && typeof window.contextMeterAPI?.getSessionDeepDive === 'function';
    const hasLive = hasLiveHttpBridge() && hasLiveRouteCapability('/session-deep-dive');
    if (!hasIpc && !hasLive) {
      inspectorState.error = t('inspector.bridgeMissing');
      renderInspectorActiveTab();
      return null;
    }
    inspectorState.loading = true;
    inspectorState.error = '';
    renderInspectorActiveTab();
    try {
      const configs = state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || [];
      const out = await callBackendWithPriority({
        ipcCall: hasIpc ? () => window.contextMeterAPI.getSessionDeepDive(cid, { force: Boolean(force), cascadeModelConfigs: configs }) : null,
        liveRoute: '/session-deep-dive',
        liveBody: {
          id: cid,
          force: Boolean(force),
          cascadeModelConfigs: configs,
          origin: typeof window !== 'undefined' ? (window.location?.origin || undefined) : undefined
        }
      });
      const resObj = out?.result;
      if (cid !== (inspectorState.targetCascadeId || state.route)) return null;
      if (resObj?.ok && resObj.data) {
        inspectorState.deepDive = resObj.data;
        inspectorState.pinnedTrendIdx = null;
        inspectorState.browserStepLimit = null;
      } else {
        inspectorState.error = resObj?.error || t('inspector.loadFailed');
      }
    } catch (e) {
      inspectorState.error = e?.message || t('inspector.loadFailed');
    } finally {
      inspectorState.loading = false;
      syncInspectorTargetHeader();
      renderInspectorActiveTab();
    }
    return inspectorState.deepDive;
  }

  async function fetchInspectorInsights(force = false) {
    const hasIpc = typeof window !== 'undefined' && typeof window.contextMeterAPI?.getCrossSessionInsights === 'function';
    const hasLive = hasLiveHttpBridge() && hasLiveRouteCapability('/cross-session-insights');
    if (!hasIpc && !hasLive) {
      inspectorState.insightsError = t('inspector.bridgeMissing');
      renderInspectorActiveTab();
      return null;
    }
    inspectorState.insightsLoading = true;
    inspectorState.insightsError = '';
    renderInspectorActiveTab();
    try {
      const out = await callBackendWithPriority({
        ipcCall: hasIpc ? () => window.contextMeterAPI.getCrossSessionInsights({ force: Boolean(force) }) : null,
        liveRoute: '/cross-session-insights',
        liveBody: {
          force: Boolean(force),
          origin: typeof window !== 'undefined' ? (window.location?.origin || undefined) : undefined
        }
      });
      const resObj = out?.result;
      if (resObj?.ok && resObj.data) {
        inspectorState.insights = resObj.data;
      } else {
        inspectorState.insightsError = resObj?.error || t('inspector.loadFailed');
      }
    } catch (e) {
      inspectorState.insightsError = e?.message || t('inspector.loadFailed');
    } finally {
      inspectorState.insightsLoading = false;
      renderInspectorActiveTab();
    }
    return inspectorState.insights;
  }

  // =========================================================================
  // Gear Settings Popover (Minimal Context Override, Lang, Theme)
  // =========================================================================
  function syncInspectorGearPopover() {
    const pop = el('insp-gear-popover');
    const gearBtn = el('insp-gear-btn');
    if (gearBtn) gearBtn.setAttribute?.('aria-expanded', String(Boolean(inspectorState.gearOpen)));
    if (!pop) return;
    pop.hidden = !inspectorState.gearOpen;
    if (!inspectorState.gearOpen) return;

    const sel = el('insp-override-model');
    const limInput = el('insp-override-limit');
    const restartBtn = el('insp-override-restart');
    const fbEl = el('insp-override-feedback');
    if (sel) {
      const products = typeof getKnownModelProducts === 'function' ? getKnownModelProducts() : [];
      const curVal = sel.value || (contextScopeMode === 'unified' ? '__unified__' : (products[0]?.productKey || '__unified__'));
      const opts = [`<option value="__unified__">${escHtml(t('inspector.overrideAllModels'))}</option>`]
        .concat(products.map(p => `<option value="${escHtml(p.productKey)}">${escHtml(p.productLabel)}</option>`));
      sel.innerHTML = opts.join('');
      sel.value = curVal;
    }
    if (limInput && !limInput.value) {
      const prefLim = contextUnifiedPreference?.limitTokens || state.latest?.budget || 512000;
      limInput.value = String(prefLim);
    }
    if (restartBtn) restartBtn.hidden = !hostSupportsRestart;
    if (fbEl) {
      fbEl.hidden = !inspectorState.overrideFeedback;
      fbEl.textContent = inspectorState.overrideFeedback || '';
      fbEl.classList?.toggle?.('is-error', Boolean(inspectorState.overrideFeedbackError));
    }

    for (const lg of ['en', 'zh-CN', 'zh-TW']) {
      el(`insp-lang-${lg}`)?.classList?.toggle?.('active', currentPanelLanguage === lg);
    }
    const modeNow = typeof currentThemeMode === 'string' ? currentThemeMode : 'auto';
    for (const tm of ['auto', 'dark', 'light']) {
      el(`insp-theme-${tm}`)?.classList?.toggle?.('active', modeNow === tm);
    }
    const tp = typeof getToolbarPrefs === 'function' ? getToolbarPrefs() : { speedChart: 'area', quotaAnim: 'wave', miniHeatmap: true };
    el('insp-speed-area')?.classList?.toggle?.('active', tp.speedChart === 'area');
    el('insp-speed-bars')?.classList?.toggle?.('active', tp.speedChart === 'bars');
    el('insp-qanim-wave')?.classList?.toggle?.('active', tp.quotaAnim === 'wave');
    el('insp-qanim-instant')?.classList?.toggle?.('active', tp.quotaAnim === 'instant');
    el('insp-hm-on')?.classList?.toggle?.('active', tp.miniHeatmap !== false);
    el('insp-hm-off')?.classList?.toggle?.('active', tp.miniHeatmap === false);
  }

  async function applyInspectorContextOverride() {
    const sel = el('insp-override-model');
    const limInput = el('insp-override-limit');
    const targetVal = sel?.value || '__unified__';
    const num = Number(String(limInput?.value || '').replace(/[,\s_]/g, ''));
    if (!Number.isFinite(num) || num <= 0 || num > 10000000) {
      inspectorState.overrideFeedback = t('inspector.overrideInvalid');
      inspectorState.overrideFeedbackError = true;
      syncInspectorGearPopover();
      return;
    }
    const limitTokens = Math.round(num);
    let res;
    if (targetVal === '__unified__') {
      contextUnifiedPreference = {
        modelId: 'unified',
        mode: 'fixed',
        limitTokens,
        updatedAt: new Date().toISOString()
      };
      contextScopeMode = 'unified';
      res = await saveSettingsPayloadBridge({ contextUnifiedPreference, contextScopeMode: 'unified' });
    } else {
      const products = typeof getKnownModelProducts === 'function' ? getKnownModelProducts() : [];
      const prod = products.find(p => p.productKey === targetVal);
      if (prod) {
        const legacyKeys = typeof resolveProductPreferenceState === 'function' ? resolveProductPreferenceState(prod).legacyKeys : [];
        res = await saveSettingsPayloadBridge({
          contextPreference: {
            scope: 'product',
            productKey: prod.productKey,
            modelId: prod.productKey,
            label: prod.productLabel,
            mode: 'fixed',
            limitTokens,
            clearLegacyKeys: legacyKeys
          }
        });
      }
    }
    if (res && res.ok) {
      inspectorState.overrideFeedback = t('inspector.overrideSaved', { val: fmt(limitTokens) });
      inspectorState.overrideFeedbackError = false;
      syncContextPreferencesCache?.(contextPreferencesMap);
    } else {
      inspectorState.overrideFeedback = res?.error || t('msg.saveFail');
      inspectorState.overrideFeedbackError = true;
    }
    syncInspectorGearPopover();
  }

  // =========================================================================
  // Tab Navigation & Open/Close Drawer Lifecycle
  // =========================================================================
  function renderInspectorSubnav() {
    const subWrap = el('insp-subnav');
    if (!subWrap) return;
    if (inspectorState.tab === 'quota') {
      subWrap.hidden = true;
      subWrap.innerHTML = '';
      return;
    }
    subWrap.hidden = false;
    const defs = inspectorState.tab === 'live'
      ? [
          ['overview', t('inspector.subOverview')],
          ['browser', t('inspector.subBrowser')],
          ['activity', t('inspector.subActivity')]
        ]
      : [
          ['usage', t('inspector.subUsage')],
          ['speed', t('inspector.subSpeed')],
          ['sessions', t('inspector.subSessions')]
        ];
    const curSub = inspectorState.tab === 'live' ? inspectorState.liveSub : inspectorState.historySub;
    subWrap.innerHTML = `<div class="insp-subnav-track" role="tablist">${defs.map(([id, lbl]) =>
      `<button class="insp-sub-btn ${curSub === id ? 'active' : ''}" type="button" role="tab" aria-selected="${curSub === id}" data-insp-sub="${id}">${escHtml(lbl)}</button>`
    ).join('')}</div>`;
    subWrap.querySelectorAll('[data-insp-sub]').forEach(btn => btn.addEventListener('click', () => {
      switchInspectorTab(inspectorState.tab, btn.getAttribute('data-insp-sub'));
    }));
  }

  function syncTopBarDrawerActivePills() {
    const isOpen = Boolean(inspectorState.open);
    el('badge-quota')?.setAttribute('data-drawer-active', String(isOpen && inspectorState.tab === 'quota'));
    el('badge')?.setAttribute('data-drawer-active', String(isOpen && inspectorState.tab === 'live'));
    el('badge-speed')?.setAttribute('data-drawer-active', String(isOpen && inspectorState.tab === 'history' && inspectorState.historySub === 'speed'));
    el('badge-tokens')?.setAttribute('data-drawer-active', String(isOpen && inspectorState.tab === 'history' && inspectorState.historySub !== 'speed'));
  }

  function switchInspectorTab(tabName, subName) {
    hideInspectorChartTooltip();
    const [nextTab, nextSub] = normalizeInspectorRoute(tabName, subName);
    inspectorState.tab = nextTab;
    if (nextTab === 'live' && nextSub) inspectorState.liveSub = nextSub;
    if (nextTab === 'history' && nextSub) inspectorState.historySub = nextSub;

    for (const tb of ['live', 'quota', 'history']) {
      const btn = el(`tab-insp-${tb}`);
      const isAct = inspectorState.tab === tb;
      if (btn) {
        btn.classList?.toggle?.('active', isAct);
        btn.setAttribute?.('aria-selected', String(isAct));
      }
    }
    syncTopBarDrawerActivePills();
    renderInspectorSubnav();

    if (inspectorState.tab === 'live' && !inspectorState.deepDive && !inspectorState.loading && (inspectorState.targetCascadeId || state.route)) {
      void fetchInspectorDeepDive(false);
    } else if (inspectorState.tab === 'quota') {
      if (typeof maybeRefreshQuotaOnOpen === 'function') void maybeRefreshQuotaOnOpen();
    } else if (inspectorState.tab === 'history') {
      if (inspectorState.targetCascadeId && inspectorState.targetCascadeId !== state.route && (!inspectorState.deepDive || inspectorState.deepDive.cascadeId !== inspectorState.targetCascadeId) && !inspectorState.loading) {
        void fetchInspectorDeepDive(false);
      }
      if (!ANTIGRAVITY_TOKEN_DATA?.updatedAt && typeof syncTokenHistoryFromHost === 'function') {
        void syncTokenHistoryFromHost(false);
      }
      if (inspectorState.historySub === 'sessions' && !inspectorState.insights && !inspectorState.insightsLoading) {
        void fetchInspectorInsights(false);
      }
    }
    renderInspectorActiveTab();
  }

  let inspectorCloseTimer = null;
  let savedHostZIndex = null;

  function openInspector(opts = {}) {
    const modal = el('panel-inspector');
    if (!modal) return;
    if (inspectorCloseTimer) {
      clearTimeout(inspectorCloseTimer);
      inspectorCloseTimer = null;
    }
    showPanel('none');
    hideContextTooltip();
    if (typeof hideQuotaTooltip === 'function') hideQuotaTooltip();
    closeColorPicker(true);
    if (opts.cascadeId) {
      if (opts.cascadeId !== inspectorState.targetCascadeId) {
        inspectorState.deepDive = null;
        inspectorState.pinnedTrendIdx = null;
      }
      inspectorState.targetCascadeId = opts.cascadeId;
    } else if (!opts.keepTarget && state.route) {
      if (inspectorState.targetCascadeId !== state.route || (inspectorState.deepDive && inspectorState.deepDive.cascadeId !== state.route)) {
        inspectorState.deepDive = null;
        inspectorState.pinnedTrendIdx = null;
      }
      inspectorState.targetCascadeId = state.route;
    } else if (!inspectorState.targetCascadeId && state.route) {
      inspectorState.targetCascadeId = state.route;
    }
    if (savedHostZIndex === null && host?.style) {
      savedHostZIndex = host.style.zIndex || '';
      host.style.zIndex = '2147483500';
    }
    const isInstant = Boolean(opts.instant) || typeof requestAnimationFrame !== 'function';
    modal.classList?.toggle?.('is-instant', isInstant);
    inspectorState.open = true;
    modal.hidden = false;
    if (isInstant) {
      modal.classList?.add?.('is-open');
    } else {
      modal.classList?.remove?.('is-open');
      requestAnimationFrame(() => {
        if (inspectorState.open) modal.classList?.add?.('is-open');
      });
    }
    syncHostStackingElevation(true);
    syncInspectorTargetHeader();
    syncInspectorGearPopover();
    switchInspectorTab(opts.tab || inspectorState.tab || 'live', opts.sub);
    if (inspectorState.tab === 'live' && opts.force) {
      void fetchInspectorDeepDive(true);
    } else if (inspectorState.tab === 'history' && inspectorState.historySub === 'sessions' && (!inspectorState.insights || opts.force)) {
      void fetchInspectorInsights(Boolean(opts.force));
    }
  }

  function closeInspector(opts = {}) {
    const modal = el('panel-inspector');
    if (!modal) return;
    hideInspectorChartTooltip();
    inspectorState.gearOpen = false;
    if (inspectorCloseTimer) {
      clearTimeout(inspectorCloseTimer);
      inspectorCloseTimer = null;
    }
    inspectorState.open = false;
    syncTopBarDrawerActivePills();
    const isInstant = Boolean(opts.instant) || typeof requestAnimationFrame !== 'function';
    modal.classList?.toggle?.('is-instant', isInstant);
    modal.classList?.remove?.('is-open');
    const finishHide = () => {
      if (inspectorState.open) return;
      modal.hidden = true;
      modal.classList?.remove?.('is-instant');
      inspectorState.targetCascadeId = null;
      inspectorState.deepDive = null;
      if (savedHostZIndex !== null && host?.style) {
        host.style.zIndex = savedHostZIndex;
        savedHostZIndex = null;
      }
      if (!isAnyPanelOpen()) syncHostStackingElevation(false);
    };
    if (isInstant) {
      finishHide();
    } else {
      inspectorCloseTimer = setTimeout(() => {
        inspectorCloseTimer = null;
        finishHide();
      }, 220);
    }
  }

  function toggleUnifiedInspector(opts = {}) {
    const [targetTab, targetSub] = normalizeInspectorRoute(opts.tab || 'live', opts.sub);
    const sameTab = inspectorState.open && inspectorState.tab === targetTab && (
      targetTab === 'quota' ||
      (targetTab === 'live' && (!targetSub || inspectorState.liveSub === targetSub)) ||
      (targetTab === 'history' && (!targetSub || inspectorState.historySub === targetSub))
    );
    if (sameTab) {
      closeInspector(opts);
      return false;
    }
    openInspector({ ...opts, tab: targetTab, sub: targetSub });
    return true;
  }

  function copyTextToClipboard(text, btn) {
    const s = String(text ?? '');
    const markDone = () => {
      if (!btn) return;
      const orig = btn.dataset.origLabel || btn.textContent;
      btn.dataset.origLabel = orig;
      btn.textContent = 'Copied';
      setTimeout(() => { if (btn.isConnected) btn.textContent = orig; }, 1200);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(s).then(markDone).catch(() => {});
      return;
    }
    try {
      const ta = document.createElement('textarea');
      ta.value = s;
      ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      markDone();
    } catch {}
  }

  function jumpToAgySession(cid) {
    if (!cid) return;
    const targetPath = `/c/${cid}`;
    const link = document.querySelector(`a[href*="${cid}"], [data-cascade-id="${cid}"], [data-conversation-id="${cid}"]`);
    if (link && typeof link.click === 'function') {
      closeInspector();
      link.click();
      return;
    }
    if (/^https?:\/\/(?:127\.0\.0\.1|localhost):\d+$/i.test(location.origin) || /^\/c\/[a-f\d-]{36}/i.test(location.pathname)) {
      closeInspector();
      if (location.pathname !== targetPath) {
        location.assign(targetPath);
      }
      return;
    }
    openInspector({ cascadeId: cid, tab: 'live', sub: 'overview', force: true, keepTarget: true });
  }

  function jumpToBrowserStep(stepIndex) {
    inspectorState.tab = 'live';
    inspectorState.liveSub = 'browser';
    inspectorState.browserStepLimit = null;
    inspectorState.browserExpandedItems.add(`step:${stepIndex}`);
    const stepObj = inspectorState.deepDive?.browser?.steps?.find(s => s.stepIndex === stepIndex);
    if (stepObj) {
      inspectorState.browserExpandedGroups.add(stepObj.category);
      inspectorState.browserExpandedGroups.add(`turn:${stepObj.turnIndex ?? 0}`);
    }
    switchInspectorTab('live', 'browser');
    setTimeout(() => {
      const target = shadow.querySelector?.(`[data-insp-step="${stepIndex}"]`);
      target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    }, 30);
  }

  // =========================================================================
  // Tab 1: Live -> Overview / Browser / Activity
  // =========================================================================
  function renderLiveOverview(pane) {
    if (inspectorState.loading && !inspectorState.deepDive) { renderInspectorSkeleton(pane); return; }
    if (inspectorState.error && !inspectorState.deepDive) { renderInspectorError(pane, inspectorState.error, () => void fetchInspectorDeepDive(true)); return; }
    const dd = inspectorState.deepDive;
    if (!dd) { renderInspectorEmpty(pane, true); return; }

    const st = dd.stats || {};
    const isTurn = inspectorState.trendGranularity === 'turn';
    const isDelta = inspectorState.trendMode === 'delta';
    const series = isTurn ? (dd.trend?.byTurn || []) : (dd.trend?.byStep || []);
    const pinnedIdx = (inspectorState.pinnedTrendIdx != null && inspectorState.pinnedTrendIdx < series.length)
      ? inspectorState.pinnedTrendIdx
      : (series.length ? series.length - 1 : null);
    const activePt = (pinnedIdx != null && series[pinnedIdx]) ? series[pinnedIdx] : (series.length ? series[series.length - 1] : null);
    const isViewingPinned = Boolean(activePt && inspectorState.pinnedTrendIdx != null && pinnedIdx !== (series.length - 1));

    const comp = dd.currentComposition || {};
    const ptBuckets = activePt?.buckets || {};
    const ptBucketSum = Object.values(ptBuckets).reduce((acc, v) => acc + (Number(v) || 0), 0);
    const usedCtx = isViewingPinned
      ? (activePt.estimatedTokensUsed ?? comp.estimatedTokensUsed ?? state.latest?.actual ?? 0)
      : (comp.estimatedTokensUsed || state.latest?.actual || 0);
    const maxCtx = (isViewingPinned ? activePt.maxContextTokens : null) || comp.maxContextTokens || state.latest?.budget || 0;
    const curBuckets = comp.buckets || {};
    const staticSum = ['systemPrompt', 'tools', 'skills', 'subagents', 'plugins']
      .reduce((acc, k) => acc + (Number(curBuckets[k]) || 0), 0);
    let buckets = curBuckets;
    let compSource = comp.source;
    if (isViewingPinned) {
      if (ptBucketSum > 0) {
        buckets = ptBuckets;
        compSource = 'official';
      } else if (staticSum > 0) {
        // Historical calls often omit tokenBreakdown; preserve static prompt overhead and attribute the remainder to Chat & Tools
        const scale = usedCtx < staticSum ? (usedCtx / staticSum) : 1;
        buckets = {
          systemPrompt: Math.round((Number(curBuckets.systemPrompt) || 0) * scale),
          tools: Math.round((Number(curBuckets.tools) || 0) * scale),
          skills: Math.round((Number(curBuckets.skills) || 0) * scale),
          subagents: Math.round((Number(curBuckets.subagents) || 0) * scale),
          plugins: Math.round((Number(curBuckets.plugins) || 0) * scale),
          chatMessages: Math.max(0, usedCtx - staticSum)
        };
        compSource = comp.source || 'official';
      } else {
        buckets = { systemPrompt: 0, tools: 0, skills: 0, subagents: 0, plugins: 0, chatMessages: usedCtx };
        compSource = 'estimated';
      }
    }
    const pct = maxCtx > 0 ? Math.min(100, (usedCtx / maxCtx) * 100) : null;
    const compTag = isViewingPinned
      ? (isTurn
        ? (activePt.turnIndex != null ? `T${activePt.turnIndex}` : `#${pinnedIdx + 1}`)
        : `${activePt.primaryStepIndex != null ? `#${activePt.primaryStepIndex}` : `#${pinnedIdx + 1}`}${activePt.turnIndex != null ? ` · T${activePt.turnIndex}` : ''}`)
      : `${fmt(st.turns)}T · ${fmt(st.steps)}S`;

    const bucketDefs = [
      ['systemPrompt', t('inspector.bucket.systemPrompt')],
      ['tools', t('inspector.bucket.tools')],
      ['skills', t('inspector.bucket.skills')],
      ['subagents', t('inspector.bucket.subagents')],
      ['plugins', t('inspector.bucket.plugins')],
      ['chatMessages', t('inspector.bucket.chatMessages')]
    ];
    const barDenom = maxCtx > 0 ? maxCtx : Math.max(1, usedCtx);
    const barSegs = bucketDefs.map(([k, lbl]) => {
      const val = Number(buckets[k]) || 0;
      const w = (val / barDenom) * 100;
      return w > 0
        ? `<div class="insp-comp-seg insp-meter-fill" style="width:${w.toFixed(2)}%;background:${getInspectorColor(k)}" title="${escHtml(lbl)}: ${fmt(val)} tokens"></div>`
        : '';
    }).join('');

    const legendHtml = bucketDefs.map(([k, lbl]) => {
      const val = Number(buckets[k]) || 0;
      if (!val && compSource === 'estimated' && k !== 'chatMessages') return '';
      return `<div class="insp-legend-item">
        <span class="insp-dot" style="background:${getInspectorColor(k)}"></span>
        <span class="insp-legend-k">${escHtml(lbl)}</span>
        <span class="insp-legend-v">${short(val)}</span>
      </div>`;
    }).join('');

    // Technical metrics merging live generation experience + deep-dive stats
    const spEval = state.lastSpeedEval || (typeof evaluateGenerationExperience === 'function' ? evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage) : null);
    const streamStr = spEval?.streamSpeed != null ? `${spEval.streamSpeed} tok/s` : (spEval?.overallTps != null ? `${spEval.overallTps} tok/s` : '—');
    const ttftStr = spEval?.ttftFormatted || (spEval?.ttftSec != null ? `${spEval.ttftSec}s` : '—');
    const eScoreStr = spEval?.efficiency?.score != null ? `${spEval.efficiency.score} / 100` : '—';

    // Trend with rising animated bars + hover floating tooltip
    const vals = series.map(pt => pt.estimatedTokensUsed || 0);
    const minVal = vals.length ? Math.min(...vals) : 0;
    const maxVal = vals.length ? Math.max(...vals) : 1;
    const baseVal = (!isDelta && series.length > 2 && maxVal > minVal)
      ? Math.max(0, Math.floor(minVal * 0.85))
      : 0;
    const spanVal = Math.max(1, maxVal - baseVal);
    const maxAbsVal = Math.max(1, ...series.map(pt => isDelta ? Math.abs(pt.deltaTokens || 0) : (pt.estimatedTokensUsed || 0)));

    let peakSpike = { delta: 0, idx: -1 };
    let spikeCount = 0;
    series.forEach((pt, i) => {
      const d = pt.deltaTokens || 0;
      if (d > peakSpike.delta) peakSpike = { delta: d, idx: i };
      if (d >= 2500) spikeCount++;
    });
    const firstVal = vals[0] || 0;
    const lastVal = vals[vals.length - 1] || 0;
    const netGrowth = lastVal - firstVal;
    const avgGrowth = series.length > 1 ? Math.round(netGrowth / (series.length - 1)) : 0;

    const trendInsightStrip = series.length > 1
      ? `<div class="insp-trend-insight-strip">
          <span class="insp-trend-chip"><b>Total:</b> ${short(lastVal)}</span>
          <span class="insp-trend-chip"><b>Net:</b> ${netGrowth >= 0 ? '+' : ''}${short(netGrowth)}</span>
          <span class="insp-trend-chip"><b>Avg/Step:</b> +${short(avgGrowth)}</span>
          ${peakSpike.delta > 0 ? `<span class="insp-trend-chip"><b>Peak:</b> +${short(peakSpike.delta)} (#${peakSpike.idx + 1})</span>` : ''}
          ${spikeCount > 0 ? `<span class="insp-trend-chip"><b>Spikes:</b> ${spikeCount}</span>` : ''}
        </div>`
      : '';

    let trendChartHtml = '';
    if (series.length === 0) {
      trendChartHtml = `<div class="insp-trend-scroll"><div class="insp-empty">${escHtml(t('inspector.noTrend'))}</div></div>`;
    } else if (isDelta) {
      const barsHtml = series.map((pt, i) => {
        const isSelected = i === pinnedIdx;
        const flags = pt.flags || [];
        const flagsHtml = flags.slice(0, 2).map(fl => {
          const info = describeTrendFlag(fl);
          return `<span class="insp-flag-icon insp-flag-${escHtml(fl)}" data-insp-hover="flag" data-tip-title="${escHtml(info.title)}" data-tip-meta="${escHtml(info.desc)}">${renderFlagSvg(fl)}</span>`;
        }).join('');
        const tipTitle = isTurn ? `Turn #${pt.turnIndex}` : `Call #${i + 1} · Step #${pt.primaryStepIndex}`;
        const totVal = pt.estimatedTokensUsed || 0;
        const deltaVal = pt.deltaTokens || 0;
        const flagTags = flags.map(fl => describeTrendFlag(fl).title);
        if (deltaVal >= 8000) flagTags.push(`Heavy spike (+${short(deltaVal)})`);
        else if (deltaVal >= 2500) flagTags.push(`Spike (+${short(deltaVal)})`);
        const flagSummary = flagTags.length ? `\n${flagTags.join(' · ')}` : '';
        const tipMeta = `${deltaVal >= 0 ? '+' : ''}${short(deltaVal)} delta · ${short(totVal)} total${flagSummary}`;
        const h = Math.max(4, Math.round((Math.abs(deltaVal) / maxAbsVal) * 34));
        const cls = deltaVal < 0 ? 'is-neg' : 'is-pos';
        return `<button class="insp-bar-col ${isSelected ? 'is-selected' : ''}" type="button" data-trend-idx="${i}" data-insp-hover="trend" data-tip-title="${escHtml(tipTitle)}" data-tip-meta="${escHtml(tipMeta)}" style="--insp-i:${Math.min(i, 24)}">
          <span class="insp-bar-flags">${flagsHtml}</span>
          <span class="insp-delta-wrap">
            <span class="insp-delta-top">${deltaVal >= 0 ? `<span class="insp-delta-bar insp-bar-rise ${cls}" style="height:${h}px"></span>` : ''}</span>
            <span class="insp-delta-zero"></span>
            <span class="insp-delta-bot">${deltaVal < 0 ? `<span class="insp-delta-bar insp-bar-rise ${cls}" style="height:${h}px"></span>` : ''}</span>
          </span>
          <span class="insp-bar-lbl">${isTurn ? `T${pt.turnIndex}` : i + 1}</span>
        </button>`;
      }).join('');
      trendChartHtml = `<div class="insp-trend-scroll">${barsHtml}</div>`;
    } else {
      const W = 380, H = 112;
      const padL = 38, padR = 10, padT = 14, padB = 20;
      const plotW = W - padL - padR;
      const plotH = H - padT - padB;
      const yMax = Math.max(1000, maxVal);
      const n = series.length;
      const pts = series.map((pt, i) => {
        const val = pt.estimatedTokensUsed || 0;
        const x = n > 1 ? padL + (i / (n - 1)) * plotW : padL + plotW / 2;
        const y = padT + plotH - (val / yMax) * plotH;
        return { x, y, pt, i };
      });

      let lineD = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
      for (let i = 1; i < pts.length; i++) {
        const p0 = pts[i - 1];
        const p1 = pts[i];
        const mx = ((p0.x + p1.x) / 2).toFixed(1);
        lineD += ` C ${mx} ${p0.y.toFixed(1)}, ${mx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
      }
      const baseY = (padT + plotH).toFixed(1);
      const areaD = `${lineD} L ${pts[pts.length - 1].x.toFixed(1)} ${baseY} L ${pts[0].x.toFixed(1)} ${baseY} Z`;

      const yMid = (padT + plotH / 2).toFixed(1);
      const gridHtml = `
        <line x1="${padL}" y1="${padT}" x2="${W - padR}" y2="${padT}" stroke="rgba(128,128,128,0.16)" stroke-dasharray="2 3"/>
        <line x1="${padL}" y1="${yMid}" x2="${W - padR}" y2="${yMid}" stroke="rgba(128,128,128,0.16)" stroke-dasharray="2 3"/>
        <line x1="${padL}" y1="${baseY}" x2="${W - padR}" y2="${baseY}" stroke="rgba(128,128,128,0.28)"/>
        <text x="${padL - 5}" y="${padT + 3}" text-anchor="end" font-size="9" fill="currentColor" opacity="0.55">${escHtml(short(yMax))}</text>
        <text x="${padL - 5}" y="${Number(yMid) + 3}" text-anchor="end" font-size="9" fill="currentColor" opacity="0.55">${escHtml(short(Math.round(yMax / 2)))}</text>
        <text x="${padL - 5}" y="${Number(baseY) + 3}" text-anchor="end" font-size="9" fill="currentColor" opacity="0.55">0</text>
      `;

      const labelStep = Math.max(1, Math.ceil(n / 6));
      const colW = n > 1 ? Math.max(4, plotW / n) : plotW;
      const markersHtml = pts.map(({ x, y, pt, i }) => {
        const isSelected = i === pinnedIdx;
        const flags = pt.flags || [];
        const deltaVal = pt.deltaTokens || 0;
        const totVal = pt.estimatedTokensUsed || 0;
        const hasCheckpoint = flags.includes('checkpoint');
        const hasSkill = flags.includes('skill_load');
        const hasModelSwitch = flags.includes('model_switch');
        const isHeavy = deltaVal >= 8000;
        const isSpike = deltaVal >= 2500;

        const flagTags = flags.map(fl => describeTrendFlag(fl).title);
        if (isHeavy) flagTags.push(`Heavy spike (+${short(deltaVal)})`);
        else if (isSpike) flagTags.push(`Spike (+${short(deltaVal)})`);
        const flagSummary = flagTags.length ? `\n${flagTags.join(' · ')}` : '';
        const tipTitle = isTurn ? `Turn #${pt.turnIndex}` : `Call #${i + 1} · Step #${pt.primaryStepIndex}`;
        const tipMeta = `${short(totVal)} total (${deltaVal >= 0 ? '+' : ''}${short(deltaVal)}) · ${short(pt.usage?.cacheReadTokens || 0)} cache${flagSummary}`;

        let dotHtml = '';
        if (isSelected) {
          dotHtml = `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${baseY}" stroke="#38bdf8" stroke-width="1" stroke-dasharray="2 2" opacity="0.6"/>`
            + `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="#38bdf8" stroke="#0f172a" stroke-width="1.5"/>`;
        } else if (hasCheckpoint) {
          dotHtml = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.2" fill="#FF9F0A" stroke="#0f172a" stroke-width="1"/>`;
        } else if (isHeavy) {
          dotHtml = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.8" fill="#FF453A"/>`;
        } else if (isSpike) {
          dotHtml = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="#FF9F0A"/>`;
        } else if (hasSkill) {
          dotHtml = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="#FF375F"/>`;
        } else if (hasModelSwitch) {
          dotHtml = `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="2.4" fill="#0A84FF"/>`;
        }

        const showLbl = i === 0 || i === n - 1 || (i % labelStep === 0 && (n - 1 - i) >= Math.ceil(labelStep / 2));
        const lblText = isTurn ? `T${pt.turnIndex}` : `${i + 1}`;
        const lblHtml = showLbl
          ? `<text x="${x.toFixed(1)}" y="${H - 4}" text-anchor="middle" font-size="9" fill="currentColor" opacity="${isSelected ? '0.95' : '0.5'}">${escHtml(lblText)}</text>`
          : '';

        const rx = Math.max(padL, x - colW / 2);
        const hitHtml = `<rect class="insp-trend-hit ${isSelected ? 'is-selected' : ''}" x="${rx.toFixed(1)}" y="${padT}" width="${colW.toFixed(1)}" height="${plotH}" data-trend-idx="${i}" data-insp-hover="trend" data-tip-title="${escHtml(tipTitle)}" data-tip-meta="${escHtml(tipMeta)}"/>`;

        return `${dotHtml}${lblHtml}${hitHtml}`;
      }).join('');

      trendChartHtml = `<div class="insp-trend-area-wrap">
        <svg class="insp-trend-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
          <defs>
            <linearGradient id="insp-trend-area-grad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.34"/>
              <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.02"/>
            </linearGradient>
          </defs>
          ${gridHtml}
          <path d="${areaD}" fill="url(#insp-trend-area-grad)"/>
          <path d="${lineD}" fill="none" stroke="#38bdf8" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
          ${markersHtml}
        </svg>
        <div class="insp-trend-legend">
          <span class="insp-trend-legend-item"><span class="insp-trend-dot" style="background:#38bdf8"></span>Context size</span>
          <span class="insp-trend-legend-item"><span class="insp-trend-dot" style="background:#FF9F0A"></span>Spike / Compacted</span>
          <span class="insp-trend-legend-item"><span class="insp-trend-dot" style="background:#FF453A"></span>Heavy spike (≥8K)</span>
          <span class="insp-trend-legend-item"><span class="insp-trend-dot" style="background:#FF375F"></span>Skill</span>
        </div>
      </div>`;
    }

    let stepDetailHtml = '';
    if (activePt) {
      const isLatest = pinnedIdx == null || pinnedIdx === (series.length - 1);
      const ptTurn = activePt.turnIndex != null ? `T${activePt.turnIndex}` : '';
      const ptStep = activePt.primaryStepIndex != null ? `#${activePt.primaryStepIndex}` : (activePt.stepIndex != null ? `#${activePt.stepIndex}` : `#${(pinnedIdx ?? 0) + 1}`);
      const modelName = activePt.modelLabel || activePt.model || 'Model';
      const durStr = activePt.streamingMs ? fmtDurMs(activePt.streamingMs) : (activePt.ttftMs ? fmtDurMs(activePt.ttftMs) : '');
      const u = activePt.usage || {};
      const deltaVal = activePt.deltaTokens || 0;
      const deltaSign = deltaVal >= 0 ? `+${short(deltaVal)}` : short(deltaVal);
      const deltaCls = deltaVal < 0 ? 'insp-del' : 'insp-add';
      const cachePct = (u.inputTokens + u.cacheReadTokens) > 0 ? ((u.cacheReadTokens / (u.inputTokens + u.cacheReadTokens)) * 100).toFixed(0) : '0';

      const flagsChips = (activePt.flags || []).map(fl =>
        `<span class="insp-chip insp-chip-${escHtml(fl)}">${renderFlagSvg(fl)} ${escHtml(fl)}</span>`
      ).join('');

      const briefTxt = activePt.brief?.response || activePt.brief?.in || activePt.brief?.user || '';

      stepDetailHtml = `<div class="insp-trend-detail-panel" data-insp-step-detail="1">
        <div class="insp-row-head" style="margin-bottom:6px">
          <div style="display:flex;align-items:center;gap:6px;min-width:0;flex:1">
            <span class="insp-chip" style="font-weight:600">${isTurn ? ptTurn : `${ptStep} ${ptTurn}`}</span>
            <span class="insp-row-title" style="font-size:12px">${escHtml(modelName)}</span>
            ${durStr ? `<span class="insp-muted" style="font-size:11px">(${escHtml(durStr)})</span>` : ''}
          </div>
          <div style="display:flex;align-items:center;gap:6px">
            ${!isLatest ? `<button class="insp-mini-btn" type="button" data-trend-reset-pin="1">${escHtml(t('inspector.resetLatest'))}</button>` : ''}
            <button class="insp-mini-btn is-primary" type="button" data-jump-step="${activePt.primaryStepIndex ?? activePt.stepIndex ?? 0}">${escHtml(t('inspector.inspectStep'))} ▸</button>
          </div>
        </div>
        <div class="insp-kv-grid" style="margin-bottom:6px">
          <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.delta'))}</span><span class="insp-kv-v ${deltaCls}">${deltaSign}</span></div>
          <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.actualPrompt'))}</span><span class="insp-kv-v">${short(u.inputTokens || 0)}</span></div>
          <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.cached'))}</span><span class="insp-kv-v">${short(u.cacheReadTokens || 0)} (${cachePct}%)</span></div>
          <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.output'))}</span><span class="insp-kv-v">${short(u.outputTokens || 0)}${u.thinkingOutputTokens ? ` (${short(u.thinkingOutputTokens)} think)` : ''}</span></div>
        </div>
        ${flagsChips ? `<div class="insp-chip-row" style="margin-bottom:6px">${flagsChips}</div>` : ''}
        ${briefTxt ? `<div class="insp-trend-brief">${escHtml(briefTxt)}</div>` : ''}
      </div>`;
    }

    // Conditional Fleet card (hidden cleanly when no subagents & no parent)
    const fl = dd.fleet || {};
    const children = fl.children || [];
    const comms = fl.communications || [];
    const hasFleet = Boolean(fl.parent || (children && children.length > 0));
    const fleetHtml = hasFleet ? `<div class="insp-card" data-insp-fleet-card="1">
      <div class="insp-card-hdr-bar">
        <span class="insp-card-title">${escHtml(t('inspector.fleet.networkTitle'))}</span>
        <span class="insp-pill">${children.length} ${escHtml(t('inspector.fleet.children'))} · ${comms.length} ${escHtml(t('inspector.fleet.messages'))}</span>
      </div>
      <div class="insp-inset-list">
        ${fl.parent ? `<div class="insp-fleet-row"><div class="insp-row-head"><span class="insp-chip">Parent</span><span class="insp-row-title">${escHtml(fl.parent.cascadeId.slice(0, 8))}</span><button class="insp-mini-btn" type="button" data-inspect-cid="${escHtml(fl.parent.cascadeId)}">${escHtml(t('inspector.inspectSession'))}</button></div></div>` : ''}
        ${children.map(ch => `<div class="insp-fleet-row">
          <div class="insp-row-head">
            <span class="insp-chip">${escHtml(ch.type || 'subagent')}</span>
            <span class="insp-row-title">${escHtml(ch.role || ch.type || 'Subagent')}</span>
            <span class="insp-row-meta">${escHtml(ch.status || 'done')}</span>
            ${ch.cascadeId && /^[0-9a-f-]{36}$/i.test(ch.cascadeId) ? `<button class="insp-mini-btn" type="button" data-inspect-cid="${escHtml(ch.cascadeId)}">${escHtml(t('inspector.inspectSession'))}</button>` : ''}
          </div>
        </div>`).join('')}
      </div>
    </div>` : '';

    pane.innerHTML = `<div class="insp-tab-enter">
      <div class="insp-card insp-card-pad">
        <div class="insp-card-head">
          <span class="insp-card-title">${escHtml(t('inspector.compositionTitle'))}${isViewingPinned ? ` · ${escHtml(isTurn ? `T${activePt.turnIndex ?? pinnedIdx + 1}` : `#${activePt.primaryStepIndex ?? activePt.stepIndex ?? pinnedIdx + 1}`)}` : ''}</span>
          <span class="insp-pill">${escHtml(compTag)} · ${short(usedCtx)}${maxCtx && pct != null ? ` / ${short(maxCtx)} (${pct.toFixed(1)}%)` : ''}</span>
        </div>
        <div class="insp-comp-track">${barSegs}</div>
        <div class="insp-legend-grid">${legendHtml}</div>
        ${(Number(buckets.systemPrompt) || 0) + (Number(buckets.tools) || 0) + (Number(buckets.skills) || 0) + (Number(buckets.subagents) || 0) + (Number(buckets.plugins) || 0) > 0
          ? `<div class="insp-muted" style="font-size:11px;margin-top:8px;padding-top:6px;border-top:1px solid var(--insp-border-soft)">Sent as input tokens: <b>${short((Number(buckets.systemPrompt) || 0) + (Number(buckets.tools) || 0) + (Number(buckets.skills) || 0) + (Number(buckets.subagents) || 0) + (Number(buckets.plugins) || 0))}</b> prompt overhead (System + Tools + Skills + Subagents + Plugins/MCP) + <b>${short(Number(buckets.chatMessages) || 0)}</b> Chat &amp; Tools</div>`
          : ''}
      </div>

      <div class="insp-kv-grid">
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.streamSpeed'))}</span><span class="insp-kv-v">${escHtml(streamStr)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.ttft'))}</span><span class="insp-kv-v">${escHtml(ttftStr)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.eScore'))}</span><span class="insp-kv-v">${escHtml(eScoreStr)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpi.cacheHit'))}</span><span class="insp-kv-v">${fmtPct1(st.cacheHitRate)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpi.inOut'))}</span><span class="insp-kv-v">${short((st.tokens?.input || 0) + (st.tokens?.cacheRead || 0))} / ${short(st.tokens?.output)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpi.timing'))}</span><span class="insp-kv-v">${fmtDurMs(st.timing?.activeMs)}</span></div>
      </div>

      <div class="insp-card insp-card-pad">
        <div class="insp-card-head">
          <span class="insp-card-title">${escHtml(t('inspector.trendTitle'))}</span>
          <div class="insp-btn-row">
            <div class="insp-segmented">
              <button class="insp-seg-btn ${!isTurn ? 'active' : ''}" type="button" data-trend-gran="step">${escHtml(t('inspector.step'))}</button>
              <button class="insp-seg-btn ${isTurn ? 'active' : ''}" type="button" data-trend-gran="turn">${escHtml(t('inspector.turn'))}</button>
            </div>
            <div class="insp-segmented">
              <button class="insp-seg-btn ${!isDelta ? 'active' : ''}" type="button" data-trend-mode="total">${escHtml(t('inspector.total'))}</button>
              <button class="insp-seg-btn ${isDelta ? 'active' : ''}" type="button" data-trend-mode="delta">${escHtml(t('inspector.delta'))}</button>
            </div>
          </div>
        </div>
        ${trendInsightStrip}
        ${trendChartHtml}
        ${stepDetailHtml}
        ${series.length ? `<div class="insp-trend-hint">${escHtml(t('inspector.trendClickHint'))}</div>` : ''}
      </div>

      ${fleetHtml}
    </div>`;

    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const sc = pane.querySelector?.('.insp-trend-scroll');
        if (sc && sc.scrollWidth > sc.clientWidth) sc.scrollLeft = sc.scrollWidth;
      });
    }

    pane.querySelectorAll('[data-trend-gran]').forEach(btn => btn.addEventListener('click', () => {
      inspectorState.trendGranularity = btn.getAttribute('data-trend-gran');
      inspectorState.pinnedTrendIdx = null;
      renderLiveOverview(pane);
    }));
    pane.querySelectorAll('[data-trend-mode]').forEach(btn => btn.addEventListener('click', () => {
      inspectorState.trendMode = btn.getAttribute('data-trend-mode');
      renderLiveOverview(pane);
    }));
    pane.querySelectorAll('[data-trend-idx]').forEach(btn => btn.addEventListener('click', () => {
      inspectorState.pinnedTrendIdx = Number(btn.getAttribute('data-trend-idx'));
      renderLiveOverview(pane);
    }));
    pane.querySelector('[data-trend-reset-pin]')?.addEventListener('click', () => {
      inspectorState.pinnedTrendIdx = null;
      renderLiveOverview(pane);
    });
    pane.querySelectorAll('[data-jump-step]').forEach(btn => btn.addEventListener('click', () => {
      jumpToBrowserStep(Number(btn.getAttribute('data-jump-step')));

    }));
    pane.querySelectorAll('[data-inspect-cid]').forEach(btn => btn.addEventListener('click', () => {
      openInspector({ cascadeId: btn.getAttribute('data-inspect-cid'), tab: 'live', sub: 'overview', force: true, keepTarget: true });
    }));
  }

  function renderLiveBrowser(pane) {
    const dd = inspectorState.deepDive;
    if (inspectorState.loading && !dd) { renderInspectorSkeleton(pane); return; }
    if (inspectorState.error && !dd) { renderInspectorError(pane, inspectorState.error, () => void fetchInspectorDeepDive(true)); return; }
    if (!dd) { renderInspectorEmpty(pane, true); return; }

    const br = dd.browser || {};
    const allSteps = br.steps || [];
    const maxIdx = allSteps.length ? allSteps[allSteps.length - 1].stepIndex : 0;
    const limit = inspectorState.browserStepLimit == null ? maxIdx : inspectorState.browserStepLimit;
    const visibleSteps = allSteps.filter(s => s.stepIndex <= limit);
    const q = inspectorState.browserSearch.trim().toLowerCase();

    const stepOpts = [`<option value="">${escHtml(t('inspector.latestStep'))} (#${maxIdx})</option>`]
      .concat(allSteps.filter(s => s.category === 'user' || s.category === 'summary' || s.stepIndex === maxIdx)
        .map(s => `<option value="${s.stepIndex}" ${inspectorState.browserStepLimit === s.stepIndex ? 'selected' : ''}>#${s.stepIndex} T${s.turnIndex} · ${escHtml(s.title)}</option>`))
      .join('');

    const sectionsAll = (br.promptSections || []).filter(p => !q || `${p.title} ${p.content}`.toLowerCase().includes(q));
    const toolsAll = (br.tools || []).filter(tl => !q || `${tl.name} ${tl.description} ${tl.source}`.toLowerCase().includes(q))
      .sort((a, b) => inspectorState.browserToolSort === 'name' ? a.name.localeCompare(b.name) : (b.numTokens - a.numTokens));

    const filteredSteps = visibleSteps.filter(s => {
      if (inspectorState.browserFilter === 'chat' && s.category !== 'user' && s.category !== 'assistant') return false;
      if (inspectorState.browserFilter === 'tools' && s.category !== 'tool_result' && !(s.category === 'assistant' && s.toolCalls?.length)) return false;
      if (inspectorState.browserFilter === 'errors' && s.status !== 'error') return false;
      if (s.category === 'assistant') {
        if (inspectorState.browserAssistantFilter === 'thinking' && !s.thinking) return false;
        if (inspectorState.browserAssistantFilter === 'tools' && (!s.toolCalls || !s.toolCalls.length)) return false;
        if (inspectorState.browserAssistantFilter === 'answer' && !s.text) return false;
      }
      if (!q) return true;
      return `${s.title} ${s.text} ${s.thinking} ${s.argsText} ${s.resultText}`.toLowerCase().includes(q);
    });

    const turnGroupsMap = new Map();
    for (const s of filteredSteps) {
      const tIdx = s.turnIndex ?? 0;
      if (!turnGroupsMap.has(tIdx)) turnGroupsMap.set(tIdx, []);
      turnGroupsMap.get(tIdx).push(s);
    }
    const turnKeys = Array.from(turnGroupsMap.keys()).sort((a, b) => a - b);
    const allGroupKeys = ['system', 'tools', ...turnKeys.map(k => `turn:${k}`)];
    const allExpanded = allGroupKeys.length > 0 && allGroupKeys.every(g => inspectorState.browserExpandedGroups.has(g));
    const toggleAllBtn = `<button class="insp-mini-btn" type="button" data-br-toggle-all="${allExpanded ? 'collapse' : 'expand'}">${escHtml(t(allExpanded ? 'inspector.collapseAll' : 'inspector.expandAll'))}</button>`;
    const filterChips = ['all', 'chat', 'tools', 'errors'].map(f =>
      `<button class="insp-filter-chip ${inspectorState.browserFilter === f ? 'active' : ''}" type="button" data-br-filter="${f}">${escHtml(t(`inspector.filter${f.charAt(0).toUpperCase() + f.slice(1)}`))}</button>`
    ).join('');

    const asstFilterCtrl = `<div class="insp-segmented">
      ${['all', 'thinking', 'tools', 'answer'].map(f => `<button class="insp-seg-btn ${inspectorState.browserAssistantFilter === f ? 'active' : ''}" type="button" data-asst-filter="${f}">${escHtml(t(`inspector.asst.${f}`))}</button>`).join('')}
    </div>`;

    const controlsHtml = `<div class="insp-toolbar">
      <select id="insp-browser-step-sel" class="insp-select">${stepOpts}</select>
      <input id="insp-browser-search" class="insp-input" type="search" value="${escHtml(inspectorState.browserSearch)}" placeholder="${escHtml(t('inspector.searchPlaceholder'))}" />
      <div class="insp-segmented">
        <button class="insp-seg-btn ${inspectorState.browserMode === 'grouped' ? 'active' : ''}" type="button" data-br-mode="grouped">${escHtml(t('inspector.modeGrouped'))}</button>
        <button class="insp-seg-btn ${inspectorState.browserMode === 'dna' ? 'active' : ''}" type="button" data-br-mode="dna">DNA</button>
      </div>
    </div>
    <div class="insp-toolbar" style="margin-top:6px;gap:6px;justify-content:space-between">
      <div class="insp-chip-row">${filterChips}</div>
      <div class="insp-btn-row">${asstFilterCtrl}${toggleAllBtn}</div>
    </div>`;

    let bodyHtml = '';
    const copyPayloads = new Map();
    if (inspectorState.browserMode === 'dna') {
      const dnaItems = filteredSteps.slice().reverse();
      const ribbon = visibleSteps.map(s => `<span class="insp-dna-seg" style="flex:${Math.max(1, s.tokenEstimate || 1)};background:${getInspectorColor(s.category)}" title="#${s.stepIndex} ${escHtml(s.title)} (~${fmt(s.tokenEstimate)} tok)"></span>`).join('');
      const rows = dnaItems.map(s => {
        const key = `step:${s.stepIndex}`;
        const exp = inspectorState.browserExpandedItems.has(key);
        const body = [s.thinking ? `[Thinking]\n${s.thinking}` : '', s.text, s.argsText ? `[Args]\n${s.argsText}` : '', s.resultText ? `[Result]\n${s.resultText}` : ''].filter(Boolean).join('\n\n');
        return `<div class="insp-row" data-insp-step="${s.stepIndex}">
          <button class="insp-row-head" type="button" data-toggle-item="${escHtml(key)}">
            <span class="insp-pos">#${s.stepIndex}</span>
            <span class="insp-dot" style="background:${getInspectorColor(s.category)}"></span>
            <span class="insp-row-title">${escHtml(s.title)}</span>
            <span class="insp-row-meta">${s.tokenEstimated ? '~' : ''}${fmt(s.tokenEstimate)} tok</span>
          </button>
          ${exp ? `<pre class="insp-pre">${escHtml(body || '—')}</pre>` : ''}
        </div>`;
      }).join('');
      bodyHtml = `<div class="insp-dna-ribbon">${ribbon}</div><div class="insp-card"><div class="insp-inset-list">${rows || `<div class="insp-empty">${escHtml(t('inspector.noMatches'))}</div>`}</div></div>`;
    } else {
      const sectionMeta = (ps) => {
        const tt = String(ps?.tokenType || '').toUpperCase();
        if (tt === 'TOKEN_TYPE_SKILLS') return { key: 'skills', label: 'Skill' };
        if (tt === 'TOKEN_TYPE_SUBAGENTS') return { key: 'subagents', label: 'Subagent' };
        if (tt === 'TOKEN_TYPE_PLUGINS') return { key: 'plugins', label: 'Plugin / MCP' };
        return { key: 'systemPrompt', label: 'System' };
      };
      const secBucketTotals = { systemPrompt: 0, skills: 0, subagents: 0, plugins: 0 };
      for (const ps of sectionsAll) {
        const m = sectionMeta(ps);
        secBucketTotals[m.key] += (ps.numTokens || 0);
      }
      const summarySteps = visibleSteps.filter(s => s.category === 'summary');
      const latestCp = summarySteps.length ? summarySteps[summarySteps.length - 1] : null;
      const latestCpTurn = latestCp ? (latestCp.turnIndex ?? 0) : null;
      const firstTurnIdx = visibleSteps.find(s => (s.turnIndex ?? 0) > 0)?.turnIndex ?? (visibleSteps[0]?.turnIndex ?? 0);
      const lastTurnIdx = visibleSteps.length ? (visibleSteps[visibleSteps.length - 1].turnIndex ?? 0) : 0;
      const activeSteps = latestCp
        ? filteredSteps.filter(s => s.stepIndex >= latestCp.stepIndex)
        : filteredSteps;

      const sysTok = sectionsAll.reduce((a, s) => a + (s.numTokens || 0), 0);
      const toolTok = toolsAll.reduce((a, s) => a + (s.numTokens || 0), 0);
      const convTok = activeSteps.reduce((a, s) => a + (s.tokenEstimate || 0), 0);
      const budgetTot = Math.max(1, sysTok + toolTok + convTok);
      const breakdownParts = [
        ['systemPrompt', 'System', secBucketTotals.systemPrompt],
        ['tools', 'Tools', toolTok],
        ['skills', 'Skills', secBucketTotals.skills],
        ['subagents', 'Subagents', secBucketTotals.subagents],
        ['plugins', 'Plugins/MCP', secBucketTotals.plugins],
        ['assistant', 'Turns', convTok]
      ].filter(([, , tok]) => tok > 0);

      const promptBudgetHtml = `<div class="insp-card insp-card-pad" style="margin-bottom:8px;display:flex;flex-direction:column;gap:8px">
        <div class="insp-card-head" style="margin-bottom:0">
          <span class="insp-card-title">Prompt Budget Breakdown</span>
          <span class="insp-pill">${short(sysTok + toolTok + convTok)}</span>
        </div>
        <div style="height:7px;border-radius:999px;overflow:hidden;display:flex;background:var(--insp-surface-inset)">
          ${breakdownParts.map(([clrKey, lbl, tok]) => `<div style="width:${(tok / budgetTot) * 100}%;background:${getInspectorColor(clrKey)}" title="${escHtml(lbl)}: ${fmt(tok)} tok"></div>`).join('')}
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:6px 12px;font-size:11px;color:var(--insp-text-muted)">
          ${breakdownParts.map(([clrKey, lbl, tok]) => `<span style="display:inline-flex;align-items:center;gap:5px;white-space:nowrap"><span class="insp-dot" style="background:${getInspectorColor(clrKey)}"></span>${escHtml(lbl)} ${Math.round((tok / budgetTot) * 100)}% (${short(tok)})</span>`).join('')}
        </div>
      </div>`;

      const renderGroup = (grpKey, label, color, count, totalTok, extraControls, itemsHtml, subMeta = '') => {
        const isOpen = inspectorState.browserExpandedGroups.has(grpKey);
        return `<div class="insp-grp">
          <div class="insp-grp-head">
            <button class="insp-grp-toggle" type="button" data-toggle-grp="${escHtml(grpKey)}">
              <span>${isOpen ? '▾' : '▸'}</span>
              <span class="insp-dot" style="background:${color}"></span>
              <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(label)} (${count})</span>
              ${subMeta ? `<span class="insp-muted" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(subMeta)}</span>` : ''}
              <span class="insp-pill">${short(totalTok)} tok</span>
            </button>
            ${extraControls || ''}
          </div>
          ${isOpen ? `<div class="insp-grp-body">${itemsHtml || `<div class="insp-empty">${escHtml(t('inspector.noMatches'))}</div>`}</div>` : ''}
        </div>`;
      };

      const secHtml = sectionsAll.map((ps, idx) => {
        const key = `sec:${idx}`;
        const exp = inspectorState.browserExpandedItems.has(key);
        const m = sectionMeta(ps);
        if (exp) copyPayloads.set(key, ps.content || '');
        return `<div class="insp-row">
          <button class="insp-row-head" type="button" data-toggle-item="${escHtml(key)}">
            <span class="insp-dot" style="background:${getInspectorColor(m.key)}"></span>
            <span class="insp-chip">${escHtml(m.label)}</span>
            <span class="insp-row-title">${escHtml(ps.title)}</span>
            <span class="insp-row-meta">${fmt(ps.numTokens)} tok</span>
          </button>
          ${exp ? `<div class="insp-step-detail">
            <div class="insp-step-actions"><button class="insp-mini-btn" type="button" data-copy-key="${escHtml(key)}">Copy</button></div>
            <pre class="insp-pre">${escHtml(ps.content)}</pre>
          </div>` : ''}
        </div>`;
      }).join('');

      const toolsHtml = toolsAll.map(tl => {
        const key = `tool:${tl.name}`;
        const exp = inspectorState.browserExpandedItems.has(key);
        if (exp) copyPayloads.set(key, [tl.name, tl.description, tl.schema].filter(Boolean).join('\n\n'));
        return `<div class="insp-row">
          <button class="insp-row-head" type="button" data-toggle-item="${escHtml(key)}">
            <span class="insp-chip">${escHtml(tl.source)}</span>
            <span class="insp-row-title">${escHtml(tl.name)}</span>
            <span class="insp-row-meta">${fmt(tl.numTokens)} tok</span>
          </button>
          ${exp ? `<div class="insp-tool-detail">
            <div class="insp-step-actions"><button class="insp-mini-btn" type="button" data-copy-key="${escHtml(key)}">Copy</button></div>
            <div class="insp-muted">${escHtml(tl.description)}</div><pre class="insp-pre">${escHtml(tl.schema || '')}</pre>
          </div>` : ''}
        </div>`;
      }).join('');

      const renderStepRow = (s) => {
        const key = `step:${s.stepIndex}`;
        const exp = inspectorState.browserExpandedItems.has(key);
        const isRaw = inspectorState.browserRawItems.has(key);
        const statusCls = s.status === 'error' ? 'pill-bad' : 'pill-muted';
        let detailHtml = '';
        if (exp) {
          const prettyCopy = [
            s.thinking ? `[Thinking]\n${s.thinking}` : '',
            s.text || '',
            s.toolCalls?.length ? `[Tool Calls]\n${s.toolCalls.map(c => `${c.name}(${c.argumentsJson})`).join('\n')}` : '',
            s.argsText ? `[Arguments]\n${s.argsText}` : '',
            s.resultText ? `[Result]\n${s.resultText}` : ''
          ].filter(Boolean).join('\n\n');
          copyPayloads.set(key, isRaw ? JSON.stringify(s, null, 2) : prettyCopy);
          detailHtml = isRaw
            ? `<pre class="insp-pre">${escHtml(JSON.stringify(s, null, 2))}</pre>`
            : `
              ${s.thinking ? `<div class="insp-sublbl">Thinking</div><pre class="insp-pre">${escHtml(s.thinking)}</pre>` : ''}
              ${s.text ? `<div class="insp-sublbl">Content</div><pre class="insp-pre">${escHtml(s.text)}</pre>` : ''}
              ${s.toolCalls?.length ? `<div class="insp-sublbl">Tool Calls (${s.toolCalls.length})</div><pre class="insp-pre">${escHtml(s.toolCalls.map(c => `${c.name}(${c.argumentsJson})`).join('\n'))}</pre>` : ''}
              ${s.argsText ? `<div class="insp-sublbl">Arguments</div><pre class="insp-pre">${escHtml(s.argsText)}</pre>` : ''}
              ${s.resultText ? `<div class="insp-sublbl">Result${s.truncated ? ' (truncated)' : ''}</div><pre class="insp-pre">${escHtml(s.resultText)}</pre>` : ''}
            `;
          detailHtml = `<div class="insp-step-detail">
            <div class="insp-step-actions">
              <button class="insp-mini-btn" type="button" data-copy-key="${escHtml(key)}">Copy</button>
              <button class="insp-mini-btn" type="button" data-toggle-raw="${escHtml(key)}">${isRaw ? 'Pretty' : 'Raw JSON'}</button>
            </div>
            ${detailHtml}
          </div>`;
        }
        const isCompactStep = s.category === 'summary';
        return `<div class="insp-row" data-insp-step="${s.stepIndex}">
          <button class="insp-row-head" type="button" data-toggle-item="${escHtml(key)}">
            <span class="insp-dot" style="background:${getInspectorColor(s.category)}"></span>
            <span class="insp-chip">${isCompactStep ? 'Summary' : escHtml(s.category)}</span>
            <span class="insp-pos">#${s.stepIndex}</span>
            <span class="insp-row-title">${escHtml(s.title)}</span>
            <span class="key-pill ${statusCls}">${escHtml(s.status)}</span>
            <span class="insp-row-meta">${s.tokenEstimated ? '~' : ''}${fmt(s.tokenEstimate)} tok</span>
          </button>
          ${detailHtml}
        </div>`;
      };

      const toolSortCtrl = `<div class="insp-segmented">
        <button class="insp-seg-btn ${inspectorState.browserToolSort === 'size' ? 'active' : ''}" type="button" data-tool-sort="size">${escHtml(t('inspector.sortSize'))}</button>
        <button class="insp-seg-btn ${inspectorState.browserToolSort === 'name' ? 'active' : ''}" type="button" data-tool-sort="name">${escHtml(t('inspector.sortName'))}</button>
      </div>`;

      // Auto-expand the latest turn on first view if no turn group has been toggled yet
      if (turnKeys.length > 0 && !turnKeys.some(k => inspectorState.browserExpandedGroups.has(`turn:${k}`) || inspectorState.browserExpandedGroups.has(`__turnCollapsed:${k}`))) {
        inspectorState.browserExpandedGroups.add(`turn:${turnKeys[turnKeys.length - 1]}`);
      }

      const showStatic = inspectorState.browserFilter === 'all' || inspectorState.browserFilter === 'tools';
      const hasExtraInjected = (secBucketTotals.skills + secBucketTotals.subagents + secBucketTotals.plugins) > 0;
      const sysGroupLabel = hasExtraInjected
        ? `${t('inspector.bucket.systemPrompt')} · Skills & MCPs`
        : t('inspector.bucket.systemPrompt');
      const staticGroupsHtml = showStatic ? `
        ${inspectorState.browserFilter !== 'tools' ? renderGroup('system', sysGroupLabel, getInspectorColor('systemPrompt'), sectionsAll.length, sysTok, '', secHtml) : ''}
        ${renderGroup('tools', t('inspector.bucket.tools'), getInspectorColor('tools'), toolsAll.length, toolTok, toolSortCtrl, toolsHtml)}
      ` : '';

      const renderTurnCard = (tIdx) => {
        const items = turnGroupsMap.get(tIdx) || [];
        const tokSum = items.reduce((a, s) => a + (s.tokenEstimate || 0), 0);
        const userStep = items.find(s => s.category === 'user');
        const hasCp = items.some(s => s.category === 'summary');
        const label = tIdx > 0 ? `Turn ${tIdx}` : 'Context Setup';
        const snippet = userStep ? userStep.title : (items[0]?.title || '');
        const rowsHtml = items.map(renderStepRow).join('');
        const stateTag = hasCp ? '<span class="insp-chip">Summary</span>' : '';
        return renderGroup(`turn:${tIdx}`, label, getInspectorColor(userStep ? 'user' : 'assistant'), items.length, tokSum, stateTag, rowsHtml, snippet);
      };

      const revTurns = turnKeys.slice().reverse();
      let turnCardsHtml = '';
      if (latestCp) {
        const activeTurns = revTurns.filter(t => t >= latestCpTurn);
        const archivedTurns = revTurns.filter(t => t < latestCpTurn);
        const archivedRange = archivedTurns.length ? ` · T${firstTurnIdx}–T${latestCpTurn - 1} in summary` : '';
        const dividerHtml = `<div style="display:flex;align-items:center;gap:8px;margin:6px 2px;font-size:11px;color:var(--insp-text-muted)">
          <span style="flex:1;height:1px;background:var(--insp-border-soft)"></span>
          <span>Compacted #${latestCp.stepIndex}${escHtml(archivedRange)}</span>
          <button class="insp-mini-btn" type="button" data-jump-step="${latestCp.stepIndex}">Summary</button>
          <span style="flex:1;height:1px;background:var(--insp-border-soft)"></span>
        </div>`;
        const railHtml = activeTurns.length
          ? `<div style="border-left:2px solid #38bdf8;padding-left:8px;margin-left:2px;display:flex;flex-direction:column;gap:6px">${activeTurns.map(renderTurnCard).join('')}</div>`
          : '';
        turnCardsHtml = `${railHtml}${dividerHtml}${archivedTurns.map(renderTurnCard).join('')}`;
      } else {
        turnCardsHtml = revTurns.map(renderTurnCard).join('');
      }

      bodyHtml = `${promptBudgetHtml}<div class="insp-scroll-list">
        ${staticGroupsHtml}
        ${turnCardsHtml || `<div class="insp-empty">${escHtml(t('inspector.noMatches'))}</div>`}
      </div>`;
    }

    pane.innerHTML = `<div class="insp-tab-enter">${controlsHtml}${bodyHtml}</div>`;
    const reRenderBr = () => { if (pane.dataset) pane.dataset.tabAnim = '0'; renderLiveBrowser(pane); };
    el('insp-browser-step-sel')?.addEventListener('change', (e) => {
      const v = e.target.value;
      inspectorState.browserStepLimit = v === '' ? null : Number(v);
      reRenderBr();
    });
    el('insp-browser-search')?.addEventListener('input', (e) => {
      inspectorState.browserSearch = e.target.value || '';
      reRenderBr();
      const inp = el('insp-browser-search');
      if (inp) { inp.focus(); inp.setSelectionRange?.(inp.value.length, inp.value.length); }
    });
    pane.querySelectorAll('[data-br-mode]').forEach(b => b.addEventListener('click', () => { inspectorState.browserMode = b.getAttribute('data-br-mode'); reRenderBr(); }));
    pane.querySelectorAll('[data-toggle-grp]').forEach(b => b.addEventListener('click', () => {
      const g = b.getAttribute('data-toggle-grp');
      if (inspectorState.browserExpandedGroups.has(g)) {
        inspectorState.browserExpandedGroups.delete(g);
        if (g.startsWith('turn:')) inspectorState.browserExpandedGroups.add(`__turnCollapsed:${g.slice(5)}`);
      } else {
        inspectorState.browserExpandedGroups.add(g);
        if (g.startsWith('turn:')) inspectorState.browserExpandedGroups.delete(`__turnCollapsed:${g.slice(5)}`);
      }
      reRenderBr();
    }));
    pane.querySelectorAll('[data-toggle-item]').forEach(b => b.addEventListener('click', () => {
      const k = b.getAttribute('data-toggle-item');
      if (inspectorState.browserExpandedItems.has(k)) inspectorState.browserExpandedItems.delete(k);
      else inspectorState.browserExpandedItems.add(k);
      reRenderBr();
    }));
    pane.querySelectorAll('[data-jump-step]').forEach(b => b.addEventListener('click', () => {
      jumpToBrowserStep(Number(b.getAttribute('data-jump-step')));
    }));
    pane.querySelectorAll('[data-copy-key]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      const k = b.getAttribute('data-copy-key');
      if (typeof copyPayloads !== 'undefined' && copyPayloads.has(k)) {
        copyTextToClipboard(copyPayloads.get(k), b);
      }
    }));
    pane.querySelectorAll('[data-toggle-raw]').forEach(b => b.addEventListener('click', () => {
      const k = b.getAttribute('data-toggle-raw');
      if (inspectorState.browserRawItems.has(k)) inspectorState.browserRawItems.delete(k);
      else inspectorState.browserRawItems.add(k);
      reRenderBr();
    }));
    pane.querySelectorAll('[data-tool-sort]').forEach(b => b.addEventListener('click', () => { inspectorState.browserToolSort = b.getAttribute('data-tool-sort'); reRenderBr(); }));
    pane.querySelectorAll('[data-asst-filter]').forEach(b => b.addEventListener('click', () => { inspectorState.browserAssistantFilter = b.getAttribute('data-asst-filter'); reRenderBr(); }));
    pane.querySelectorAll('[data-br-filter]').forEach(b => b.addEventListener('click', () => { inspectorState.browserFilter = b.getAttribute('data-br-filter'); reRenderBr(); }));
    pane.querySelector('[data-br-toggle-all]')?.addEventListener('click', (e) => {
      const act = e.currentTarget.getAttribute('data-br-toggle-all');
      if (act === 'expand') {
        allGroupKeys.forEach(g => inspectorState.browserExpandedGroups.add(g));
      } else {
        for (const g of allGroupKeys) {
          inspectorState.browserExpandedGroups.delete(g);
          if (g.startsWith('turn:')) inspectorState.browserExpandedGroups.add(`__turnCollapsed:${g.slice(5)}`);
        }
      }
      reRenderBr();
    });
  }

  function renderLiveActivity(pane) {
    const dd = inspectorState.deepDive;
    if (inspectorState.loading && !dd) { renderInspectorSkeleton(pane); return; }
    if (inspectorState.error && !dd) { renderInspectorError(pane, inspectorState.error, () => void fetchInspectorDeepDive(true)); return; }
    if (!dd) { renderInspectorEmpty(pane, true); return; }

    const fa = dd.fileActivity || { totals: {}, files: [] };
    const ce = dd.commandExecutions || { total: 0, items: [], programCounts: [] };
    const evAll = dd.events || [];
    const sec = inspectorState.actSection || 'files';

    const topBar = `<div class="insp-toolbar" style="justify-content:space-between">
      <div class="insp-segmented">
        <button class="insp-seg-btn ${sec === 'files' ? 'active' : ''}" type="button" data-act-sec="files">${escHtml(t('inspector.fileActivityTitle'))} (${fa.totals?.files || 0})</button>
        <button class="insp-seg-btn ${sec === 'commands' ? 'active' : ''}" type="button" data-act-sec="commands">${escHtml(t('inspector.commandsTitle'))} (${ce.total || 0})</button>
        <button class="insp-seg-btn ${sec === 'events' ? 'active' : ''}" type="button" data-act-sec="events">${escHtml(t('inspector.eventsTitle'))} (${evAll.length})</button>
        <button class="insp-seg-btn ${sec === 'timeline' ? 'active' : ''}" type="button" data-act-sec="timeline">${escHtml(t('inspector.timelineTitle'))}</button>
      </div>
      ${sec === 'files' && (fa.totals?.additions || fa.totals?.deletions) ? `<span class="insp-pill"><span class="insp-add">+${fa.totals.additions || 0}</span> <span class="insp-del">-${fa.totals.deletions || 0}</span></span>` : ''}
    </div>`;

    const kpiStrip = `<div class="insp-summary-strip" style="margin-bottom:8px">
      <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpiFiles'))}</span><span class="insp-kv-v">${fa.totals?.files || 0}</span></div>
      <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpiLines'))}</span><span class="insp-kv-v"><span class="insp-add">+${fa.totals?.additions || 0}</span> / <span class="insp-del">-${fa.totals?.deletions || 0}</span></span></div>
      <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpiCmds'))}</span><span class="insp-kv-v">${ce.total || 0} <span class="insp-muted" style="font-size:10px">(${ce.items.filter(c => c.status === 'error').length} err)</span></span></div>
      <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpiEvents'))}</span><span class="insp-kv-v">${evAll.length}</span></div>
    </div>`;

    let cardHtml = '';
    if (sec === 'files') {
      const allFiles = fa.files || [];
      const sumWrites = allFiles.reduce((a, f) => a + (f.writes || 0), 0);
      const sumReads = allFiles.reduce((a, f) => a + (f.reads || 0), 0);
      const sumSearches = allFiles.reduce((a, f) => a + (f.searches || 0), 0);
      const sumImages = allFiles.reduce((a, f) => a + (f.images || 0), 0);
      const sumOps = Math.max(1, sumWrites + sumReads + sumSearches + sumImages);

      const topHotspots = [...allFiles]
        .sort((a, b) => ((b.additions || 0) + (b.deletions || 0)) - ((a.additions || 0) + (a.deletions || 0)) || ((b.writes || 0) + (b.reads || 0)) - ((a.writes || 0) + (a.reads || 0)))
        .slice(0, 5);
      const maxChurn = Math.max(1, ...topHotspots.map(f => (f.additions || 0) + (f.deletions || 0)));
      const hasLineDiffs = topHotspots.some(f => (f.additions || 0) + (f.deletions || 0) > 0);
      const maxTouches = Math.max(1, ...topHotspots.map(f => (f.writes || 0) + (f.reads || 0) + (f.searches || 0) + (f.images || 0)));

      const mixBarHtml = allFiles.length ? `<div class="insp-card insp-card-pad" style="margin-bottom:8px;display:flex;flex-direction:column;gap:8px">
        <div class="insp-card-head" style="margin-bottom:0">
          <span class="insp-card-title">${hasLineDiffs ? 'Code Churn & Operation Mix' : 'File Operation Mix'}</span>
          <span class="insp-row-meta">${sumWrites} write · ${sumReads} read · ${sumSearches} search${sumImages ? ` · ${sumImages} img` : ''}</span>
        </div>
        <div style="height:6px;border-radius:999px;overflow:hidden;display:flex;background:var(--insp-surface-inset)">
          ${sumWrites ? `<div style="width:${(sumWrites / sumOps) * 100}%;background:#30D158" title="Writes: ${sumWrites}"></div>` : ''}
          ${sumReads ? `<div style="width:${(sumReads / sumOps) * 100}%;background:#32ADE6" title="Reads: ${sumReads}"></div>` : ''}
          ${sumSearches ? `<div style="width:${(sumSearches / sumOps) * 100}%;background:#BF5AF2" title="Searches: ${sumSearches}"></div>` : ''}
          ${sumImages ? `<div style="width:${(sumImages / sumOps) * 100}%;background:#FF9F0A" title="Images: ${sumImages}"></div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          ${topHotspots.map(f => {
            const churn = (f.additions || 0) + (f.deletions || 0);
            const touches = (f.writes || 0) + (f.reads || 0) + (f.searches || 0) + (f.images || 0);
            const addW = hasLineDiffs ? ((f.additions || 0) / maxChurn) * 100 : ((f.writes || 0) / maxTouches) * 100;
            const delW = hasLineDiffs ? ((f.deletions || 0) / maxChurn) * 100 : ((f.reads || 0) / maxTouches) * 100;
            return `<button class="insp-row-head" type="button" data-focus-file="${escHtml(f.path)}" style="padding:3px 4px;border-radius:6px">
              <span class="insp-row-title" style="font-size:11px;max-width:45%" title="${escHtml(f.path)}">${escHtml(f.name)}</span>
              <div style="flex:1;height:5px;border-radius:999px;overflow:hidden;display:flex;background:var(--insp-surface-inset)">
                ${addW ? `<div style="width:${addW.toFixed(1)}%;background:${hasLineDiffs ? '#30D158' : '#32ADE6'}"></div>` : ''}
                ${delW ? `<div style="width:${delW.toFixed(1)}%;background:${hasLineDiffs ? '#FF453A' : 'rgba(148,163,184,0.45)'}"></div>` : ''}
              </div>
              <span class="insp-row-meta" style="font-size:10.5px;min-width:66px;text-align:right">${churn ? `<span class="insp-add">+${f.additions}</span> <span class="insp-del">-${f.deletions}</span>` : `${touches}×`}</span>
            </button>`;
          }).join('')}
        </div>
      </div>` : '';

      const fq = inspectorState.fileSearch.trim().toLowerCase();
      const filesFiltered = allFiles.filter(f => {
        if (inspectorState.fileFilter === 'read' && !f.reads) return false;
        if (inspectorState.fileFilter === 'write' && !f.writes) return false;
        if (inspectorState.fileFilter === 'search' && !f.searches) return false;
        if (inspectorState.fileFilter === 'image' && !f.images) return false;
        if (fq && !f.path.toLowerCase().includes(fq)) return false;
        return true;
      }).sort((a, b) => {
        if (inspectorState.fileSort === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
        if (inspectorState.fileSort === 'touches') return ((b.writes || 0) + (b.reads || 0) + (b.searches || 0)) - ((a.writes || 0) + (a.reads || 0) + (a.searches || 0));
        return ((b.additions || 0) + (b.deletions || 0)) - ((a.additions || 0) + (a.deletions || 0)) || ((b.writes || 0) + (b.reads || 0)) - ((a.writes || 0) + (a.reads || 0));
      });
      const rows = filesFiltered.map(f => {
        const exp = inspectorState.expandedFiles.has(f.path);
        const opsHtml = exp ? `<div class="insp-ops-list">${(f.ops || []).map(op =>
          `<button class="insp-op-row" type="button" data-jump-step="${op.stepIndex}">
            <span class="insp-chip">${escHtml(op.kind)}</span>
            <span class="insp-pos">#${op.stepIndex}</span>
            <span class="insp-row-title insp-muted">${escHtml(op.detail || '')}</span>
          </button>`
        ).join('')}</div>` : '';
        return `<div class="insp-file-row">
          <button class="insp-row-head" type="button" data-toggle-file="${escHtml(f.path)}">
            <span class="insp-row-title" title="${escHtml(f.path)}">${escHtml(f.name)} <span class="insp-muted">${escHtml(f.path)}</span></span>
            <span class="insp-row-meta">
              ${(f.additions || f.deletions) ? `<span class="insp-add">+${f.additions}</span> <span class="insp-del">-${f.deletions}</span>` : `${f.reads || f.searches || f.images || 0}×`}
            </span>
          </button>
          ${opsHtml}
        </div>`;
      }).join('');
      cardHtml = `${mixBarHtml}<div class="insp-card">
        <div class="insp-card-hdr-bar">
          <div class="insp-segmented">
            ${['all', 'read', 'write', 'search', 'image'].map(f => `<button class="insp-seg-btn ${inspectorState.fileFilter === f ? 'active' : ''}" type="button" data-file-filter="${f}">${escHtml(t(`inspector.file.${f}`))}</button>`).join('')}
          </div>
          <div class="insp-segmented">
            ${[['churn', 'Churn'], ['touches', 'Touches'], ['name', 'Name']].map(([k, lbl]) => `<button class="insp-seg-btn ${inspectorState.fileSort === k ? 'active' : ''}" type="button" data-file-sort="${k}">${lbl}</button>`).join('')}
          </div>
          <input id="insp-file-search" class="insp-input" type="search" value="${escHtml(inspectorState.fileSearch)}" placeholder="${escHtml(t('inspector.searchPath'))}" />
        </div>
        <div class="insp-inset-list">${rows || `<div class="insp-empty">${escHtml(t('inspector.noMatches'))}</div>`}</div>
      </div>`;
    } else if (sec === 'commands') {
      const allCmds = ce.items || [];
      const okCmds = allCmds.filter(c => c.status === 'ok').length;
      const errCmds = allCmds.filter(c => c.status === 'error').length;
      const totalCmdMs = allCmds.reduce((a, c) => a + (Number(c.durationMs) || 0), 0);
      const okRate = allCmds.length ? Math.round((okCmds / allCmds.length) * 100) : null;
      const topProgs = (ce.programCounts || []).slice(0, 5);
      const maxProgCnt = Math.max(1, ...topProgs.map(p => p.count || 0));
      const cmdAnalyticsHtml = allCmds.length ? `<div class="insp-card insp-card-pad" style="margin-bottom:8px;display:flex;flex-direction:column;gap:8px">
        <div class="insp-card-head" style="margin-bottom:0">
          <span class="insp-card-title">Command Health & Program Breakdown</span>
          <span class="insp-row-meta">${okRate != null ? `${okRate}% ok` : '—'} · ${errCmds} err · ${fmtDurMs(totalCmdMs)}</span>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px">
          ${topProgs.map(p => {
            const act = inspectorState.cmdProgramFilter === p.program;
            const pct = Math.round(((p.count || 0) / maxProgCnt) * 100);
            return `<button class="insp-row-head" type="button" data-cmd-prog="${escHtml(p.program)}" style="padding:3px 4px;border-radius:6px;${act ? 'background:var(--insp-hover-bg)' : ''}">
              <span class="insp-chip" style="min-width:64px;text-align:center">${escHtml(p.program)}</span>
              <div style="flex:1;height:5px;border-radius:999px;overflow:hidden;background:var(--insp-surface-inset)">
                <div style="width:${pct}%;height:100%;background:${act ? '#30D158' : '#32ADE6'}"></div>
              </div>
              <span class="insp-row-meta" style="font-size:10.5px;min-width:34px;text-align:right">${p.count}×</span>
            </button>`;
          }).join('')}
        </div>
      </div>` : '';

      const cq = inspectorState.cmdSearch.trim().toLowerCase();
      const cmdsFiltered = allCmds.filter(c => {
        if (inspectorState.cmdStatusFilter !== 'all' && c.status !== inspectorState.cmdStatusFilter) return false;
        if (inspectorState.cmdProgramFilter && c.program !== inspectorState.cmdProgramFilter) return false;
        if (cq && !`${c.commandLine} ${c.program} ${c.outputPreview}`.toLowerCase().includes(cq)) return false;
        return true;
      }).sort((a, b) => {
        if (inspectorState.cmdSort === 'slowest') return (Number(b.durationMs) || 0) - (Number(a.durationMs) || 0);
        if (inspectorState.cmdSort === 'errors') return (b.status === 'error' ? 1 : 0) - (a.status === 'error' ? 1 : 0) || (b.stepIndex || 0) - (a.stepIndex || 0);
        return (b.stepIndex || 0) - (a.stepIndex || 0);
      });
      const rows = cmdsFiltered.map(c => {
        const key = `cmd:${c.stepIndex}`;
        const exp = inspectorState.expandedCmds.has(key);
        const pillCls = c.status === 'ok' ? 'pill-good' : (c.status === 'error' ? 'pill-bad' : 'pill-warn');
        return `<div class="insp-cmd-row">
          <button class="insp-row-head" type="button" data-toggle-cmd="${escHtml(key)}">
            <span class="insp-chip">${escHtml(c.program)}</span>
            <span class="insp-row-title">${escHtml(c.commandLine)}</span>
            <span class="key-pill ${pillCls}">${c.exitCode != null ? `exit ${c.exitCode}` : escHtml(c.status)}</span>
            <span class="insp-row-meta">${fmtDurMs(c.durationMs)}</span>
          </button>
          ${exp ? `<div class="insp-step-detail">
            <div class="insp-step-actions"><button class="insp-mini-btn" type="button" data-jump-step="${c.stepIndex}">${escHtml(t('inspector.inspectStep'))} #${c.stepIndex}</button></div>
            <pre class="insp-pre">${escHtml(c.outputPreview || '—')}</pre>
          </div>` : ''}
        </div>`;
      }).join('');
      cardHtml = `${cmdAnalyticsHtml}<div class="insp-card">
        <div class="insp-card-hdr-bar">
          <div class="insp-segmented">
            ${['all', 'ok', 'error', 'running'].map(st => `<button class="insp-seg-btn ${inspectorState.cmdStatusFilter === st ? 'active' : ''}" type="button" data-cmd-status="${st}">${escHtml(t(`inspector.cmd.${st}`))}</button>`).join('')}
          </div>
          <div class="insp-segmented">
            ${[['recent', 'Recent'], ['slowest', 'Slowest'], ['errors', 'Errors']].map(([k, lbl]) => `<button class="insp-seg-btn ${inspectorState.cmdSort === k ? 'active' : ''}" type="button" data-cmd-sort="${k}">${lbl}</button>`).join('')}
          </div>
          <input id="insp-cmd-search" class="insp-input" type="search" value="${escHtml(inspectorState.cmdSearch)}" placeholder="${escHtml(t('inspector.searchCmd'))}" />
        </div>
        <div class="insp-inset-list">${rows || `<div class="insp-empty">${escHtml(t('inspector.noMatches'))}</div>`}</div>
      </div>`;
    } else if (sec === 'events') {
      const evCounts = {};
      for (const ev of evAll) evCounts[ev.kind] = (evCounts[ev.kind] || 0) + 1;
      const evList = evAll.filter(ev => inspectorState.eventFilter === 'all' || ev.kind === inspectorState.eventFilter);
      const rows = evList.map(ev => `<button class="insp-event-row" type="button" data-jump-step="${ev.stepIndex}">
        <span class="insp-chip">${escHtml(ev.kind)}</span>
        <span class="insp-pos">#${ev.stepIndex}</span>
        <span class="insp-row-title">${escHtml(ev.title)} <span class="insp-muted">${escHtml(ev.detail || '')}</span></span>
        ${ev.tokenDelta != null ? `<span class="insp-row-meta">${ev.tokenDelta >= 0 ? '+' : ''}${short(ev.tokenDelta)}</span>` : ''}
      </button>`).join('');
      cardHtml = `<div class="insp-card">
        <div class="insp-card-hdr-bar">
          <div class="insp-segmented">
            ${['all', 'checkpoint', 'model_switch', 'skill_load', 'subagent_spawn', 'error'].map(k => {
              const cnt = k === 'all' ? evAll.length : (evCounts[k] || 0);
              return `<button class="insp-seg-btn ${inspectorState.eventFilter === k ? 'active' : ''}" type="button" data-ev-filter="${k}">${escHtml(t(`inspector.ev.${k}`))}${cnt ? ` (${cnt})` : ''}</button>`;
            }).join('')}
          </div>
        </div>
        <div class="insp-inset-list">${rows || `<div class="insp-empty">${escHtml(t('inspector.noEvents'))}</div>`}</div>
      </div>`;
    } else { // timeline
      const timelineItems = [];
      for (const f of (fa.files || [])) {
        for (const op of (f.ops || [])) {
          timelineItems.push({
            kind: 'file',
            stepIndex: op.stepIndex,
            turnIndex: op.turnIndex,
            timestamp: op.timestamp,
            chip: op.kind,
            title: `${op.kind}: ${f.name}`,
            detail: op.detail || f.path,
            status: '',
            meta: (f.additions || f.deletions) ? `+${f.additions} -${f.deletions}` : ''
          });
        }
      }
      for (const c of (ce.items || [])) {
        timelineItems.push({
          kind: 'cmd',
          stepIndex: c.stepIndex,
          turnIndex: c.turnIndex,
          timestamp: c.createdAt,
          chip: c.program,
          title: c.commandLine,
          detail: c.outputPreview ? c.outputPreview.slice(0, 140) : '',
          status: c.status,
          meta: fmtDurMs(c.durationMs)
        });
      }
      for (const ev of evAll) {
        timelineItems.push({
          kind: 'event',
          stepIndex: ev.stepIndex,
          turnIndex: ev.turnIndex,
          timestamp: ev.timestamp,
          chip: ev.kind,
          title: ev.title,
          detail: ev.detail || '',
          status: ev.kind === 'error' ? 'error' : '',
          meta: ev.tokenDelta != null ? `${ev.tokenDelta >= 0 ? '+' : ''}${short(ev.tokenDelta)}` : ''
        });
      }
      timelineItems.sort((a, b) => (b.stepIndex ?? 0) - (a.stepIndex ?? 0) || (b.timestamp ?? 0) - (a.timestamp ?? 0));
      const rows = timelineItems.map(item => {
        const pillCls = item.status === 'error' ? 'pill-bad' : (item.status === 'ok' ? 'pill-good' : '');
        return `<button class="insp-timeline-row" type="button" data-jump-step="${item.stepIndex}">
          <span class="insp-chip">${escHtml(item.chip)}</span>
          <span class="insp-pos">#${item.stepIndex}</span>
          <div class="insp-timeline-body">
            <div class="insp-row-title">${escHtml(item.title)}</div>
            ${item.detail ? `<div class="insp-muted" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(item.detail)}</div>` : ''}
          </div>
          ${item.status ? `<span class="key-pill ${pillCls}">${escHtml(item.status)}</span>` : ''}
          ${item.meta ? `<span class="insp-row-meta">${escHtml(item.meta)}</span>` : ''}
        </button>`;
      }).join('');
      cardHtml = `<div class="insp-card">
        <div class="insp-card-hdr-bar">
          <span class="insp-card-title">${escHtml(t('inspector.timelineTitle'))}</span>
          <span class="insp-pill">${timelineItems.length}</span>
        </div>
        <div class="insp-inset-list">${rows || `<div class="insp-empty">${escHtml(t('inspector.noEvents'))}</div>`}</div>
      </div>`;
    }

    pane.innerHTML = `<div class="insp-tab-enter">${kpiStrip}${topBar}${cardHtml}</div>`;
    const reRenderAct = () => { if (pane.dataset) pane.dataset.tabAnim = '0'; renderLiveActivity(pane); };
    pane.querySelectorAll('[data-act-sec]').forEach(b => b.addEventListener('click', () => { inspectorState.actSection = b.getAttribute('data-act-sec'); reRenderAct(); }));
    pane.querySelectorAll('[data-file-filter]').forEach(b => b.addEventListener('click', () => { inspectorState.fileFilter = b.getAttribute('data-file-filter'); reRenderAct(); }));
    pane.querySelectorAll('[data-file-sort]').forEach(b => b.addEventListener('click', () => { inspectorState.fileSort = b.getAttribute('data-file-sort'); reRenderAct(); }));
    pane.querySelectorAll('[data-focus-file]').forEach(b => b.addEventListener('click', () => {
      const p = b.getAttribute('data-focus-file');
      inspectorState.fileFilter = 'all';
      inspectorState.expandedFiles.add(p);
      reRenderAct();
    }));
    el('insp-file-search')?.addEventListener('input', (e) => { inspectorState.fileSearch = e.target.value || ''; reRenderAct(); const i = el('insp-file-search'); if (i) { i.focus(); i.setSelectionRange?.(i.value.length, i.value.length); } });
    pane.querySelectorAll('[data-toggle-file]').forEach(b => b.addEventListener('click', () => {
      const p = b.getAttribute('data-toggle-file');
      if (inspectorState.expandedFiles.has(p)) inspectorState.expandedFiles.delete(p); else inspectorState.expandedFiles.add(p);
      reRenderAct();
    }));
    pane.querySelectorAll('[data-cmd-status]').forEach(b => b.addEventListener('click', () => { inspectorState.cmdStatusFilter = b.getAttribute('data-cmd-status'); reRenderAct(); }));
    pane.querySelectorAll('[data-cmd-sort]').forEach(b => b.addEventListener('click', () => { inspectorState.cmdSort = b.getAttribute('data-cmd-sort'); reRenderAct(); }));
    pane.querySelectorAll('[data-cmd-prog]').forEach(b => b.addEventListener('click', () => {
      const pr = b.getAttribute('data-cmd-prog');
      inspectorState.cmdProgramFilter = inspectorState.cmdProgramFilter === pr ? '' : pr;
      reRenderAct();
    }));
    el('insp-cmd-search')?.addEventListener('input', (e) => { inspectorState.cmdSearch = e.target.value || ''; reRenderAct(); const i = el('insp-cmd-search'); if (i) { i.focus(); i.setSelectionRange?.(i.value.length, i.value.length); } });
    pane.querySelectorAll('[data-toggle-cmd]').forEach(b => b.addEventListener('click', () => {
      const k = b.getAttribute('data-toggle-cmd');
      if (inspectorState.expandedCmds.has(k)) inspectorState.expandedCmds.delete(k); else inspectorState.expandedCmds.add(k);
      reRenderAct();
    }));
    pane.querySelectorAll('[data-ev-filter]').forEach(b => b.addEventListener('click', () => { inspectorState.eventFilter = b.getAttribute('data-ev-filter'); reRenderAct(); }));
    pane.querySelectorAll('[data-jump-step]').forEach(b => b.addEventListener('click', () => jumpToBrowserStep(Number(b.getAttribute('data-jump-step')))));
  }

  // =========================================================================
  // Tab 2: Quota (Unified 5h + 7d Side-by-Side + Honest Shared Pools vs This PC)
  // =========================================================================
  function renderQuotaTab(pane) {
    const nowMs = Date.now();
    const view = typeof computeEffectiveQuotaView === 'function' ? computeEffectiveQuotaView(nowMs) : null;
    if (!view || !Array.isArray(view.pools) || view.pools.length === 0) {
      pane.innerHTML = `<div class="insp-tab-enter"><div class="insp-card">
        <div class="insp-empty-state">
          <div>${escHtml(quotaState.error || t('inspector.quotaNoData'))}</div>
          <button class="insp-mini-btn is-primary" type="button" data-insp-quota-retry="1">${escHtml(t('inspector.retry'))}</button>
        </div>
      </div></div>`;
      pane.querySelector('[data-insp-quota-retry]')?.addEventListener('click', () => {
        if (typeof refreshQuotaNow === 'function') void refreshQuotaNow({ force: true, manual: true });
      });
      return;
    }

    const activePool = view.pools.find(p => p.poolKey === view.currentModel?.poolKey) || view.pools[0];
    const buckets = activePool?.buckets || [];
    const b5h = buckets.find(b => b.windowKey === '5h') || activePool?.primaryBucket || buckets[0] || null;
    const bWeek = buckets.find(b => b.windowKey === 'weekly') || buckets[1] || null;

    const renderDualBox = (label, b, colorHex) => {
      const pct = b?.remainingFraction != null ? Math.round(b.remainingFraction * 100) : null;
      const pctStr = b?.percentText || (pct != null ? `${pct}%` : '—');
      const resetStr = b?.hasResetTime && b.resetAtMs
        ? `${t('inspector.quotaResetsIn', { t: formatCountdownMsCompact(b.resetAtMs - nowMs) })}${b.resetTimeText ? ` · ${b.resetTimeText}` : ''}`
        : t('quota.time.unknown');
      return `<div class="insp-quota-cell">
        <span class="insp-kv-k">${escHtml(label)}</span>
        <div class="insp-quota-num-row">
          <span class="insp-quota-big">${escHtml(pctStr)}</span>
          <span class="insp-muted">${escHtml(resetStr)}</span>
        </div>
        <div class="insp-meter-track">
          <div class="insp-meter-fill" style="width:${pct != null ? Math.max(0, Math.min(100, pct)) : 0}%;background:${colorHex}"></div>
        </div>
      </div>`;
    };

    const rawTier = view.planTierName || ANTIGRAVITY_TOKEN_DATA.planStatus?.tierName || '';
    const planLabel = (rawTier && rawTier !== '未知') ? rawTier : '';
    const activeHeaderMeta = [activePool?.title || '', planLabel].filter(Boolean).join(' · ');

    const poolRows = view.pools.map(p => {
      const pb = p.primaryBucket || p.buckets?.[0] || null;
      const isCur = Boolean(activePool && p.poolKey === activePool.poolKey);
      const poolPct = pb?.remainingFraction != null ? Math.round(pb.remainingFraction * 100) : null;
      const modelsList = Array.from(new Set((p.models || []).map(m => m.productLabel).filter(Boolean)));
      const modelsStr = modelsList.length > 4
        ? `${modelsList.slice(0, 4).join(' · ')} +${modelsList.length - 4}`
        : modelsList.join(' · ');

      let badgeText = pb?.percentText || (poolPct != null ? `${poolPct}%` : '—');
      let badgeCls = 'insp-pool-status';
      if (p.noPermission) {
        badgeText = t('inspector.quotaNoAccess');
      } else if (p.isExhausted || p.status === 'exhausted') {
        badgeText = t('inspector.quotaExhausted');
        badgeCls += ' is-bad';
      } else if (p.status === 'low') {
        badgeCls += ' is-warn';
      } else if (isCur) {
        badgeCls += ' is-active';
      }

      let bodyHtml = '';
      if (p.noPermission) {
        bodyHtml = `<div class="insp-muted">${escHtml(p.unavailabilityReason || t('inspector.quotaNoAccess'))}</div>`;
      } else {
        const winList = (Array.isArray(p.buckets) && p.buckets.length > 0) ? p.buckets : (pb ? [pb] : []);
        const winHtml = winList.map(bk => {
          const bPct = bk.remainingFraction != null ? Math.round(bk.remainingFraction * 100) : 0;
          const wLbl = bk.windowKey === '5h' ? '5h' : (bk.windowKey === 'weekly' ? '7d' : (bk.windowShort || 'Quota'));
          const bColor = bk.windowKey === 'weekly' ? 'var(--insp-accent)' : (bPct < 20 ? '#FF453A' : (bPct < 45 ? '#FF9F0A' : '#30D158'));
          const wReset = (bk.hasResetTime && bk.resetAtMs) ? formatCountdownMsCompact(bk.resetAtMs - nowMs) : '—';
          return `<div class="insp-pool-win-row">
            <span class="insp-pool-win-lbl">${escHtml(wLbl)}</span>
            <div class="insp-meter-track" style="flex:1"><div class="insp-meter-fill" style="width:${Math.max(0, Math.min(100, bPct))}%;background:${bColor}"></div></div>
            <span class="insp-pool-win-val">${escHtml(bk.percentText || `${bPct}%`)}</span>
            <span class="insp-pool-win-reset">${escHtml(wReset)}</span>
          </div>`;
        }).join('');

        const est = pb?.tokenEstimate || p.tokenEstimate || null;
        const cycleTok = Number(est?.cycleTokensUsed || 0);
        const samples = Number(est?.sampleCount || 0);
        const localTxt = cycleTok > 0
          ? `${t('inspector.quotaThisPc')}: ${short(cycleTok)} tok${samples > 0 ? ` (${samples})` : ''}`
          : (quotaState.busy ? t('inspector.quotaWarming') : t('inspector.quotaNoLocal'));
        const rightMeta = [];
        if (est?.isReliable && est?.estRemainingShort) rightMeta.push(`${t('inspector.quotaEstLeft')}: ~${est.estRemainingShort}`);
        if (est?.externalDivergence) rightMeta.push(t('inspector.quotaSharedDevices'));
        bodyHtml = `${winHtml}<div class="insp-pool-local"><span>${escHtml(localTxt)}</span><span>${escHtml(rightMeta.join(' · '))}</span></div>`;
      }

      return `<div class="insp-quota-pair">
        <div class="insp-card-head" style="margin-bottom:0">
          <span class="insp-card-title">${escHtml(p.title || p.poolKey)}</span>
          <div style="display:flex;align-items:center;gap:5px">
            ${isCur ? `<span class="insp-pool-status is-active">${escHtml(t('inspector.quotaActivePool'))}</span>` : ''}
            <span class="${badgeCls}">${escHtml(badgeText)}</span>
          </div>
        </div>
        ${modelsStr ? `<div class="insp-pool-models">${escHtml(modelsStr)}</div>` : ''}
        ${bodyHtml}
      </div>`;
    }).join('');

    pane.innerHTML = `<div class="insp-tab-enter">
      <div class="insp-quota-dual">
        ${renderDualBox(t('inspector.quota5h'), b5h, '#30D158')}
        ${renderDualBox(t('inspector.quota7d'), bWeek, 'var(--insp-accent)')}
      </div>
      <div class="insp-card">
        <div class="insp-card-hdr-bar">
          <span class="insp-card-title">${escHtml(t('inspector.quotaPoolsTitle'))}</span>
          ${activeHeaderMeta ? `<span class="insp-pill">${escHtml(activeHeaderMeta)}</span>` : ''}
        </div>
        <div class="insp-note-strip">${escHtml(t('inspector.quotaPoolsExplain'))}</div>
        <div class="insp-inset-list">${poolRows}</div>
      </div>
    </div>`;
  }

  // =========================================================================
  // Tab 3: History -> Usage / Speed / Sessions
  // =========================================================================
  function renderHistoryUsage(pane) {
    const core = typeof __AGContextMeterCore !== 'undefined' ? __AGContextMeterCore : (globalThis.__AGContextMeterCore || null);
    const is1d = inspectorState.usageRange === '1d';
    const periodDays = inspectorState.usageRange === '30d' ? 30 : 7;
    const todayStr = typeof formatLocalYmd === 'function' ? formatLocalYmd(new Date()) : new Date().toISOString().slice(0, 10);
    const dailyModelMap = ANTIGRAVITY_TOKEN_DATA.dailyModelMapBySource?.all || ANTIGRAVITY_TOKEN_DATA.dailyModelMap || {};
    const hourlyModelMap = ANTIGRAVITY_TOKEN_DATA.hourlyModelMapBySource?.all || ANTIGRAVITY_TOKEN_DATA.hourlyModelMap || {};
    const dailyMap = ANTIGRAVITY_TOKEN_DATA.dailyMap || {};
    const sumObj = ANTIGRAVITY_TOKEN_DATA.summary || {};
    const isLight = resolveTheme?.() === 'light';

    let days = [];
    let rawLegend = [];
    if (core && typeof core.summarizeModelUsageWindow === 'function') {
      const hourKeys = is1d ? Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')) : null;
      const summary = core.summarizeModelUsageWindow(is1d ? (hourlyModelMap[todayStr] || {}) : dailyModelMap, {
        periodDays,
        ...(hourKeys ? { bucketKeys: hourKeys } : {}),
        endDate: todayStr,
        groupBy: 'model',
        metric: 'total',
        theme: isLight ? 'light' : 'dark',
        modelMetaByKey: ANTIGRAVITY_TOKEN_DATA.modelMetaByKey,
        unattributedLabel: t('modelsUsage.unattributed')
      });
      days = Array.isArray(summary?.days) ? summary.days : [];
      rawLegend = Array.isArray(summary?.legend) ? summary.legend : [];
    }

    // 7d & 30d totals + today + cache hit summary
    const baseDt = new Date(todayStr + 'T00:00:00');
    let tok7d = 0;
    let tok30d = 0;
    const heatCells = [];
    let maxHeat = 1;
    let activeDaysCount = 0;
    let peakDay = { ymd: todayStr, tot: 0 };
    for (let i = 29; i >= 0; i--) {
      const dt = new Date(baseDt.getTime() - i * 86400000);
      const ymd = typeof formatLocalYmd === 'function' ? formatLocalYmd(dt) : dt.toISOString().slice(0, 10);
      const tot = Number(dailyMap[ymd]?.total || 0);
      tok30d += tot;
      if (i < 7) tok7d += tot;
      if (i < 28) {
        if (tot > 0) activeDaysCount++;
        if (tot > maxHeat) maxHeat = tot;
        if (tot > peakDay.tot) peakDay = { ymd, tot };
        heatCells.push({ ymd, tot });
      }
    }
    const todayTok = Number(dailyMap[todayStr]?.total || sumObj.todayTokens || 0);
    const curIn = Number(sumObj.totalInputTokens || 0);
    const curCa = Number(sumObj.totalCacheTokens || 0);
    const curOut = Number(sumObj.totalOutputTokens || 0);
    const cacheRate = (curIn + curCa) > 0 ? curCa / (curIn + curCa) : null;

    // Stacked bar chart with clean non-wrapping date/hour anchors
    const anchorSet = is1d
      ? new Set([0, 6, 12, 18, 23])
      : (periodDays === 30 ? new Set([0, 7, 14, 21, Math.max(0, days.length - 1)]) : null);
    const maxDayTok = Math.max(1, ...days.map(d => Number(d.total) || 0));
    const chartHtml = days.map((d, idx) => {
      const tot = Number(d.total) || 0;
      const barH = tot > 0 ? Math.max(6, Math.round((tot / maxDayTok) * 76)) : 3;
      const nonZeroSegs = (d.segments || []).filter(s => (Number(s.tokens) || 0) > 0);
      const segs = nonZeroSegs.map(s => {
        const segH = Math.max(2, Math.round(((Number(s.tokens) || 0) / Math.max(1, tot)) * barH));
        return `<span class="insp-day-seg" style="height:${segH}px;background:${escHtml(s.color || 'var(--insp-accent)')}"></span>`;
      }).join('') || `<span class="insp-day-seg" style="height:${barH}px;background:var(--insp-accent);opacity:${tot > 0 ? 0.85 : 0.15}"></span>`;
      const showLbl = is1d ? anchorSet.has(idx) : (periodDays === 7 || anchorSet?.has(idx));
      const lbl = showLbl ? (is1d ? `${d.date}h` : d.date.slice(5).replace('-', '/')) : '';
      const tipTitle = is1d ? `${todayStr} ${d.date}:00` : d.date;
      const tipLines = [short(tot) + ' tok'].concat(
        nonZeroSegs.slice().sort((a, b) => (b.tokens || 0) - (a.tokens || 0)).slice(0, 3).map(s => `${s.label}: ${short(s.tokens)}`)
      );
      return `<div class="insp-day-col" data-insp-hover="usage" data-tip-title="${escHtml(tipTitle)}" data-tip-meta="${escHtml(tipLines.join('\n'))}">
        <div class="insp-day-stack insp-bar-rise" style="height:${barH}px;--insp-i:${Math.min(idx, 20)}">${segs}</div>
        <span class="insp-bar-lbl">${escHtml(lbl)}</span>
      </div>`;
    }).join('');

    // Model legend (Top 5 + Other Models)
    let legendItems = rawLegend.slice();
    if (legendItems.length > 5) {
      const top5 = legendItems.slice(0, 5);
      const tail = legendItems.slice(5);
      const otherTok = tail.reduce((a, x) => a + (Number(x.tokens) || 0), 0);
      const winTot = Math.max(1, legendItems.reduce((a, x) => a + (Number(x.tokens) || 0), 0));
      top5.push({
        label: t('inspector.otherModels'),
        color: '#71717a',
        tokens: otherTok,
        pctLabel: `${((otherTok / winTot) * 100).toFixed(0)}%`
      });
      legendItems = top5;
    }
    const legendHtml = legendItems.length
      ? `<div class="insp-model-legend">${legendItems.map(it => `<div class="insp-legend-item">
          <span class="insp-dot" style="background:${escHtml(it.color || 'var(--insp-accent)')}"></span>
          <span class="insp-legend-k">${escHtml(it.label)}</span>
          <span class="insp-legend-v">${short(it.tokens)}${it.pctLabel ? ` (${escHtml(it.pctLabel)})` : ''}</span>
        </div>`).join('')}</div>`
      : '';

    // 28-day heatmap with active days, peak day, and Less..More legend
    const opsLevels = [0.08, 0.28, 0.52, 0.76, 0.98];
    const heatHtml = heatCells.map(c => {
      const ratio = c.tot / maxHeat;
      const op = c.tot === 0 ? opsLevels[0] : (ratio < 0.25 ? opsLevels[1] : ratio < 0.5 ? opsLevels[2] : ratio < 0.75 ? opsLevels[3] : opsLevels[4]);
      return `<span class="insp-heat-cell" data-insp-hover="heat" data-tip-title="${escHtml(c.ymd)}" data-tip-meta="${escHtml(short(c.tot))} tok" style="background:rgba(10,132,255,${op})"></span>`;
    }).join('');
    const heatLegendSwatches = opsLevels.map(op => `<span class="insp-heat-swatch" style="background:rgba(10,132,255,${op})"></span>`).join('');
    const heatMetaLeft = [
      t('inspector.activeDays', { n: activeDaysCount }),
      peakDay.tot > 0 ? t('inspector.peakDay', { val: short(peakDay.tot), date: peakDay.ymd.slice(5).replace('-', '/') }) : ''
    ].filter(Boolean).join(' · ');

    // Windowed API Equivalent Cost (follows 1d / 7d / 30d bars, per-model pricing)
    const rangeTag = is1d ? '1d' : (periodDays === 30 ? '30d' : '7d');
    const calcModelsCost = (items) => {
      let totIn = 0, totCa = 0, totOut = 0, totAll = 0;
      let inUsd = 0, caUsd = 0, outUsd = 0, savedUsd = 0;
      for (const item of items) {
        const mIn = Number(item.input) || 0;
        const mCa = Number(item.cache) || 0;
        const mOut = Number(item.output) || 0;
        const mTot = Number(item.tokens) || (mIn + mCa + mOut);
        totIn += mIn;
        totCa += mCa;
        totOut += mOut;
        totAll += mTot;
        if (core && typeof core.calculateReferenceModelCost === 'function') {
          const mc = core.calculateReferenceModelCost({
            inputTokens: mIn,
            cacheTokens: mCa,
            outputTokens: mOut,
            totalTokens: mTot
          }, item.key, { pricingDate: todayStr }) || {};
          const mInUsd = Number(mc.inputCostUSD || 0);
          const mCaUsd = Number(mc.cacheCostUSD || 0);
          const mOutUsd = Number(mc.outputCostUSD || 0);
          const mRateIn = Number(mc.matchedTier?.inputPerMillion ?? 0.75);
          inUsd += mInUsd;
          caUsd += mCaUsd;
          outUsd += mOutUsd;
          savedUsd += Math.max(0, (mCa * mRateIn / 1e6) - mCaUsd);
        }
      }
      return { totIn, totCa, totOut, totAll, inUsd, caUsd, outUsd, totalUsd: inUsd + caUsd + outUsd, savedUsd };
    };

    const winCost = calcModelsCost(rawLegend);
    const winIn = winCost.totIn;
    const winCa = winCost.totCa;
    const winOut = winCost.totOut;
    const winTotal = winCost.totAll;
    const cInUsd = winCost.inUsd;
    const cCaUsd = winCost.caUsd;
    const cOutUsd = winCost.outUsd;
    const resolvedCost = winCost.totalUsd;
    const winCacheSavedUsd = winCost.savedUsd;
    const winCacheRate = (winIn + winCa) > 0 ? winCa / (winIn + winCa) : null;
    const winSavedTag = winCacheSavedUsd > 0 ? ` <span class="insp-add" style="font-size:11px;font-weight:600">saved ${escHtml(fmtUsd(winCacheSavedUsd))}</span>` : '';

    const allModelTotals = new Map();
    for (const dayRecs of Object.values(dailyModelMap || {})) {
      if (!dayRecs || typeof dayRecs !== 'object') continue;
      for (const [rawKey, rec] of Object.entries(dayRecs)) {
        if (!rec || typeof rec !== 'object') continue;
        const mKey = ANTIGRAVITY_TOKEN_DATA.modelMetaByKey?.[rawKey]?.modelKey || rawKey.split(':')[0] || rawKey;
        const prev = allModelTotals.get(mKey) || { key: mKey, input: 0, cache: 0, output: 0, tokens: 0 };
        prev.input += Number(rec.input) || 0;
        prev.cache += Number(rec.cache) || 0;
        prev.output += Number(rec.output) || 0;
        prev.tokens += Number(rec.total) || 0;
        allModelTotals.set(mKey, prev);
      }
    }
    const allCaSavedUsd = allModelTotals.size > 0
      ? calcModelsCost(allModelTotals.values()).savedUsd
      : Math.max(0, (curCa * 0.75 / 1e6) - (curCa * 0.075 / 1e6));
    const allSavedTag = allCaSavedUsd > 0 ? ` <span class="insp-add" style="font-size:11px;font-weight:600">saved ${escHtml(fmtUsd(allCaSavedUsd))}</span>` : '';
    const tierName = (ANTIGRAVITY_TOKEN_DATA.planStatus?.tierName && ANTIGRAVITY_TOKEN_DATA.planStatus.tierName !== '未知')
      ? ANTIGRAVITY_TOKEN_DATA.planStatus.tierName
      : '';

    pane.innerHTML = `<div class="insp-tab-enter">
      <div class="insp-summary-strip">
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.usageToday'))}</span><span class="insp-kv-v">${short(todayTok)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.usage7d'))}</span><span class="insp-kv-v">${short(tok7d)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.usage30d'))}</span><span class="insp-kv-v">${short(tok30d)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpi.cacheHit'))}</span><span class="insp-kv-v">${fmtPct1(cacheRate)}${allSavedTag}</span></div>
      </div>

      <div class="insp-card insp-card-pad">
        <div class="insp-card-head">
          <span class="insp-card-title">${escHtml(t('inspector.usageByModel'))}</span>
          <div class="insp-segmented">
            <button class="insp-seg-btn ${inspectorState.usageRange === '1d' ? 'active' : ''}" type="button" data-usage-range="1d">1d</button>
            <button class="insp-seg-btn ${inspectorState.usageRange === '7d' ? 'active' : ''}" type="button" data-usage-range="7d">7d</button>
            <button class="insp-seg-btn ${inspectorState.usageRange === '30d' ? 'active' : ''}" type="button" data-usage-range="30d">30d</button>
          </div>
        </div>
        <div class="insp-7d-row ${is1d || periodDays === 30 ? 'is-30d' : ''}">${chartHtml || `<div class="insp-empty">${escHtml(t('inspector.noEvents'))}</div>`}</div>
        ${legendHtml}
      </div>

      <div class="insp-card insp-card-pad">
        <div class="insp-card-head">
          <span class="insp-card-title">${escHtml(t('inspector.dailyHeatmap'))}</span>
          <span class="insp-pill">${escHtml(t('inspector.days28'))}</span>
        </div>
        <div class="insp-heatmap-grid">${heatHtml}</div>
        <div class="insp-heat-footer">
          <span>${escHtml(heatMetaLeft)}</span>
          <span class="insp-heat-scale">${escHtml(t('inspector.heatLess'))}${heatLegendSwatches}${escHtml(t('inspector.heatMore'))}</span>
        </div>
      </div>

      <div class="insp-card">
        <button id="insp-cost-toggle-btn" class="insp-cost-toggle" type="button">
          <span>${escHtml(t('inspector.apiCostEst'))} (${rangeTag}): <strong>${escHtml(fmtUsd(resolvedCost))}</strong> · ${short(winTotal)} tok</span>
          <span style="color:var(--insp-accent)">${escHtml(inspectorState.costExpanded ? t('inspector.showLess') : t('inspector.showMore'))}</span>
        </button>
        ${inspectorState.costExpanded ? `<div class="insp-kv-grid" style="border:none;border-top:1px solid var(--insp-hairline);border-radius:0">
          <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.costInput'))}</span><span class="insp-kv-v">${fmtUsd(cInUsd)} · ${short(winIn)}</span></div>
          <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.costCache'))}</span><span class="insp-kv-v">${fmtUsd(cCaUsd)} · ${short(winCa)}</span></div>
          <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.costOutput'))}</span><span class="insp-kv-v">${fmtUsd(cOutUsd)} · ${short(winOut)}</span></div>
          <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpi.cacheHit'))}</span><span class="insp-kv-v">${fmtPct1(winCacheRate)}${winSavedTag}</span></div>
        </div>
        <div class="insp-cost-note"><span>${escHtml(t('inspector.costRefNote'))}</span><span>${escHtml(tierName)}</span></div>` : ''}
      </div>
    </div>`;

    pane.querySelectorAll('[data-usage-range]').forEach(b => b.addEventListener('click', () => {
      inspectorState.usageRange = b.getAttribute('data-usage-range');
      renderHistoryUsage(pane);
    }));
    el('insp-cost-toggle-btn')?.addEventListener('click', () => {
      inspectorState.costExpanded = !inspectorState.costExpanded;
      renderHistoryUsage(pane);
    });
  }

  function renderHistorySpeed(pane) {
    const isInspectedOther = Boolean(inspectorState.targetCascadeId && inspectorState.targetCascadeId !== state.route);
    const dd = (isInspectedOther && inspectorState.deepDive?.cascadeId === inspectorState.targetCascadeId) ? inspectorState.deepDive : null;
    if (isInspectedOther && !dd && inspectorState.loading) { renderInspectorSkeleton(pane); return; }

    let spEval = null;
    if (isInspectedOther && dd) {
      const st = dd.stats || {};
      const tm = st.timing || {};
      const outTok = Number(st.tokens?.output || 0);
      const callsN = Math.max(1, Number(st.modelCalls || 0));
      const streamSec = tm.streamingMs > 0 ? tm.streamingMs / 1000 : 0;
      const ttftSec = tm.ttftMs > 0 ? (tm.ttftMs / callsN) / 1000 : null;
      const totalSec = tm.modelMs > 0 ? tm.modelMs / 1000 : (streamSec + (ttftSec || 0));
      spEval = typeof evaluateGenerationExperience === 'function'
        ? evaluateGenerationExperience({
            outputTokens: outTok,
            streamingDurationSec: streamSec || null,
            ttftSec,
            totalDurationSec: totalSec || null,
            modelId: st.modelId || st.modelLabel || ''
          }, currentPanelLanguage)
        : null;
    } else {
      spEval = state.lastSpeedEval || (typeof evaluateGenerationExperience === 'function' ? evaluateGenerationExperience(resolveSpeedEvaluationInput(), currentPanelLanguage) : null);
    }

    const streamStr = spEval?.streamSpeed != null ? `${spEval.streamSpeed} tok/s` : (spEval?.overallTps != null ? `${spEval.overallTps} tok/s` : '—');
    const ttftStr = spEval?.ttftFormatted || (spEval?.ttftSec != null ? `${spEval.ttftSec}s` : '—');
    const durStr = spEval?.durationFormatted || (spEval?.totalDurationSec != null ? `${spEval.totalDurationSec}s` : '—');
    const eScoreStr = spEval?.efficiency?.score != null ? `${spEval.efficiency.score}` : '—';

    let mergedCalls = typeof mergeAvailableSpeedCalls === 'function' ? mergeAvailableSpeedCalls() : [];
    if (isInspectedOther) {
      const filtered = mergedCalls.filter(c => c.cascadeId === inspectorState.targetCascadeId);
      if (filtered.length > 0) {
        mergedCalls = filtered;
      } else if (dd?.trend?.byStep?.length) {
        mergedCalls = dd.trend.byStep
          .filter(pt => Number(pt.streamingMs) > 0 && Number(pt.usage?.outputTokens) > 0)
          .map(pt => ({
            cascadeId: inspectorState.targetCascadeId,
            status: 'final',
            model: pt.model || pt.modelLabel || '',
            modelLabel: pt.modelLabel || pt.model || '',
            outputTokens: Number(pt.usage.outputTokens) || 0,
            inputTokens: Number(pt.usage.inputTokens) || 0,
            durationSec: (Number(pt.streamingMs) + Number(pt.ttftMs || 0)) / 1000,
            streamingDurationSec: Number(pt.streamingMs) / 1000,
            ttftSec: pt.ttftMs > 0 ? Number(pt.ttftMs) / 1000 : null,
            timestamp: Date.now()
          }));
      } else {
        mergedCalls = [];
      }
    }

    const daysArg = isInspectedOther ? 'all' : (inspectorState.speedRange === '7d' ? 7 : (inspectorState.speedRange === '30d' ? 30 : 'all'));
    const groups = typeof summarizeSpeedByModel === 'function'
      ? summarizeSpeedByModel(mergedCalls, {
          days: daysArg,
          origin: 'all',
          metric: 'tps',
          cascadeModelConfigs: state.cascadeModelConfigs || state.scan?.cascadeModelConfigs || []
        })
      : [];
    const maxTps = Math.max(10, ...groups.map(g => Number(g.medianTps) || 0));

    const speedRows = groups.map(g => {
      const tps = Number(g.medianTps) || 0;
      const pct = Math.min(100, Math.round((tps / maxTps) * 100));
      const label = typeof formatProductDisplayWithEffort === 'function'
        ? formatProductDisplayWithEffort(g.productLabel, g.effort)
        : (g.productLabel || g.modelExactId || '—');
      const tipMeta = [
        `${tps.toFixed(1)} tok/s · ${t('inspector.samples', { n: g.count || 0 })}`,
        g.medianTtft != null ? `TTFT ${g.medianTtft}s` : '',
        g.medianOutputTokens != null ? `Med ${short(g.medianInputTokens || 0)} in / ${short(g.medianOutputTokens)} out` : ''
      ].filter(Boolean).join('\n');
      return `<div class="insp-speed-row" data-insp-hover="speed" data-tip-title="${escHtml(label)}" data-tip-meta="${escHtml(tipMeta)}">
        <div class="insp-card-head" style="margin-bottom:0">
          <span class="insp-row-title" style="font-weight:500">${escHtml(label)}</span>
          <span class="insp-row-meta"><strong style="color:var(--ag-text-primary)">${tps.toFixed(1)} tok/s</strong> · ${g.medianTtft != null ? `TTFT ${g.medianTtft}s · ` : ''}${t('inspector.samples', { n: g.count || 0 })}</span>
        </div>
        <div class="insp-meter-track">
          <div class="insp-meter-fill" style="width:${pct}%;background:#32ADE6"></div>
        </div>
      </div>`;
    }).join('');

    pane.innerHTML = `<div class="insp-tab-enter">
      <div class="insp-kv-grid">
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.speedLiveCall'))}</span><span class="insp-kv-v">${escHtml(streamStr)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.ttft'))}</span><span class="insp-kv-v">${escHtml(ttftStr)}</span></div>

        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.eScore'))}</span><span class="insp-kv-v">${escHtml(eScoreStr)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('session.speed.duration'))}</span><span class="insp-kv-v">${escHtml(durStr)}</span></div>
      </div>
      <div class="insp-card">
        <div class="insp-card-hdr-bar">
          <span class="insp-card-title">${escHtml(t('inspector.speedObserved'))}</span>
          <div class="insp-segmented">
            <button class="insp-seg-btn ${inspectorState.speedRange === '7d' ? 'active' : ''}" type="button" data-speed-range="7d">7d</button>
            <button class="insp-seg-btn ${inspectorState.speedRange === '30d' ? 'active' : ''}" type="button" data-speed-range="30d">30d</button>
            <button class="insp-seg-btn ${inspectorState.speedRange === 'all' ? 'active' : ''}" type="button" data-speed-range="all">${escHtml(t('inspector.speedRangeAll'))}</button>
          </div>
        </div>
        <div class="insp-inset-list">${speedRows || `<div class="insp-empty">${escHtml(t('speed.empty'))}</div>`}</div>
      </div>
    </div>`;

    pane.querySelectorAll('[data-speed-range]').forEach(b => b.addEventListener('click', () => {
      if (pane.dataset) pane.dataset.tabAnim = '0';
      inspectorState.speedRange = b.getAttribute('data-speed-range');
      renderHistorySpeed(pane);
    }));
  }

  function renderHistorySessions(pane) {
    if (inspectorState.insightsLoading && !inspectorState.insights) { renderInspectorSkeleton(pane); return; }
    if (inspectorState.insightsError && !inspectorState.insights) { renderInspectorError(pane, inspectorState.insightsError, () => void fetchInspectorInsights(true)); return; }
    const ins = inspectorState.insights;
    if (!ins) { renderInspectorSkeleton(pane); return; }

    const now = Date.now();
    const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
    const cutoff = inspectorState.insightsRange === 'today' ? dayStart.getTime()
      : inspectorState.insightsRange === '7d' ? now - 7 * 86400000
      : inspectorState.insightsRange === '30d' ? now - 30 * 86400000
      : 0;

    const q = inspectorState.insightsSearch.trim().toLowerCase();
    const tagF = inspectorState.insightsTagFilter;
    const tagSet = tagF ? new Set(tagF.sessionIds || []) : null;

    const sessions = (ins.sessions || []).filter(s => {
      if (cutoff && (s.lastModifiedMs || s.createdAtMs || 0) < cutoff) return false;
      if (tagSet && !tagSet.has(s.cascadeId)) return false;
      if (q && !`${s.title} ${s.cascadeId} ${s.workspace} ${s.modelLabel}`.toLowerCase().includes(q)) return false;
      return true;
    }).sort((a, b) => {
      if (inspectorState.insightsSort === 'tokens') return (b.tokens?.total || 0) - (a.tokens?.total || 0);
      if (inspectorState.insightsSort === 'cost') return (b.estimatedCostUSD || 0) - (a.estimatedCostUSD || 0);
      if (inspectorState.insightsSort === 'steps') return (b.stepCount || 0) - (a.stepCount || 0);
      return (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0);
    });

    const totTok = sessions.reduce((a, s) => a + (s.tokens?.total || 0), 0);
    const totCost = sessions.reduce((a, s) => a + (s.estimatedCostUSD || 0), 0);
    const totIn = sessions.reduce((a, s) => a + (s.tokens?.input || 0) + (s.tokens?.cacheRead || 0), 0);
    const totCache = sessions.reduce((a, s) => a + (s.tokens?.cacheRead || 0), 0);

    const renderChips = (list, kind) => (list || []).slice(0, 6).map(it => {
      const act = tagF && tagF.kind === kind && tagF.name === it.name;
      return `<button class="insp-filter-chip ${act ? 'active' : ''}" type="button" data-ins-tag="${escHtml(kind)}:${escHtml(it.name)}">${escHtml(it.name)} (${it.count})</button>`;
    }).join('');

    const subagentsByParent = new Map();
    const mainSessions = [];
    for (const s of sessions) {
      if (s.isSubagent && s.parentCascadeId) {
        const pk = s.parentCascadeId.toLowerCase();
        if (!subagentsByParent.has(pk)) subagentsByParent.set(pk, []);
        subagentsByParent.get(pk).push(s);
      } else {
        mainSessions.push(s);
      }
    }
    const visibleMainSet = new Set(mainSessions.map(s => String(s.cascadeId || '').toLowerCase()));
    const orphanSubagents = [];
    for (const [pk, list] of subagentsByParent.entries()) {
      if (!visibleMainSet.has(pk)) orphanSubagents.push(...list);
    }

    const renderSessionRow = (s, isNested = false) => {
      const shortCid = s.cascadeId ? s.cascadeId.slice(0, 8) : '';
      const wsName = s.workspace ? basenameOf(s.workspace) : '';
      const metaParts = [
        shortCid,
        wsName,
        s.modelLabel || '—',
        `${s.stepCount} steps`,
        fmtRelTime(s.lastModifiedMs)
      ].filter(Boolean).join(' · ');

      const rowAttr = s.isSubagent
        ? `data-inspect-cid="${escHtml(s.cascadeId)}"`
        : `data-jump-cid="${escHtml(s.cascadeId)}"`;
      const subBadge = s.isSubagent
        ? `<span class="insp-chip" style="margin-right:6px;vertical-align:middle">Subagent</span>`
        : '';
      const rightInspectBtn = s.isSubagent
        ? ''
        : `<span class="insp-mini-btn" role="button" tabindex="0" data-inspect-cid="${escHtml(s.cascadeId)}">${escHtml(t('inspector.inspectSession'))}</span>`;
      const nestedStyle = isNested ? 'padding-left:28px;background:var(--insp-surface-inset);border-top:1px solid var(--insp-hairline);' : '';

      return `<button class="insp-session-btn" type="button" ${rowAttr} style="${nestedStyle}">
        <div style="min-width:0;flex:1">
          <div class="insp-row-title" style="font-weight:${isNested ? '500' : '600'};font-size:${isNested ? '12px' : '12.5px'}">${subBadge}${escHtml(s.title)}</div>
          <div class="insp-row-meta" style="font-size:11px">${escHtml(metaParts)}</div>
        </div>
        <span class="insp-row-meta" style="flex-shrink:0;white-space:nowrap">${short(s.tokens?.total)} · ${fmtUsd(s.estimatedCostUSD)} · ${fmtPct1(s.cacheHitRate)}</span>
        ${rightInspectBtn}
      </button>`;
    };

    const sessRows = mainSessions.slice(0, 35).map(s => {
      const subs = subagentsByParent.get(String(s.cascadeId || '').toLowerCase()) || [];
      const rowHtml = renderSessionRow(s, false);
      if (!subs.length) return rowHtml;
      const exp = inspectorState.expandedSessionParents.has(s.cascadeId);
      const subTok = subs.reduce((a, x) => a + (x.tokens?.total || 0), 0);
      const toggleHtml = `<button class="insp-row-head" type="button" data-toggle-subs="${escHtml(s.cascadeId)}" style="width:100%;padding:5px 14px 6px 28px;border-top:1px solid var(--insp-hairline);background:var(--insp-surface-inset);font-size:11px;color:var(--ag-text-muted);justify-content:space-between">
        <span>${exp ? '▾' : '▸'} Subagents (${subs.length})</span>
        <span>${short(subTok)} tok</span>
      </button>`;
      const subRowsHtml = exp ? subs.map(sub => renderSessionRow(sub, true)).join('') : '';
      return `${rowHtml}${toggleHtml}${subRowsHtml}`;
    }).join('') + (orphanSubagents.length ? orphanSubagents.slice(0, 15).map(sub => renderSessionRow(sub, false)).join('') : '');

    pane.innerHTML = `<div class="insp-tab-enter">
      <div class="insp-toolbar">
        <div class="insp-segmented">
          ${['today', '7d', '30d', 'all'].map(r => `<button class="insp-seg-btn ${inspectorState.insightsRange === r ? 'active' : ''}" type="button" data-ins-range="${r}">${escHtml(t(`inspector.range.${r}`))}</button>`).join('')}
        </div>
        <input id="insp-ins-search" class="insp-input" type="search" value="${escHtml(inspectorState.insightsSearch)}" placeholder="${escHtml(t('inspector.searchSessions'))}" />
        <select id="insp-ins-sort" class="insp-select">
          ${['recent', 'tokens', 'cost', 'steps'].map(sk => `<option value="${sk}" ${inspectorState.insightsSort === sk ? 'selected' : ''}>${escHtml(t(`inspector.sort.${sk}`))}</option>`).join('')}
        </select>
      </div>
      <div class="insp-summary-strip">
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.insights.sessions'))}</span><span class="insp-kv-v">${fmt(sessions.length)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpi.tokens'))}</span><span class="insp-kv-v">${short(totTok)}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.apiCostEst'))}</span><span class="insp-kv-v">${escHtml(fmtUsd(totCost))}</span></div>
        <div class="insp-kv-cell"><span class="insp-kv-k">${escHtml(t('inspector.kpi.cacheHit'))}</span><span class="insp-kv-v">${fmtPct1(totIn > 0 ? totCache / totIn : null)}</span></div>
      </div>
      <div class="insp-card insp-card-pad" style="display:flex;flex-direction:column;gap:8px">
        <div class="insp-chip-row">${renderChips(ins.topTools, 'tool')}${renderChips(ins.topCommands, 'cmd')}${renderChips(ins.topSkills, 'skill')}</div>
      </div>
      <div class="insp-card">
        <div class="insp-card-hdr-bar">
          <span class="insp-card-title">${escHtml(t('inspector.insights.sessions'))}</span>
          <span class="insp-pill">${fmt(sessions.length)}</span>
        </div>
        <div class="insp-inset-list">${sessRows || `<div class="insp-empty">${escHtml(t('inspector.noMatches'))}</div>`}</div>
      </div>
    </div>`;

    const reRenderSess = () => { if (pane.dataset) pane.dataset.tabAnim = '0'; renderHistorySessions(pane); };
    pane.querySelectorAll('[data-toggle-subs]').forEach(b => b.addEventListener('click', () => {
      const pid = b.getAttribute('data-toggle-subs');
      if (inspectorState.expandedSessionParents.has(pid)) inspectorState.expandedSessionParents.delete(pid);
      else inspectorState.expandedSessionParents.add(pid);
      reRenderSess();
    }));
    pane.querySelectorAll('[data-ins-range]').forEach(b => b.addEventListener('click', () => {
      inspectorState.insightsRange = b.getAttribute('data-ins-range');
      reRenderSess();
    }));
    el('insp-ins-search')?.addEventListener('input', (e) => {
      inspectorState.insightsSearch = e.target.value || '';
      renderHistorySessions(pane);
      const i = el('insp-ins-search');
      if (i) { i.focus(); i.setSelectionRange?.(i.value.length, i.value.length); }
    });
    el('insp-ins-sort')?.addEventListener('change', (e) => {
      inspectorState.insightsSort = e.target.value;
      renderHistorySessions(pane);
    });
    pane.querySelectorAll('[data-ins-tag]').forEach(b => b.addEventListener('click', () => {
      const [kind, ...rest] = b.getAttribute('data-ins-tag').split(':');
      const name = rest.join(':');
      if (inspectorState.insightsTagFilter?.kind === kind && inspectorState.insightsTagFilter?.name === name) {
        inspectorState.insightsTagFilter = null;
      } else {
        const list = kind === 'tool' ? ins.topTools : (kind === 'cmd' ? ins.topCommands : ins.topSkills);
        const found = (list || []).find(x => x.name === name);
        inspectorState.insightsTagFilter = found ? { kind, name, sessionIds: found.sessionIds } : null;
      }
      renderHistorySessions(pane);
    }));
    pane.querySelectorAll('[data-jump-cid]').forEach(b => b.addEventListener('click', () => {
      jumpToAgySession(b.getAttribute('data-jump-cid'));
    }));
    pane.querySelectorAll('[data-inspect-cid]').forEach(b => b.addEventListener('click', (e) => {
      e.stopPropagation();
      openInspector({ cascadeId: b.getAttribute('data-inspect-cid'), tab: 'live', sub: 'overview', force: true, keepTarget: true });
    }));
  }

  // =========================================================================
  // Master Tab Renderer & Static Event Wiring
  // =========================================================================
  let lastAnimatedInspectorTab = null;
  let tabAnimResetTimer = null;

  function renderInspectorActiveTab() {
    if (!inspectorState.open) return;
    const pane = el('insp-body');
    if (!pane) return;
    const tabChanged = inspectorState.tab !== lastAnimatedInspectorTab;
    lastAnimatedInspectorTab = inspectorState.tab;
    if (pane.dataset) pane.dataset.tabAnim = tabChanged ? '1' : '0';
    if (tabAnimResetTimer) { clearTimeout(tabAnimResetTimer); tabAnimResetTimer = null; }
    if (tabChanged) {
      tabAnimResetTimer = setTimeout(() => {
        tabAnimResetTimer = null;
        if (pane.dataset) pane.dataset.tabAnim = '0';
      }, 240);
    }
    hideInspectorChartTooltip();
    syncInspectorGearPopover();
    if (inspectorState.tab === 'live') {
      if (inspectorState.liveSub === 'browser') renderLiveBrowser(pane);
      else if (inspectorState.liveSub === 'activity') renderLiveActivity(pane);
      else renderLiveOverview(pane);
    } else if (inspectorState.tab === 'quota') {
      renderQuotaTab(pane);
    } else {
      if (inspectorState.historySub === 'speed') renderHistorySpeed(pane);
      else if (inspectorState.historySub === 'sessions') renderHistorySessions(pane);
      else renderHistoryUsage(pane);
    }
  }

  el('badge-inspector')?.addEventListener('click', () => openInspector({ tab: 'live', sub: 'overview' }));
  el('btn-open-inspector')?.addEventListener('click', () => openInspector({ tab: 'live', sub: 'overview' }));
  el('overflow-inspector-btn')?.addEventListener('click', () => openInspector({ tab: 'live', sub: 'overview' }));
  el('btn-inspector-close')?.addEventListener('click', () => closeInspector());
  el('btn-inspector-refresh')?.addEventListener('click', () => {
    if (inspectorState.tab === 'quota') {
      if (typeof refreshQuotaNow === 'function') void refreshQuotaNow({ force: true, manual: true });
    } else if (inspectorState.tab === 'history') {
      if (inspectorState.historySub === 'sessions') void fetchInspectorInsights(true);
      else if (typeof syncTokenHistoryFromHost === 'function') void syncTokenHistoryFromHost(true);
    } else {
      void fetchInspectorDeepDive(true);
    }
  });
  el('btn-inspector-back-current')?.addEventListener('click', () => {
    if (state.route) openInspector({ cascadeId: state.route, tab: 'live', sub: 'overview', force: true });
  });
  el('insp-gear-btn')?.addEventListener('click', () => {
    inspectorState.gearOpen = !inspectorState.gearOpen;
    syncInspectorGearPopover();
  });
  el('insp-override-apply')?.addEventListener('click', () => { void applyInspectorContextOverride(); });
  el('insp-override-restart')?.addEventListener('click', () => { openClientRestartConfirmFlow?.(); });
  for (const lg of ['en', 'zh-CN', 'zh-TW']) {
    el(`insp-lang-${lg}`)?.addEventListener('click', () => {
      void applyPanelLanguage?.(lg, { persist: true });
    });
  }
  for (const tm of ['auto', 'dark', 'light']) {
    el(`insp-theme-${tm}`)?.addEventListener('click', () => {
      currentThemeMode = tm;
      try { localStorage?.setItem('ag_theme_mode', tm); } catch { }
      applyTheme?.();
      syncInspectorGearPopover();
      renderInspectorActiveTab();
    });
  }
  const applyToolbarPref = patch => {
    saveToolbarPrefs?.(patch);
    syncInspectorGearPopover();
    renderSpeedBarplotBars?.(el('badge-speed')?.getAttribute('data-phase') || 'idle', el('speed-barplot')?.style?.color || '');
    if (typeof applyQuotaSnapshotView === 'function' && typeof quotaViewState !== 'undefined' && quotaViewState.lastPayload) {
      applyQuotaSnapshotView(quotaViewState.lastPayload);
    }
    if (typeof applyTokenHistoryPayload === 'function' && typeof ANTIGRAVITY_TOKEN_DATA !== 'undefined') {
      const miniHm = el('token-mini-heatmap');
      if (miniHm) miniHm.hidden = getToolbarPrefs?.().miniHeatmap === false;
    }
  };
  el('insp-speed-area')?.addEventListener('click', () => applyToolbarPref({ speedChart: 'area' }));
  el('insp-speed-bars')?.addEventListener('click', () => applyToolbarPref({ speedChart: 'bars' }));
  el('insp-qanim-wave')?.addEventListener('click', () => applyToolbarPref({ quotaAnim: 'wave' }));
  el('insp-qanim-instant')?.addEventListener('click', () => applyToolbarPref({ quotaAnim: 'instant' }));
  el('insp-hm-on')?.addEventListener('click', () => applyToolbarPref({ miniHeatmap: true }));
  el('insp-hm-off')?.addEventListener('click', () => applyToolbarPref({ miniHeatmap: false }));
  for (const tb of ['live', 'quota', 'history']) {
    el(`tab-insp-${tb}`)?.addEventListener('click', () => switchInspectorTab(tb));
  }
  el('panel-inspector')?.addEventListener('click', (e) => {
    if (e.target === el('panel-inspector')) closeInspector();
  });

  // Delegated Floating Hover Tooltip Listeners
  const inspBodyEl = el('insp-body');
  inspBodyEl?.addEventListener('mouseover', (e) => {
    const hoverTarget = e?.target?.closest?.('[data-insp-hover]');
    if (hoverTarget) showInspectorChartTooltipForTarget(hoverTarget);
  });
  inspBodyEl?.addEventListener('mouseout', (e) => {
    const cur = e?.target?.closest?.('[data-insp-hover]');
    const rel = e?.relatedTarget?.closest?.('[data-insp-hover]');
    if (cur && cur !== rel) hideInspectorChartTooltip();
  });
  inspBodyEl?.addEventListener('scroll', hideInspectorChartTooltip, { passive: true });
