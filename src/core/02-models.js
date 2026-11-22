  function extractModelString(req) {
    if (!req) return '';
    if (typeof req === 'string') return req;
    const cm = req.chatModel;
    return cm?.modelDisplayName || cm?.responseModel || cm?.model || req.modelDisplayName || req.responseModel || req.model || req.chatModel || req.modelId || '';
  }

  function normalizeModelId(raw) {
    if (!raw || typeof raw !== 'string') return null;
    const str = raw.trim().toLowerCase();
    if (str.includes('3.8-flash') || str.includes('3.8 flash') || str.includes('flash-n')) return 'gemini-3.8-flash';
    if (str.includes('4-neon') || str.includes('4 neon') || str.includes('neon')) return 'gemini-4-neon';
    if (str.includes('4-hydrogen') || str.includes('4 hydrogen') || str.includes('hydrogen')) return 'gemini-4-hydrogen';
    // 注：2.32.1 客户端已将 gemini-pro-orchestrator 明确归为 Orchestrator (Argon)，仅明确的 carbon / m670 归为 gemini-4-carbon；未知 orchestrator 后缀保持未计价
    if (str.includes('4-carbon') || str.includes('4 carbon') || str.includes('carbon') || str.includes('m670')) return 'gemini-4-carbon';
    if (str.includes('4-argon') || str.includes('4 argon') || str.includes('argon') || /\bgemini-pro-orchestrator(?:-(?:argon|g1(?:-pro)?))?$/.test(str) || str.includes('m668')) return 'gemini-4-argon';
    if (str.includes('3.1-pro') || str.includes('3.1 pro')) return 'gemini-3.1-pro-preview';
    if (str.includes('3.5-flash-lite') || str.includes('3.5 flash-lite') || str.includes('flash-lite')) return 'gemini-3.5-flash-lite';
    if (str.includes('2.5-pro') || str.includes('2.5 pro')) return 'gemini-2.5-pro';
    if (/(?:opus[-_ ]5[._-]5(?![0-9]|\.[0-9]|[-_](?!20\d{6}(?![0-9]))[0-9])|5[._-]5(?![0-9]|\.[0-9]|[-_](?!20\d{6}(?![0-9]))[0-9])[-_ ]opus)/.test(str)) return 'claude-opus-5-5';
    if (/(?:sonnet[-_ ]5[._-]5(?![0-9]|\.[0-9]|[-_](?!20\d{6}(?![0-9]))[0-9])|5[._-]5(?![0-9]|\.[0-9]|[-_](?!20\d{6}(?![0-9]))[0-9])[-_ ]sonnet)/.test(str)) return 'claude-sonnet-5-5';
    if (str.includes('gpt-oss-120b') || str.includes('gpt oss 120b')) return 'gpt-oss-120b';
    return null;
  }

  /**
   * 解析准确模型标识用于按模型保存上下文偏好（不做计费家族归一化）
   * 优先级：精确 ID 字段 -> cascadeModelConfigs 精确 ID 匹配 -> 仅在无准确 ID 时按唯一 label 反查 -> 规范化原始标识
   */
  function resolveStableModelId(input, cascadeModelConfigs = []) {
    let idCandidates = [];
    let labelCandidates = [];

    if (typeof input === 'string') {
      const s = input.trim();
      if (!s) return null;
      idCandidates = [s];
      labelCandidates = [s];
    } else if (input && typeof input === 'object') {
      const cm = input.chatModel || input;
      const displaySet = new Set(
        [cm.modelDisplayName, cm.label]
          .filter(v => typeof v === 'string' && v.trim())
          .map(v => v.trim())
      );
      const rawIds = [
        cm.modelId,
        cm.modelOrAlias?.model,
        cm.modelRaw,
        cm.chatStartMetadata?.model,
        cm.responseModel,
        cm.model
      ];
      const seenId = new Set();
      for (const val of rawIds) {
        if (typeof val !== 'string') continue;
        const t = val.trim();
        if (!t || seenId.has(t)) continue;
        // summarize 结果里的 model 可能是纯显示名（与 modelDisplayName 相同），此时不应挤占准确 ID
        if (val === cm.model && displaySet.has(t) && (cm.modelId || cm.modelRaw || cm.modelOrAlias?.model)) {
          continue;
        }
        seenId.add(t);
        idCandidates.push(t);
      }
      labelCandidates = Array.from(displaySet);
    }

    if (!idCandidates.length && !labelCandidates.length) return null;

    const pickConfigCanonicalId = (cfg) => {
      const alias = String(cfg?.modelOrAlias?.model || '').trim();
      const mId = String(cfg?.modelId || '').trim();
      if (alias && mId) {
        // 若同一 alias 被多个不同 modelId（如 low/high 档位）共用，则以具体 modelId 区分档位；否则优先 alias
        const sameAliasCount = cascadeModelConfigs.filter(
          x => String(x?.modelOrAlias?.model || '').trim().toLowerCase() === alias.toLowerCase()
        ).length;
        return (sameAliasCount > 1 ? mId : alias).toLowerCase();
      }
      const chosen = alias || mId || String(cfg?.label || '').trim();
      return chosen ? chosen.toLowerCase() : null;
    };

    const stripModelPrefix = (v) => String(v || '').trim().toLowerCase().replace(/^model_/, '');

    if (Array.isArray(cascadeModelConfigs) && cascadeModelConfigs.length) {
      // 1. 优先按准确 ID 精确匹配（兼容 Protobuf MODEL_ 前缀，绝不受 label 文本影响）
      for (const cand of idCandidates) {
        const candLower = cand.toLowerCase();
        const candStripped = stripModelPrefix(cand);
        const matched = cascadeModelConfigs.find((c) => {
          const mId = String(c?.modelId || '').trim().toLowerCase();
          const aliasId = String(c?.modelOrAlias?.model || '').trim().toLowerCase();
          return (
            (mId && (mId === candLower || stripModelPrefix(mId) === candStripped)) ||
            (aliasId && (aliasId === candLower || stripModelPrefix(aliasId) === candStripped))
          );
        });
        if (matched) {
          return pickConfigCanonicalId(matched);
        }
      }

      // 2. 仅当没有任何可独立识别的准确 ID 时，才允许按唯一 label 反查
      const hasDistinctId = idCandidates.some(id => !labelCandidates.includes(id));
      if (!hasDistinctId) {
        for (const lblCand of labelCandidates) {
          const lblLower = lblCand.toLowerCase();
          const labelMatches = cascadeModelConfigs.filter(
            c => String(c?.label || '').trim().toLowerCase() === lblLower
          );
          if (labelMatches.length === 1) {
            return pickConfigCanonicalId(labelMatches[0]);
          }
        }
      }
    }

    const chosen = (idCandidates[0] || labelCandidates[0] || '').trim().toLowerCase();
    return chosen || null;
  }

  // 力度档位白名单（按长度降序排列，防止 Extra High / XHigh 被部分匹配为 High/Extra）
  const EFFORT_WHITELIST = ['Extra High', 'XHigh', 'Low', 'Medium', 'High', 'Extra', 'Minimal', 'Max'];
  // 预编译档位解析正则，避免 groupModelProduct 高频调用时重复编译 RegExp
  const EFFORT_REGEX_PARTS = EFFORT_WHITELIST.map(e => e.replace(/\s+/g, '\\s+')).join('|');
  const EFFORT_PAREN_RE = new RegExp(`^(.+?)\\s*[\\(（](${EFFORT_REGEX_PARTS})[\\)）]\\s*$`, 'i');
  const EFFORT_SUFFIX_RE = new RegExp(`^(.+?)\\s+(${EFFORT_REGEX_PARTS})\\s*$`, 'i');
  const EFFORT_LABEL_ZH = {
    Low: '低（Low）',
    Medium: '中（Medium）',
    High: '高（High）',
    XHigh: '超高（XHigh）',
    Extra: '超高（Extra）',
    'Extra High': '超高（Extra High）'
  };
  const EFFORT_LABEL_TW = {
    Low: '低（Low）',
    Medium: '中（Medium）',
    High: '高（High）',
    XHigh: '超高（XHigh）',
    Extra: '超高（Extra）',
    'Extra High': '超高（Extra High）'
  };

  function normalizeEffortValue(raw) {
    if (typeof raw !== 'string') return null;
    const s = raw.trim().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').toLowerCase();
    if (!s) return null;
    if (s === 'x high' || s === 'xhigh') return 'XHigh';
    for (const item of EFFORT_WHITELIST) {
      if (item.toLowerCase() === s) return item;
    }
    return null;
  }

  /**
   * 拆分模型展示名与尾部重复档位括号，确保产品名与思考档位分离且不重复拼接。
   * 例如 "Gemini 4 Hydrogen (High) (High)" -> { baseLabel: "Gemini 4 Hydrogen", effort: "High" }
   */
  function splitModelDisplayAndEffort(displayText, explicitEffort = null) {
    let baseLabel = String(displayText || '').trim();
    let extractedEffort = normalizeEffortValue(explicitEffort || '');
    for (let i = 0; i < 4 && baseLabel; i++) {
      const mParen = baseLabel.match(EFFORT_PAREN_RE);
      if (mParen) {
        baseLabel = mParen[1].trim();
        if (!extractedEffort) extractedEffort = normalizeEffortValue(mParen[2]);
        continue;
      }
      const mSuffix = baseLabel.match(EFFORT_SUFFIX_RE);
      if (mSuffix) {
        baseLabel = mSuffix[1].trim();
        if (!extractedEffort) extractedEffort = normalizeEffortValue(mSuffix[2]);
        continue;
      }
      break;
    }
    return {
      baseLabel,
      effort: extractedEffort || null
    };
  }

  /**
   * 核对 MODEL_PLACEHOLDER_* 原始 ID 与客户端配置/可用模型表的可靠映射关系：
   * 分别输出 rawPlaceholderId、stableModelId、displayName 与 effort；
   * 严禁把未映射的原始占位 ID 直接冒充为已验证的实际路由模型。
   */
  function resolvePlaceholderModelInfo(rawInput, cascadeModelConfigs = [], availableModels = null) {
    const rawStr = typeof rawInput === 'string'
      ? rawInput.trim()
      : String(rawInput?.modelId || rawInput?.modelOrAlias?.model || rawInput?.modelRaw || rawInput?.model || '').trim();
    const isPlaceholder = /^model_placeholder_/i.test(rawStr);
    const configs = Array.isArray(cascadeModelConfigs) ? cascadeModelConfigs : [];
    const stripPrefix = s => String(s || '').trim().toLowerCase().replace(/^model_/, '');

    let matchedCfg = null;
    if (rawStr && configs.length) {
      const low = rawStr.toLowerCase();
      const stripped = stripPrefix(rawStr);
      matchedCfg = configs.find(c => {
        const mId = String(c?.modelId || '').trim().toLowerCase();
        const alias = String(c?.modelOrAlias?.model || '').trim().toLowerCase();
        return (mId && (mId === low || stripPrefix(mId) === stripped))
          || (alias && (alias === low || stripPrefix(alias) === stripped));
      }) || null;
    }

    let matchedAvailKey = null;
    let matchedAvailObj = null;
    if (!matchedCfg && rawStr && availableModels && typeof availableModels === 'object') {
      const low = rawStr.toLowerCase();
      const stripped = stripPrefix(rawStr);
      for (const [k, v] of Object.entries(availableModels)) {
        const vk = String(v?.model || '').trim().toLowerCase();
        if (k.toLowerCase() === low || (vk && (vk === low || stripPrefix(vk) === stripped))) {
          matchedAvailKey = k;
          matchedAvailObj = v;
          break;
        }
      }
    }

    const explicitDisplay = (rawInput && typeof rawInput === 'object')
      ? String(rawInput.modelDisplayName || rawInput.modelLabel || '').trim()
      : '';
    const rawRespModel = (rawInput && typeof rawInput === 'object')
      ? String(rawInput.responseModel || rawInput.chatStartMetadata?.model || '').trim()
      : '';

    const rawDisplay = matchedCfg?.label
      || matchedAvailObj?.displayName
      || (explicitDisplay && !/^model_placeholder_/i.test(explicitDisplay) ? explicitDisplay : '')
      || '';
    const split = splitModelDisplayAndEffort(rawDisplay, (rawInput && typeof rawInput === 'object') ? rawInput.effort : null);

    const stableFromCfg = matchedCfg?.modelId
      ? String(matchedCfg.modelId).trim().toLowerCase()
      : (matchedAvailKey ? String(matchedAvailKey).trim().toLowerCase() : null);
    const nonPlaceholderCfgId = (stableFromCfg && !/^model_placeholder_/i.test(stableFromCfg)) ? stableFromCfg : null;
    const rawStrSlug = (!isPlaceholder && rawStr && /\s/.test(rawStr) && matchedCfg?.modelId && !/^model_placeholder_/i.test(matchedCfg.modelId))
      ? matchedCfg.modelId.toLowerCase()
      : null;
    const derivedSlug = split.baseLabel
      ? `${split.baseLabel}${split.effort ? `-${split.effort}` : ''}`.toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '')
      : null;
    const cleanNonPlaceholderRaw = (!isPlaceholder && rawStr && !/\s/.test(rawStr)) ? rawStr.toLowerCase() : null;
    const hasReliableMapping = Boolean(
      (matchedCfg && (matchedCfg.label || (matchedCfg.modelId && !/^model_placeholder_/i.test(matchedCfg.modelId))))
      || (matchedAvailObj && matchedAvailObj.displayName)
      || (rawDisplay && !/^model_placeholder_/i.test(rawDisplay))
      || (rawRespModel && !/^model_placeholder_/i.test(rawRespModel))
    );

    const mappingSource = matchedCfg
      ? 'cascadeModelConfigs'
      : (matchedAvailObj ? 'availableModels' : ((rawDisplay || rawRespModel) ? 'explicit_response' : (isPlaceholder ? 'unmapped_placeholder' : 'direct_id')));

    return {
      rawPlaceholderId: isPlaceholder ? rawStr : null,
      rawId: rawStr || null,
      stableModelId: nonPlaceholderCfgId || rawStrSlug || cleanNonPlaceholderRaw || (hasReliableMapping ? derivedSlug : null),
      displayName: split.baseLabel || null,
      effort: split.effort || null,
      isPlaceholder,
      isMapped: hasReliableMapping,
      isRoutedModelVerified: Boolean((rawRespModel && !/^model_placeholder_/i.test(rawRespModel)) || hasReliableMapping),
      mappingSource
    };
  }

  /**
   * 档位展示映射：默认/英文返回标准英文名（如 Extra High），中文面板按繁简返回对照标签
   * @param {string} effort 原始力度值
   * @param {string} [lang='en'] 语言代码（'en' | 'zh-CN' | 'zh-TW'）
   */
  function formatEffortLabel(effort, lang = 'en') {
    if (!effort) return '';
    const norm = normalizeEffortValue(effort);
    if (!norm) return String(effort);
    const l = typeof lang === 'string' ? lang.trim().toLowerCase() : 'en';
    if (l === 'zh-cn' || l === 'zh-hans' || l === 'zh') {
      return EFFORT_LABEL_ZH[norm] || norm;
    }
    if (l === 'zh-tw' || l === 'zh-hant' || l === 'tw') {
      return EFFORT_LABEL_TW[norm] || norm;
    }
    return norm;
  }

  /**
   * 按名称或准确 ID 前缀识别厂商（不使用模糊子串匹配）
   */
  function detectModelVendor(productLabel, modelId) {
    const candidates = [productLabel, modelId]
      .filter(v => typeof v === 'string' && v.trim())
      .map(v => v.trim().toLowerCase());
    for (const c of candidates) {
      if (c.startsWith('product:google:')) return 'Google';
      if (c.startsWith('product:anthropic:')) return 'Anthropic';
      if (c.startsWith('product:openai:')) return 'OpenAI';
      if (/^(?:models\/)?(?:gemini|google|gemma|imagen|veo)\b/.test(c)) return 'Google';
      if (/^(?:models\/)?(?:claude|anthropic)\b/.test(c)) return 'Anthropic';
      if (/^(?:models\/)?(?:gpt|openai|o1|o3|o4|chatgpt|codex)\b/.test(c)) return 'OpenAI';
    }
    return '其他';
  }

  /**
   * 模型产品分组纯函数：
   * 将同一产品的不同力度档位归为同一个 productKey；
   * Carbon/Argon 等产品后缀、版本号与代际保持独立，不进行模糊合并。
   */
  function groupModelProduct(config) {
    const obj = (config && typeof config === 'object') ? config : { label: typeof config === 'string' ? config : '' };
    const cm = obj.chatModel || obj;
    const rawId = String(cm.modelId || cm.modelOrAlias?.model || cm.modelRaw || (typeof config === 'string' ? config : '') || '').trim();
    const rawLabel = String(cm.label || cm.modelDisplayName || cm.model || '').trim();
    const explicitEffort = normalizeEffortValue(cm.effort || cm.thinkingEffort || cm.reasoningEffort || obj.effort || '');

    let effort = explicitEffort;
    let productLabel = rawLabel;

    // 仅当末尾括号（半角或全角）或后缀属于白名单档位词时才拆分为 effort（复用模块级预编译正则）
    const parenRe = EFFORT_PAREN_RE;
    const suffixRe = EFFORT_SUFFIX_RE;

    if (productLabel) {
      const mParen = productLabel.match(parenRe);
      if (mParen) {
        productLabel = mParen[1].trim();
        if (!effort) effort = normalizeEffortValue(mParen[2]);
      } else {
        const mSuffix = productLabel.match(suffixRe);
        if (mSuffix) {
          productLabel = mSuffix[1].trim();
          if (!effort) effort = normalizeEffortValue(mSuffix[2]);
        }
      }
    }

    if (!productLabel && rawId) {
      const idEffortRe = /^(.+?)[-_](extra[-_]?high|x[-_]?high|low|medium|high|extra|minimal|max)$/i;
      const mId = rawId.match(idEffortRe);
      if (mId) {
        productLabel = mId[1].trim();
        if (!effort) effort = normalizeEffortValue(mId[2]);
      } else {
        productLabel = rawId;
      }
    }

    if (!productLabel) productLabel = 'Unknown';
    const vendor = detectModelVendor(productLabel, rawId);
    const vendorSlugMap = { Google: 'google', Anthropic: 'anthropic', OpenAI: 'openai', 其他: 'other' };
    let slug = productLabel
      .toLowerCase()
      .replace(/[^a-z0-9.\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '');
    const pkMatch = rawId.toLowerCase().match(/^product:(google|anthropic|openai|other):(.+)$/);
    if (pkMatch && productLabel.toLowerCase() === rawId.toLowerCase()) {
      slug = pkMatch[2];
    }
    const productKey = `product:${vendorSlugMap[vendor] || 'other'}:${slug || rawId.toLowerCase() || 'unknown'}`;

    return {
      productKey,
      productLabel,
      vendor,
      effort: effort || null
    };
  }

  /**
   * 1000 进制 K 换算格式化，全项目统一口径（如 512000 -> 512K, 786432 -> 786.4K）
   */
  function formatTokensK(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    const num = Number(v);
    if (num >= 1e6) return `${parseFloat((num / 1e6).toFixed(2))}M`;
    if (num >= 1000) return `${parseFloat((num / 1000).toFixed(1))}K`;
    return Math.round(num).toLocaleString('en-US');
  }

  /**
   * 判定单条记录是否为有效的实测速度样本
   */
  function isValidSpeedSample(call) {
    if (!call || typeof call !== 'object') return false;
    if (call.status !== 'final') return false;
    if (call.isEstimated === true || call.isSynthetic === true) return false;
    const out = Number(call.outputTokens);
    const dur = Number(call.durationSec);
    if (!Number.isFinite(out) || out <= 0) return false;
    if (!Number.isFinite(dur) || dur <= 0) return false;
    return true;
  }

  function computeMedian(values) {
    const clean = (Array.isArray(values) ? values : [])
      .map(Number)
      .filter(v => Number.isFinite(v))
      .sort((a, b) => a - b);
    if (!clean.length) return null;
    const mid = Math.floor(clean.length / 2);
    return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
  }

  const MAX_SPEED_SAMPLES_PER_MODEL = 200;

  /**
   * 按准确模型 ID（含档位）汇总速度对比统计（中位数、样本数、时间范围与折线序列）
   */
  function summarizeSpeedByModel(calls, options = {}) {
    const days = options.days;
    const originFilter = options.origin || 'all';
    const metric = options.metric || 'tps';
    const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
    const cutoffMs = (days === 7 || days === '7')
      ? nowMs - 7 * 86400000
      : (days === 30 || days === '30')
        ? nowMs - 30 * 86400000
        : null;
    const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];

    const groups = new Map();
    for (const c of (Array.isArray(calls) ? calls : [])) {
      if (!isValidSpeedSample(c)) continue;
      if (originFilter !== 'all') {
        const recOrigin = c.origin === 'speed-test' ? 'speed-test' : 'chat';
        if (recOrigin !== originFilter) continue;
      }
      const ts = Number(c.timestamp) || (c.created_at ? Date.parse(c.created_at) : 0) || (c.date ? Date.parse(c.date) : 0) || 0;
      if (cutoffMs !== null && (!ts || ts < cutoffMs)) continue;

      const exactId = String(c.modelExactId || resolveStableModelId(c, cascadeConfigs) || c.model || '').trim().toLowerCase();
      if (!exactId) continue;

      const rawLabel = String(c.modelLabel || c.model || exactId).trim();
      const prod = groupModelProduct({ modelId: exactId, label: rawLabel, effort: c.effort });
      const outputTokens = Number(c.outputTokens);
      const durationSec = Number(c.durationSec);
      const tpsVal = Number.isFinite(Number(c.tps)) && Number(c.tps) > 0
        ? Number(c.tps)
        : Number((outputTokens / durationSec).toFixed(1));
      const ttftVal = (c.ttftSec !== undefined && c.ttftSec !== null && Number.isFinite(Number(c.ttftSec)) && Number(c.ttftSec) >= 0)
        ? Number(c.ttftSec)
        : null;
      const streamingVal = (c.streamingSec !== undefined && c.streamingSec !== null && Number.isFinite(Number(c.streamingSec)) && Number(c.streamingSec) >= 0)
        ? Number(c.streamingSec)
        : null;
      const inVal = (c.inputTokens != null || c.cacheReadTokens != null || c.cacheTokens != null)
        ? (Number(c.inputTokens) || 0) + (Number(c.cacheReadTokens ?? c.cacheTokens) || 0)
        : null;

      if (!groups.has(exactId)) {
        groups.set(exactId, {
          modelExactId: exactId,
          modelLabel: rawLabel,
          productKey: prod.productKey,
          productLabel: prod.productLabel,
          vendor: prod.vendor,
          effort: c.effort || prod.effort || null,
          records: []
        });
      }
      const g = groups.get(exactId);
      g.records.push({
        callId: c.callId || null,
        ts,
        tps: tpsVal,
        ttftSec: ttftVal,
        streamingSec: streamingVal,
        durationSec,
        outputTokens,
        inputTokens: inVal,
        origin: c.origin === 'speed-test' ? 'speed-test' : 'chat'
      });
    }

    const result = [];
    for (const g of groups.values()) {
      // 按时间降序截断保留最近 200 条
      g.records.sort((a, b) => b.ts - a.ts);
      const recent = g.records.slice(0, MAX_SPEED_SAMPLES_PER_MODEL);
      if (!recent.length) continue;

      const medTps = computeMedian(recent.map(r => r.tps));
      const ttftList = recent.map(r => r.ttftSec).filter(v => v !== null);
      const medTtft = ttftList.length ? computeMedian(ttftList) : null;
      const medDur = computeMedian(recent.map(r => r.durationSec));
      const medOut = computeMedian(recent.map(r => r.outputTokens));
      const inList = recent.map(r => r.inputTokens).filter(v => v !== null && v > 0);
      const medIn = inList.length ? computeMedian(inList) : null;

      const tsList = recent.map(r => r.ts).filter(t => t > 0);
      const minTs = tsList.length ? Math.min(...tsList) : null;
      const maxTs = tsList.length ? Math.max(...tsList) : null;

      // 折线图使用时间升序排列
      const samples = recent.slice().sort((a, b) => a.ts - b.ts);

      result.push({
        modelExactId: g.modelExactId,
        modelLabel: g.modelLabel,
        productKey: g.productKey,
        productLabel: g.productLabel,
        vendor: g.vendor,
        effort: g.effort,
        count: recent.length,
        lowSample: recent.length < 3,
        medianTps: medTps !== null ? Number(medTps.toFixed(1)) : null,
        medianTtft: medTtft !== null ? Number(medTtft.toFixed(2)) : null,
        medianDuration: medDur !== null ? Number(medDur.toFixed(2)) : null,
        medianOutputTokens: medOut !== null ? Math.round(medOut) : null,
        medianInputTokens: medIn !== null ? Math.round(medIn) : null,
        minTs,
        maxTs,
        samples
      });
    }

    result.sort((a, b) => {
      if (metric === 'ttft') {
        if (a.medianTtft == null && b.medianTtft == null) return 0;
        if (a.medianTtft == null) return 1;
        if (b.medianTtft == null) return -1;
        return a.medianTtft - b.medianTtft;
      }
      if (metric === 'duration') {
        if (a.medianDuration == null && b.medianDuration == null) return 0;
        if (a.medianDuration == null) return 1;
        if (b.medianDuration == null) return -1;
        return a.medianDuration - b.medianDuration;
      }
      if (a.medianTps == null && b.medianTps == null) return 0;
      if (a.medianTps == null) return 1;
      if (b.medianTps == null) return -1;
      return b.medianTps - a.medianTps;
    });

    return result;
  }
