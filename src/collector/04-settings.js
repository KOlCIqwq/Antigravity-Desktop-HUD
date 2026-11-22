// ============================================================================
// 用户自定义订阅配置与插件栏偏好持久化（按账号隔离 + default 回退 + 损坏自愈）
// ============================================================================
function getCustomPlanPath(overridePathOrDir) {
  if (overridePathOrDir) {
    if (overridePathOrDir.endsWith('.json')) return overridePathOrDir;
    return path.join(overridePathOrDir, 'custom_plan_v1.json');
  }
  if (process.env.AG_DIR) {
    return path.join(process.env.AG_DIR, 'custom_plan_v1.json');
  }
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.gemini', 'antigravity', 'custom_plan_v1.json');
}

function sanitizeAccountPlanEntry(entry, accountKey = 'default') {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const out = { ...entry };
  out.account = String(entry.account || accountKey || 'default').trim().toLowerCase();

  // 1. 账号所在地区 (accountRegion / country)：独立保留，仅修改本地记录
  const rawAccReg = (typeof out.accountRegion === 'string' && out.accountRegion.trim())
    ? out.accountRegion.trim()
    : ((typeof out.country === 'string' && out.country.trim()) ? out.country.trim() : '');
  if (rawAccReg && !rawAccReg.includes('未知')) {
    out.accountRegion = rawAccReg;
    out.country = rawAccReg;
  } else {
    delete out.accountRegion;
    delete out.country;
  }

  // 2. 订阅国家 (subscriptionCountry / subscriptionRegion / region)：独立保留，可与账号所在地区不同
  const rawSubCountry = (typeof out.subscriptionCountry === 'string' && out.subscriptionCountry.trim())
    ? out.subscriptionCountry.trim()
    : ((typeof out.subscriptionRegion === 'string' && out.subscriptionRegion.trim())
      ? out.subscriptionRegion.trim()
      : ((typeof out.region === 'string' && out.region.trim()) ? out.region.trim() : ''));
  if (rawSubCountry && !rawSubCountry.includes('未知')) {
    out.subscriptionCountry = rawSubCountry;
    out.subscriptionRegion = rawSubCountry;
    out.region = rawSubCountry;
  } else {
    delete out.subscriptionCountry;
    delete out.subscriptionRegion;
    delete out.region;
  }

  // 3. 订阅币种 (subscriptionCurrency / currency)：独立保留，支持标记手动(custom)或自动(auto)来源
  const rawCur = (typeof out.subscriptionCurrency === 'string' && out.subscriptionCurrency.trim())
    ? out.subscriptionCurrency.trim()
    : ((typeof out.currency === 'string' && out.currency.trim()) ? out.currency.trim() : '');
  if (rawCur) {
    let cur = rawCur.toUpperCase();
    if (cur === 'NTD') cur = 'TWD';
    if (CURRENCY_SYMBOLS[cur]) {
      out.subscriptionCurrency = cur;
      out.currency = cur;
      if (!out.currencySymbol) out.currencySymbol = CURRENCY_SYMBOLS[cur];
    } else {
      delete out.subscriptionCurrency;
      delete out.currency;
      delete out.currencySymbol;
    }
  } else {
    delete out.subscriptionCurrency;
    delete out.currency;
    delete out.currencySymbol;
  }

  if (out.currencySource) {
    out.currencySource = String(out.currencySource).trim();
  }

  // 1. 先清洗校验实付金额 (actualPricePaid)
  if (out.actualPricePaid !== undefined && out.actualPricePaid !== null && out.actualPricePaid !== '') {
    const num = Number(out.actualPricePaid);
    if (Number.isFinite(num) && num >= 0) {
      out.actualPricePaid = num;
    } else {
      out.actualPricePaid = null;
    }
  } else {
    out.actualPricePaid = null;
  }

  // 2. 校验价格模式 (priceMode)
  if (out.priceMode === 'custom' || out.priceMode === 'preset') {
    // 保持用户显式模式
  } else if (out.priceSource === 'preset_region') {
    out.priceMode = 'preset';
  } else if (out.actualPricePaid !== null) {
    out.priceMode = 'custom';
  } else {
    out.priceMode = 'preset';
  }

  if (out.priceMode === 'custom' && out.actualPricePaid !== null) {
    out.customActualPrice = out.actualPricePaid;
  }

  if (out.customActualPrice !== undefined && out.customActualPrice !== null && out.customActualPrice !== '') {
    const cNum = Number(out.customActualPrice);
    if (Number.isFinite(cNum) && cNum >= 0) {
      out.customActualPrice = cNum;
    } else {
      delete out.customActualPrice;
    }
  }

  return out;
}

function sanitizeContextPreferenceEntry(raw, fallbackModelId = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const isProductScope = raw.scope === 'product' || (typeof raw.productKey === 'string' && raw.productKey.trim()) || (typeof fallbackModelId === 'string' && fallbackModelId.startsWith('product:'));
  const rawModelId = isProductScope ? (raw.productKey || raw.modelId || fallbackModelId) : (raw.modelId || fallbackModelId);
  if (!rawModelId || typeof rawModelId !== 'string') return null;
  const stableKey = isProductScope
    ? rawModelId.trim().toLowerCase()
    : (resolveStableModelId(rawModelId) || rawModelId.trim().toLowerCase());
  if (!stableKey) return null;

  const modeRaw = String(raw.mode || 'default').trim().toLowerCase();
  if (modeRaw !== 'default' && modeRaw !== 'fixed' && modeRaw !== 'dynamic') {
    return null;
  }

  let limitTokens = null;
  if (modeRaw === 'default') {
    limitTokens = DEFAULT_CHECKPOINT_TOKENS;
  } else if (modeRaw === 'fixed') {
    const val = validateContextLimit(raw.limitTokens);
    if (!val.ok) return null;
    limitTokens = val.limitTokens;
  }

  const out = {
    modelId: stableKey,
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : String(rawModelId).trim(),
    mode: modeRaw,
    limitTokens,
    updatedAt: typeof raw.updatedAt === 'string' && raw.updatedAt ? raw.updatedAt : new Date().toISOString()
  };
  if (isProductScope) {
    out.scope = 'product';
    out.productKey = stableKey;
  }
  return out;
}

function sanitizeContextPreferencesMap(rawMap) {
  const out = {};
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return out;
  for (const [k, v] of Object.entries(rawMap)) {
    const clean = sanitizeContextPreferenceEntry(v, k);
    if (clean) out[clean.modelId] = clean;
  }
  return out;
}

function loadCustomPlanSettings(overridePathOrDir) {
  const p = getCustomPlanPath(overridePathOrDir);
  const def = {
    version: '1.1.0',
    updatedAt: '',
    lastAccount: 'default',
    accounts: {},
    uiPreferences: {},
    contextPreferences: {},
    contextScopeMode: 'unified',
    contextUnifiedPreference: { mode: 'default', limitTokens: null }
  };
  try {
    if (!fs.existsSync(p)) return def;
    const content = fs.readFileSync(p, 'utf8');
    if (!content.trim()) return def;
    let raw;
    try {
      raw = JSON.parse(content);
    } catch (parseErr) {
      // 配置文件损坏时自动隔离备份并恢复默认结构，防止崩溃
      try {
        const bakCorrupt = p.replace(/\.json$/i, '') + '.corrupt.bak.json';
        fs.copyFileSync(p, bakCorrupt);
      } catch { }
      return { ...def, recoveredFromCorruption: true };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ...def, recoveredFromCorruption: true };
    }

    const accounts = {};
    // 兼容旧版直接平铺在顶层的配置结构
    if (!raw.accounts && (raw.region || raw.subscriptionRegion || raw.country || raw.currency || raw.actualPricePaid !== undefined)) {
      const legacyEntry = sanitizeAccountPlanEntry(raw, raw.email || raw.account || 'default');
      if (legacyEntry) {
        accounts[legacyEntry.account] = legacyEntry;
        accounts['default'] = { ...legacyEntry, account: 'default' };
      }
    } else if (raw.accounts && typeof raw.accounts === 'object' && !Array.isArray(raw.accounts)) {
      for (const [k, v] of Object.entries(raw.accounts)) {
        const cleanKey = String(k).trim().toLowerCase();
        const sanitized = sanitizeAccountPlanEntry(v, cleanKey);
        if (sanitized) accounts[cleanKey] = sanitized;
      }
    }

    const uiPreferences = (raw.uiPreferences && typeof raw.uiPreferences === 'object' && !Array.isArray(raw.uiPreferences))
      ? { ...raw.uiPreferences }
      : {};
    const contextPreferences = sanitizeContextPreferencesMap(raw.contextPreferences);

    // 默认使用统一模式，但升级时若已保存非默认模型偏好则保留分别模式，不覆盖用户选择
    let contextScopeMode = 'unified';
    if (raw.contextScopeMode === 'per_model' || raw.contextScopeMode === 'unified') {
      contextScopeMode = raw.contextScopeMode;
    } else if (Object.keys(contextPreferences).length > 0) {
      contextScopeMode = 'per_model';
    }

    const contextUnifiedPreference = raw.contextUnifiedPreference && typeof raw.contextUnifiedPreference === 'object'
      ? (sanitizeContextPreferenceEntry({ ...raw.contextUnifiedPreference, modelId: 'unified' }) || { mode: 'default', limitTokens: null })
      : { mode: 'default', limitTokens: null };

    return {
      version: raw.version || '1.1.0',
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
      lastAccount: typeof raw.lastAccount === 'string' ? raw.lastAccount : 'default',
      accounts,
      uiPreferences,
      contextPreferences,
      contextScopeMode,
      contextUnifiedPreference
    };
  } catch {
    return def;
  }
}

function saveCustomPlanSettingsDetailed(settings, overridePathOrDir) {
  const p = getCustomPlanPath(overridePathOrDir);
  const res = safeWriteJsonSync(p, settings, {
    validate: (data) => data && typeof data === 'object' && !Array.isArray(data)
  });
  if (!res.ok) {
    return { ok: false, error: res.error || '写入配置文件失败', phase: res.phase, path: p };
  }
  return { ok: true, path: p };
}

function saveCustomPlanSettings(settings, overridePathOrDir) {
  return saveCustomPlanSettingsDetailed(settings, overridePathOrDir).ok;
}

function setCustomPlanForAccount(accountKey, customData = {}, overridePathOrDir) {
  if (!accountKey) return false;
  const settings = loadCustomPlanSettings(overridePathOrDir);
  const key = String(accountKey).trim().toLowerCase();
  const merged = sanitizeAccountPlanEntry({
    ...(settings.accounts[key] || {}),
    ...customData,
    account: key,
    updatedAt: new Date().toISOString()
  }, key);
  if (!merged) return false;
  settings.accounts[key] = merged;
  // 同步 default 槽位与最近活跃账号，供启动早期尚未取得邮箱时读取
  settings.accounts['default'] = {
    ...(settings.accounts['default'] || {}),
    ...merged,
    account: 'default'
  };
  if (key !== 'default') settings.lastAccount = key;
  settings.updatedAt = new Date().toISOString();
  return saveCustomPlanSettings(settings, overridePathOrDir);
}

function clearCustomPlanForAccount(accountKey, overridePathOrDir) {
  if (!accountKey) return false;
  const settings = loadCustomPlanSettings(overridePathOrDir);
  const key = String(accountKey).trim().toLowerCase();
  delete settings.accounts[key];
  delete settings.accounts['default'];
  settings.updatedAt = new Date().toISOString();
  return saveCustomPlanSettings(settings, overridePathOrDir);
}

function resolveAccountCustomPlan(customSettingsAll, currentAccountKey) {
  if (!customSettingsAll || !customSettingsAll.accounts) return null;
  const accMap = customSettingsAll.accounts;
  if (currentAccountKey) {
    const k = String(currentAccountKey).trim().toLowerCase();
    if (accMap[k]) return accMap[k];
    // 账号隔离：明确指定了账号（非 default），但在配置中不存在该账号记录时，绝不回退到 default 或 lastAccount
    if (k !== 'default') return null;
  }
  // 仅在未指定账号（启动早期）或明确是 default 时，才允许检查 lastAccount 或 default
  if (!currentAccountKey || currentAccountKey === 'default') {
    if (customSettingsAll.lastAccount && accMap[customSettingsAll.lastAccount]) {
      return accMap[customSettingsAll.lastAccount];
    }
    if (accMap['default']) return accMap['default'];
  }
  return null;
}

function getPluginSettings(options = {}) {
  const targetDir = typeof options === 'string' ? options : options?.agDir;
  const settings = loadCustomPlanSettings(targetDir);
  const email = options?.email || cachedTokenHistory?.planStatus?.email || null;
  const customPlan = resolveAccountCustomPlan(settings, email);
  const uiPrefs = settings.uiPreferences || {};
  const contextPreferences = settings.contextPreferences || {};
  return {
    ok: true,
    customPlan,
    uiPreferences: uiPrefs,
    contextPreferences,
    contextScopeMode: settings.contextScopeMode || 'unified',
    contextUnifiedPreference: settings.contextUnifiedPreference || { mode: 'default', limitTokens: null },
    savedHeatView: uiPrefs.savedHeatView,
    autoCheckUpdate: uiPrefs.autoCheckUpdate,
    panelLanguage: uiPrefs.panelLanguage || 'zh-CN',
    accounts: settings.accounts || {},
    updatedAt: settings.updatedAt || '',
    recoveredFromCorruption: Boolean(settings.recoveredFromCorruption)
  };
}

function savePluginSettings(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, error: '无效的设置参数' };
  }
  const targetDir = typeof options === 'string' ? options : (options?.targetDir || options?.agDir || payload?.targetDir || payload?.agDir);
  const settings = loadCustomPlanSettings(targetDir);
  const rawKey = payload.account || payload.email || cachedTokenHistory?.planStatus?.email || settings.lastAccount || 'default';
  const key = String(rawKey).trim().toLowerCase() || 'default';

  if (payload.clearPlan === true) {
    delete settings.accounts[key];
    if (key === 'default' || settings.lastAccount === key) {
      delete settings.accounts['default'];
      settings.lastAccount = 'default';
    }
  } else if (payload.customPlan && typeof payload.customPlan === 'object') {
    // 账号隔离约束：新账号独立初始化，禁止从默认配置继承以避免跨账号数据污染
    const prev = settings.accounts[key] || {};
    const inputPlan = payload.customPlan;
    const mergedRaw = {
      ...prev,
      ...inputPlan,
      account: key,
      updatedAt: new Date().toISOString()
    };

    // 兼容层双向同步：若更新了兼容字段（如 currency），同步更新规范字段，防止被 prev 中的旧规范字段覆盖
    if (inputPlan.currency && !inputPlan.subscriptionCurrency) {
      mergedRaw.subscriptionCurrency = inputPlan.currency;
    }
    if (inputPlan.subscriptionCurrency && !inputPlan.currency) {
      mergedRaw.currency = inputPlan.subscriptionCurrency;
    }
    if (inputPlan.country && !inputPlan.accountRegion) {
      mergedRaw.accountRegion = inputPlan.country;
    }
    if (inputPlan.accountRegion && !inputPlan.country) {
      mergedRaw.country = inputPlan.accountRegion;
    }
    if (inputPlan.subscriptionRegion && !inputPlan.subscriptionCountry) {
      mergedRaw.subscriptionCountry = inputPlan.subscriptionRegion;
    }
    if (inputPlan.subscriptionCountry && !inputPlan.subscriptionRegion) {
      mergedRaw.subscriptionRegion = inputPlan.subscriptionCountry;
      mergedRaw.region = inputPlan.subscriptionCountry;
    }

    // 传入 null 或空字符串时，从合并对象中删除对应字段
    if (inputPlan.country === null || inputPlan.country === '' || inputPlan.accountRegion === null || inputPlan.accountRegion === '') {
      delete mergedRaw.country;
      delete mergedRaw.accountRegion;
    }
    if (inputPlan.subscriptionRegion === null || inputPlan.subscriptionRegion === '' || inputPlan.subscriptionCountry === null || inputPlan.subscriptionCountry === '' || inputPlan.region === null || inputPlan.region === '') {
      delete mergedRaw.subscriptionRegion;
      delete mergedRaw.subscriptionCountry;
      delete mergedRaw.region;
    }
    if (inputPlan.currency === null || inputPlan.currency === '' || inputPlan.subscriptionCurrency === null || inputPlan.subscriptionCurrency === '') {
      delete mergedRaw.currency;
      delete mergedRaw.subscriptionCurrency;
      delete mergedRaw.currencySymbol;
    }

    const sanitized = sanitizeAccountPlanEntry(mergedRaw, key);
    if (!sanitized) {
      return { ok: false, error: '订阅设置格式无效' };
    }
    settings.accounts[key] = sanitized;
    if (key === 'default') {
      settings.accounts['default'] = { ...sanitized, account: 'default' };
    } else {
      settings.lastAccount = key;
      settings.accounts['default'] = { ...sanitized, account: 'default' };
    }
  }

  const topLevelUiPrefs = {};
  if (typeof payload.savedHeatView === 'string' && payload.savedHeatView) {
    topLevelUiPrefs.savedHeatView = payload.savedHeatView;
  }
  const validPanelLanguages = new Set(['zh-CN', 'zh-TW', 'en']);
  if (typeof payload.autoCheckUpdate === 'boolean') {
    topLevelUiPrefs.autoCheckUpdate = payload.autoCheckUpdate;
  }
  if (typeof payload.panelLanguage === 'string' && validPanelLanguages.has(payload.panelLanguage)) {
    topLevelUiPrefs.panelLanguage = payload.panelLanguage;
  }
  const incomingUiPrefs = (payload.uiPreferences && typeof payload.uiPreferences === 'object' && !Array.isArray(payload.uiPreferences))
    ? { ...payload.uiPreferences, ...topLevelUiPrefs }
    : (Object.keys(topLevelUiPrefs).length > 0 ? topLevelUiPrefs : null);

  if (incomingUiPrefs) {
    if (incomingUiPrefs.panelLanguage !== undefined && !validPanelLanguages.has(incomingUiPrefs.panelLanguage)) {
      delete incomingUiPrefs.panelLanguage;
    }
    const nextUi = {
      ...(settings.uiPreferences || {}),
      ...incomingUiPrefs,
      updatedAt: new Date().toISOString()
    };
    if (nextUi.restartVerification === null) {
      delete nextUi.restartVerification;
    }
    settings.uiPreferences = nextUi;
  }

  if (!settings.contextPreferences || typeof settings.contextPreferences !== 'object') {
    settings.contextPreferences = {};
  }

  if (Array.isArray(payload.clearContextPreferences)) {
    for (const rawKey of payload.clearContextPreferences) {
      if (typeof rawKey !== 'string' || !rawKey.trim()) continue;
      const kNorm = rawKey.trim().toLowerCase();
      delete settings.contextPreferences[kNorm];
      const resolvedK = resolveStableModelId(rawKey);
      if (resolvedK) delete settings.contextPreferences[resolvedK];
    }
  }

  if (payload.clearContextPreference === true) {
    const rawTargetModel = payload.productKey || payload.modelId || payload.contextPreference?.productKey || payload.contextPreference?.modelId;
    if (!rawTargetModel || typeof rawTargetModel !== 'string' || !rawTargetModel.trim()) {
      return { ok: false, error: '恢复模型默认偏好时缺少模型标识' };
    }
    const trimmed = rawTargetModel.trim().toLowerCase();
    delete settings.contextPreferences[trimmed];
    if (!trimmed.startsWith('product:')) {
      const stableKey = resolveStableModelId(rawTargetModel);
      if (stableKey) delete settings.contextPreferences[stableKey];
    }
  } else if (payload.contextPreference !== undefined) {
    const cp = payload.contextPreference;
    if (!cp || typeof cp !== 'object' || Array.isArray(cp)) {
      return { ok: false, error: '无效的模型上下文偏好参数格式' };
    }
    const isProd = cp.scope === 'product' || (typeof cp.productKey === 'string' && cp.productKey.trim());
    const idField = isProd ? (cp.productKey || cp.modelId) : cp.modelId;
    if (!idField || typeof idField !== 'string' || !idField.trim()) {
      return { ok: false, error: '按模型保存偏好时必须提供模型标识' };
    }
    const modeRaw = String(cp.mode || 'default').trim().toLowerCase();
    if (modeRaw !== 'default' && modeRaw !== 'fixed' && modeRaw !== 'dynamic') {
      return { ok: false, error: `不支持的上下文偏好模式: ${cp.mode}` };
    }
    if (modeRaw === 'fixed') {
      const valCheck = validateContextLimit(cp.limitTokens);
      if (!valCheck.ok) {
        return { ok: false, error: valCheck.error };
      }
    }
    const sanitizedPref = sanitizeContextPreferenceEntry({
      ...cp,
      modelId: idField,
      mode: modeRaw,
      updatedAt: new Date().toISOString()
    });
    if (!sanitizedPref) {
      return { ok: false, error: '模型上下文偏好参数校验失败' };
    }
    if (Array.isArray(cp.clearLegacyKeys)) {
      for (const lk of cp.clearLegacyKeys) {
        if (typeof lk !== 'string' || !lk.trim()) continue;
        delete settings.contextPreferences[lk.trim().toLowerCase()];
        const rk = resolveStableModelId(lk);
        if (rk) delete settings.contextPreferences[rk];
      }
    }
    settings.contextPreferences[sanitizedPref.modelId] = sanitizedPref;
  }

  if (payload.contextScopeMode === 'unified' || payload.contextScopeMode === 'per_model') {
    settings.contextScopeMode = payload.contextScopeMode;
  }
  if (payload.contextUnifiedPreference !== undefined) {
    if (payload.contextUnifiedPreference === null) {
      delete settings.contextUnifiedPreference;
    } else if (typeof payload.contextUnifiedPreference === 'object') {
      const sanitizedUnified = sanitizeContextPreferenceEntry({
        ...payload.contextUnifiedPreference,
        modelId: 'unified',
        updatedAt: new Date().toISOString()
      });
      if (sanitizedUnified) {
        settings.contextUnifiedPreference = sanitizedUnified;
      }
    }
  }

  delete settings.recoveredFromCorruption;
  settings.updatedAt = new Date().toISOString();
  const writeRes = saveCustomPlanSettingsDetailed(settings, targetDir);
  if (!writeRes.ok) {
    return { ok: false, error: writeRes.error || '配置落盘失败' };
  }

  const activeCustom = resolveAccountCustomPlan(settings, key === 'default' ? null : key);
  const baseLive = cachedTokenHistory?.rawPlanStatus || cachedTokenHistory?.planStatus || null;
  const effectivePlanStatus = resolveEffectivePlanStatus(baseLive, activeCustom, {
    cachedLivePlan: baseLive,
    currentEmail: key === 'default' ? (baseLive?.email || null) : key
  });

  // 同步更新内存缓存与 v2 归档中的 planStatus，确保刷新或重启即刻一致
  if (!targetDir && cachedTokenHistory) {
    cachedTokenHistory.planStatus = effectivePlanStatus;
    cachedTokenHistory.customPlanSettings = activeCustom;
    cachedTokenHistory.uiPreferences = settings.uiPreferences;
  }
  let archiveSyncWarning = null;
  let archiveSynced = false;
  try {
    const home = process.env.USERPROFILE || os.homedir();
    const agDir = targetDir && !targetDir.endsWith('.json') ? targetDir : (process.env.AG_DIR || path.join(home, '.gemini', 'antigravity'));
    const archivePathV2 = path.join(agDir, 'token_usage_archive_v2.json');
    if (fs.existsSync(archivePathV2)) {
      const readRes = safeReadJsonSync(archivePathV2, null);
      if (readRes.ok && readRes.data && typeof readRes.data === 'object') {
        const v2Raw = { ...readRes.data };
        v2Raw.planStatus = effectivePlanStatus;
        v2Raw.customPlanSettings = activeCustom;
        const writeArch = safeWriteJsonSync(archivePathV2, v2Raw);
        if (!writeArch.ok) {
          archiveSyncWarning = writeArch.error || '写入 v2 归档文件失败';
        } else {
          archiveSynced = true;
        }
      } else if (readRes.corrupted) {
        archiveSyncWarning = 'v2 归档文件内容已损坏，已阻止回写覆盖以保护原始数据';
      }
    }
  } catch (err) {
    archiveSyncWarning = err?.message || '同步派生归档时发生未知异常';
  }

  return {
    ok: true,
    partial: archiveSyncWarning !== null,
    warning: archiveSyncWarning ? `主配置已保存，但派生归档同步失败: ${archiveSyncWarning}` : undefined,
    archiveSynced,
    path: writeRes.path,
    savedAt: settings.updatedAt,
    customPlan: activeCustom,
    planStatus: effectivePlanStatus,
    uiPreferences: settings.uiPreferences,
    contextPreferences: settings.contextPreferences || {},
    contextScopeMode: settings.contextScopeMode || 'unified',
    contextUnifiedPreference: settings.contextUnifiedPreference || null
  };
}

const cachedUserStatusByOrigin = new Map();
const cachedQuotaStateByOrigin = new Map();
const activeQuotaFetchByOrigin = new Map();
