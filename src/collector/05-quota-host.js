function normalizeQuotaOriginScope(options = {}) {
  const raw = typeof options.origin === 'string' ? options.origin.trim() : '';
  return raw || '__default__';
}

function buildAccountScopeKey(emailOrId) {
  const raw = typeof emailOrId === 'string' ? emailOrId.trim().toLowerCase() : '';
  if (!raw) return 'anonymous';
  return 'acct_' + crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function resetQuotaHostCacheForTest() {
  cachedUserStatusByOrigin.clear();
  cachedQuotaStateByOrigin.clear();
  activeQuotaFetchByOrigin.clear();
}

function classifyQuotaFetchError(err) {
  const msg = String(err?.message || err || '未知错误').trim();
  const lower = msg.toLowerCase();
  if (/enoent|devtoolsactiveport/i.test(lower)) {
    return { kind: 'network', message: '本地额度服务尚未就绪，请稍后重试' };
  }
  if (/timeout|timed out|etimedout|deadline/i.test(lower)) {
    return { kind: 'timeout', message: '请求语言服务超时' };
  }
  if (/econnrefused|econnreset|enotfound|not running|unreachable|network|socket|connect/i.test(lower)) {
    return { kind: 'network', message: '未能连接到 Antigravity 本地服务' };
  }
  if (/unauthorized|forbidden|401|403|csrf|鉴权/i.test(lower)) {
    return { kind: 'auth', message: '本地鉴权失败或已失效' };
  }
  return { kind: 'network', message: msg || '额度数据获取失败' };
}

/**
 * 并发拉取宿主模型额度池与可用模型详情，带多窗口 origin 隔离、并发去重、短缓存、失败分级及账号切换检测
 * @param {Object} options - 支持 force / origin / backendSource / userStatus / quotaSummary / connect 等参数
 */
function isValidUserStatusPayload(val) {
  if (!val || typeof val !== 'object' || Array.isArray(val) || Object.keys(val).length === 0) return false;
  if (val.userStatus !== undefined) {
    return Boolean(val.userStatus && typeof val.userStatus === 'object' && !Array.isArray(val.userStatus) && Object.keys(val.userStatus).length > 0);
  }
  return true;
}

async function fetchQuotaSnapshotFromHost(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const force = options.force === true;
  const hasStaticFixture = options.userStatus !== undefined || options.quotaSummary !== undefined || options.error !== undefined;
  const originScope = normalizeQuotaOriginScope(options);
  const backendSource = typeof options.backendSource === 'string' && options.backendSource.trim()
    ? options.backendSource.trim()
    : 'host';

  // 短缓存防刷（仅在非强制刷新且无静态测试桩时生效，15s 内复用同 origin 结果）
  const prevCachedQuota = cachedQuotaStateByOrigin.get(originScope) || null;
  if (!force && !hasStaticFixture && !options.agDir && prevCachedQuota && (nowMs - prevCachedQuota.fetchedAtMs < 15000)) {
    if (prevCachedQuota.backendSource === backendSource && prevCachedQuota.collectorVersion === PROJECT_VERSION) {
      return prevCachedQuota;
    }
    return {
      ...prevCachedQuota,
      collectorVersion: PROJECT_VERSION,
      backendVersion: PROJECT_VERSION,
      backendSource
    };
  }

  // 如果已有相同 origin 请求进行中，直接合并等待，避免重复请求
  const activePromise = activeQuotaFetchByOrigin.get(originScope) || null;
  if (!hasStaticFixture && activePromise) {
    if (!force) return activePromise;
    try { await activePromise; } catch { }
  }

  const runFetch = async () => {
    let userStatusRes = null;
    let quotaSummaryRes = null;
    let fetchError = null;
    let errorKind = null;

    if (options.error) {
      const classified = classifyQuotaFetchError(options.error);
      fetchError = classified.message;
      errorKind = classified.kind;
    } else if (options.userStatus !== undefined || options.quotaSummary !== undefined) {
      userStatusRes = options.userStatus || null;
      quotaSummaryRes = options.quotaSummary || null;
    } else {
      const localApi = require('./local-api');
      const connector = typeof options.connect === 'function' ? options.connect : localApi.connect;
      const callQuotaApi = async (api) => {
        const [uRes, qRes] = await Promise.allSettled([
          api.call('GetUserStatus', {}),
          api.call('RetrieveUserQuotaSummary', {})
        ]);
        if (uRes.status === 'fulfilled' && isValidUserStatusPayload(uRes.value)) userStatusRes = uRes.value;
        if (qRes.status === 'fulfilled' && qRes.value) quotaSummaryRes = qRes.value;
        if (!userStatusRes && !quotaSummaryRes) {
          throw (uRes.status === 'rejected' ? uRes.reason : (qRes.status === 'rejected' ? qRes.reason : new Error('宿主未返回额度数据')));
        }
      };
      try {
        const connectOpts = typeof options.connect === 'function'
          ? (options.origin ? { origin: options.origin } : undefined)
          : options;
        const api = await connector(connectOpts);
        await callQuotaApi(api);
      } catch (e) {
        let lastErr = e;
        if (typeof options.connect !== 'function') {
          const tried = new Set(options.origin ? [options.origin] : []);
          const hubs = localApi.discoverLiveDaemonHubs(options);
          for (const hub of hubs) {
            for (const candOrigin of [hub.origin, hub.httpOrigin]) {
              if (!candOrigin || tried.has(candOrigin)) continue;
              tried.add(candOrigin);
              try {
                const api = await localApi.connect({ ...options, origin: candOrigin });
                await callQuotaApi(api);
                lastErr = null;
                break;
              } catch (hubErr) {
                lastErr = hubErr;
              }
            }
            if (userStatusRes || quotaSummaryRes) break;
          }
        }
        if (!userStatusRes && !quotaSummaryRes) {
          const classified = classifyQuotaFetchError(lastErr);
          fetchError = classified.message;
          errorKind = classified.kind;
        }
      }
    }

    const doneAtMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const rawConfigs = userStatusRes?.userStatus?.cascadeModelConfigData?.clientModelConfigs
      || userStatusRes?.cascadeModelConfigData?.clientModelConfigs
      || [];
    const sanitizedConfigs = Array.isArray(rawConfigs)
      ? rawConfigs.map(sanitizeCascadeModelConfig).filter(Boolean)
      : [];
    const parsedPlan = userStatusRes ? parseUserPlanStatus(userStatusRes) : null;
    const rawEmail = parsedPlan?.email || userStatusRes?.userStatus?.email || '';
    const scopeQuotaState = cachedQuotaStateByOrigin.get(originScope) || null;
    const scopeUserEntry = cachedUserStatusByOrigin.get(originScope) || null;
    const prevAccountScopeKey = scopeUserEntry?.accountScopeKey || scopeQuotaState?.accountScopeKey || null;
    const nextScopeKey = rawEmail ? buildAccountScopeKey(rawEmail) : (prevAccountScopeKey || 'anonymous');

    // 账号切换检测：一旦发现同 origin 作用域下账号变化，立即清掉旧账号缓存，绝不跨账号残留旧额度
    const accountSwitched = Boolean(
      rawEmail &&
      prevAccountScopeKey &&
      nextScopeKey !== prevAccountScopeKey
    );
    if (accountSwitched) {
      cachedQuotaStateByOrigin.delete(originScope);
      cachedUserStatusByOrigin.delete(originScope);
    }
    if (rawEmail) {
      const existingEntry = cachedUserStatusByOrigin.get(originScope) || {};
      cachedUserStatusByOrigin.set(originScope, {
        ...existingEntry,
        accountScopeKey: nextScopeKey
      });
    }

    if (fetchError) {
      // 保留同 origin 同账号最后一次有效原始响应以产出 stale 状态；无旧数据时产出 error 状态
      const curScoped = cachedQuotaStateByOrigin.get(originScope) || null;
      const prevRaw = (!accountSwitched && curScoped?._raw) ? curScoped._raw : null;
      const snapshot = buildModelQuotaSnapshot({
        cascadeModelConfigs: prevRaw?.cascadeModelConfigs || [],
        quotaSummaryRes: prevRaw?.quotaSummaryRes || null,
        planStatus: prevRaw?.planStatus || null,
        currentModel: options.currentModel || null,
        browsePoolKey: options.browsePoolKey || null,
        fetchMeta: {
          fetchedAtMs: prevRaw?.fetchedAtMs || null,
          error: fetchError,
          errorKind
        },
        nowMs: doneAtMs
      });
      const out = {
        ok: false,
        collectorVersion: PROJECT_VERSION,
        backendVersion: PROJECT_VERSION,
        backendSource,
        originScope,
        accountScopeKey: prevRaw?.accountScopeKey || nextScopeKey,
        accountSwitched,
        fetchedAtMs: doneAtMs,
        lastSuccessAtMs: prevRaw?.fetchedAtMs || null,
        error: fetchError,
        errorKind,
        planTierSummary: prevRaw?.planStatus ? {
          status: prevRaw.planStatus.status,
          tierKey: prevRaw.planStatus.tierKey,
          tierId: prevRaw.planStatus.tierId || null,
          teamsTier: prevRaw.planStatus.teamsTier || null,
          tierName: prevRaw.planStatus.tierName || null,
          planName: prevRaw.planStatus.planName || null
        } : null,
        snapshot,
        _raw: prevRaw
      };
      if (!hasStaticFixture && !options.agDir && curScoped) {
        cachedQuotaStateByOrigin.set(originScope, { ...curScoped, error: fetchError, errorKind, snapshot });
      }
      return out;
    }

    const rawRecord = {
      cascadeModelConfigs: sanitizedConfigs,
      quotaSummaryRes,
      planStatus: parsedPlan,
      fetchedAtMs: doneAtMs,
      accountScopeKey: nextScopeKey
    };

    const snapshot = buildModelQuotaSnapshot({
      cascadeModelConfigs: sanitizedConfigs,
      quotaSummaryRes,
      planStatus: parsedPlan,
      currentModel: options.currentModel || null,
      browsePoolKey: options.browsePoolKey || null,
      fetchMeta: {
        fetchedAtMs: doneAtMs,
        error: null,
        errorKind: null
      },
      nowMs: doneAtMs
    });

    const out = {
      ok: true,
      collectorVersion: PROJECT_VERSION,
      backendVersion: PROJECT_VERSION,
      backendSource,
      originScope,
      accountScopeKey: nextScopeKey,
      accountSwitched,
      fetchedAtMs: doneAtMs,
      lastSuccessAtMs: doneAtMs,
      error: null,
      errorKind: null,
      planTierSummary: parsedPlan ? {
        status: parsedPlan.status,
        tierKey: parsedPlan.tierKey,
        tierId: parsedPlan.tierId || null,
        teamsTier: parsedPlan.teamsTier || null,
        tierName: parsedPlan.tierName || null,
        planName: parsedPlan.planName || null
      } : null,
      snapshot,
      cascadeModelConfigs: sanitizedConfigs,
      _raw: rawRecord
    };

    if (!hasStaticFixture && !options.agDir && Array.isArray(snapshot?.pools) && snapshot.pools.length > 0) {
      cachedQuotaStateByOrigin.set(originScope, out);
    }
    return out;
  };

  if (!hasStaticFixture) {
    const p = runFetch().finally(() => {
      if (activeQuotaFetchByOrigin.get(originScope) === p) activeQuotaFetchByOrigin.delete(originScope);
    });
    activeQuotaFetchByOrigin.set(originScope, p);
    return p;
  }
  return runFetch();
}

async function fetchUserStatusFromHost(options = {}) {
  if (options && options.userStatus !== undefined) {
    if (!options.userStatus) return null;
    const parsed = parseUserPlanStatus(options.userStatus);
    const configs = options.userStatus?.userStatus?.cascadeModelConfigData?.clientModelConfigs || options.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const availMap = options.availableModels ? parseAvailableModelsResponse(options.availableModels) : {};
    if (parsed) {
      if (Object.keys(availMap).length) parsed.availableModelDetails = availMap;
      if (configs.length) parsed.cascadeModelConfigs = mergeModelCapabilitiesIntoConfigs(configs, availMap);
    }
    return parsed;
  }
  const originScope = normalizeQuotaOriginScope(options);
  const cachedEntry = cachedUserStatusByOrigin.get(originScope) || null;
  if (!options.agDir && !options.force && cachedEntry?.status && Date.now() - (cachedEntry.fetchedAt || 0) < 60000) {
    return cachedEntry.status;
  }
  try {
    const { connect } = require('./local-api');
    const api = await connect(options.origin ? { origin: options.origin } : undefined);
    const [res, availRes] = await Promise.all([
      api.call('GetUserStatus', {}),
      api.call('GetAvailableModels', { forceRefresh: false }).catch(() => null)
    ]);
    const parsed = parseUserPlanStatus(res);
    const configs = res?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    const availMap = availRes ? parseAvailableModelsResponse(availRes) : {};
    if (parsed) {
      if (Object.keys(availMap).length) parsed.availableModelDetails = availMap;
      if (configs.length) parsed.cascadeModelConfigs = mergeModelCapabilitiesIntoConfigs(configs, availMap);
    }
    if (parsed && !options.agDir) {
      const nextScope = parsed.email ? buildAccountScopeKey(parsed.email) : null;
      const prevScope = cachedEntry?.accountScopeKey || null;
      if (nextScope && prevScope && nextScope !== prevScope) {
        cachedQuotaStateByOrigin.delete(originScope);
      }
      cachedUserStatusByOrigin.set(originScope, {
        status: parsed,
        fetchedAt: Date.now(),
        accountScopeKey: nextScope || prevScope || null
      });
    }
    return parsed;
  } catch {
    return cachedEntry?.status || null;
  }
}

let activeScanPromise = null;
let activeScanScope = '';
let cachedTokenHistoryScope = '';
let currentScanSequence = 0;
const TRANSCRIPT_SKIP_DIRS = new Set(['steps', 'tasks', 'scratch', 'media', 'artifacts', 'node_modules', '.git', '__pycache__']);
const transcriptFileCache = new Map();

const IGNORED_WSL_DISTRO_RE = /^(?:docker-desktop(?:-data)?|rancher-desktop(?:-data)?|podman-machine(?:-[a-z0-9_-]+)?)$/i;
const WSL_LXSS_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';
