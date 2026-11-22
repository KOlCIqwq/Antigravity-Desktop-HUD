(function () {
  'use strict';
  if ((location.protocol !== 'https:' && location.protocol !== 'http:') || location.hostname !== '127.0.0.1') return;

  // 在替换或重载旧实例之前捕获当前打开面板、滚动位置与未保存设置草稿（同时兼容无 captureHotReloadState 的旧版本）
  let inheritedHotReloadState = null;
  try {
    if (typeof globalThis.__AGContextMeter?.captureHotReloadState === 'function') {
      inheritedHotReloadState = globalThis.__AGContextMeter.captureHotReloadState();
    } else if (typeof document !== 'undefined') {
      const prevHost = document.getElementById('ag-context-meter');
      const prevRoot = prevHost?.shadowRoot;
      if (prevRoot) {
        const readVal = id => prevRoot.getElementById(id)?.value;
        const readChk = id => Boolean(prevRoot.getElementById(id)?.checked);
        const pCtx = prevRoot.getElementById('panel');
        const pTokens = prevRoot.getElementById('panel-tokens');
        const pQuota = prevRoot.getElementById('panel-quota');
        const openPanel = (pQuota && !pQuota.hidden) ? 'quota'
          : ((pTokens && !pTokens.hidden) ? 'tokens'
            : ((pCtx && !pCtx.hidden) ? 'context' : 'none'));
        const activeTab = ['session', 'models', 'speed', 'settings'].find(
          k => prevRoot.getElementById(`tab-ctx-${k}`)?.classList?.contains('active')
        ) || null;
        const scrollTops = {};
        for (const sId of ['panel', 'panel-tokens', 'panel-quota', 'ctx-model-list', 'quota-view-body']) {
          const n = prevRoot.getElementById(sId);
          if (n && Number(n.scrollTop) > 0) scrollTops[sId] = Number(n.scrollTop);
        }
        const openDrawers = [];
        for (const btnId of [
          'btn-toggle-details', 'btn-toggle-card-details', 'btn-toggle-unlock-details',
          'btn-toggle-enhance-details', 'btn-toggle-proxy', 'btn-toggle-colors', 'btn-toggle-token-colors'
        ]) {
          if (prevRoot.getElementById(btnId)?.getAttribute?.('aria-expanded') === 'true') {
            openDrawers.push(btnId);
          }
        }
        const proxySaveBtn = prevRoot.getElementById('btn-save-proxy-config');
        const enhanceSaveBtn = prevRoot.getElementById('btn-enhance-preset-apply');
        inheritedHotReloadState = {
          capturedAt: Date.now(),
          openPanel,
          activeContextTab: activeTab,
          isContextSettingsView: activeTab === 'settings',
          scrollTops,
          openDrawers,
          drafts: {
            proxyInputDirty: Boolean(proxySaveBtn && !proxySaveBtn.hidden),
            proxyUrl: readVal('input-proxy-url'),
            proxyBypass: readVal('input-proxy-bypass'),
            ctxDraftDirty: Boolean(readVal('ctx-custom-limit-input')),
            ctxCustomValue: readVal('ctx-custom-limit-input'),
            enhanceTitleDirty: Boolean(enhanceSaveBtn && !enhanceSaveBtn.hidden),
            enhanceTitleDraft: readChk('chk-enhance-chinese-title')
          }
        };
      }
    }
  } catch { }

  globalThis.__AGContextMeter?.dispose?.();
  const activeDisposers = (globalThis.__AGContextMeterDisposers = globalThis.__AGContextMeterDisposers || new Set());
  for (const fn of Array.from(activeDisposers)) {
    try { fn(); } catch { }
  }
  activeDisposers.clear();
  // 清理此前初始化异常或重复挂载遗留的孤儿宿主容器，保证页面内永远仅有唯一实例
  try {
    if (typeof document.querySelectorAll === 'function') {
      document.querySelectorAll('#ag-context-meter').forEach(node => {
        try {
          if (typeof node.__agForceDispose === 'function') {
            node.__agForceDispose();
            node.remove?.();
            return;
          }
          // 无主历史闭包节点：剥离 ID、隐藏且清空 shadowRoot 内容，保持其在位静默不再触发重插循环
          node.removeAttribute?.('id');
          node.setAttribute?.('data-ag-retired', '1');
          if (node.style) {
            node.style.cssText = 'display:none!important;width:0!important;height:0!important;overflow:hidden!important;pointer-events:none!important;position:absolute!important;';
          }
          if (node.shadowRoot && typeof node.shadowRoot.innerHTML === 'string') {
            node.shadowRoot.innerHTML = '';
          }
        } catch { }
      });
    }
  } catch { }
  const {
    summarize,
    parseGeneratorCall,
    calculateRequestApiCost,
    normalizeModelId,
    resolveStableModelId,
    formatEffortLabel,
    detectModelVendor,
    groupModelProduct,
    formatTokensK,
    isValidSpeedSample,
    computeMedian,
    summarizeSpeedByModel,
    computeCacheReadStats,
    summarizeCacheReadStats,
    normalizeSessionCallRecord,
    sanitizeTurnPreviewText,
    groupSessionCallsByTurns,
    ELV91_SCORE_RULE_VERSION,
    formatHumanDuration,
    computeStreamStability,
    calculateExperienceScore,
    evaluateGenerationExperience,
    getLvlForRange,
    getDailyModelCost,
    calculateIntervalCost,
    convertToCNY,
    resolveEffectivePlanStatus,
    selectPrimaryQuotaBucket,
    splitModelDisplayAndEffort,
    resolvePlaceholderModelInfo
  } = (globalThis.__AGContextMeterCore || {});
  const host = document.createElement('div');
  host.id = 'ag-context-meter';
  host.setAttribute('data-layout', 'wide');
  host.setAttribute('data-dock', 'fixed');
  host.setAttribute('data-window-active', 'true');
  const shadow = host.attachShadow({ mode: 'open' });

  // Antigravity 本地真实 Token 统计基准数据（纯净初始状态，启动时由宿主实时扫描本地实际账本注入）
  const ANTIGRAVITY_TOKEN_DATA = {
    updatedAt: "",
    firstUseDate: null,
    summary: {
      grandTotalTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheTokens: 0,
      todayTokens: 0,
      monthTokens: 0,
      yearTokens: 0,
      totalSteps: 0,
      totalConversations: 0,
      firstUseDate: null,
      activeDaysCount: 0
    },
    dailyMap: {},
    dailyModelMap: {},
    dailyModelMapBySource: null,
    modelMetaByKey: null,
    speedRecords: []
  };

  const RING_RADIUS = 7.5;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

  /* @INSERT_STYLES_AND_TEMPLATE */

  (document.body || document.documentElement).appendChild(host);
  const el = id => shadow.getElementById(id);
  /* @INSERT_I18N_MODULE */
  /* @INSERT_BUDGET_ENGINE_MODULE */
  const budgetEngine = globalThis.__AGContextBudgetEngine || {};
  const fmt = v => v == null ? '—' : Math.round(v).toLocaleString('en-US');
  const short = v => {
    if (v == null) return '—';
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) return `${parseFloat((v / 1000).toFixed(1))}K`;
    return fmt(v);
  };
  // 悬停信息气泡专用紧凑计数格式（如 37k、475k、1.05M）
  const fmtBubbleToken = v => {
    if (v == null) return t('common.unknown');
    if (v >= 1e9) return `${parseFloat((v / 1e9).toFixed(2))}B`;
    if (v >= 1e6) return `${parseFloat((v / 1e6).toFixed(2))}M`;
    if (v >= 1000) {
      const k = v / 1000;
      return k >= 10 ? `${Math.round(k)}k` : `${parseFloat(k.toFixed(1))}k`;
    }
    return String(Math.round(v));
  };
  const range = value => value ? `≈ ${short(value.low)}–${short(value.high)}` : '—';
  const token = value => value == null ? t('common.notProvided') : `${fmt(value)} tokens`;
  const state = {
    route: null, count: 0, latest: null, requestAt: 0, requestError: '',
    requestBusy: false, requestNext: 0, scanBusy: false, scanNext: 0,
    scanError: '', scan: null, generation: 0, controllers: new Set(),
    disposed: false, layoutMode: 'wide', tooltipOpen: false,
    callsHydrated: false, syncedFinalMap: new Map(), pendingFinalCalls: new Map(),
    quarantinedOversizeMap: new Map(), flushFinalsBusy: false, pendingFlushForceSync: false,
    nextFlushRetryAt: 0, nextOversizeRetryAt: 0,
    displayedCallRecord: null, displayedCallSig: '', pendingLatestCallRecord: null,
    pinnedCallRecord: null, latestCallDetailOpen: false, lastAnimatedCallSig: '',
    historyDrawerOpen: false, sessionTimeline: null, timelineLoading: false,
    timelineError: '', expandedTurnKeys: new Set(), timelinePageLimit: 10,
    timelineAutoExpandedRoute: null, timelineRenderedRoute: null,
    lastTimelineFetchAt: 0, lastTimelineCallSig: '', callRenderTimer: null,
    callEnterAnimTimer: null,
    speedBreakdownOpen: false, livePendingRequest: null, liveWaitTickTimer: null,
    streamSampleTracker: null, lastSpeedEval: null, speedOverrideForTest: null
  };
  const route = () => location.pathname.match(/^\/c\/([a-f\d-]{36})(?:\/|$)/i)?.[1] || null;
  let activeHeatView = 'daily';
  let heatPageOffset = 0;
  let heatMonthOffset = 0;
  let heatYearOffset = 0;
  let activeCostModel = 'gemini-3.8-flash';
  let activeCostMode = 'ref';
  let autoCheckUpdate = true;
  let cachedLatestRelease = null;

  function getToolbarPrefs() {
    const def = { speedChart: 'area', quotaAnim: 'wave', miniHeatmap: true };
    try {
      const raw = localStorage?.getItem('ag_cb_toolbar_prefs');
      if (raw) return { ...def, ...JSON.parse(raw) };
    } catch {}
    return def;
  }

  function saveToolbarPrefs(patch) {
    const next = { ...getToolbarPrefs(), ...(patch || {}) };
    try { localStorage?.setItem('ag_cb_toolbar_prefs', JSON.stringify(next)); } catch {}
    return next;
  }

  const METER_RENDERER_VERSION = typeof METER_VERSION !== 'undefined' ? METER_VERSION : '0.8.8';
  function formatDisplayVersion(rawVer) {
    const clean = String(rawVer ?? METER_RENDERER_VERSION).replace(/^v/i, '').trim();
    if (!clean) return '0.8.8 α';
    if (clean === '0.8.8') return '0.8.8 α';
    return `v${clean}`;
  }
  const backendStatus = {
    rendererVersion: METER_RENDERER_VERSION,
    backendSource: null,
    backendVersion: null,
    backendPid: null,
    ipcBackendVersion: (typeof window !== 'undefined' && window.__AGContextMeterBootBackend?.backendVersion)
      ? String(window.__AGContextMeterBootBackend.backendVersion)
      : null,
    liveHostVersion: (typeof window !== 'undefined' && window.__AGContextMeterLive?.version)
      ? String(window.__AGContextMeterLive.version)
      : null,
    liveHealthy: null,
    hotReloadFallback: false,
    backendVersionMismatch: false,
    lastVerifiedAtMs: null,
    lastQuotaDurationMs: null,
    lastError: null
  };

  function hasLiveHttpBridge() {
    return typeof window !== 'undefined' && Boolean(window.__AGContextMeterLive?.port && window.__AGContextMeterLive?.token);
  }

  function hasLiveRouteCapability(routePath) {
    if (!hasLiveHttpBridge()) return false;
    const caps = window.__AGContextMeterLive?.capabilities;
    if (!caps || typeof caps !== 'object') return true;
    const map = {
      '/quota': 'quota',
      '/scan': 'scan',
      '/token-history': 'tokenHistory',
      '/session-timeline': 'sessionTimeline',
      '/session-deep-dive': 'sessionDeepDive',
      '/cross-session-insights': 'crossSessionInsights',
      '/record-calls': 'recordCalls',
      '/get-settings': 'settings',
      '/save-settings': 'settings',
      '/launch-cli': 'launchCli',
      '/context-unlock-status': 'contextUnlock',
      '/context-unlock-apply': 'contextUnlock',
      '/context-unlock-restore': 'contextUnlock',
      '/enhance-status': 'enhance',
      '/enhance-apply': 'enhance',
      '/enhance-restore': 'enhance',
      '/restart-language-servers': 'enhance',
      '/modules-status': 'modules',
      '/toggle-module': 'modules',
      '/test-proxy': 'modules',
      '/accounts-overview': 'accounts',
      '/accounts-action': 'accounts',
      '/check-update': 'checkUpdate',
      '/apply-update': 'applyUpdate'
    };
    const key = map[routePath];
    if (!key) return true;
    if (Array.isArray(caps)) return caps.includes(key);
    return caps[key] !== false;
  }

  function shouldPreferLiveHost(ipcAvailable = false, routePath = '') {
    if (!hasLiveHttpBridge()) return false;
    if (routePath && !hasLiveRouteCapability(routePath)) return false;
    if (!ipcAvailable) return true;
    if (backendStatus.liveHealthy === false) return false;
    const live = window.__AGContextMeterLive || {};
    if (backendStatus.ipcBackendVersion === METER_RENDERER_VERSION) {
      return false;
    }
    if (live.version && live.version === METER_RENDERER_VERSION) {
      return true;
    }
    if (typeof window !== 'undefined' && window.__AGContextMeterHotReloadContext?.preferLiveHost) {
      return true;
    }
    return false;
  }

  async function postLiveHttpEndpoint(routePath, body = {}, opts = {}) {
    const live = typeof window !== 'undefined' ? window.__AGContextMeterLive : null;
    if (!live?.port || !live?.token) {
      throw new Error('LIVE_BRIDGE_UNAVAILABLE');
    }
    const headers = { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token };
    const fetchOpts = {
      method: 'POST',
      headers,
      body: JSON.stringify(body || {})
    };
    if (opts.signal) fetchOpts.signal = opts.signal;
    const r = await fetch(`http://127.0.0.1:${live.port}${routePath}`, fetchOpts);
    if (!r.ok) {
      const errBody = typeof r.json === 'function' ? await r.json().catch(() => null) : null;
      const err = new Error(errBody?.error || `HTTP ${r.status}`);
      err.httpStatus = r.status;
      err.responseData = errBody;
      throw err;
    }
    return await r.json();
  }

  function syncObservedBackendMeta(source, payloadOrRes, durationMs = null) {
    if (Number.isFinite(durationMs)) backendStatus.lastQuotaDurationMs = durationMs;
    const ver = payloadOrRes?.collectorVersion || payloadOrRes?.backendVersion || payloadOrRes?.version || payloadOrRes?.data?.collectorVersion || payloadOrRes?.data?.backendVersion || null;
    if (source === 'live-host') {
      backendStatus.liveHealthy = true;
      backendStatus.backendSource = 'live-host';
      backendStatus.hotReloadFallback = false;
      if (ver) {
        backendStatus.backendVersion = String(ver);
        backendStatus.liveHostVersion = String(ver);
      } else if (window.__AGContextMeterLive?.version) {
        backendStatus.backendVersion = String(window.__AGContextMeterLive.version);
      }
      if (payloadOrRes?.pid) backendStatus.backendPid = payloadOrRes.pid;
    } else if (source === 'electron-ipc') {
      backendStatus.backendSource = 'electron-ipc';
      if (ver) {
        backendStatus.backendVersion = String(ver);
        backendStatus.ipcBackendVersion = String(ver);
      }
    }
    backendStatus.backendVersionMismatch = Boolean(
      backendStatus.backendVersion &&
      backendStatus.backendVersion !== METER_RENDERER_VERSION
    );
    backendStatus.lastVerifiedAtMs = Date.now();
  }

  async function callBackendWithPriority({ ipcCall = null, liveRoute = '', liveBody = {}, liveFetchOpts = {}, onFallback = null } = {}) {
    const hasIpc = typeof ipcCall === 'function';
    const preferLive = shouldPreferLiveHost(hasIpc, liveRoute);
    if (preferLive && liveRoute) {
      try {
        const res = await postLiveHttpEndpoint(liveRoute, liveBody, liveFetchOpts);
        syncObservedBackendMeta('live-host', res?.data || res);
        return { source: 'live-host', result: res };
      } catch (liveErr) {
        if (liveErr?.name === 'AbortError') throw liveErr;
        backendStatus.liveHealthy = false;
        backendStatus.lastError = liveErr?.message || String(liveErr || '');
        if (!hasIpc) throw liveErr;
        backendStatus.hotReloadFallback = true;
        if (typeof onFallback === 'function') onFallback(liveErr);
      }
    }
    if (hasIpc) {
      const res = await ipcCall();
      syncObservedBackendMeta('electron-ipc', res?.data || res);
      return { source: 'electron-ipc', result: res };
    }
    if (hasLiveHttpBridge() && liveRoute) {
      const res = await postLiveHttpEndpoint(liveRoute, liveBody, liveFetchOpts);
      syncObservedBackendMeta('live-host', res?.data || res);
      return { source: 'live-host', result: res };
    }
    return { source: 'none', result: null };
  }

  /**
   * 获取当前有效设备像素比，用于跨屏混合 DPI 下的物理像素网格对齐
   */
  function getEffectiveDpr() {
    try {
      const dpr = typeof window !== 'undefined' ? Number(window.devicePixelRatio) : 1;
      return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
    } catch {
      return 1;
    }
  }

  /**
   * 将 CSS 逻辑坐标对齐到最近的物理设备像素边界，防止 100%/175% 混合缩放下出现亚像素偏移发虚
   */
  function snapToDevicePixel(px) {
    const num = Number(px);
    if (!Number.isFinite(num)) return 0;
    const dpr = getEffectiveDpr();
    return Math.round(num * dpr) / dpr;
  }

  /* @INSERT_COLORS_MODULE */
  // =========================================================================
  // 模块 2: 宿主布局挂载、右上角原生窗口控制区预留、渐进式宽度收缩与悬浮层定位
  // =========================================================================
  let resizeObserver = null;
  let hostDomObserver = null;
  let brandObserver = null;
  let observedTitlebar = null;
  let layoutRaf = 0;
  const earlyDisposeHooks = [];
  const disconnectBrandObserver = () => {
    try { brandObserver?.disconnect?.(); } catch { }
    if (brandObserver && globalThis.__AGContextMeterBrandObserver === brandObserver) {
      globalThis.__AGContextMeterBrandObserver = null;
    }
    brandObserver = null;
  };
  const earlyForceDispose = () => {
    state.disposed = true;
    for (const controller of state.controllers) {
      try { controller.abort(); } catch { }
    }
    if (layoutRaf && typeof cancelAnimationFrame === 'function') {
      try { cancelAnimationFrame(layoutRaf); } catch { }
      layoutRaf = 0;
    }
    while (earlyDisposeHooks.length) {
      const hook = earlyDisposeHooks.pop();
      try { hook(); } catch { }
    }
    try { resizeObserver?.disconnect?.(); } catch { }
    try { hostDomObserver?.disconnect?.(); } catch { }
    disconnectBrandObserver();
    if (globalThis.__AGContextMeterActiveHost === host) {
      globalThis.__AGContextMeterActiveHost = null;
    }
    activeDisposers.delete(earlyForceDispose);
    try { host.remove?.(); } catch { }
  };
  globalThis.__AGContextMeterActiveHost = host;
  host.__agForceDispose = earlyForceDispose;
  activeDisposers.add(earlyForceDispose);

  function findHostTitlebar() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      return document.querySelector('[class*="@container/titlebar"]');
    } catch {
      return null;
    }
  }

  function isTopRightToolbarCluster(el) {
    if (!el || typeof el.getAttribute !== 'function') return false;
    const cls = el.className || '';
    if (typeof cls !== 'string') return false;
    const classList = typeof el.classList?.contains === 'function'
      ? el.classList
      : { contains: c => cls.split(/\s+/).includes(c) };
    if (!classList.contains('absolute') || !classList.contains('right-0')) return false;

    const styleTop = el.style?.top || el.getAttribute('style') || '';
    const hasTopClass = classList.contains('top-0');
    const hasTopStyle = /(?:^|;)\s*top:\s*0(?:px)?(?:\s*;|$)/i.test(styleTop);
    const rectTop = el.getBoundingClientRect ? el.getBoundingClientRect().top : 0;
    if (el.getBoundingClientRect && rectTop >= 20) return false;
    const isAtTop = hasTopClass || hasTopStyle || (rectTop <= 10 && rectTop >= 0);
    if (!isAtTop) return false;

    // 排除明显非顶栏容器（右侧全高抽屉、全屏浮层或带有明确非零高度下沉定位的浮层）
    if (classList.contains('bottom-0') || classList.contains('h-screen') || classList.contains('h-full')) {
      return false;
    }

    // 排除右侧滚动条滑槽（特征：包含 top-0.5 / bottom-0.5 / w-3 等滚动条特征）
    if (classList.contains('w-3') || classList.contains('right-0.5')) {
      return false;
    }

    // 必须符合顶栏控制按钮容器特征：
    // a) 包含右侧栏切换按钮
    // b) 或包含 z-50 并具有 flex / items-center 水平布局
    const hasAuxToggle = Boolean(el.querySelector && el.querySelector('[data-testid="toggle-aux-sidebar"]'));
    const hasToolbarLayout = classList.contains('z-50') && (classList.contains('items-center') || classList.contains('flex'));

    return hasAuxToggle || hasToolbarLayout;
  }

  function findTopRightCluster() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      // 1. 优先从右侧栏切换按钮向上寻找最近的顶栏容器
      const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxToggle?.closest) {
        // 先尝试带 top-0 的经典结构（Antigravity 1.x）
        let cluster = auxToggle.closest('div.absolute.right-0.top-0');
        if (cluster && isTopRightToolbarCluster(cluster)) return cluster;
        // 兼容 Antigravity 2.x（top: 0px 写在内联 style，class 无 top-0）
        cluster = auxToggle.closest('div.absolute.right-0');
        if (cluster && isTopRightToolbarCluster(cluster)) return cluster;
      }

      // 2. 备用安全探测：当 auxToggle 尚未挂载或被动态卸载时，精确匹配顶栏容器
      // 严格检查顶部坐标与容器特征，绝不误伤滚动条、侧栏抽屉或模态弹窗
      const selectors = [
        'div.h-screen.w-screen > div.flex-1 > div.absolute.right-0.top-0.z-50',
        'div.h-screen.w-screen > div.flex-1 > div.absolute.right-0.z-50',
        'div.absolute.right-0.z-50'
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && isTopRightToolbarCluster(el)) return el;
      }
      return null;
    } catch {
      return null;
    }
  }

  // 动态计算右上角原生窗口控制区（Minimize / Maximize / Close）独占宽度（CSS px）
  function computeWindowControlsWidth(topRight) {
    if (!topRight) return 0;
    try {
      const plat = (typeof navigator !== 'undefined' && navigator.platform) || '';
      if (/^Mac|iPhone|iPad/i.test(plat)) return 0;
      if (topRight?.getBoundingClientRect) {
        const tr = topRight.getBoundingClientRect();
        // 若顶部已单独渲染菜单栏（top >= 20），则 40px 工具栏不在窗口顶边，无需重复留白
        if (tr.height > 0 && tr.top >= 20) return 0;
      }
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
      // 优先 1: 标准 WCO 接口 navigator.windowControlsOverlay
      const wco = typeof navigator !== 'undefined' ? navigator.windowControlsOverlay : null;
      if (wco?.visible && typeof wco.getTitlebarAreaRect === 'function') {
        const rect = wco.getTitlebarAreaRect();
        if (rect && rect.width > 0 && vw > 0 && rect.width < vw) {
          return Math.max(0, Math.ceil(vw - rect.right));
        }
      }
      // 优先 2: 根据 Electron titleBarOverlay 几何规格（Windows 3 颗原生控制按钮共 138 OS DIP）与实时缩放比动态换算
      let zoomFactor = 1;
      if (typeof window !== 'undefined') {
        const nativeZoom = window.electronNative?.getZoomLevel?.();
        if (typeof nativeZoom === 'number' && nativeZoom >= 0.25 && nativeZoom <= 5) {
          zoomFactor = nativeZoom;
        } else if (window.outerWidth > 0 && window.innerWidth > 0) {
          const ratio = window.outerWidth / window.innerWidth;
          if (ratio >= 0.25 && ratio <= 5) zoomFactor = ratio;
        }
      }
      const rawCssWidth = Math.ceil(138 / zoomFactor);
      let existingSpacerWidth = 0;
      if (topRight?.querySelectorAll) {
        const spacers = topRight.querySelectorAll('div[aria-hidden="true"]');
        for (const sp of spacers) {
          if (sp.id !== 'ag-wco-spacer' && sp.getBoundingClientRect) {
            existingSpacerWidth += Math.round(sp.getBoundingClientRect().width || parseFloat(sp.style?.width) || 0);
          }
        }
      }
      return Math.max(0, rawCssWidth - existingSpacerWidth);
    } catch {
      return 98;
    }
  }

  function syncWindowControlsOverlay() {
    if (state.disposed) return;
    try {
      const topRight = findTopRightCluster();
      const wcoWidth = computeWindowControlsWidth(topRight);
      const spacer = typeof document.getElementById === 'function' ? document.getElementById('ag-wco-spacer') : null;
      if (topRight && typeof document.createElement === 'function' && wcoWidth > 0) {
        let activeSpacer = spacer;
        if (!activeSpacer || activeSpacer.parentElement !== topRight) {
          activeSpacer?.remove?.();
          activeSpacer = document.createElement('div');
          activeSpacer.id = 'ag-wco-spacer';
          activeSpacer.setAttribute('aria-hidden', 'true');
          topRight.appendChild(activeSpacer);
        }
        const targetCss = `width:${wcoWidth}px;height:100%;flex-shrink:0;pointer-events:none;`;
        if (activeSpacer.style.cssText !== targetCss) {
          activeSpacer.style.cssText = targetCss;
        }
      } else {
        if (spacer) {
          spacer.remove();
        }
        if (topRight?.querySelectorAll) {
          const oldSpacers = topRight.querySelectorAll('#ag-wco-spacer');
          for (const s of oldSpacers) {
            s.remove?.();
          }
        }
      }

      // 主对话区顶栏若处于窗口最顶行（无独立菜单栏，top < 20）且靠最右边，需同步避让系统控制按钮及右侧独立浮动簇
      let titlebarWcoPad = 0;
      const titlebar = findHostTitlebar();
      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        const vw = (typeof window !== 'undefined' && window.innerWidth) || 0;
        if (tbRect.height > 0 && tbRect.top < 20 && (vw <= 0 || tbRect.right >= vw - 16)) {
          const baseWco = computeWindowControlsWidth(titlebar);
          if (baseWco > 0) {
            titlebarWcoPad = baseWco;
            if (topRight && topRight !== titlebar && !titlebar.contains?.(topRight) && topRight.getBoundingClientRect) {
              const trRect = topRight.getBoundingClientRect();
              if (trRect.width > 0 && trRect.top < 20 && vw > 0 && trRect.left < vw) {
                titlebarWcoPad = Math.max(titlebarWcoPad, Math.ceil(vw - trRect.left) + 6);
              }
            }
          }
        }
      }

      if (typeof document.head !== 'undefined' && document.head && typeof document.createElement === 'function') {
        let styleEl = typeof document.getElementById === 'function' ? document.getElementById('ag-topbar-host-fix') : null;
        if (!styleEl) {
          styleEl = document.createElement('style');
          styleEl.id = 'ag-topbar-host-fix';
          document.head.appendChild(styleEl);
        }
        const activeWco = wcoWidth > 0 || titlebarWcoPad > 0;
        const cssText = [
          '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] {',
          '  padding-right: calc(var(--right-cluster-width, 140px) - 4px) !important;',
          '}',
          titlebarWcoPad > 0 ? [
            '[class*="@container/titlebar"] {',
            `  padding-right: ${titlebarWcoPad}px !important;`,
            '}'
          ].join('\n') : '',
          activeWco ? [
            '[class*="@container/titlebar"],',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id],',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child {',
            '  -webkit-app-region: drag;',
            '}',
            '[class*="@container/titlebar"] button,',
            '[class*="@container/titlebar"] a,',
            '[class*="@container/titlebar"] input,',
            '[class*="@container/titlebar"] [role="button"],',
            '[data-testid="pane-titlebar-toolbar"] > *,',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] button,',
            '[data-aux-pane-focus-scope="true"] > div[data-active-tab-id] [data-tab-id],',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child button,',
            'div[role="navigation"][aria-label] > div.shrink-0:first-child a,',
            '#ag-context-meter {',
            '  -webkit-app-region: no-drag;',
            '}'
          ].join('\n') : ''
        ].join('\n');
        if (styleEl.textContent !== cssText) {
          styleEl.textContent = cssText;
        }
      }
      syncNativeOverlayTheme();
    } catch { }
  }

  let layoutMeasurementDirty = true;
  let cachedMeasuredAvailWidth = null;
  let cachedMeasuredAvailAt = 0;
  let cachedMeasuredWinWidth = 0;

  function ensureHostDocked() {
    if (state.disposed) return;
    if (globalThis.__AGContextMeterActiveHost && globalThis.__AGContextMeterActiveHost !== host) {
      earlyForceDispose();
      return;
    }
    // 热路径短路：宿主已稳固停靠在预期标题栏内且尺寸未标脏时，跳过 DOM 遍历与强制布局查询
    if (
      !layoutMeasurementDirty
      && host.isConnected
      && host.getAttribute('data-dock') === 'flow'
      && observedTitlebar
      && observedTitlebar.isConnected
      && observedTitlebar.contains(host)
      && host.parentElement
    ) {
      return;
    }
    syncWindowControlsOverlay();
    const titlebar = findHostTitlebar();
    if (titlebar) {
      // 自愈保护：若主对话区（div.flex[style*="min-width"]）的 inline flex-grow 被意外清空，立即恢复为 1，绝不覆写其他分栏属性
      try {
        const convPane = titlebar.closest?.('div.flex[style*="min-width"]');
        if (convPane?.style && (!convPane.style.flexGrow || convPane.style.flexGrow === '0')) {
          convPane.style.flexGrow = '1';
        }
      } catch { }

      let targetContainer = titlebar;
      try {
        const rightGroup = titlebar.querySelector(':scope > div.shrink-0') || titlebar.lastElementChild;
        if (rightGroup && rightGroup !== titlebar.firstElementChild) {
          targetContainer = rightGroup;
        }
      } catch { }

      if (host.parentElement !== targetContainer) {
        if (targetContainer.firstChild && targetContainer !== titlebar) {
          targetContainer.insertBefore(host, targetContainer.firstChild);
        } else {
          targetContainer.appendChild(host);
        }
      }
      host.setAttribute('data-dock', 'flow');
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
      } catch { }
      host.style.right = '';
      host.style.top = '';

      if (observedTitlebar !== titlebar) {
        observedTitlebar = titlebar;
        try {
          if (resizeObserver) {
            resizeObserver.disconnect();
            resizeObserver.observe(titlebar);
            if (document.body) resizeObserver.observe(document.body);
          }
        } catch { }
      }
    } else {
      const fallbackParent = document.body || document.documentElement;
      if (fallbackParent && host.parentElement !== fallbackParent) {
        fallbackParent.appendChild(host);
      }
      host.setAttribute('data-dock', 'fixed');
      updateFixedFallbackPosition();
    }
    updateResponsiveLayout(layoutMeasurementDirty);
  }

  function findNativeTopRightAnchor() {
    try {
      if (typeof document.querySelector !== 'function') return null;
      const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      const openIdeBtn = buttons.find(b => {
        const text = (b.textContent || '').trim();
        return (text === 'Open IDE' || text === '打开 IDE' || text.includes('Open IDE') || text.includes('打开 IDE')) && b.getBoundingClientRect?.().top < 50;
      });
      if (openIdeBtn) {
        const parentGroup = openIdeBtn.closest('div.flex.items-center, div.absolute.right-0') || openIdeBtn;
        return parentGroup;
      }
      const auxToggle = document.querySelector('[data-testid="toggle-aux-sidebar"]');
      if (auxToggle?.closest) {
        return auxToggle.closest('div.absolute.right-0.top-0') || auxToggle;
      }
      return document.querySelector('div.absolute.right-0.top-0');
    } catch {
      return null;
    }
  }

  function updateFixedFallbackPosition() {
    if (host.getAttribute?.('data-dock') === 'flow') {
      try {
        host.style.removeProperty?.('right');
        host.style.removeProperty?.('top');
      } catch { }
      host.style.right = '';
      host.style.top = '';
      return;
    }
    try {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      let rightOffset = 144;
      const anchor = findNativeTopRightAnchor();
      if (anchor?.getBoundingClientRect) {
        const r = anchor.getBoundingClientRect();
        if (r.width > 0 && r.left > 0 && r.left < vw) {
          rightOffset = Math.max(144, Math.ceil(vw - r.left + 6));
        }
      }
      host.style.top = '6px';
      host.style.right = `${rightOffset}px`;
    } catch { }
  }

  // 带迟滞区间（Hysteresis）的四阶段渐进收缩计算，防止临界宽度抖动
  function computeNextLayoutMode(availWidth, currentMode) {
    // 阈值设计：
    // wide <-> compact: 收缩 < 195px, 恢复 >= 210px
    // compact <-> minimal: 收缩 < 135px, 恢复 >= 150px
    // minimal <-> ring-only: 收缩 < 68px, 恢复 >= 82px
    if (availWidth == null || Number.isNaN(availWidth)) return 'wide';
    if (currentMode === 'wide') {
      if (availWidth < 68) return 'ring-only';
      if (availWidth < 135) return 'minimal';
      if (availWidth < 195) return 'compact';
      return 'wide';
    }
    if (currentMode === 'compact') {
      if (availWidth >= 210) return 'wide';
      if (availWidth < 68) return 'ring-only';
      if (availWidth < 135) return 'minimal';
      return 'compact';
    }
    if (currentMode === 'minimal') {
      if (availWidth >= 210) return 'wide';
      if (availWidth >= 150) return 'compact';
      if (availWidth < 68) return 'ring-only';
      return 'minimal';
    }
    // currentMode === 'ring-only'
    if (availWidth >= 210) return 'wide';
    if (availWidth >= 150) return 'compact';
    if (availWidth >= 82) return 'minimal';
    return 'ring-only';
  }

  function measureAvailableWidth(force = false) {
    try {
      const now = Date.now();
      const curWinW = typeof window !== 'undefined' ? (window.innerWidth || 0) : 0;
      if (
        !force
        && !layoutMeasurementDirty
        && cachedMeasuredAvailWidth !== null
        && curWinW === cachedMeasuredWinWidth
        && now - cachedMeasuredAvailAt < 300
      ) {
        return cachedMeasuredAvailWidth;
      }
      const titlebar = findHostTitlebar();
      if (titlebar?.getBoundingClientRect) {
        const tbRect = titlebar.getBoundingClientRect();
        if (tbRect.width > 0) {
          const titleEl = titlebar.firstElementChild;
          const titleInner = titleEl?.firstElementChild;
          const contentStart = titleInner?.getBoundingClientRect
            ? Math.max(8, titleInner.getBoundingClientRect().left - tbRect.left)
            : (tbRect.left < 168 ? (168 - tbRect.left) : 12);
          const titleRealW = titleEl?.scrollWidth ? Math.min(320, titleEl.scrollWidth) : 160;
          const minTitleWidth = tbRect.width < 760
            ? Math.max(96, Math.min(180, titleRealW))
            : Math.max(150, titleRealW);
          let nativeButtonsWidth = 64;
          let rightPad = 8;
          let titlebarOwnPadRight = 0;
          if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
            titlebarOwnPadRight = parseFloat(window.getComputedStyle(titlebar).paddingRight) || 0;
          }

          const rightGroup = host.parentElement;
          if (rightGroup && rightGroup !== titlebar) {
            const auxOpen = typeof document.querySelector === 'function'
              && !!document.querySelector('[data-testid="aux-pane-sash"]');
            const root = typeof document.querySelector === 'function'
              ? document.querySelector('div.h-screen.w-screen')
              : null;
            const rightClusterVar = root?.style?.getPropertyValue?.('--right-cluster-width')?.trim() || '';
            if (auxOpen) {
              rightPad = 8;
            } else if (rightClusterVar) {
              rightPad = Math.max(8, (parseFloat(rightClusterVar) || 44) - 4);
            } else if (typeof window !== 'undefined' && typeof window.getComputedStyle === 'function') {
              rightPad = parseFloat(window.getComputedStyle(rightGroup).paddingRight) || 0;
            }
            if (rightGroup.children) {
              let sum = 0;
              for (const child of rightGroup.children) {
                if (child !== host && child.getBoundingClientRect) {
                  sum += child.getBoundingClientRect().width;
                }
              }
              if (sum > 0) nativeButtonsWidth = sum + 6;
            }
          }
          const effectiveRightReserve = Math.max(rightPad, titlebarOwnPadRight);
          const avail = tbRect.width - contentStart - minTitleWidth - effectiveRightReserve - nativeButtonsWidth;
          cachedMeasuredAvailWidth = avail;
          cachedMeasuredAvailAt = now;
          cachedMeasuredWinWidth = curWinW;
          layoutMeasurementDirty = false;
          return avail;
        }
      }
      if (typeof window !== 'undefined' && window.innerWidth) {
        const avail = window.innerWidth - 360;
        cachedMeasuredAvailWidth = avail;
        cachedMeasuredAvailAt = now;
        cachedMeasuredWinWidth = curWinW;
        layoutMeasurementDirty = false;
        return avail;
      }
    } catch { }
    return 400;
  }

  function renderSessionCost() {
    const roundCostBar = el('round-cost-bar');
    const roundCostText = el('round-cost-text');
    const sessionCostText = el('session-cost-text');
    if (!roundCostText || !sessionCostText) return;
    const activeCalls = state.sessionCalls || [];
    const latestCall = activeCalls[activeCalls.length - 1];
    const sessTotal = state.sessionCostTotal || 0;
    if (latestCall && latestCall.isPriced) {
      const roundCost = latestCall.costUSD || 0;
      const roundCostStr = roundCost < 0.01 ? '<$0.01' : `≈$${roundCost.toFixed(4)}`;
      const estLabel = latestCall.status === 'streaming' ? t('cost.streamingEst') : t('cost.returnedEst');
      roundCostText.textContent = t('cost.latestTurn', { val: roundCostStr, label: estLabel });
      roundCostText.title = t('cost.modelTip', {
        model: latestCall.model,
        input: fmt(latestCall.inputTokens),
        cache: fmt(latestCall.cacheTokens),
        output: fmt(latestCall.outputTokens),
        cost: roundCost.toFixed(6)
      });
    } else if (latestCall) {
      roundCostText.textContent = t('cost.unpriced');
      roundCostText.title = latestCall.model ? t('cost.unpricedTip', { model: latestCall.model }) : t('cost.missingModel');
    } else {
      roundCostText.textContent = t('cost.latestDash');
      roundCostText.title = '';
    }
    sessionCostText.textContent = sessTotal > 0 ? t('cost.sessionTotal', { val: sessTotal.toFixed(4) }) : t('session.sessionCost.dash');
  }

  function applyLayoutMode(nextMode) {
    if (!nextMode) return;
    const prev = state.layoutMode;
    state.layoutMode = nextMode;
    host.setAttribute('data-layout', nextMode);
    if (prev !== nextMode) {
      if (nextMode !== 'minimal' && nextMode !== 'ring-only') {
        const om = el('overflow-menu');
        if (om) om.hidden = true;
        el('badge-overflow')?.setAttribute('aria-expanded', 'false');
      }
      syncSpeedBadgeText();
    }
    renderSessionCost();
  }

  function updateResponsiveLayout(forceMeasure = false) {
    if (state.disposed) return;
    if (forceMeasure) layoutMeasurementDirty = true;
    syncWindowControlsOverlay();
    const avail = measureAvailableWidth(forceMeasure);
    const nextMode = computeNextLayoutMode(avail, state.layoutMode);
    applyLayoutMode(nextMode);
    if (state.tooltipOpen) positionContextTooltip();
    if (state.quotaTooltipOpen) positionQuotaTooltip();
    if (isAnyPanelOpen() || !el('overflow-menu')?.hidden) positionFloatingPanels();
  }

  function scheduleLayoutSync() {
    if (state.disposed) return;
    if (typeof requestAnimationFrame === 'function') {
      if (layoutRaf) return;
      layoutRaf = requestAnimationFrame(() => {
        layoutRaf = 0;
        ensureHostDocked();
      });
    } else {
      ensureHostDocked();
    }
  }

  // 定位顶栏圆环悬停气泡：空间足够时优先在锚点上方，顶部空间不足时自动翻转至下方，左右防裁切
  function positionBadgeTooltip(tipId, anchorId, fallbackW = 190, fallbackH = 66) {
    const tip = el(tipId);
    const badge = el(anchorId);
    if (!tip || !badge || !badge.getBoundingClientRect) return;
    try {
      const bRect = badge.getBoundingClientRect();
      if (bRect.width === 0 && bRect.height === 0) return;
      const tRect = tip.getBoundingClientRect ? tip.getBoundingClientRect() : { width: fallbackW, height: fallbackH };
      const tipW = tRect.width || fallbackW;
      const tipH = tRect.height || fallbackH;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const gap = 7;

      const spaceAbove = bRect.top;
      const spaceBelow = vh - bRect.bottom;
      let top;
      if (spaceAbove >= tipH + gap + 6 || spaceAbove > spaceBelow) {
        top = bRect.top - tipH - gap;
        tip.setAttribute('data-placement', 'top');
      } else {
        top = bRect.bottom + gap;
        tip.setAttribute('data-placement', 'bottom');
      }
      top = snapToDevicePixel(Math.max(6, Math.min(vh - tipH - 6, top)));

      let left = bRect.left + bRect.width / 2 - tipW / 2;
      left = snapToDevicePixel(Math.max(8, Math.min(vw - tipW - 8, left)));

      tip.style.top = `${top}px`;
      tip.style.left = `${left}px`;
    } catch { }
  }

  function positionContextTooltip() {
    positionBadgeTooltip('context-tooltip', 'badge', 190, 66);
  }

  function positionQuotaTooltip() {
    positionBadgeTooltip('quota-tooltip', 'badge-quota', 220, 84);
  }

  function hideAllTooltips() {
    hideContextTooltip();
    hideQuotaTooltip();
    hideSpeedTooltip();
    hideTokensTooltip();
  }

  function showContextTooltip() {
    const tip = el('context-tooltip');
    if (!tip || !el('panel')?.hidden) return;
    hideQuotaTooltip();
    hideSpeedTooltip();
    hideTokensTooltip();
    state.tooltipOpen = true;
    tip.setAttribute('data-visible', 'true');
    positionContextTooltip();
  }

  function hideContextTooltip() {
    const tip = el('context-tooltip');
    if (!tip) return;
    state.tooltipOpen = false;
    tip.setAttribute('data-visible', 'false');
  }

  function showQuotaTooltip() {
    const tip = el('quota-tooltip');
    if (!tip || isAnyPanelOpen()) return;
    hideContextTooltip();
    hideSpeedTooltip();
    hideTokensTooltip();
    state.quotaTooltipOpen = true;
    tip.setAttribute('data-visible', 'true');
    positionQuotaTooltip();
  }

  function hideQuotaTooltip() {
    const tip = el('quota-tooltip');
    if (!tip) return;
    state.quotaTooltipOpen = false;
    tip.setAttribute('data-visible', 'false');
  }

  function showSpeedTooltip() {
    const tip = el('speed-tooltip');
    if (!tip || isAnyPanelOpen()) return;
    hideContextTooltip();
    hideQuotaTooltip();
    hideTokensTooltip();
    const d = state.latest;
    const sp = d?.speed;
    const rowsEl = el('speed-tip-rows');
    const subEl = el('speed-tip-sub');
    if (rowsEl) {
      if (sp) {
        const rows = [
          ['Stream Speed', sp.streamingTps != null ? `${sp.streamingTps} tok/s` : '—'],
          ['Overall Rate', sp.tps != null ? `${sp.tps} tok/s` : '—'],
          ['TTFT', sp.ttft != null ? `${sp.ttft}s` : '—'],
          ['Total Time', sp.duration != null ? `${sp.duration}s` : '—'],
          ['Output / Think', `${fmt(sp.outputTokens || 0)} / ${fmt(sp.thinkingTokens || 0)}`],
          ...(sp.eScore != null ? [['E-Score', `${sp.eScore} / 100${sp.eGrade ? ` (${sp.eGrade})` : ''}`]] : [])
        ];
        rowsEl.innerHTML = rows.map(([k, v]) => `<div class="quota-tip-row"><span class="quota-tip-label">${k}</span><span class="quota-tip-val">${v}</span></div>`).join('');
      } else {
        rowsEl.innerHTML = '';
      }
    }
    if (subEl) subEl.textContent = d?.model || (state.requestBusy ? 'Generating…' : 'Idle');
    tip.setAttribute('data-visible', 'true');
    positionBadgeTooltip('speed-tooltip', 'badge-speed', 220, 120);
  }

  function hideSpeedTooltip() {
    const tip = el('speed-tooltip');
    if (tip) tip.setAttribute('data-visible', 'false');
  }

  function showTokensTooltip() {
    const tip = el('tokens-tooltip');
    if (!tip || isAnyPanelOpen()) return;
    hideContextTooltip();
    hideQuotaTooltip();
    hideSpeedTooltip();
    const h = typeof ANTIGRAVITY_TOKEN_DATA !== 'undefined' ? ANTIGRAVITY_TOKEN_DATA : null;
    const sum = h?.summary;
    const rowsEl = el('tokens-tip-rows');
    const subEl = el('tokens-tip-sub');
    if (rowsEl) {
      if (sum && (Number(sum.grandTotalTokens) > 0 || Number(sum.totalConversations) > 0)) {
        const costUsd = sum.costEstimate?.pricedCostUSD ?? sum.referenceCost?.all?.totalCostUSD;
        const rows = [
          ['Total Tokens', short(sum.grandTotalTokens || 0)],
          ['Today', short(sum.todayTokens || 0)],
          ['This Month', short(sum.monthTokens || 0)],
          ['Cache Hit', sum.cacheReadStats?.cacheReadPct != null ? `${sum.cacheReadStats.cacheReadPct}%` : '—'],
          ['Est. API Cost', costUsd != null ? `$${Number(costUsd).toFixed(2)}` : '—']
        ];
        rowsEl.innerHTML = rows.map(([k, v]) => `<div class="quota-tip-row"><span class="quota-tip-label">${k}</span><span class="quota-tip-val">${v}</span></div>`).join('');
      } else {
        rowsEl.innerHTML = '';
      }
    }
    if (subEl) {
      subEl.textContent = (sum && (Number(sum.grandTotalTokens) > 0 || Number(sum.totalConversations) > 0))
        ? `${sum.totalConversations || 0} conversations · ${sum.activeDaysCount || 0} active days`
        : 'Scanning local usage…';
    }
    tip.setAttribute('data-visible', 'true');
    positionBadgeTooltip('tokens-tooltip', 'badge-tokens', 220, 120);
  }

  function hideTokensTooltip() {
    const tip = el('tokens-tooltip');
    if (tip) tip.setAttribute('data-visible', 'false');
  }

  let elevatedStackAncestor = null;

  function syncHostStackingElevation(elevate) {
    try {
      if (elevate) {
        const z0 = host.closest?.('div.relative.z-0');
        if (z0?.style) {
          elevatedStackAncestor = z0;
          z0.style.zIndex = '40';
        }
      } else if (elevatedStackAncestor?.style) {
        elevatedStackAncestor.style.zIndex = '';
        elevatedStackAncestor = null;
      }
    } catch { }
  }

  function getLeftProjectSidebarRight(vw) {
    try {
      if (typeof document.querySelector === 'function') {
        const navEl = document.querySelector('div[role="navigation"]');
        if (navEl?.getBoundingClientRect) {
          const nr = navEl.getBoundingClientRect();
          if (nr.width > 0 && nr.left <= 8 && nr.right > 0 && nr.right < vw - 260) {
            return Math.ceil(nr.right);
          }
        }
      }
    } catch { }
    return 0;
  }

  function positionFloatingPanels() {
    if (!host.getBoundingClientRect) return;
    try {
      const hRect = host.getBoundingClientRect();
      if (hRect.width === 0 && hRect.height === 0) return;
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1280;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 800;
      const navRight = getLeftProjectSidebarRight(vw);
      const minLeft = navRight > 0 ? Math.max(12, navRight + 12) : 12;

      const placePanel = (panelEl, targetW, anchorBtn) => {
        if (!panelEl) return;
        const bRect = (anchorBtn && anchorBtn.getBoundingClientRect && anchorBtn !== host && anchorBtn.getBoundingClientRect().right > hRect.left)
          ? anchorBtn.getBoundingClientRect()
          : hRect;
        const dpr = getEffectiveDpr();
        const top = snapToDevicePixel(Math.max(36, Math.min(vh - 120, (bRect.bottom || hRect.bottom) + 6)));
        const isCompact = panelEl.classList?.contains?.('cost-compact-view') || panelEl.getAttribute?.('class')?.includes?.('cost-compact-view');
        const effW = isCompact ? 400 : targetW;
        const maxAvailW = Math.max(260, vw - minLeft - 12);
        const finalW = Math.min(effW, maxAvailW);

        // 核心锚点：右侧精确对齐到触发按钮右边缘，并按当前 DPI 物理像素网格对齐
        let left = snapToDevicePixel(bRect.right - finalW);
        left = Math.min(left, snapToDevicePixel(vw - finalW - 12));
        left = Math.max(snapToDevicePixel(minLeft), left);

        const maxWidthPx = Math.max(260, vw - left - 12);
        const maxHeightPx = Math.max(160, vh - top - 16);
        const geomKey = `${top}|${left}|${maxWidthPx}|${maxHeightPx}|${isCompact ? 1 : 0}|${dpr}`;
        if (panelEl._lastPlacedGeomKey === geomKey) return;
        panelEl._lastPlacedGeomKey = geomKey;

        panelEl.style.top = `${top}px`;
        panelEl.style.left = `${left}px`;
        panelEl.style.right = 'auto';
        panelEl.style.maxWidth = `${maxWidthPx}px`;
        panelEl.style.maxHeight = `${maxHeightPx}px`;
        panelEl.style.transformOrigin = 'top right';
      };

      placePanel(el('panel'), 472, el(activeContextAnchorId) || el('badge'));
      placePanel(el('panel-quota'), 460, el(activeQuotaAnchorId) || el('badge-quota'));
      placePanel(el('panel-tokens'), 730, el(activeTokensAnchorId) || el('badge-tokens'));
      placePanel(el('overflow-menu'), 220, el('badge-overflow'));
      positionColorPickerPopover();
    } catch { }
  }

  let lastObservedHostModelSig = null;
  let hostModelSyncTimer = null;
  let domMutationThrottleTimer = null;
  function scheduleHostModelSync() {
    try {
      if (state.disposed || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
      if (hostModelSyncTimer) return;
      hostModelSyncTimer = setTimeout(() => {
        hostModelSyncTimer = null;
        try {
          if (state.disposed || typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
          const trig = document.querySelector('[data-testid="model-selector-trigger"]');
          const nextSig = trig ? `${trig.getAttribute?.('aria-label') || ''}|${trig.textContent || ''}` : '';
          if (nextSig === lastObservedHostModelSig) return;
          lastObservedHostModelSig = nextSig;
          if (typeof syncContextModelSelectionFromState === 'function') {
            syncContextModelSelectionFromState();
          }
        } catch { }
      }, 60);
    } catch { }
  }

  function flushHostDomMutationCheck() {
    domMutationThrottleTimer = null;
    if (state.disposed) return;
    if (!host.isConnected || host.getAttribute('data-dock') !== 'flow' || !findHostTitlebar()?.contains?.(host)) {
      scheduleLayoutSync();
    }
    scheduleHostModelSync();
  }

  try {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => updateResponsiveLayout(true));
      if (document.body) resizeObserver.observe(document.body);
    }
    if (typeof MutationObserver !== 'undefined' && document.body) {
      hostDomObserver = new MutationObserver(() => {
        if (state.disposed) return;
        // 轻量 O(1) 检查优先，其余全量/选择器查询合并节流至低频窗口，防止聊天吐字与切会话卡顿
        if (!host.isConnected || host.getAttribute('data-dock') !== 'flow') {
          layoutMeasurementDirty = true;
          scheduleLayoutSync();
        }
        if (!domMutationThrottleTimer) {
          domMutationThrottleTimer = setTimeout(flushHostDomMutationCheck, 180);
        }
      });
      hostDomObserver.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] });
    }
  } catch { }

  const onWindowResize = () => {
    updateResponsiveLayout(true);
    try { syncCumResponsiveNarrowState(); } catch { }
  };
  const handleDpiOrZoomChange = () => {
    try {
      for (const id of ['panel', 'panel-quota', 'panel-tokens', 'overflow-menu']) {
        const node = el(id);
        if (node) node._lastPlacedGeomKey = '';
      }
      layoutMeasurementDirty = true;
      updateResponsiveLayout(true);
      const upPop = el('update-popover');
      if (upPop && upPop.style.display === 'block') {
        positionUpdatePopover();
      }
      if (state.tooltipOpen) positionContextTooltip();
    } catch { }
  };
  let removeDpiWatcher = null;
  const attachDpiWatcher = () => {
    try {
      if (removeDpiWatcher) {
        removeDpiWatcher();
        removeDpiWatcher = null;
      }
      if (state.disposed || typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
      const mql = window.matchMedia(`(resolution: ${getEffectiveDpr()}dppx)`);
      if (!mql) return;
      const onChange = () => {
        if (state.disposed) return;
        attachDpiWatcher();
        handleDpiOrZoomChange();
      };
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        removeDpiWatcher = () => {
          try { mql.removeEventListener?.('change', onChange); } catch { }
        };
      } else if (typeof mql.addListener === 'function') {
        mql.addListener(onChange);
        removeDpiWatcher = () => {
          try { mql.removeListener?.(onChange); } catch { }
        };
      }
    } catch { }
  };
  const onWindowFocus = () => {
    host.setAttribute('data-window-active', 'true');
    if (typeof onQuotaWindowFocus === 'function') onQuotaWindowFocus();
  };
  const onWindowBlur = () => {
    host.setAttribute('data-window-active', 'false');
    if (typeof onQuotaWindowBlur === 'function') onQuotaWindowBlur();
  };
  try {
    window.addEventListener?.('resize', onWindowResize);
    window.addEventListener?.('focus', onWindowFocus);
    window.addEventListener?.('blur', onWindowBlur);
    navigator?.windowControlsOverlay?.addEventListener?.('geometrychange', onWindowResize);
    attachDpiWatcher();
    earlyDisposeHooks.push(() => {
      try {
        window.removeEventListener?.('resize', onWindowResize);
        window.removeEventListener?.('focus', onWindowFocus);
        window.removeEventListener?.('blur', onWindowBlur);
        navigator?.windowControlsOverlay?.removeEventListener?.('geometrychange', onWindowResize);
        if (removeDpiWatcher) {
          removeDpiWatcher();
          removeDpiWatcher = null;
        }
        if (hostModelSyncTimer) { clearTimeout(hostModelSyncTimer); hostModelSyncTimer = null; }
        if (domMutationThrottleTimer) { clearTimeout(domMutationThrottleTimer); domMutationThrottleTimer = null; }
      } catch { }
    });
  } catch { }

  ensureHostDocked();
