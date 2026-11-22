  function normalizeModelLookupName(raw) {
    return String(raw || '')
      .toLowerCase()
      .replace(/\([^)]*\)/g, ' ')
      .replace(/\b(low|medium|high|xhigh|extra\s*high)\b/gi, ' ')
      .replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractModelsFromGroupDescription(desc) {
    if (!desc || typeof desc !== 'string') return [];
    const m = desc.match(/models\s+within\s+this\s+group\s*:\s*([^\n\r]+)/i);
    if (!m) return [];
    return m[1]
      .split(/[,，、;；]+/)
      .map(s => s.trim())
      .filter(Boolean);
  }

  function inferGroupBucketLabel(windowStr, bucketId = '') {
    const w = String(windowStr || bucketId || '').toLowerCase();
    if (w.includes('5h') || w.includes('hour')) return { key: '5h', short: '5h', label: '5小时限额' };
    if (w.includes('weekly') || w.includes('7d') || w.includes('week')) return { key: 'weekly', short: '7d', label: '每周限额' };
    if (w.includes('daily') || w.includes('24h') || w.includes('day')) return { key: 'daily', short: '24h', label: '每日限额' };
    return { key: w || 'quota', short: '', label: '周期限额' };
  }

  const QUOTA_WINDOW_TIE_ORDER = {
    '5h': 0,
    '24h': 1,
    daily: 1,
    '7d': 2,
    weekly: 2
  };

  function resolveQuotaBucketWindowRank(bucket) {
    if (!bucket || typeof bucket !== 'object') return 99;
    const short = String(bucket.windowShort || '').trim().toLowerCase();
    const key = String(bucket.windowKey || '').trim().toLowerCase();
    const id = String(bucket.bucketId || '').trim().toLowerCase();
    for (const candidate of [short, key]) {
      if (candidate in QUOTA_WINDOW_TIE_ORDER) return QUOTA_WINDOW_TIE_ORDER[candidate];
    }
    if (id.includes('5h') || id.includes('5_hour')) return 0;
    if (id.includes('24h') || id.includes('day') || id.includes('daily')) return 1;
    if (id.includes('7d') || id.includes('week') || id.includes('weekly')) return 2;
    return 10;
  }

  /**
   * 统一选择主限额窗口（被 buildModelQuotaSnapshot 与顶栏徽章渲染共用）：
   * 1) 优先 remainingFraction 最小的更紧缩窗口；
   * 2) 相同剩余量按 5h -> 24h/daily -> 7d/weekly -> 其他 确定性排序；
   * 3) 返回 { primaryBucket, selectionReason } 供悬浮详情解释选择依据。
   */
  function selectPrimaryQuotaBucket(buckets = []) {
    const list = Array.isArray(buckets) ? buckets.filter(Boolean) : [];
    if (!list.length) return { primaryBucket: null, selectionReason: 'none' };
    const priced = list.filter(b => b.remainingFraction !== null && b.remainingFraction !== undefined && Number.isFinite(Number(b.remainingFraction)));
    if (!priced.length) {
      return { primaryBucket: list[0], selectionReason: list.length === 1 ? 'single_window' : 'unpriced_fallback' };
    }
    const sorted = priced.slice().sort((a, b) => {
      const diff = Number(a.remainingFraction) - Number(b.remainingFraction);
      if (Math.abs(diff) > 1e-6) return diff;
      const rankDiff = resolveQuotaBucketWindowRank(a) - resolveQuotaBucketWindowRank(b);
      if (rankDiff !== 0) return rankDiff;
      return String(a.bucketId || '').localeCompare(String(b.bucketId || ''));
    });
    const best = sorted[0];
    if (priced.length === 1) return { primaryBucket: best, selectionReason: 'single_window' };
    const second = sorted[1];
    const isTie = Math.abs(Number(best.remainingFraction) - Number(second.remainingFraction)) <= 1e-6;
    return {
      primaryBucket: best,
      selectionReason: isTie ? 'tie_window' : 'tighter_window'
    };
  }

  /**
   * 聚合账号下各共享额度池、产品档位与当前会话模型额度状态（纯函数）
   * 严格区分：available / low / exhausted / no_permission / stale / error / unknown
   * 绝不把网络错误判为耗尽，绝不把 Notice 标记判为权限不足，绝不伪造重置倒计时或强行推算剩余 Token。
   */
  function buildModelQuotaSnapshot(input = {}) {
    const nowMs = Number.isFinite(Number(input.nowMs)) ? Number(input.nowMs) : Date.now();
    const userStatusRoot = input.userStatusRes?.userStatus || input.userStatusRes || null;
    const rawConfigs = (Array.isArray(input.cascadeModelConfigs) && input.cascadeModelConfigs.length > 0)
      ? input.cascadeModelConfigs
      : (Array.isArray(userStatusRoot?.cascadeModelConfigData?.clientModelConfigs)
        ? userStatusRoot.cascadeModelConfigData.clientModelConfigs
        : []);
    const planStatus = input.planStatus || (userStatusRoot ? parseUserPlanStatus(input.userStatusRes) : null);

    const quotaSummaryRoot = input.quotaSummaryRes?.response || input.quotaSummaryRes || null;
    const rawGroups = Array.isArray(quotaSummaryRoot?.groups) ? quotaSummaryRoot.groups : [];

    const fetchMeta = input.fetchMeta && typeof input.fetchMeta === 'object' ? input.fetchMeta : {};
    const fetchedAtMs = Number.isFinite(Number(fetchMeta.fetchedAtMs)) ? Number(fetchMeta.fetchedAtMs) : null;
    const nextRefreshAtMs = Number.isFinite(Number(fetchMeta.nextRefreshAtMs)) ? Number(fetchMeta.nextRefreshAtMs) : null;
    const staleThresholdMs = Number.isFinite(Number(fetchMeta.staleThresholdMs)) ? Number(fetchMeta.staleThresholdMs) : 180000;
    const lastError = fetchMeta.error ? String(fetchMeta.error) : null;
    const errorKind = fetchMeta.errorKind || (lastError ? 'network' : null);

    // 1. 解析 RetrieveUserQuotaSummary 中的权威共享池组
    const parsedGroups = rawGroups.map((g, idx) => {
      const desc = typeof g.description === 'string' ? g.description.trim() : '';
      const explicitModelNames = Array.isArray(g.modelIds) && g.modelIds.length
        ? g.modelIds.map(String)
        : extractModelsFromGroupDescription(desc);
      const bucketList = Array.isArray(g.buckets) ? g.buckets : [];
      const buckets = bucketList.map((b, bIdx) => {
        const parsedFrac = parseQuotaFraction(b, { unavailable: Boolean(b && b.disabled), schemaKind: 'quota_summary_bucket' });
        const resetMeta = formatQuotaResetMeta(b.resetTime || b.reset_time || null, nowMs);
        const wMeta = inferGroupBucketLabel(b.window || '', b.bucketId || b.id || `bucket-${bIdx}`);
        return {
          bucketId: b.bucketId || b.id || `bucket-${bIdx}`,
          windowKey: wMeta.key,
          windowShort: wMeta.short,
          windowLabel: wMeta.label,
          remainingFraction: parsedFrac.fraction,
          percentText: formatQuotaPercentText(parsedFrac.fraction),
          isExhausted: parsedFrac.isExhausted,
          fractionSource: parsedFrac.source,
          hasResetTime: resetMeta.hasResetTime,
          resetTimeIso: resetMeta.resetTimeIso,
          resetAtMs: resetMeta.resetAtMs,
          resetTimeText: resetMeta.resetTimeText,
          countdownText: resetMeta.countdownText,
          isResetPassed: resetMeta.isResetPassed
        };
      });

      const title = String(g.displayName || g.name || g.groupId || `配额组 ${idx + 1}`).trim();
      let sharedKey = null;
      const joinedHints = [g.groupId, title, desc, ...explicitModelNames].filter(Boolean).join(' ').toLowerCase();
      if (joinedHints.includes('3p') || joinedHints.includes('claude') || joinedHints.includes('gpt-oss')) {
        sharedKey = 'shared_3p_pool';
      } else if (joinedHints.includes('argon')) {
        sharedKey = 'shared_gemini_argon';
      } else if (joinedHints.includes('carbon')) {
        sharedKey = 'shared_gemini_carbon';
      } else if (joinedHints.includes('hydrogen') || joinedHints.includes('flash')) {
        sharedKey = 'shared_gemini_main';
      } else {
        sharedKey = `group_${g.groupId || normalizeModelLookupName(title) || idx}`;
      }

      return {
        groupId: g.groupId || `group-${idx}`,
        sharedKey,
        title,
        description: desc,
        explicitModelNames,
        normalizedExplicitNames: explicitModelNames.map(normalizeModelLookupName).filter(Boolean),
        buckets
      };
    });

    // 2. 将 clientModelConfigs 按产品折叠多挡位（如 Low/Medium/High/XHigh）
    const productMap = new Map();
    const fallbackGroupNames = {
      shared_gemini_main: 'Gemini 4 Hydrogen / Gemini 3.8 Flash',
      shared_3p_pool: 'Claude Opus/Sonnet 5.5 / GPT-OSS 120B (第三方共享池)',
      shared_gemini_argon: 'Gemini 4 Argon / Orchestrator',
      shared_gemini_carbon: 'Gemini 4 Carbon'
    };

    for (const cfg of rawConfigs) {
      if (!cfg || typeof cfg !== 'object') continue;
      if (cfg.isHistorical === true) continue;
      const gInfo = groupModelProduct(cfg);
      const avail = classifyModelQuotaAvailability(cfg, planStatus);
      const qi = cfg.quotaInfo || {};
      const parsedFrac = parseQuotaFraction(qi, { unavailable: avail.noPermission, schemaKind: 'codeium_quota_info' });
      const resetMeta = formatQuotaResetMeta(qi.resetTime || null, nowMs);
      const poolKey = getModelPoolKey(cfg);
      const defaultSharedKey = getSharedQuotaGroupKey(cfg);

      // 查找匹配的 quotaSummary group
      const cfgNorm = normalizeModelLookupName(gInfo.productLabel || cfg.label || cfg.modelId);
      const matchedSummaryGroup = parsedGroups.find(pg => {
        if (pg.normalizedExplicitNames.some(en => en && (cfgNorm === en || cfgNorm.includes(en) || en.includes(cfgNorm)))) {
          return true;
        }
        return pg.sharedKey === defaultSharedKey;
      }) || null;

      const resolvedSharedKey = matchedSummaryGroup ? matchedSummaryGroup.sharedKey : defaultSharedKey;
      const pKey = `${resolvedSharedKey}::${gInfo.productKey}`;

      let prod = productMap.get(pKey);
      if (!prod) {
        prod = {
          productKey: gInfo.productKey,
          productLabel: gInfo.productLabel,
          vendor: gInfo.vendor,
          poolKey,
          sharedGroupKey: resolvedSharedKey,
          efforts: [],
          modelIds: [],
          aliases: [],
          rawConfigs: [],
          remainingFraction: null,
          isExhausted: false,
          noPermission: false,
          unavailabilityReason: null,
          noticeTitle: null,
          noticeText: null,
          hasResetTime: false,
          resetTimeIso: null,
          resetAtMs: null,
          resetTimeText: null,
          countdownText: null,
          isResetPassed: false
        };
        productMap.set(pKey, prod);
      }

      if (gInfo.effort && !prod.efforts.includes(gInfo.effort)) prod.efforts.push(gInfo.effort);
      const mId = String(cfg.modelId || cfg.model || '').trim();
      const aliasId = String(cfg.modelOrAlias?.model || '').trim();
      if (mId && !prod.modelIds.includes(mId)) prod.modelIds.push(mId);
      if (aliasId && !prod.aliases.includes(aliasId)) prod.aliases.push(aliasId);
      prod.rawConfigs.push(cfg);

      // 产品级权限状态：如果任意非推荐挡位没权限且全组都无可用挡位才算无权限；若新增可用挡位则解锁
      if (!avail.noPermission) {
        prod._hasAvailableMember = true;
      } else if (!prod.unavailabilityReason && avail.reason) {
        prod.unavailabilityReason = avail.reason;
      }
      if (avail.noticeText && !prod.noticeText) {
        prod.noticeTitle = avail.noticeTitle;
        prod.noticeText = avail.noticeText;
      }

      // 合并 config.quotaInfo
      if (parsedFrac.hasValue) {
        if (prod.remainingFraction === null || parsedFrac.fraction < prod.remainingFraction) {
          prod.remainingFraction = parsedFrac.fraction;
          prod.isExhausted = parsedFrac.isExhausted;
        }
      }
      if (resetMeta.hasResetTime) {
        if (!prod.hasResetTime || (prod.resetAtMs !== null && resetMeta.resetAtMs !== null && resetMeta.resetAtMs < prod.resetAtMs)) {
          prod.hasResetTime = true;
          prod.resetTimeIso = resetMeta.resetTimeIso;
          prod.resetAtMs = resetMeta.resetAtMs;
          prod.resetTimeText = resetMeta.resetTimeText;
          prod.countdownText = resetMeta.countdownText;
          prod.isResetPassed = resetMeta.isResetPassed;
        }
      }
    }

    for (const prod of productMap.values()) {
      prod.noPermission = !prod._hasAvailableMember;
      delete prod._hasAvailableMember;
      if (prod.noPermission) {
        // 无权限模型不将其缺失的 quota 标为耗尽
        prod.remainingFraction = null;
        prod.isExhausted = false;
      }
      prod.percentText = prod.noPermission ? '无权限' : formatQuotaPercentText(prod.remainingFraction);
    }

    // 3. 构建最终共享池卡片列表
    const poolMap = new Map();
    const ensurePool = (sKey, titleHint, summaryGroup = null) => {
      let pool = poolMap.get(sKey);
      if (!pool) {
        pool = {
          poolKey: sKey,
          title: summaryGroup?.title || fallbackGroupNames[sKey] || titleHint || sKey,
          description: summaryGroup?.description || '',
          sourceType: summaryGroup ? 'quota_summary_and_configs' : 'model_configs_only',
          buckets: summaryGroup ? summaryGroup.buckets.map(b => ({ ...b })) : [],
          models: [],
          status: 'unknown',
          statusLabel: '未知',
          primaryBucket: null,
          remainingFraction: null,
          percentText: '未知',
          isExhausted: false,
          noPermission: false,
          unavailabilityReason: null,
          hasResetTime: false,
          resetTimeIso: null,
          resetAtMs: null,
          resetTimeText: null,
          countdownText: null,
          isResetPassed: false
        };
        poolMap.set(sKey, pool);
      }
      return pool;
    };

    for (const pg of parsedGroups) {
      ensurePool(pg.sharedKey, pg.title, pg);
    }

    for (const prod of productMap.values()) {
      const sKey = prod.sharedGroupKey;
      const summaryGroup = parsedGroups.find(pg => pg.sharedKey === sKey) || null;
      const pool = ensurePool(sKey, prod.productLabel, summaryGroup);
      pool.models.push({
        productKey: prod.productKey,
        productLabel: prod.productLabel,
        vendor: prod.vendor,
        efforts: prod.efforts,
        modelIds: prod.modelIds,
        aliases: prod.aliases,
        noPermission: prod.noPermission,
        unavailabilityReason: prod.unavailabilityReason,
        noticeTitle: prod.noticeTitle,
        noticeText: prod.noticeText,
        remainingFraction: prod.remainingFraction,
        percentText: prod.percentText,
        isExhausted: prod.isExhausted
      });
    }

    // 若 summary group 有 explicitModelNames 但还没对应 config 落入，补充可读模型名占位以便展示
    for (const pg of parsedGroups) {
      const pool = poolMap.get(pg.sharedKey);
      if (pool && pool.models.length === 0 && pg.explicitModelNames.length > 0) {
        for (const name of pg.explicitModelNames) {
          pool.models.push({
            productKey: `summary:${normalizeModelLookupName(name)}`,
            productLabel: name,
            vendor: detectModelVendor(name, name),
            efforts: [],
            modelIds: [],
            aliases: [],
            noPermission: false,
            unavailabilityReason: null,
            noticeTitle: null,
            noticeText: null,
            remainingFraction: null,
            percentText: '—',
            isExhausted: false
          });
        }
      }
    }

    // 为无 buckets 的 pool 从组内可用模型 config.quotaInfo 合成主窗口；并为有 buckets 的计算主限制
    for (const pool of poolMap.values()) {
      const allNoPerm = pool.models.length > 0 && pool.models.every(m => m.noPermission);
      if (allNoPerm) {
        pool.noPermission = true;
        pool.unavailabilityReason = pool.models.find(m => m.unavailabilityReason)?.unavailabilityReason || '当前账号套餐不支持该模型';
        pool.status = 'no_permission';
        pool.statusLabel = '权限不足';
        pool.percentText = '无权限';
        continue;
      }

      if (pool.buckets.length === 0) {
        // 仅由 clientModelConfigs 合成主导窗口
        const validFracs = [];
        let earliestReset = null;
        for (const prod of productMap.values()) {
          if (prod.sharedGroupKey !== pool.poolKey || prod.noPermission) continue;
          if (prod.remainingFraction !== null) validFracs.push(prod.remainingFraction);
          if (prod.hasResetTime && (!earliestReset || (prod.resetAtMs !== null && prod.resetAtMs < earliestReset.resetAtMs))) {
            earliestReset = prod;
          }
        }
        if (validFracs.length > 0 || earliestReset) {
          const minFrac = validFracs.length > 0 ? Math.min(...validFracs) : null;
          pool.buckets.push({
            bucketId: 'config-primary',
            windowKey: pool.poolKey === 'shared_gemini_argon' ? 'weekly' : 'quota',
            windowShort: pool.poolKey === 'shared_gemini_argon' ? '7d' : '',
            windowLabel: pool.poolKey === 'shared_gemini_argon' ? '每周限额' : '当前主限额',
            remainingFraction: minFrac,
            percentText: formatQuotaPercentText(minFrac),
            isExhausted: minFrac === 0,
            fractionSource: validFracs.length > 0 ? 'client_config' : 'missing',
            hasResetTime: Boolean(earliestReset?.hasResetTime),
            resetTimeIso: earliestReset?.resetTimeIso || null,
            resetAtMs: earliestReset?.resetAtMs || null,
            resetTimeText: earliestReset?.resetTimeText || null,
            countdownText: earliestReset?.countdownText || null,
            isResetPassed: Boolean(earliestReset?.isResetPassed)
          });
        }
      }

      // 从 buckets 中统一选出主窗口（更紧缩优先 + 5h/7d 确定性平局规则）
      const { primaryBucket: pb, selectionReason } = selectPrimaryQuotaBucket(pool.buckets);
      pool.selectionReason = selectionReason;
      if (pb && pb.remainingFraction !== null && pb.remainingFraction !== undefined) {
        pool.primaryBucket = pb;
        pool.remainingFraction = pb.remainingFraction;
        pool.percentText = pb.percentText;
        pool.isExhausted = pb.isExhausted;
        pool.hasResetTime = pb.hasResetTime;
        pool.resetTimeIso = pb.resetTimeIso;
        pool.resetAtMs = pb.resetAtMs;
        pool.resetTimeText = pb.resetTimeText;
        pool.countdownText = pb.countdownText;
        pool.isResetPassed = pb.isResetPassed;
        if (pb.isExhausted || pb.remainingFraction === 0) {
          pool.status = 'exhausted';
          pool.statusLabel = '额度耗尽';
        } else if (pb.remainingFraction <= 0.2) {
          pool.status = 'low';
          pool.statusLabel = '余量较低';
        } else {
          pool.status = 'available';
          pool.statusLabel = '正常可用';
        }
      } else if (pb) {
        pool.primaryBucket = pb;
        pool.hasResetTime = pb.hasResetTime;
        pool.resetTimeIso = pb.resetTimeIso;
        pool.resetAtMs = pb.resetAtMs;
        pool.resetTimeText = pb.resetTimeText;
        pool.countdownText = pb.countdownText;
        pool.isResetPassed = pb.isResetPassed;
        pool.status = 'unknown';
        pool.statusLabel = '未知';
        pool.percentText = '未知';
      }

      // 优化池标题：若池内模型名比 group description 更清晰则补充
      if (!summaryTitleLooksDescriptive(pool.title) && pool.models.length > 0) {
        pool.title = pool.models.map(m => m.productLabel).slice(0, 3).join(' / ');
      }
    }

    function summaryTitleLooksDescriptive(titleStr) {
      return typeof titleStr === 'string' && titleStr.trim().length > 0 && !titleStr.startsWith('group_') && !titleStr.startsWith('shared_');
    }

    const pools = Array.from(poolMap.values());

    // 4. 匹配当前会话模型与浏览查看池（浏览不修改 currentModel）
    const findMatchedForTarget = (targetInput) => {
      if (!targetInput) return { pool: null, model: null };
      const targetStr = typeof targetInput === 'object'
        ? String(targetInput.modelId || targetInput.modelOrAlias?.model || targetInput.label || targetInput.model || '')
        : String(targetInput);
      const tLower = targetStr.trim().toLowerCase();
      const tStripped = tLower.replace(/^model_/, '');
      const tNorm = normalizeModelLookupName(targetStr);

      for (const pool of pools) {
        for (const m of pool.models) {
          const allIds = [...m.modelIds, ...m.aliases].map(x => x.toLowerCase());
          if (allIds.some(id => id === tLower || id.replace(/^model_/, '') === tStripped)) {
            return { pool, model: m };
          }
          if (tNorm && normalizeModelLookupName(m.productLabel) === tNorm) {
            return { pool, model: m };
          }
        }
      }
      const fallbackGroup = getSharedQuotaGroupKey(targetInput);
      const byGroup = pools.find(p => p.poolKey === fallbackGroup);
      if (byGroup) {
        return { pool: byGroup, model: byGroup.models[0] || null };
      }
      return { pool: null, model: null };
    };

    const currentMatch = findMatchedForTarget(input.currentModel);
    const browsePool = input.browsePoolKey
      ? (pools.find(p => p.poolKey === input.browsePoolKey) || currentMatch.pool || pools[0] || null)
      : (currentMatch.pool || pools[0] || null);

    // 5. 数据新鲜度与刷新状态机
    const hasAnyPoolData = pools.length > 0 && pools.some(p => p.remainingFraction !== null || p.noPermission);
    const anyResetPassed = pools.some(p => p.isResetPassed && p.remainingFraction === 0);
    const ageMs = fetchedAtMs !== null ? Math.max(0, nowMs - fetchedAtMs) : null;
    const isAgeExpired = ageMs !== null && ageMs > staleThresholdMs;

    let syncState = 'unknown';
    if (!hasAnyPoolData && lastError) {
      syncState = 'error';
    } else if (hasAnyPoolData && (lastError || isAgeExpired || anyResetPassed)) {
      syncState = 'stale';
    } else if (hasAnyPoolData) {
      syncState = 'fresh';
    } else {
      syncState = 'unknown';
    }

    // 6. 顶栏与概览裁决（严禁仅凭网络错误显示耗尽；不只是颜色表达）
    let activeStatus = 'unknown';
    let activeStatusLabel = '未知';
    let badgeText = '未知';
    let badgeTag = '';
    let activeFraction = null;
    let activeResetMeta = formatQuotaResetMeta(null, nowMs);

    if (syncState === 'error') {
      activeStatus = 'error';
      activeStatusLabel = '刷新失败';
      badgeText = '失败';
      badgeTag = '重试';
    } else if (currentMatch.model?.noPermission || currentMatch.pool?.noPermission) {
      activeStatus = 'no_permission';
      activeStatusLabel = '权限不足';
      badgeText = '无权限';
      badgeTag = '';
    } else if (currentMatch.pool) {
      const p = currentMatch.pool;
      activeFraction = p.remainingFraction;
      activeResetMeta = {
        hasResetTime: p.hasResetTime,
        resetTimeIso: p.resetTimeIso,
        resetAtMs: p.resetAtMs,
        resetTimeText: p.resetTimeText,
        countdownText: p.countdownText,
        isResetPassed: p.isResetPassed
      };
      if (p.remainingFraction === null) {
        activeStatus = syncState === 'stale' ? 'stale' : 'unknown';
        activeStatusLabel = syncState === 'stale' ? '数据过期' : '未知';
        badgeText = syncState === 'stale' ? '过期' : '未知';
      } else if (p.isExhausted || p.remainingFraction === 0) {
        activeStatus = syncState === 'stale' ? 'stale' : 'exhausted';
        activeStatusLabel = syncState === 'stale' ? '数据过期（上次已耗尽）' : '额度耗尽';
        badgeText = '已耗尽';
        badgeTag = p.primaryBucket?.windowShort || '';
      } else {
        activeStatus = syncState === 'stale' ? 'stale' : (p.remainingFraction <= 0.2 ? 'low' : 'available');
        activeStatusLabel = syncState === 'stale' ? '数据过期' : (p.remainingFraction <= 0.2 ? '余量较低' : '正常可用');
        badgeText = p.percentText;
        badgeTag = syncState === 'stale' ? '过期' : (p.primaryBucket?.windowShort || '');
      }
    } else if (syncState === 'stale') {
      activeStatus = 'stale';
      activeStatusLabel = '数据过期';
      badgeText = '过期';
    } else if (hasAnyPoolData && !input.currentModel) {
      // 未确定当前模型但已获取池数据：取所有可用池中最紧缩的一个或明确标注未识别当前模型
      activeStatus = 'unknown';
      activeStatusLabel = '未匹配当前模型';
      badgeText = '未知';
    }

    return {
      schemaVersion: 1,
      syncState,
      fetchedAtMs,
      nextRefreshAtMs,
      staleThresholdMs,
      lastError,
      errorKind,
      currentModel: currentMatch.model
        ? {
            productKey: currentMatch.model.productKey,
            productLabel: currentMatch.model.productLabel,
            poolKey: currentMatch.pool.poolKey,
            poolTitle: currentMatch.pool.title,
            noPermission: currentMatch.model.noPermission,
            unavailabilityReason: currentMatch.model.unavailabilityReason,
            noticeText: currentMatch.model.noticeText
          }
        : (input.currentModel ? { productLabel: String(input.currentModel?.label || input.currentModel), poolKey: null, poolTitle: null } : null),
      activeStatus,
      activeStatusLabel,
      badge: {
        text: badgeText,
        tag: badgeTag,
        fraction: activeFraction,
        status: activeStatus,
        statusLabel: activeStatusLabel
      },
      activeReset: activeResetMeta,
      browsePoolKey: browsePool?.poolKey || null,
      planTierName: planStatus?.tierName || planStatus?.planName || null,
      planTierKey: planStatus?.tierKey || null,
      planTierId: planStatus?.tierId || null,
      planTeamsTier: planStatus?.teamsTier || null,
      pools,
      basisNote: '仅依据宿主接口返回的剩余比例与重置时间展示，不凭空换算剩余 Token 数量。'
    };
  }

  /**
   * 严格校验外部链接是否属于官方白名单（官方仓库或作者署名主页）
   */
  function formatApproxTokensShort(n) {
    const num = Number(n);
    if (!Number.isFinite(num) || num < 0) return null;
    if (num >= 1000000000) return `${(num / 1000000000).toFixed(2)}B`;
    if (num >= 1000000) return `${(num / 1000000).toFixed(num >= 10000000 ? 1 : 2)}M`;
    if (num >= 1000) return `${(num / 1000).toFixed(num >= 100000 ? 0 : 1)}K`;
    return String(Math.round(num));
  }

  function inferQuotaWindowDurationMs(windowKey, bucketId = '') {
    const k = String(windowKey || bucketId || '').toLowerCase();
    if (!k) return null;
    if (k === '5h' || k.includes('5hour') || k.includes('5_hour')) return 5 * 3600000;
    if (k === 'weekly' || k === '7d' || k.includes('week')) return 7 * 86400000;
    if (k === 'daily' || k === '24h' || k.includes('day')) return 24 * 3600000;
    return null;
  }

  const QUOTA_CAL_TTL_MS = {
    '5h': 7 * 86400000,
    weekly: 21 * 86400000,
    daily: 14 * 86400000,
    default: 14 * 86400000
  };

  function computeBucketTokenEstimate(pool, bucket, options = {}) {
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const prev = options.calibrationEntry && typeof options.calibrationEntry === 'object'
      ? { ...options.calibrationEntry }
      : null;
    const events = Array.isArray(options.usageEvents) ? options.usageEvents : [];
    const rawCoverageStart = options.historyCoverageStartMs;
    const historyCoverageStartMs = (rawCoverageStart !== null && rawCoverageStart !== undefined && Number.isFinite(Number(rawCoverageStart)) && Number(rawCoverageStart) > 0)
      ? Number(rawCoverageStart)
      : null;
    const frac = (bucket && typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction))
      ? Math.max(0, Math.min(1, bucket.remainingFraction))
      : null;

    if (pool?.noPermission) {
      return {
        estRemainingTokens: null,
        estRemainingShort: null,
        estTotalTokens: null,
        estTotalShort: null,
        estSource: 'unavailable',
        estBasis: 'no_permission',
        isReliable: false,
        isStaleCalibration: false,
        invalidationReason: 'no_permission',
        hasFullCycleCoverage: false,
        mixedPoolModels: false,
        poolModelsUsed: [],
        tokenAccountingBasis: 'raw_input_cache_output',
        cycleInputTokens: 0,
        cycleCacheTokens: 0,
        cycleOutputTokens: 0,
        sampleCount: Number(prev?.sampleCount) || 0,
        cycleTokensUsed: 0,
        externalDivergence: false,
        nextCalibrationEntry: prev
      };
    }

    const poolModelKeys = new Set();
    if (Array.isArray(pool?.models)) {
      for (const m of pool.models) {
        for (const rawId of [...(m.modelIds || []), ...(m.aliases || []), m.productLabel]) {
          const pk = getModelPoolKey(rawId);
          if (pk && pk !== 'unknown') poolModelKeys.add(pk);
        }
      }
    }
    const poolSharedKey = pool?.poolKey || null;
    const windowMs = inferQuotaWindowDurationMs(bucket?.windowKey, bucket?.bucketId);
    const maxCalAgeMs = QUOTA_CAL_TTL_MS[bucket?.windowKey] || QUOTA_CAL_TTL_MS.default;
    const resetAtMs = (bucket?.hasResetTime && Number.isFinite(Number(bucket.resetAtMs))) ? Number(bucket.resetAtMs) : null;
    const prevResetMs = prev?.lastResetAtMs != null && Number.isFinite(Number(prev.lastResetAtMs))
      ? Number(prev.lastResetAtMs)
      : (prev?.lastResetTimeIso ? new Date(prev.lastResetTimeIso).getTime() : NaN);

    const resetShiftedForward = resetAtMs !== null && Number.isFinite(prevResetMs) && (resetAtMs - prevResetMs) > 600000;
    const jumpedUp = Boolean(prev && typeof prev.lastFraction === 'number' && frac !== null && (frac - prev.lastFraction) >= 0.04);
    const isNewCycle = Boolean(resetShiftedForward || jumpedUp);
    let resetObservedAt = Number(prev?.lastResetObservedAt) || 0;
    if (isNewCycle) {
      resetObservedAt = nowMs;
    }

    // 仅在存在重置时间且处于当前合理窗口内时推算理论周期起点；注意它本身不能证明本地覆盖全周期
    let cycleStartMs = null;
    if (resetAtMs !== null && windowMs !== null && !bucket?.isResetPassed && (resetAtMs - nowMs) <= windowMs + 300000) {
      cycleStartMs = resetAtMs - windowMs;
    }

    // 周期起点覆盖证明：要么本周期在本机监控期间发生过重置/满额基线观察，要么采集器明确给出了不晚于周期起点的历史记录时间
    const prevObservedFullSameCycle = Boolean(
      !isNewCycle &&
      prev?.observedCycleFromStart === true &&
      (resetAtMs === null || prev?.fullStartCycleResetMs === resetAtMs)
    );
    const currentObservedFull = Boolean(
      cycleStartMs !== null &&
      frac !== null &&
      ((isNewCycle && resetAtMs !== null) || (!prev && frac >= 0.98) || (prevObservedFullSameCycle))
    );
    const observedCycleFromStart = prevObservedFullSameCycle || currentObservedFull;
    const fullStartCycleResetMs = observedCycleFromStart ? (resetAtMs ?? prev?.fullStartCycleResetMs ?? null) : null;
    const withinHistoryRetention = cycleStartMs !== null && (nowMs - cycleStartMs) <= (8 * 86400000 + 300000);
    const hasCollectorCoverage = Boolean(
      cycleStartMs !== null &&
      withinHistoryRetention &&
      historyCoverageStartMs !== null &&
      historyCoverageStartMs <= cycleStartMs + 300000
    );
    const hasFullCycleCoverage = Boolean(cycleStartMs !== null && (observedCycleFromStart || hasCollectorCoverage));

    const effectiveStartMs = cycleStartMs !== null
      ? Math.max(cycleStartMs, resetObservedAt ? resetObservedAt - 60000 : 0)
      : (resetObservedAt ? resetObservedAt - 60000 : (windowMs !== null ? nowMs - windowMs : null));

    let cycleTokensUsed = 0;
    let cycleInputTokens = 0;
    let cycleCacheTokens = 0;
    let cycleOutputTokens = 0;
    const poolModelsSet = new Set();
    if (effectiveStartMs !== null) {
      for (const ev of events) {
        if (!ev || typeof ev !== 'object') continue;
        const evShared = ev.sharedGroupKey || (ev.poolKey ? getSharedQuotaGroupKey(ev.poolKey) : null);
        const matchesPool = (poolSharedKey && evShared === poolSharedKey) || (ev.poolKey && poolModelKeys.has(ev.poolKey));
        if (!matchesPool) continue;
        const ts = Number(ev.ts ?? ev.timestamp);
        const inp = Math.max(0, Number(ev.inputTokens || 0));
        const cache = Math.max(0, Number(ev.cacheTokens ?? ev.cacheReadTokens ?? 0));
        const outp = Math.max(0, Number(ev.outputTokens || 0));
        const tok = Number(ev.totalTokens ?? ev.tok ?? (inp + cache + outp));
        if (!Number.isFinite(ts) || !Number.isFinite(tok) || tok <= 0) continue;
        if (ts >= effectiveStartMs && ts <= nowMs + 60000) {
          cycleTokensUsed += tok;
          cycleInputTokens += inp;
          cycleCacheTokens += cache;
          cycleOutputTokens += outp;
          if (ev.poolKey && ev.poolKey !== 'unknown') poolModelsSet.add(String(ev.poolKey));
        }
      }
    }
    const mixedPoolModels = poolModelsSet.size > 1;
    const poolModelsUsed = Array.from(poolModelsSet);

    // 校验历史校准合法性与有效期（缺失 calibratedAt 视作旧版未知时效缓存并过期失效）
    const rawPriorTotal = (prev && Number.isFinite(Number(prev.calibratedTotalTokens)) && Number(prev.calibratedTotalTokens) >= 15000 && Number(prev.calibratedTotalTokens) <= 1e11)
      ? Number(prev.calibratedTotalTokens)
      : null;
    const rawCalAt = (prev && Number.isFinite(Number(prev.calibratedAt)) && Number(prev.calibratedAt) > 0)
      ? Number(prev.calibratedAt)
      : (prev && Number.isFinite(Number(prev.updatedAt)) && rawPriorTotal !== null && prev.schemaVersion >= 2 ? Number(prev.updatedAt) : null);
    const isCalibrationExpired = rawPriorTotal !== null && (rawCalAt === null || (nowMs - rawCalAt) > maxCalAgeMs);

    let calibratedTotal = (!isCalibrationExpired && rawPriorTotal !== null) ? rawPriorTotal : null;
    let calibratedAt = calibratedTotal !== null ? rawCalAt : null;
    let calibratedResetAtMs = calibratedTotal !== null ? (prev?.calibratedResetAtMs ?? null) : null;
    let sampleCount = calibratedTotal !== null ? (Number(prev?.sampleCount) || 0) : 0;
    let calSource = calibratedTotal !== null ? (prev?.source || null) : null;

    // 独立的先验历史基线：仅当先验校准是在另一个周期或通过增量/完整历史建立且未过期、未被污染时，才可用于异常降级参考
    const priorIndependentTotal = (calibratedTotal !== null && !prev?.externalDivergenceInCycle && calSource !== 'cycle')
      ? calibratedTotal
      : null;

    let externalDivergence = false;
    let divergenceInCycle = isNewCycle ? false : Boolean(prev?.externalDivergenceInCycle);
    let invalidationReason = isNewCycle ? null : (prev?.cycleInvalidationReason || null);
    let calibratedThisStep = false;

    if (frac === null) {
      return {
        estRemainingTokens: null,
        estRemainingShort: null,
        estTotalTokens: calibratedTotal ? Math.round(calibratedTotal) : null,
        estTotalShort: calibratedTotal ? formatApproxTokensShort(calibratedTotal) : null,
        estSource: 'unknown',
        estBasis: 'fraction_missing',
        isReliable: false,
        isStaleCalibration: Boolean(calibratedTotal),
        invalidationReason: 'fraction_missing',
        hasFullCycleCoverage,
        mixedPoolModels,
        poolModelsUsed,
        tokenAccountingBasis: 'raw_input_cache_output',
        cycleInputTokens: Math.round(cycleInputTokens),
        cycleCacheTokens: Math.round(cycleCacheTokens),
        cycleOutputTokens: Math.round(cycleOutputTokens),
        sampleCount,
        cycleTokensUsed: Math.round(cycleTokensUsed),
        externalDivergence: divergenceInCycle,
        nextCalibrationEntry: prev
      };
    }

    let anchorFraction = (prev && typeof prev.anchorFraction === 'number' && !isNewCycle)
      ? prev.anchorFraction
      : frac;
    let anchorCycleTokens = (prev && typeof prev.anchorCycleTokens === 'number' && !isNewCycle)
      ? prev.anchorCycleTokens
      : cycleTokensUsed;

    // 同一周期内若余量微幅上浮（小于重置阈值），刷新高水位锚点
    if (frac > anchorFraction && (frac - anchorFraction) < 0.04 && !resetShiftedForward) {
      anchorFraction = frac;
      anchorCycleTokens = cycleTokensUsed;
    }

    const deltaF = anchorFraction - frac;
    const deltaTok = cycleTokensUsed - anchorCycleTokens;

    if (!divergenceInCycle) {
      // 方法 A（优先）：同周期相邻有效采样差值校准。要求余量降幅 >= 2% 且本机增耗 >= 2,000 Tokens
      if (deltaF >= 0.02 && deltaTok >= 2000) {
        const sampleTotal = deltaTok / deltaF;
        const outOfBounds = !Number.isFinite(sampleTotal) || sampleTotal < 15000 || sampleTotal > 1e11;
        const tooLowVsPrior = calibratedTotal !== null && sampleTotal < calibratedTotal * 0.25;
        const tooHighVsPrior = calibratedTotal !== null && sampleTotal > calibratedTotal * 4.5;
        if (!outOfBounds && !tooLowVsPrior && !tooHighVsPrior) {
          if (calibratedTotal !== null && sampleCount >= 1) {
            const clamped = Math.max(calibratedTotal * 0.35, Math.min(calibratedTotal * 3, sampleTotal));
            calibratedTotal = sampleCount >= 2 ? (calibratedTotal * 0.6 + clamped * 0.4) : (calibratedTotal * 0.4 + clamped * 0.6);
          } else {
            calibratedTotal = sampleTotal;
          }
          sampleCount += 1;
          calSource = 'delta';
          calibratedAt = nowMs;
          calibratedResetAtMs = resetAtMs;
          calibratedThisStep = true;
          invalidationReason = null;
          anchorFraction = frac;
          anchorCycleTokens = cycleTokensUsed;
        } else {
          externalDivergence = true;
          divergenceInCycle = true;
          invalidationReason = tooHighVsPrior ? 'calibration_ratio_drift' : (tooLowVsPrior ? 'external_divergence' : 'delta_out_of_bounds');
        }
      } else if ((deltaF >= 0.03 && deltaTok < 500) || (deltaF >= 0.15 && deltaTok < 2000)) {
        // 同周期可观测窗口内额度明显下降 (>=3% 且几乎零本地消耗，或 >=15% 且增量不足 2,000) -> 外部/他端消耗或漏采
        externalDivergence = true;
        divergenceInCycle = true;
        invalidationReason = 'external_divergence';
      }

      // 方法 B（次选）：必须同时具备周期起点覆盖证明 + 本机足量消耗 (>=3,000) + 无异常偏移，绝不单凭 resetAt - windowMs 强行反推
      const usedFrac = 1 - frac;
      if (usedFrac >= 0.03 && !externalDivergence && !divergenceInCycle) {
        if (hasFullCycleCoverage) {
          if (cycleTokensUsed >= 3000) {
            const cycleTotal = cycleTokensUsed / usedFrac;
            const outOfBounds = !Number.isFinite(cycleTotal) || cycleTotal < 15000 || cycleTotal > 1e11 || (usedFrac >= 0.1 && cycleTotal < 15000);
            const deviatesVsPrior = calibratedTotal !== null && (cycleTotal < calibratedTotal * 0.25 || cycleTotal > calibratedTotal * 4.5);
            if (!outOfBounds && !deviatesVsPrior) {
              if (calibratedTotal === null || calSource !== 'delta') {
                calibratedTotal = cycleTotal;
                calSource = 'cycle';
                calibratedAt = nowMs;
                calibratedResetAtMs = resetAtMs;
                calibratedThisStep = true;
                sampleCount = Math.max(sampleCount, 1);
              }
              invalidationReason = null;
            } else {
              externalDivergence = true;
              divergenceInCycle = true;
              invalidationReason = deviatesVsPrior ? 'external_divergence' : 'cycle_out_of_bounds';
            }
          } else if ((usedFrac >= 0.05 && cycleTokensUsed < 500) || (usedFrac >= 0.15 && cycleTokensUsed < 2000)) {
            externalDivergence = true;
            divergenceInCycle = true;
            invalidationReason = 'external_divergence';
          }
        } else if (usedFrac >= 0.15 && cycleTokensUsed < 500) {
          // 首次或缺失周期起点覆盖时若周期已消耗 >= 15% 但本地几乎零消耗：本轮标识为缺样本/他端消耗拦截，
          // 但仅在已存在前置对比且确认同区段发生外耗时才锁死后续增量法 A（防止首次半周期接入后永久阻塞增量校准）
          externalDivergence = true;
          invalidationReason = 'external_divergence';
        }
      }
    } else {
      externalDivergence = true;
    }

    // 状态判定严格互斥：耗尽 -> 外部消耗/异常降级 -> 校准过期 -> 正常本周期/历史参考 -> 等待或覆盖不足
    const isCurrentCycleCalibrated = Boolean(
      calibratedTotal !== null &&
      !divergenceInCycle &&
      (calibratedThisStep || (calibratedResetAtMs !== null && resetAtMs !== null && calibratedResetAtMs === resetAtMs))
    );
    const hasAnyInvalidation = Boolean(externalDivergence || divergenceInCycle);

    let estRemainingTokens = null;
    let estTotalTokensOut = calibratedTotal !== null ? Math.round(calibratedTotal) : null;
    let estSource = 'uncalibrated';
    let estBasis = 'waiting_samples';
    let isReliable = false;
    let isStaleCalibration = false;
    let finalReason = invalidationReason;

    if (frac === 0) {
      estRemainingTokens = 0;
      estSource = 'exhausted';
      estBasis = 'exhausted';
      isReliable = true;
      finalReason = null;
    } else if (hasAnyInvalidation) {
      // 检测到外部消耗或异常失真：绝不按正常有效校准展示；无独立有效历史基线时强制置空，存在时降级标为不可靠参考
      if (priorIndependentTotal !== null && !isCalibrationExpired) {
        estRemainingTokens = Math.max(0, Math.round(priorIndependentTotal * frac));
        estTotalTokensOut = Math.round(priorIndependentTotal);
        estSource = 'unreliable_cached';
        estBasis = 'stale_with_divergence';
        isReliable = false;
        isStaleCalibration = true;
        finalReason = finalReason || 'external_divergence';
      } else {
        estRemainingTokens = null;
        estTotalTokensOut = null;
        estSource = 'incomplete';
        estBasis = 'incomplete_samples';
        isReliable = false;
        isStaleCalibration = false;
        finalReason = finalReason || 'external_divergence';
      }
    } else if (isCalibrationExpired && calibratedTotal === null) {
      estRemainingTokens = null;
      estTotalTokensOut = null;
      estSource = 'expired';
      estBasis = 'calibration_expired';
      isReliable = false;
      isStaleCalibration = true;
      finalReason = 'calibration_expired';
    } else if (calibratedTotal !== null) {
      estRemainingTokens = Math.max(0, Math.round(calibratedTotal * frac));
      if (isCurrentCycleCalibrated && calSource === 'delta') {
        estSource = 'delta';
        estBasis = 'delta_calibrated';
        isReliable = true;
        finalReason = null;
        invalidationReason = null;
      } else if (isCurrentCycleCalibrated && calSource === 'cycle' && hasFullCycleCoverage) {
        estSource = 'cycle';
        estBasis = 'cycle_estimated';
        isReliable = true;
        finalReason = null;
        invalidationReason = null;
      } else {
        // 跨周期沿用未过期的历史校准且当期暂无新样本：保留数值但标记为非实时可靠的历史参考
        estSource = 'cached';
        estBasis = 'cached_calibration';
        isReliable = false;
        isStaleCalibration = true;
        finalReason = 'cross_cycle_unverified';
      }
    } else {
      estRemainingTokens = null;
      estSource = 'uncalibrated';
      estBasis = (!hasFullCycleCoverage && (1 - frac) >= 0.03) ? 'coverage_incomplete' : 'waiting_samples';
      isReliable = false;
    }

    const nextCalibrationEntry = {
      schemaVersion: 2,
      calibratedTotalTokens: calibratedTotal !== null ? Math.round(calibratedTotal) : null,
      calibratedAt: calibratedAt ?? null,
      calibratedResetAtMs: calibratedResetAtMs ?? null,
      sampleCount,
      source: calSource,
      lastFraction: frac,
      lastResetAtMs: resetAtMs,
      lastResetTimeIso: bucket?.resetTimeIso || null,
      lastResetObservedAt: resetObservedAt || null,
      observedCycleFromStart,
      fullStartCycleResetMs,
      externalDivergenceInCycle: divergenceInCycle,
      cycleInvalidationReason: invalidationReason,
      anchorFraction,
      anchorCycleTokens: Math.round(anchorCycleTokens),
      updatedAt: nowMs
    };

    return {
      estRemainingTokens,
      estRemainingShort: estRemainingTokens !== null ? formatApproxTokensShort(estRemainingTokens) : null,
      estTotalTokens: estTotalTokensOut,
      estTotalShort: estTotalTokensOut !== null ? formatApproxTokensShort(estTotalTokensOut) : null,
      estSource,
      estBasis,
      isReliable,
      isStaleCalibration,
      invalidationReason: finalReason || null,
      hasFullCycleCoverage,
      mixedPoolModels,
      poolModelsUsed,
      tokenAccountingBasis: 'raw_input_cache_output',
      cycleInputTokens: Math.round(cycleInputTokens),
      cycleCacheTokens: Math.round(cycleCacheTokens),
      cycleOutputTokens: Math.round(cycleOutputTokens),
      sampleCount,
      cycleTokensUsed: Math.round(cycleTokensUsed),
      externalDivergence: hasAnyInvalidation,
      nextCalibrationEntry
    };
  }

  function applyQuotaTokenEstimates(snapshot, options = {}) {
    if (!snapshot || !Array.isArray(snapshot.pools)) {
      return { snapshot, nextCalibrationMap: { ...(options.calibrationMap || {}) } };
    }
    const scopeKey = options.accountScopeKey || snapshot.accountScopeKey || 'anonymous';
    const prevMap = (options.calibrationMap && typeof options.calibrationMap === 'object') ? options.calibrationMap : {};
    const nextCalibrationMap = { ...prevMap };
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : (snapshot.fetchedAtMs || Date.now());
    const usageEvents = Array.isArray(options.usageEvents) ? options.usageEvents : [];
    const historyCoverageStartMs = options.historyCoverageStartMs ?? null;

    const nextPools = snapshot.pools.map(pool => {
      if (!pool || !Array.isArray(pool.buckets)) return pool;
      const nextBuckets = pool.buckets.map(bucket => {
        const entryKey = `${scopeKey}::${pool.poolKey}::${bucket.windowKey || bucket.bucketId || 'primary'}`;
        const est = computeBucketTokenEstimate(pool, bucket, {
          nowMs,
          usageEvents,
          historyCoverageStartMs,
          calibrationEntry: prevMap[entryKey] || null
        });
        if (est.nextCalibrationEntry) {
          nextCalibrationMap[entryKey] = est.nextCalibrationEntry;
        }
        return {
          ...bucket,
          tokenEstimate: {
            estRemainingTokens: est.estRemainingTokens,
            estRemainingShort: est.estRemainingShort,
            estTotalTokens: est.estTotalTokens,
            estTotalShort: est.estTotalShort,
            estSource: est.estSource,
            estBasis: est.estBasis,
            isReliable: est.isReliable,
            isStaleCalibration: est.isStaleCalibration,
            invalidationReason: est.invalidationReason,
            hasFullCycleCoverage: est.hasFullCycleCoverage,
            mixedPoolModels: est.mixedPoolModels,
            poolModelsUsed: est.poolModelsUsed,
            tokenAccountingBasis: est.tokenAccountingBasis,
            cycleInputTokens: est.cycleInputTokens,
            cycleCacheTokens: est.cycleCacheTokens,
            cycleOutputTokens: est.cycleOutputTokens,
            sampleCount: est.sampleCount,
            cycleTokensUsed: est.cycleTokensUsed,
            externalDivergence: est.externalDivergence
          }
        };
      });
      const nextPrimaryBucket = pool.primaryBucket
        ? (nextBuckets.find(b => b.bucketId === pool.primaryBucket.bucketId) || nextBuckets[0] || pool.primaryBucket)
        : (nextBuckets[0] || null);
      return {
        ...pool,
        buckets: nextBuckets,
        primaryBucket: nextPrimaryBucket,
        tokenEstimate: nextPrimaryBucket?.tokenEstimate || null
      };
    });

    return {
      snapshot: {
        ...snapshot,
        pools: nextPools
      },
      nextCalibrationMap
    };
  }

  function isValidExternalUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    try {
      const u = new URL(rawUrl);
      if (u.protocol !== 'https:') return false;
      if (u.hostname === 'github.com') {
        const pathname = u.pathname.replace(/\/+$/, '');
        const repoPrefix = '/elviscjn-cjn/antigravity-context-viewer';
        return pathname === repoPrefix || pathname.startsWith(repoPrefix + '/');
      }
      if (u.hostname === 'linux.do') {
        const pathname = u.pathname.replace(/\/+$/, '');
        return (
          pathname === '/t/topic/3117832' ||
          pathname === '/t/3117832' ||
          pathname.startsWith('/t/topic/3117832/') ||
          pathname === '/u/23375/summary' ||
          pathname === '/u/23375'
        );
      }
      return false;
    } catch {
      return false;
    }
  }

  const UNATTRIBUTED_MODEL_KEY = '__unattributed__';
  const MODEL_PRODUCT_DISPLAY_NAMES = {
    'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
    'gemini-4-argon': 'Gemini 4 Argon',
    'gemini-4-carbon': 'Gemini 4 Carbon',
    'orchestrator': 'Orchestrator',
    'gemini-3.8-flash': 'Gemini 3.8 Flash',
    'gemini-3.1-pro-preview': 'Gemini 3.1 Pro',
    'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
    'gemini-2.5-pro': 'Gemini 2.5 Pro',
    'claude-opus-5-5': 'Claude Opus 5.5',
    'claude-sonnet-5-5': 'Claude Sonnet 5.5',
    'gpt-oss-120b': 'GPT-OSS 120B'
  };
  const MODEL_FIXED_COLORS_DARK = {
    'gemini-4-hydrogen': '#a78bfa',
    'gemini-4-argon': '#6366f1',
    'gemini-3.8-flash': '#38bdf8',
    'gemini-4-carbon': '#e879f9',
    'orchestrator': '#f472b6',
    'claude-opus-5-5': '#f59e0b',
    'claude-sonnet-5-5': '#fbbf24',
    'gpt-oss-120b': '#10b981',
    'gemini-3.1-pro-preview': '#818cf8',
    'gemini-3.5-flash-lite': '#2dd4bf',
    'gemini-2.5-pro': '#8b5cf6',
    [UNATTRIBUTED_MODEL_KEY]: 'rgba(161, 161, 170, 0.28)'
  };
  const MODEL_FIXED_COLORS_LIGHT = {
    'gemini-4-hydrogen': '#7c3aed',
    'gemini-4-argon': '#4f46e5',
    'gemini-3.8-flash': '#0284c7',
    'gemini-4-carbon': '#c026d3',
    'orchestrator': '#db2777',
    'claude-opus-5-5': '#d97706',
    'claude-sonnet-5-5': '#b45309',
    'gpt-oss-120b': '#059669',
    'gemini-3.1-pro-preview': '#4338ca',
    'gemini-3.5-flash-lite': '#0d9488',
    'gemini-2.5-pro': '#6d28d9',
    [UNATTRIBUTED_MODEL_KEY]: 'rgba(113, 113, 122, 0.24)'
  };
  const MODEL_FALLBACK_PALETTE_DARK = ['#a78bfa', '#38bdf8', '#6366f1', '#2dd4bf', '#f59e0b', '#e879f9', '#10b981', '#f472b6'];
  const MODEL_FALLBACK_PALETTE_LIGHT = ['#7c3aed', '#0284c7', '#4f46e5', '#0d9488', '#d97706', '#c026d3', '#059669', '#db2777'];
  const MODEL_USAGE_ID_FALLBACK_LABELS = {
    'gemini-flash-worker-agy': 'Gemini 4 Hydrogen (Orchestrator)',
    'model_placeholder_m669': 'Gemini 4 Hydrogen (Orchestrator)',
    'placeholder-m669': 'Gemini 4 Hydrogen (Orchestrator)',
    'm669': 'Gemini 4 Hydrogen (Orchestrator)',
    'model_placeholder_m667': 'Orchestrator (Carbon)',
    'placeholder-m667': 'Orchestrator (Carbon)',
    'm667': 'Orchestrator (Carbon)',
    'model_placeholder_m681': 'Orchestrator (Argon)',
    'placeholder-m681': 'Orchestrator (Argon)',
    'm681': 'Orchestrator (Argon)',
    'model_placeholder_m668': 'Orchestrator (Argon)',
    'placeholder-m668': 'Orchestrator (Argon)',
    'm668': 'Orchestrator (Argon)',
    'model_placeholder_m670': 'Gemini 4 Carbon',
    'placeholder-m670': 'Gemini 4 Carbon',
    'm670': 'Gemini 4 Carbon',
    'gemini-4-hydrogen-sonar': 'Gemini 4 Hydrogen',
    'model_placeholder_m578': 'Gemini 4 Hydrogen',
    'm578': 'Gemini 4 Hydrogen',
    'gemini-4-hydrogen-tiered-high': 'Gemini 4 Hydrogen (High)',
    'model_placeholder_m530': 'Gemini 4 Hydrogen (High)',
    'm530': 'Gemini 4 Hydrogen (High)',
    'gemini-4-hydrogen-tiered-xhigh': 'Gemini 4 Hydrogen (XHigh)',
    'model_placeholder_m531': 'Gemini 4 Hydrogen (XHigh)',
    'm531': 'Gemini 4 Hydrogen (XHigh)',
    'model_placeholder_m525': 'Gemini 4 Hydrogen (High)',
    'm525': 'Gemini 4 Hydrogen (High)',
    'model_placeholder_m526': 'Gemini 4 Hydrogen (Medium)',
    'm526': 'Gemini 4 Hydrogen (Medium)',
    'model_placeholder_m527': 'Gemini 4 Hydrogen (Low)',
    'm527': 'Gemini 4 Hydrogen (Low)',
    'model_placeholder_m528': 'Gemini 4 Hydrogen (XHigh)',
    'm528': 'Gemini 4 Hydrogen (XHigh)',
    'model_placeholder_m417': 'Gemini 4 Argon (High)',
    'm417': 'Gemini 4 Argon (High)',
    'model_placeholder_m418': 'Gemini 4 Argon (Medium)',
    'm418': 'Gemini 4 Argon (Medium)',
    'model_placeholder_m419': 'Gemini 4 Argon (Low)',
    'm419': 'Gemini 4 Argon (Low)',
    'model_placeholder_m427': 'Gemini 4 Carbon (High)',
    'm427': 'Gemini 4 Carbon (High)',
    'model_placeholder_m437': 'Gemini 4 Carbon (Medium)',
    'm437': 'Gemini 4 Carbon (Medium)',
    'model_placeholder_m438': 'Gemini 4 Carbon (Low)',
    'm438': 'Gemini 4 Carbon (Low)',
    'gemini-3.8-flash-tiered': 'Gemini 3.8 Flash',
    'model_placeholder_m322': 'Gemini 3.8 Flash',
    'm322': 'Gemini 3.8 Flash',
    'model_placeholder_m318': 'Gemini 3.8 Flash (High)',
    'm318': 'Gemini 3.8 Flash (High)',
    'model_placeholder_m319': 'Gemini 3.8 Flash (Medium)',
    'm319': 'Gemini 3.8 Flash (Medium)',
    'model_placeholder_m320': 'Gemini 3.8 Flash (Low)',
    'm320': 'Gemini 3.8 Flash (Low)',
    'model_placeholder_m400': 'Claude Opus 5.5 (Low)',
    'm400': 'Claude Opus 5.5 (Low)',
    'model_placeholder_m401': 'Claude Opus 5.5 (Medium)',
    'm401': 'Claude Opus 5.5 (Medium)',
    'model_placeholder_m402': 'Claude Opus 5.5 (High)',
    'm402': 'Claude Opus 5.5 (High)',
    'model_placeholder_m403': 'Claude Sonnet 5.5 (Low)',
    'm403': 'Claude Sonnet 5.5 (Low)',
    'model_placeholder_m404': 'Claude Sonnet 5.5 (Medium)',
    'm404': 'Claude Sonnet 5.5 (Medium)',
    'model_placeholder_m405': 'Claude Sonnet 5.5 (High)',
    'm405': 'Claude Sonnet 5.5 (High)',
    'model_placeholder_m198': 'Gemini 3.5 Flash-Lite',
    'm198': 'Gemini 3.5 Flash-Lite',
    'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
    'model_placeholder_m50': 'Gemini 3.1 Flash-Lite',
    'm50': 'Gemini 3.1 Flash-Lite',
    'gemini-3-flash': 'Gemini 3 Flash',
    'model_placeholder_m18': 'Gemini 3 Flash',
    'm18': 'Gemini 3 Flash'
  };
