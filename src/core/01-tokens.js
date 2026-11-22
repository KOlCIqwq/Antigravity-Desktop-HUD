(function (root) {
  'use strict';
  const number = value => value !== undefined && value !== null && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  function parseDurationSec(value) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    const match = String(value).trim().match(/^([\d.]+)\s*s?$/i);
    if (!match) return null;
    const num = parseFloat(match[1]);
    return Number.isFinite(num) && num >= 0 ? num : null;
  }

  function getModelPoolKey(raw) {
    if (!raw) return 'unknown';
    const text = typeof raw === 'object'
      ? [raw.modelId, raw.model, raw.label, raw.modelDisplayName, raw.modelOrAlias?.model, raw.poolKey].filter(Boolean).join(' ')
      : String(raw);
    const s = String(text || '').toLowerCase().trim();
    if (!s) return 'unknown';
    if (s.includes('carbon') || s.includes('gemini-4-carbon') || s.includes('m670')) {
      return 'gemini-4-carbon';
    }
    // 优先匹配 Argon / Orchestrator (Argon)，允许裸 gemini-pro-orchestrator 与已知变体但不吞并未知后缀
    if (s.includes('argon') || s.includes('gemini-4-argon') || s.includes('m668') || /\bgemini-pro-orchestrator(?:-(?:argon|g1(?:-pro)?))?(?![a-z0-9-])/.test(s)) {
      return 'gemini-4-argon';
    }
    if (s.includes('hydrogen') || s.includes('gemini-4-hydrogen')) {
      return 'gemini-4-hydrogen';
    }
    if (s.includes('flash') || s.includes('gemini-3.8-flash') || s.includes('gemini-3-flash') || s.includes('gemini-2.5-flash')) {
      return 'gemini-3.8-flash';
    }
    if (s.includes('pro') && (s.includes('gemini-3') || s.includes('gemini-4') || s.includes('high') || s.includes('low'))) {
      return 'gemini-4-hydrogen';
    }
    if (s.includes('opus') || s.includes('claude-opus')) return 'claude-opus-5-5';
    if (s.includes('sonnet') || s.includes('claude-sonnet')) return 'claude-sonnet-5-5';
    if (s.includes('claude')) return 'claude-sonnet-5-5';
    if (s.includes('gpt-oss') || s.includes('gpt')) return 'gpt-oss-120b';
    return s.replace(/[^a-z0-9_-]/g, '') || 'unknown';
  }

  function getSharedQuotaGroupKey(raw) {
    const pk = getModelPoolKey(raw);
    if (pk === 'gemini-4-hydrogen' || pk === 'gemini-3.8-flash') return 'shared_gemini_main';
    if (pk === 'claude-opus-5-5' || pk === 'claude-sonnet-5-5' || pk === 'gpt-oss-120b') return 'shared_3p_pool';
    if (pk === 'gemini-4-argon') return 'shared_gemini_argon';
    if (pk === 'gemini-4-carbon') return 'shared_gemini_carbon';
    return pk && pk !== 'unknown' ? `shared_${pk}` : 'unknown';
  }

  function formatLocalDateStr(dt) {
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  }

  function formatResetTimeZh(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      if (isNaN(d.getTime())) return String(isoStr);
      const m = d.getMonth() + 1;
      const day = d.getDate();
      const h = String(d.getHours()).padStart(2, '0');
      const min = String(d.getMinutes()).padStart(2, '0');
      return `${m}月${day}日 ${h}:${min}`;
    } catch {
      return String(isoStr);
    }
  }

  const STRICT_ISO_RESET_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

  function parseStrictResetTimestamp(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim();
    const m = s.match(STRICT_ISO_RESET_RE);
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    const hour = Number(m[4]);
    const minute = Number(m[5]);
    const second = Number(m[6]);
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
      return null;
    }
    const utcCheck = new Date(Date.UTC(year, month - 1, day));
    if (
      utcCheck.getUTCFullYear() !== year ||
      utcCheck.getUTCMonth() !== month - 1 ||
      utcCheck.getUTCDate() !== day
    ) {
      return null;
    }
    const frac = m[7] ? `.${m[7].slice(0, 3)}` : '';
    const normalized = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${frac}${m[8]}`;
    const ms = Date.parse(normalized);
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return ms;
  }

  function parseQuotaFraction(rawQuota, options = {}) {
    if (!rawQuota || typeof rawQuota !== 'object') {
      return { fraction: null, hasValue: false, isExhausted: false, source: 'missing' };
    }
    const candidates = [
      rawQuota.remainingFraction,
      rawQuota.remaining_fraction,
      rawQuota.fraction
    ];
    for (const c of candidates) {
      if (typeof c === 'number' && Number.isFinite(c)) {
        const clamped = Math.max(0, Math.min(1, c));
        return {
          fraction: clamped,
          hasValue: true,
          isExhausted: clamped === 0,
          source: 'fraction'
        };
      }
    }
    const amtCandidates = [rawQuota.remainingAmount, rawQuota.remaining_amount, rawQuota.remaining];
    for (const rawAmt of amtCandidates) {
      if (rawAmt === undefined || rawAmt === null || rawAmt === '') continue;
      // Protobuf int64 在 protojson 中常序列化为十进制数字字符串
      const amt = typeof rawAmt === 'number'
        ? rawAmt
        : (typeof rawAmt === 'string' && /^-?\d+(\.\d+)?$/.test(rawAmt.trim()) ? Number(rawAmt.trim()) : NaN);
      if (Number.isFinite(amt)) {
        if (amt <= 0) {
          return { fraction: 0, hasValue: true, isExhausted: true, source: 'amount_zero' };
        }
        const rawTotal = rawQuota.limit ?? rawQuota.totalAmount ?? rawQuota.total ?? null;
        const total = rawTotal === null || rawTotal === undefined || rawTotal === '' ? NaN : Number(rawTotal);
        if (Number.isFinite(total) && total > 0) {
          const clamped = Math.max(0, Math.min(1, amt / total));
          return { fraction: clamped, hasValue: true, isExhausted: clamped === 0, source: 'amount_ratio' };
        }
        // 正余量但缺少可靠的额度总量依据时，返回未知比例而非强行换算或落入零额度耗尽
        return { fraction: null, hasValue: false, isExhausted: false, source: 'amount_without_total' };
      }
    }
    // 仅在有明确协议依据的消息（exa.codeium_common_pb.QuotaInfo，普通 proto3 float + json omitempty）中，
    // 若非不可用/已禁用且存在有效 resetTime、同时无其它冲突字段时，才将省略的 remainingFraction 按 0 耗尽处理；
    // 对于 QuotaSummaryBucket（oneof remaining）或未指明契约的任意缺字段响应，证据不足一律视为未知。
    const canInferProto3ScalarZero = options.schemaKind === 'codeium_quota_info' || options.allowProto3ZeroDefault === true;
    const isExplicitlyDisabled = Boolean(options.unavailable || rawQuota.disabled === true);
    const hasResetStr = parseStrictResetTimestamp(rawQuota.resetTime || rawQuota.reset_time) !== null;
    if (canInferProto3ScalarZero && !isExplicitlyDisabled && hasResetStr) {
      return { fraction: 0, hasValue: true, isExhausted: true, source: 'proto3_zero_with_reset' };
    }
    return { fraction: null, hasValue: false, isExhausted: false, source: 'missing' };
  }

  function formatQuotaPercentText(fraction) {
    if (fraction === null || fraction === undefined || !Number.isFinite(Number(fraction))) return '未知';
    const f = Math.max(0, Math.min(1, Number(fraction)));
    if (f === 0) return '0%';
    const pct = f * 100;
    if (pct < 0.1) return '<0.1%';
    if (pct < 1) return `${pct.toFixed(1)}%`;
    return `${Math.round(pct)}%`;
  }

  function formatQuotaResetMeta(resetTimeIso, nowMs = Date.now()) {
    if (!resetTimeIso || typeof resetTimeIso !== 'string') {
      return {
        hasResetTime: false,
        resetTimeIso: null,
        resetAtMs: null,
        resetTimeText: null,
        countdownText: null,
        countdownMs: null,
        isResetPassed: false
      };
    }
    const parsedMs = parseStrictResetTimestamp(resetTimeIso);
    if (parsedMs === null) {
      return {
        hasResetTime: false,
        resetTimeIso: null,
        resetAtMs: null,
        resetTimeText: null,
        countdownText: null,
        countdownMs: null,
        isResetPassed: false
      };
    }
    const d = new Date(parsedMs);
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const resetTimeText = `${mm}-${dd} ${hh}:${mi}`;
    const diffMs = parsedMs - nowMs;
    if (diffMs <= 0) {
      return {
        hasResetTime: true,
        resetTimeIso,
        resetAtMs: parsedMs,
        resetTimeText,
        countdownText: '已到重置时间（待确认）',
        countdownMs: 0,
        isResetPassed: true
      };
    }
    const totalSec = Math.ceil(diffMs / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    let countdownText;
    if (days > 0) countdownText = `${days}天${hours}小时`;
    else if (hours > 0) countdownText = `${hours}小时${mins}分`;
    else if (mins > 0) countdownText = `${mins}分`;
    else countdownText = `${Math.max(1, secs)}秒`;
    return {
      hasResetTime: true,
      resetTimeIso,
      resetAtMs: parsedMs,
      resetTimeText,
      countdownText,
      countdownMs: diffMs,
      isResetPassed: false
    };
  }

  const DECORATIVE_BADGE_TAG_RE = /^(new|beta|preview|alpha|experimental|recommended|updated|hot|popular|最新|预览|預覽|推荐|推薦)$/i;

  /**
   * 判断模型角标文本是否仅为装饰性标签，不能作为不可用或故障原因
   */
  function isDecorativeBadgeTagTitle(tagTitle) {
    return typeof tagTitle === 'string' && DECORATIVE_BADGE_TAG_RE.test(tagTitle.trim());
  }

  /**
   * 将账号套餐字段规范化为精确允许匹配的套餐标识集合，禁止宽泛子串误放行受限账号
   */
  function buildAllowedTierMatchSet(planStatus) {
    if (!planStatus || typeof planStatus !== 'object') return null;
    const rawTierKey = typeof planStatus.tierKey === 'string' ? planStatus.tierKey.trim().toLowerCase() : '';
    const rawTierId = typeof planStatus.tierId === 'string' ? planStatus.tierId.trim().toLowerCase() : '';
    const rawTeamsTier = typeof planStatus.teamsTier === 'string' ? planStatus.teamsTier.trim().toLowerCase() : '';

    // 套餐尚未识别且无任何具体层级标识时，不执行 allowedTiers 猜测拦截
    if (planStatus.status === 'unidentified' || ((!rawTierKey || rawTierKey === 'unknown') && !rawTierId && !rawTeamsTier)) {
      return null;
    }

    const tokens = new Set();
    if (rawTierId) tokens.add(rawTierId);
    if (rawTeamsTier) tokens.add(rawTeamsTier);
    if (rawTierKey && rawTierKey !== 'unknown' && rawTierKey !== 'custom') tokens.add(rawTierKey);

    const isUltraTier = rawTierKey === 'ultra' ||
      rawTierId === 'g1-ultra-tier' ||
      rawTeamsTier === 'teams_tier_pro_ultimate' ||
      rawTeamsTier === 'teams_tier_ultra';
    const isProTier = !isUltraTier && (
      rawTierKey === 'pro' ||
      rawTierId === 'g1-pro-tier' ||
      rawTeamsTier === 'teams_tier_pro'
    );
    const isPlusTier = rawTierKey === 'plus' ||
      rawTierId === 'g1-plus-tier' ||
      rawTeamsTier === 'teams_tier_plus';
    const isFreeTier = rawTierKey === 'free' ||
      rawTierId === 'free-tier' ||
      rawTeamsTier === 'teams_tier_free';

    if (isUltraTier) {
      // Ultra 账号向上覆盖 Ultimate，并兼容上游可能回传或缺失 TEAMS_TIER_PRO 的情况；不放行未声明的企业专享档位
      tokens.add('ultra');
      tokens.add('g1-ultra-tier');
      tokens.add('teams_tier_pro_ultimate');
      tokens.add('teams_tier_ultra');
      tokens.add('ultimate');
      tokens.add('teams_tier_pro');
      tokens.add('g1-pro-tier');
      tokens.add('pro');
    } else if (isProTier) {
      tokens.add('pro');
      tokens.add('g1-pro-tier');
      tokens.add('teams_tier_pro');
    } else if (isPlusTier) {
      tokens.add('plus');
      tokens.add('g1-plus-tier');
      tokens.add('teams_tier_plus');
    } else if (isFreeTier) {
      tokens.add('free');
      tokens.add('free-tier');
      tokens.add('teams_tier_free');
    }

    return tokens.size > 0 ? tokens : null;
  }

  function classifyModelQuotaAvailability(config, planStatus = null) {
    if (!config || typeof config !== 'object') {
      return { noPermission: false, unavailable: false, reason: null, noticeTitle: null, noticeText: null };
    }
    const tagTitle = typeof config.tagTitle === 'string' ? config.tagTitle.trim() : '';
    const tagDesc = typeof config.tagDescription === 'string' ? config.tagDescription.trim() : '';
    const isTagUnavailable = /^(unavailable|disabled|不可用|无权限|無權限)$/i.test(tagTitle) || /unavailable|disabled|不可用|无权限|無權限/i.test(tagTitle);
    const isDecorativeBadgeTag = isDecorativeBadgeTagTitle(tagTitle);
    const isExplicitNoticeTag = /^notice$/i.test(tagTitle);
    const isTagNotice = !isTagUnavailable && (Boolean(tagDesc) || isExplicitNoticeTag || (Boolean(tagTitle) && !isDecorativeBadgeTag));

    let tierBlocked = false;
    let tierReason = null;
    if (Array.isArray(config.allowedTiers) && config.allowedTiers.length > 0) {
      const allowedTokens = buildAllowedTierMatchSet(planStatus);
      if (allowedTokens) {
        const hit = config.allowedTiers.some(v => allowedTokens.has(String(v || '').trim().toLowerCase()));
        if (!hit) {
          tierBlocked = true;
          tierReason = `仅限 ${config.allowedTiers.join(' / ')} 套餐可用`;
        }
      }
    }

    const explicitlyDisabled = Boolean(
      config.disabled === true ||
      config.enabled === false ||
      config.unavailable === true ||
      config.isUnavailable === true ||
      config.status === 'unavailable' ||
      isTagUnavailable ||
      tierBlocked
    );

    const hasConfigNotice = typeof config.notice === 'string' && config.notice.trim() && !explicitlyDisabled;
    const noticeText = isTagNotice
      ? (tagDesc || (!isDecorativeBadgeTag ? tagTitle : null))
      : (hasConfigNotice ? config.notice.trim() : null);

    // 清洗服务端或上游缓存中可能被装饰角标污染的 reason，确保真实故障原因不被 New 等角标覆盖
    const rawConfigReason = typeof config.unavailabilityReason === 'string' ? config.unavailabilityReason.trim() : '';
    const cleanConfigReason = (rawConfigReason && !isDecorativeBadgeTagTitle(rawConfigReason)) ? rawConfigReason : '';
    const nonDecorativeTagTitle = (!isDecorativeBadgeTag && tagTitle) ? tagTitle : null;

    const unavailabilityReason = tierBlocked
      ? (cleanConfigReason || tierReason || tagDesc || nonDecorativeTagTitle || '当前套餐无权访问该模型')
      : (cleanConfigReason || tagDesc || nonDecorativeTagTitle || tierReason || '当前套餐无权访问该模型');

    return {
      noPermission: explicitlyDisabled,
      unavailable: explicitlyDisabled,
      reason: explicitlyDisabled ? unavailabilityReason : null,
      noticeTitle: (noticeText && (isTagNotice || hasConfigNotice)) ? (tagTitle || 'Notice') : null,
      noticeText: noticeText || null
    };
  }

  function resolveModelQuota(modelIdOrName, cascadeModelConfigs, options = {}) {
    if (!Array.isArray(cascadeModelConfigs) || !cascadeModelConfigs.length || !modelIdOrName) {
      return null;
    }
    const rawStr = typeof modelIdOrName === 'object'
      ? String(modelIdOrName.modelId || modelIdOrName.modelOrAlias?.model || modelIdOrName.label || modelIdOrName.model || '')
      : String(modelIdOrName);
    const poolKey = getModelPoolKey(rawStr);
    const targetLower = rawStr.trim().toLowerCase();
    const targetStripped = targetLower.replace(/^model_/, '');

    // 1. 优先精准匹配 modelId / modelOrAlias.model / model / label（兼容 MODEL_ 前缀）
    let matched = cascadeModelConfigs.find(c => {
      if (!c || typeof c !== 'object') return false;
      const cands = [c.modelId, c.modelOrAlias?.model, c.model, c.label]
        .filter(v => typeof v === 'string' && v.trim())
        .map(v => v.trim().toLowerCase());
      return cands.some(v => v === targetLower || v.replace(/^model_/, '') === targetStripped);
    });

    // 2. 匹配同一产品组 / 配额池
    if (!matched && poolKey !== 'unknown') {
      matched = cascadeModelConfigs.find(c => {
        const cPool = getModelPoolKey(c);
        return cPool === poolKey;
      });
    }

    if (!matched) return null;

    const avail = classifyModelQuotaAvailability(matched, options?.planStatus || null);
    const qi = matched.quotaInfo || {};
    const parsed = parseQuotaFraction(qi, { unavailable: avail.noPermission, schemaKind: 'codeium_quota_info' });
    const poolNames = {
      'gemini-4-argon': 'Gemini 4 Argon 配额池（周限额）',
      'gemini-4-hydrogen': 'Gemini 4 Hydrogen / 3.8 Flash 共享池',
      'gemini-3.8-flash': 'Gemini 3.8 Flash / Hydrogen 共享池',
      'gemini-4-carbon': 'Gemini 4 Carbon 配额池',
      'claude-opus-5-5': 'Claude / GPT-OSS 第三方共享池',
      'claude-sonnet-5-5': 'Claude / GPT-OSS 第三方共享池',
      'gpt-oss-120b': 'Claude / GPT-OSS 第三方共享池'
    };

    return {
      modelId: matched.modelId || matched.modelOrAlias?.model || '',
      label: matched.label || rawStr,
      poolKey,
      sharedGroupKey: getSharedQuotaGroupKey(matched),
      poolName: poolNames[poolKey] || (matched.label ? `${matched.label} 配额池` : '专属模型配额池'),
      remainingFraction: parsed.fraction,
      resetTime: qi.resetTime || null,
      isExhausted: parsed.isExhausted,
      noPermission: avail.noPermission,
      unavailabilityReason: avail.reason,
      noticeText: avail.noticeText
    };
  }

  function classifyRequestError(input, options = {}) {
    const error = typeof input === 'string' ? input : String(input?.error || input?.message || '');
    const currentModel = options.currentModel || '';
    const cascadeConfigs = options.cascadeModelConfigs || [];
    const modelQuota = resolveModelQuota(currentModel, cascadeConfigs);

    if (!error) {
      return {
        kind: 'none',
        title: '正常',
        badgeText: '正常',
        detail: '',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: modelQuota?.poolName || currentModel || null,
        diagnostic: ''
      };
    }

    // 脱敏清洗诊断摘要（去除非必要的完整 URL 和堆栈冗余）
    let diagnostic = error.replace(/https?:\/\/[^\s"']+/g, '<API>').trim();
    if (diagnostic.length > 120) diagnostic = diagnostic.slice(0, 117) + '...';

    // 1. 上下文容量超限 (Context Overflow)
    // 明确排除 Go context.DeadlineExceeded 网络超时
    const isDeadlineTimeout = /context deadline exceeded|deadline exceeded|stream idle timeout/i.test(error);
    const overflowMatch = !isDeadlineTimeout && error.match(/input token count exceeds|context\s*(?:window|length|tokens?|limit|size|capacity)?.{0,35}(?:exceed|too long)|maximum context length|prompt exceeds maximum context length|max_tokens exceeded/i);
    if (overflowMatch) {
      const serviceLimit = number(error.match(/(?:allowed|limit(?:\s+of)?|length(?:\s+is|\s+of)?)\s*[:=]?\s*([\d,]+)/i)?.[1]?.replaceAll(',', ''));
      return {
        kind: 'context_overflow',
        title: '超限告警',
        badgeText: '超限',
        detail: `输入超出模型容量上限${serviceLimit ? `（${serviceLimit} tokens）` : ''}，请精简上下文或新建会话`,
        serviceLimit,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 2. 模型或额度池耗尽 (Quota Exhausted)
    const explicitQuotaMatch = /(?:quota\s*(?:exceeded|reached|limit|exhausted)|out\s+of\s+quota|exhausted.*(?:capacity|quota)|resource_exhausted.*(?:quota|capacity|billing)|free\s+tier\s+quota|daily\s+quota|weekly\s+quota)/i.test(error);
    const quotaZeroEvidence = Boolean(modelQuota && typeof modelQuota.remainingFraction === 'number' && modelQuota.remainingFraction <= 0.0001);

    if (explicitQuotaMatch || quotaZeroEvidence) {
      const resetTimeZh = modelQuota?.resetTime ? formatResetTimeZh(modelQuota.resetTime) : null;
      const poolName = modelQuota?.poolName || (currentModel ? `${currentModel} 专属配额` : '模型配额');
      return {
        kind: 'quota_exhausted',
        title: '额度耗尽',
        badgeText: '额度耗尽',
        detail: `${poolName}额度已用尽${resetTimeZh ? `，预计 ${resetTimeZh} 重置` : ''}。可手动切换其他可用模型`,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: modelQuota?.resetTime || null,
        resetTimeZh,
        modelOrPool: poolName,
        diagnostic
      };
    }

    // 3. 请求频率限制 (Rate Limited)
    const rateLimitMatch = /(?:rate\s*limit|too\s*many\s*requests|\b429\b|RateLimitError|RESOURCE_EXHAUSTED.*rate)/i.test(error);
    if (rateLimitMatch) {
      const retryMatch = error.match(/(?:retry\s+in|retry-after|wait)\s*[:=]?\s*([\d.]+)\s*(?:s|sec|seconds)?/i);
      const retryAfterSec = retryMatch ? parseFloat(retryMatch[1]) : null;
      return {
        kind: 'rate_limited',
        title: '请求限流',
        badgeText: '限流',
        detail: `请求过于频繁，触发服务端频率限制（429）${retryAfterSec ? `，建议等待 ${retryAfterSec} 秒后重试` : '，请稍候重试'}`,
        serviceLimit: null,
        retryAfterSec,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 4. 用户主动取消或请求中断 (Canceled)
    const canceledMatch = /(?:context canceled by user|user cancelled|request was aborted|AbortError)/i.test(error);
    if (canceledMatch) {
      return {
        kind: 'canceled',
        title: '已取消',
        badgeText: '已取消',
        detail: '本次生成请求已由用户或系统主动取消',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 5. 身份认证与权限错误 (Auth / Permission)
    const authMatch = /(?:UNAUTHENTICATED|PERMISSION_DENIED|\b401\b|\b403\b|invalid api key|credentials expired|permission denied)/i.test(error);
    if (authMatch) {
      return {
        kind: 'auth_error',
        title: '认证异常',
        badgeText: '认证',
        detail: '身份认证失败或缺少访问权限，请检查账号登录状态或订阅权限',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 6. 服务暂不可用 (Service Unavailable)
    const unavailMatch = /(?:UNAVAILABLE|\b503\b|\b502\b|\b504\b|server overloaded|high demand|Bad Gateway|Service Unavailable)/i.test(error);
    if (unavailMatch) {
      return {
        kind: 'service_unavailable',
        title: '服务受限',
        badgeText: '服务异常',
        detail: '模型服务暂时过载或不可用，请稍后重试',
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 7. 明确网络连接失败或超时 (Network Error)
    const netMatch = /(?:\bEOF\b|idle timeout|deadline exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|Failed to fetch|NetworkError)/i.test(error);
    if (netMatch) {
      let cleanNet = '连接失败或超时';
      if (/deadline exceeded|timeout/i.test(error)) cleanNet = '连接或读取超时';
      else if (/ECONNRESET|socket hang up/i.test(error)) cleanNet = '连接被对端重置';
      else if (/ECONNREFUSED/i.test(error)) cleanNet = '连接被拒绝';
      else if (/ENOTFOUND/i.test(error)) cleanNet = 'DNS 域名解析失败';
      else if (/\bEOF\b/i.test(error)) cleanNet = '服务端过早关闭连接 (EOF)';

      return {
        kind: 'network_error',
        title: '网络故障',
        badgeText: '网络',
        detail: `网络连接异常（${cleanNet}），请检查网络代理及本地连接`,
        serviceLimit: null,
        retryAfterSec: null,
        resetTime: null,
        modelOrPool: currentModel || null,
        diagnostic
      };
    }

    // 8. 兜底：原因待确认 (Unknown)
    return {
      kind: 'unknown',
      title: '原因待确认',
      badgeText: '待确认',
      detail: `请求失败，当前无法确认具体原因（${diagnostic}）`,
      serviceLimit: null,
      retryAfterSec: null,
      resetTime: null,
      modelOrPool: currentModel || null,
      diagnostic
    };
  }

  function summarize(metadata, options = {}) {
    const m = metadata?.chatModel;
    if (!m) return null;
    const lastRetry = (m.retryInfos || []).at(-1);
    const error = String(lastRetry?.error || m.error || '');
    const model = m.modelDisplayName || m.responseModel || m.model || options.currentModel || '';
    const modelRaw = String(m.model || m.modelOrAlias?.model || m.responseModel || m.modelDisplayName || options.currentModel || '').trim();
    const modelId = resolveStableModelId(m, options.cascadeModelConfigs || []) || resolveStableModelId(options.currentModel, options.cascadeModelConfigs || []) || null;

    // 执行结构化错误分类
    const classification = error ? classifyRequestError(error, {
      currentModel: model,
      cascadeModelConfigs: options.cascadeModelConfigs || [],
      userStatus: options.userStatus || null
    }) : { kind: 'none' };

    const exceeded = classification.kind === 'context_overflow';
    const network = classification.kind === 'network_error';
    const serviceLimit = classification.serviceLimit || null;

    const usage = lastRetry ? lastRetry.usage : m.usage;
    const input = number(usage?.inputTokens), cached = number(usage?.cacheReadTokens), output = number(usage?.outputTokens);
    const thinking = number(usage?.thinkingOutputTokens), responseTokens = number(usage?.responseOutputTokens);
    const hasInput = (input || 0) + (cached || 0) > 0;

    // 解耦维度：错误发生时不强制归零已有上下文用量
    const prevContext = options.previousValidContext || null;
    let actual = hasInput && !error ? (input || 0) + (cached || 0) + (output || 0) : null;
    if (actual === null && prevContext && prevContext.actual != null && !exceeded) {
      actual = prevContext.actual;
    }

    const context = m.chatStartMetadata?.contextWindowMetadata;
    const estimate = number(context?.estimatedTokensUsed) || prevContext?.estimate || null;
    const budget = number(context?.maxContextTokens) || prevContext?.budget || null;

    // 计算生成耗时与输出速度 (Tokens Per Second)
    const ttft = parseDurationSec(m.timeToFirstToken);
    const streamingSec = parseDurationSec(m.streamingDuration);
    const duration = (ttft !== null && streamingSec !== null) ? (ttft + streamingSec) : (ttft ?? streamingSec ?? null);
    let tps = null;
    if (output && duration && duration > 0) {
      tps = Number((output / duration).toFixed(1));
    }
    let streamingTps = null;
    if (output && streamingSec && streamingSec >= 0.05) {
      streamingTps = Number((output / streamingSec).toFixed(1));
    }
    const speedInputTokens = hasInput ? ((input || 0) + (cached || 0)) : null;
    const speedExp = (!error && output != null && ttft != null && duration != null && streamingTps != null)
      ? calculateExperienceScore({
          outputTokens: output,
          totalInputTokens: speedInputTokens,
          ttftSec: ttft,
          streamingSec,
          totalDurationSec: duration,
          streamSpeed: streamingTps
        })
      : { available: false, score: null, grade: null, ruleVersion: ELV91_SCORE_RULE_VERSION };
    const speed = (tps !== null || duration !== null || output !== null || ttft !== null) ? {
      tps,
      streamingTps,
      streamSpeed: streamingTps,
      duration: duration !== null ? Number(duration.toFixed(2)) : null,
      ttft: ttft !== null ? Number(ttft.toFixed(2)) : null,
      streamingSec: streamingSec !== null ? Number(streamingSec.toFixed(2)) : null,
      ttftRatio: (ttft !== null && duration !== null && duration > 0) ? Number(Math.min(100, Math.max(0, (ttft / duration) * 100)).toFixed(1)) : null,
      outputTokens: output ?? 0,
      thinkingTokens: thinking ?? 0,
      responseTokens: responseTokens ?? (output ?? 0),
      totalInputTokens: speedInputTokens,
      eScore: speedExp.score,
      eGrade: speedExp.grade,
      scoreRuleVersion: ELV91_SCORE_RULE_VERSION
    } : null;

    let status = 'pending';
    if (exceeded) status = 'exceeded';
    else if (network) status = 'network';
    else if (classification.kind === 'quota_exhausted') status = 'quota_exhausted';
    else if (classification.kind === 'rate_limited') status = 'rate_limited';
    else if (classification.kind === 'auth_error') status = 'auth_error';
    else if (classification.kind === 'service_unavailable') status = 'service_unavailable';
    else if (classification.kind === 'canceled') status = 'canceled';
    else if (error) status = 'failed';
    else if (actual !== null) status = 'reported';
    else if (estimate > 0) status = 'estimated';

    const usedVal = actual ?? (estimate > 0 ? estimate : null);
    const percentVal = actual !== null && budget > 0 && !exceeded ? (actual / budget * 100) : null;

    return {
      used: usedVal,
      actual,
      estimate: estimate > 0 ? estimate : null,
      budget: budget > 0 ? budget : null,
      serviceLimit,
      exceeded,
      network,
      error,
      errorClassification: classification,
      estimated: actual === null,
      input: hasInput ? (input || 0) + (cached || 0) : (prevContext?.input || null),
      cached: cached || prevContext?.cached || 0,
      output: output ?? (prevContext?.output ?? null),
      percent: percentVal,
      model,
      modelId,
      modelRaw,
      status,
      speed
    };
  }
  function measure(text, outAcc = null) {
    text = String(text || '');
    const len = text.length;
    let chars = 0, bytes = 0, cjk = 0;
    for (let i = 0; i < len; i++) {
      const c = text.charCodeAt(i);
      if (c <= 127) {
        chars++;
        bytes++;
      } else if (c <= 2047) {
        chars++;
        bytes += 2;
      } else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < len) {
        const c2 = text.charCodeAt(i + 1);
        if (c2 >= 0xDC00 && c2 <= 0xDFFF) {
          i++;
          chars++;
          bytes += 4;
          continue;
        }
        chars++;
        bytes += 3;
      } else {
        chars++;
        bytes += 3;
        if ((c >= 0x2e80 && c <= 0x9fff) || (c >= 0xf900 && c <= 0xfaff)) cjk++;
      }
    }
    if (outAcc) {
      outAcc.chars += chars;
      outAcc.bytes += bytes;
      outAcc.cjk += cjk;
      return outAcc;
    }
    const middle = (chars - cjk) / 4 + cjk * 1.2;
    return { chars, bytes, low: Math.ceil(middle * .7), high: Math.ceil(Math.max(middle * 1.6, bytes / 2)) };
  }
  function add(a, b) { for (const k of ['chars', 'bytes', 'low', 'high']) a[k] += b[k] || 0; return a; }
  const empty = () => ({ chars: 0, bytes: 0, low: 0, high: 0 });
  function analyzeSteps(steps) {
    const groups = { user: empty(), assistant: empty(), thinking: empty(), tools: empty(), summaries: empty() };
    const media = new Map();
    let userMessages = 0, assistantMessages = 0, latestStepError = null, lastUserAt = -1, lastAssistantAt = -1;
    const skip = new Set(['metadata', 'userConfig', 'lastUserConfig', 'userAgentSpec', 'activeUserState', 'thinkingSignature', 'thumbnail', 'inlineData', 'media', 'modelUsage', 'tokenUsage', 'mendelExperimentIds']);
    // 直接按与原 content()+measure() 等价的逻辑流式累计 chars/bytes/cjk，避免分配巨型中间拼接字符串
    const toolAcc = { chars: 0, bytes: 0, cjk: 0 };
    function accumulateContent(value, acc) {
      if (typeof value === 'string') { measure(value, acc); return; }
      if (typeof value === 'number' || typeof value === 'boolean') { measure(String(value), acc); return; }
      if (!value) return;
      if (Array.isArray(value)) {
        for (let idx = 0; idx < value.length; idx++) {
          if (idx > 0) { acc.chars += 1; acc.bytes += 1; }
          accumulateContent(value[idx], acc);
        }
        return;
      }
      const keys = Object.keys(value);
      let wrote = false;
      for (let idx = 0; idx < keys.length; idx++) {
        const key = keys[idx];
        if (skip.has(key)) continue;
        if (wrote) { acc.chars += 1; acc.bytes += 1; }
        wrote = true;
        measure(key, acc);
        acc.chars += 2; // ': '
        acc.bytes += 2;
        accumulateContent(value[key], acc);
      }
    }
    function attachments(value, source, withinStep = new Set()) {
      if (!value || typeof value !== 'object') return;
      if (Array.isArray(value)) { for (const v of value) attachments(v, source, withinStep); return; }
      if (value.uri && (value.mimeType || value.inlineData !== undefined)) {
        const key = String(value.uri);
        if (!withinStep.has(key)) { withinStep.add(key); const prior = media.get(key); if (prior) prior.references++; else media.set(key, { uri: key, name: String(value.description || key.split(/[\\/]/).pop()), mime: String(value.mimeType || ''), references: 1, source }); }
      } else if (value.inlineData && !value.uri) {
        const key = `inline-${media.size}`;
        const rawData = typeof value.inlineData === 'string' ? value.inlineData : (value.inlineData.data || '');
        const mime = String(value.mimeType || value.inlineData.mimeType || '');
        if (!withinStep.has(key)) {
          withinStep.add(key);
          media.set(key, {
            uri: `inline:${key}`,
            inlineData: rawData,
            name: String(value.description || (mime.startsWith('image/') ? '内嵌图像' : '内嵌附件')),
            mime,
            references: 1,
            source
          });
        }
      }
      for (const [key, v] of Object.entries(value)) if (!skip.has(key) || key === 'media') attachments(v, source, withinStep);
    }
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      if (s.userInput) {
        userMessages++; lastUserAt = i;
        const u = s.userInput;
        add(groups.user, measure(u.userResponse || (u.items || []).map(item => item.text || '').join('\n')));
        // Canonical media and item inline previews represent the same upload.
        attachments(u.media?.length ? u.media : u.items, 'user');
      } else if (s.plannerResponse) {
        assistantMessages++; lastAssistantAt = i;
        add(groups.assistant, measure(s.plannerResponse.modifiedResponse || s.plannerResponse.response || ''));
        add(groups.thinking, measure(s.plannerResponse.thinking || ''));
        attachments(s.plannerResponse, 'assistant');
      } else if (s.errorMessage) {
        const e = s.errorMessage.error || {};
        latestStepError = { index: i, text: e.modelErrorMessage || e.shortError || e.fullError || '', id: e.errorId || '' };
      } else if (s.checkpoint) {
        add(groups.summaries, measure(s.checkpoint.sessionSummary || ''));
      } else {
        toolAcc.chars = 0; toolAcc.bytes = 0; toolAcc.cjk = 0;
        const stepKeys = Object.keys(s);
        let wroteStep = false;
        const withinToolStep = new Set();
        for (let kIdx = 0; kIdx < stepKeys.length; kIdx++) {
          const k = stepKeys[kIdx];
          if (k === 'type' || k === 'status' || k === 'metadata' || k === 'error') continue;
          if (!skip.has(k)) {
            if (wroteStep) { toolAcc.chars += 1; toolAcc.bytes += 1; }
            wroteStep = true;
            measure(k, toolAcc);
            toolAcc.chars += 2;
            toolAcc.bytes += 2;
            accumulateContent(s[k], toolAcc);
          }
          if (!skip.has(k) || k === 'media') {
            attachments(s[k], 'assistant', withinToolStep);
          }
        }
        if (toolAcc.chars > 0 || toolAcc.bytes > 0) {
          const middle = (toolAcc.chars - toolAcc.cjk) / 4 + toolAcc.cjk * 1.2;
          add(groups.tools, {
            chars: toolAcc.chars,
            bytes: toolAcc.bytes,
            low: Math.ceil(middle * .7),
            high: Math.ceil(Math.max(middle * 1.6, toolAcc.bytes / 2))
          });
        }
      }
    }
    const total = Object.values(groups).reduce(add, empty());
    const currentError = latestStepError && latestStepError.index > Math.max(lastUserAt, lastAssistantAt) ? latestStepError : null;
    return { groups, total, media: [...media.values()], steps: steps.length, userMessages, assistantMessages, currentError };
  }

  // 官方 Developer API Standard 公开费率表 (USD / 百万 Token)
  // 官方 Developer API Standard 公开费率表 (USD / 百万 Token)
  // 来源: https://ai.google.dev/gemini-api/docs/pricing , https://aistudio.google.com/docs/pricing
  //       https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/
  //       https://platform.claude.com/docs/en/about-claude/pricing
  // 核对日期: 2026-11-16 (合入 PR #9，保留并校验 Gemini 4 Argon / Carbon / Hydrogen 与 Claude 5.5 官方公开费率)
  const GEMINI_PRICING_TABLE = {
    'gemini-3.8-flash': [
      {
        effectiveTo: '2026-12-31',
        inputPerMillion: 0.75,
        outputPerMillion: 3.75,
        cacheReadPerMillion: 0.075
      },
      {
        effectiveFrom: '2027-01-01',
        inputPerMillion: 1.50,
        outputPerMillion: 7.50,
        cacheReadPerMillion: 0.15
      }
    ],
    'gemini-4-neon': [
      {
        inputPerMillion: 3.00,
        outputPerMillion: 15.00,
        cacheReadPerMillion: 0.15
      }
    ],
    'gemini-4-hydrogen': [
      {
        inputPerMillion: 1.50,
        outputPerMillion: 7.50,
        cacheReadPerMillion: 0.075
      }
    ],
    'gemini-4-carbon': [
      {
        effectiveTo: '2026-11-30',
        inputPerMillion: 2.00,
        outputPerMillion: 10.00,
        cacheReadPerMillion: 0.10
      },
      {
        effectiveFrom: '2026-12-01',
        inputPerMillion: 4.00,
        outputPerMillion: 20.00,
        cacheReadPerMillion: 0.20
      }
    ],
    'gemini-4-argon': [
      {
        effectiveTo: '2026-11-30',
        inputPerMillion: 2.00,
        outputPerMillion: 10.00,
        cacheReadPerMillion: 0.10
      },
      {
        effectiveFrom: '2026-12-01',
        inputPerMillion: 4.00,
        outputPerMillion: 20.00,
        cacheReadPerMillion: 0.20
      }
    ],
    'gemini-3.1-pro-preview': [
      {
        maxPromptTokens: 200000,
        inputPerMillion: 2.00,
        outputPerMillion: 12.00,
        cacheReadPerMillion: 0.20
      },
      {
        minPromptTokens: 200001,
        inputPerMillion: 4.00,
        outputPerMillion: 18.00,
        cacheReadPerMillion: 0.40
      }
    ],
    'gemini-3.5-flash-lite': [
      {
        inputPerMillion: 0.30,
        outputPerMillion: 2.50,
        cacheReadPerMillion: 0.03
      }
    ],
    'gemini-2.5-pro': [
      {
        maxPromptTokens: 200000,
        inputPerMillion: 1.25,
        outputPerMillion: 10.00,
        cacheReadPerMillion: 0.125
      },
      {
        minPromptTokens: 200001,
        inputPerMillion: 2.50,
        outputPerMillion: 15.00,
        cacheReadPerMillion: 0.25
      }
    ],
    'claude-opus-5-5': [
      {
        inputPerMillion: 4.00,
        outputPerMillion: 20.00,
        cacheReadPerMillion: 0.20
      }
    ],
    'claude-sonnet-5-5': [
      {
        inputPerMillion: 2.00,
        outputPerMillion: 10.00,
        cacheReadPerMillion: 0.10
      }
    ],
    'gpt-oss-120b': [
      {
        inputPerMillion: 0.09,
        outputPerMillion: 0.36,
        cacheReadPerMillion: 0
      }
    ]
  };
