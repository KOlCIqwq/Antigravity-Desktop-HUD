  function parseUserPlanStatus(raw) {
    if (!raw || typeof raw !== 'object') {
      return {
        status: 'unidentified',
        tierKey: 'unknown',
        tierName: '未知',
        tierId: null,
        teamsTier: null,
        planName: '未知',
        email: null,
        region: '未知',
        currency: 'USD',
        billingCycle: '未知',
        officialPriceMonthly: null,
        priceRangeNote: '未知',
        actualPricePaid: null,
        isPriceEstimated: true,
        promptCredits: null,
        flowCredits: null,
        pricingTableVerifiedDate: '2026-11-08',
        updatedAt: null
      };
    }
    const us = raw.userStatus || raw;
    const userTier = us.userTier || {};
    const planStatus = us.planStatus || {};
    const planInfo = planStatus.planInfo || {};
    const email = us.email || null;
    const rawTierName = String(userTier.name || planInfo.planName || '').trim();

    // Only identify a plan when explicit entitlement evidence exists; avoid treating empty objects or default states as Free
    const hasTierEvidence = Boolean(
      rawTierName ||
      userTier.id ||
      planInfo.teamsTier ||
      planStatus.availablePromptCredits !== undefined ||
      planInfo.monthlyPromptCredits !== undefined
    );

    if (!hasTierEvidence) {
      return {
        status: 'unidentified',
        tierKey: 'unknown',
        tierName: '未知',
        tierId: null,
        teamsTier: null,
        planName: '未知',
        email,
        region: '未知',
        currency: 'USD',
        billingCycle: '未知',
        officialPriceMonthly: null,
        priceRangeNote: '未知',
        actualPricePaid: null,
        isPriceEstimated: true,
        promptCredits: null,
        flowCredits: null,
        pricingTableVerifiedDate: '2026-11-08',
        updatedAt: null
      };
    }

    let tierKey = 'unknown';
    let tierDisplayName = '未知';
    let officialPrice = null;
    let priceRange = null;
    const rawTeamsTier = typeof planInfo.teamsTier === 'string' ? planInfo.teamsTier.trim() : '';

    if (/ultra/i.test(rawTierName) || /ultra/i.test(userTier.id || '') || /pro_ultimate|teams_tier_ultra/i.test(rawTeamsTier)) {
      tierKey = 'ultra';
      const subTierMatch = rawTierName.match(/ultra\s*([0-9a-zA-Z\-_]+)/i);
      if (subTierMatch && !['plan', 'tier'].includes(subTierMatch[1].toLowerCase())) {
        tierDisplayName = `Google AI Ultra (${subTierMatch[1]})`;
        officialPrice = null;
        priceRange = '子档定制费率未知';
      } else {
        tierDisplayName = 'Google AI Ultra（子档未知）';
        officialPrice = null;
        priceRange = '参考区间 $99.99 ~ $249.99/月（子档未知）';
      }
    } else if (/pro/i.test(rawTierName) || /pro/i.test(userTier.id || '') || /^teams_tier_pro$/i.test(rawTeamsTier)) {
      tierKey = 'pro';
      tierDisplayName = 'Google AI Pro';
      officialPrice = 19.99;
      priceRange = '$19.99/月（公开参考）';
    } else if (/plus/i.test(rawTierName) || /plus/i.test(userTier.id || '') || /^teams_tier_plus$/i.test(rawTeamsTier)) {
      tierKey = 'plus';
      tierDisplayName = 'Google AI Plus';
      officialPrice = 4.99;
      priceRange = '$4.99/月（公开参考）';
    } else if (/free/i.test(rawTierName) || /free/i.test(userTier.id || '') || /^teams_tier_free$/i.test(rawTeamsTier)) {
      tierKey = 'free';
      tierDisplayName = 'Free';
      officialPrice = 0;
      priceRange = '$0/月（公开参考）';
    } else {
      tierKey = 'custom';
      tierDisplayName = rawTierName || rawTeamsTier || '未知套餐';
      officialPrice = null;
      priceRange = '费率未知';
    }

    return {
      status: 'identified',
      tierKey,
      tierName: tierDisplayName,
      tierId: userTier.id || null,
      teamsTier: planInfo.teamsTier || null,
      planName: planInfo.planName || tierDisplayName,
      email,
      region: '未知',
      currency: 'USD',
      billingCycle: officialPrice !== null ? '月付 · 公开参考' : '未知',
      officialPriceMonthly: officialPrice,
      priceRangeNote: priceRange,
      actualPricePaid: null,
      isPriceEstimated: true,
      promptCredits: {
        available: planStatus.availablePromptCredits ?? null,
        monthly: planInfo.monthlyPromptCredits ?? null
      },
      flowCredits: {
        available: planStatus.availableFlowCredits ?? null,
        monthly: planInfo.monthlyFlowCredits ?? null
      },
      aiCredits: (us.aiCredits ?? planStatus.availableAiCredits ?? planStatus.aiCredits ?? null),
      pricingTableVerifiedDate: '2026-11-08',
      updatedAt: new Date().toISOString()
    };
  }

  function calculateReferenceModelCost(tokenTotals = {}, modelKey = 'gemini-3.8-flash', options = {}) {
    if (!tokenTotals || typeof tokenTotals !== 'object') {
      tokenTotals = {};
    }
    const input = Number(tokenTotals.inputTokens ?? tokenTotals.input ?? tokenTotals.totalInputTokens ?? 0);
    const cache = Number(tokenTotals.cacheTokens ?? tokenTotals.cacheReadTokens ?? tokenTotals.cache ?? tokenTotals.totalCacheTokens ?? 0);
    const output = Number(tokenTotals.outputTokens ?? tokenTotals.output ?? tokenTotals.totalOutputTokens ?? 0);
    const total = Number(tokenTotals.totalTokens ?? tokenTotals.total ?? tokenTotals.grandTotalTokens ?? (input + cache + output));
    const hasBreakdown = (input + cache + output) > 0;

    const normKey = normalizeModelId(modelKey) || 'gemini-3.8-flash';
    const tierRules = GEMINI_PRICING_TABLE[normKey] || GEMINI_PRICING_TABLE['gemini-3.8-flash'];
    const reqDate = options.pricingDate ? String(options.pricingDate).slice(0, 10) : '2026-11-08';
    let matchedTier = tierRules[0];
    for (const rule of tierRules) {
      if (rule.effectiveTo && reqDate > rule.effectiveTo) continue;
      if (rule.effectiveFrom && reqDate < rule.effectiveFrom) continue;
      matchedTier = rule;
      break;
    }

    let inputCost = 0;
    let cacheCost = 0;
    let outputCost = 0;
    let totalCost = 0;
    let unpricedTokens = 0;

    if (hasBreakdown) {
      inputCost = (input * matchedTier.inputPerMillion) / 1000000;
      cacheCost = (cache * matchedTier.cacheReadPerMillion) / 1000000;
      outputCost = (output * matchedTier.outputPerMillion) / 1000000;
      totalCost = inputCost + cacheCost + outputCost;
    } else if (total > 0) {
      if (options.simulationSplit && typeof options.simulationSplit === 'object') {
        const inRatio = Number(options.simulationSplit.inputRatio || 0.8);
        const outRatio = Number(options.simulationSplit.outputRatio || 0.2);
        const simIn = total * inRatio;
        const simOut = total * outRatio;
        inputCost = (simIn * matchedTier.inputPerMillion) / 1000000;
        outputCost = (simOut * matchedTier.outputPerMillion) / 1000000;
        totalCost = inputCost + outputCost;
      } else {
        unpricedTokens = total;
      }
    }

    // Hybrid mode: use actual model for identified records and reference model for unknown portion only (subtracting residuals accurately by category)
    let hybrid = null;
    if (options.mode === 'unpriced_only' || options.knownUsage) {
      const ku = options.knownUsage || {};
      const knownIn = Number(ku.inputTokens ?? ku.byCategory?.inputTokens ?? ku.input ?? 0);
      const knownCache = Number(ku.cacheTokens ?? ku.cacheReadTokens ?? ku.byCategory?.cacheTokens ?? ku.cache ?? 0);
      const knownOut = Number(ku.outputTokens ?? ku.byCategory?.outputTokens ?? ku.output ?? 0);
      const knownCost = Number(ku.costUSD ?? ku.pricedCostUSD ?? 0);

      const residualIn = Math.max(0, input - knownIn);
      const residualCache = Math.max(0, cache - knownCache);
      const residualOut = Math.max(0, output - knownOut);

      const resInCost = (residualIn * matchedTier.inputPerMillion) / 1000000;
      const resCacheCost = (residualCache * matchedTier.cacheReadPerMillion) / 1000000;
      const resOutCost = (residualOut * matchedTier.outputPerMillion) / 1000000;
      const resTotalCost = resInCost + resCacheCost + resOutCost;

      const combined = resTotalCost === 0 ? knownCost : Number((knownCost + resTotalCost).toFixed(4));
      hybrid = {
        knownCostUSD: knownCost,
        unpricedResidualTokens: residualIn + residualCache + residualOut,
        unpricedResidualCostUSD: Number(resTotalCost.toFixed(4)),
        combinedTotalUSD: combined,
        residualTokensBreakdown: {
          input: residualIn,
          cache: residualCache,
          output: residualOut,
          inputCostUSD: Number(resInCost.toFixed(4)),
          cacheCostUSD: Number(resCacheCost.toFixed(4)),
          outputCostUSD: Number(resOutCost.toFixed(4))
        }
      };
    }

    const modelNameMap = {
      'gemini-3.8-flash': 'Gemini 3.8 Flash Standard',
      'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
      'gemini-4-carbon': 'Gemini 4 Carbon',
      'gemini-4-argon': 'Gemini 4 Argon',
      'gemini-3.1-pro-preview': 'Gemini 3.1 Pro Preview',
      'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
      'gemini-2.5-pro': 'Gemini 2.5 Pro',
      'claude-opus-5-5': 'Claude Opus 5.5',
      'claude-sonnet-5-5': 'Claude Sonnet 5.5'
    };

    return {
      modelKey: normKey,
      modelDisplayName: modelNameMap[normKey] || normKey,
      pricingDate: reqDate,
      matchedTier,
      hasBreakdown,
      inputTokens: input,
      cacheTokens: cache,
      cacheReadTokens: cache,
      outputTokens: output,
      totalTokens: total,
      inputCostUSD: Number(inputCost.toFixed(4)),
      cacheCostUSD: Number(cacheCost.toFixed(4)),
      outputCostUSD: Number(outputCost.toFixed(4)),
      totalCostUSD: Number(totalCost.toFixed(4)),
      formattedTotalUSD: Number(totalCost.toFixed(2)),
      categoryBreakdown: {
        input: {
          tokens: input,
          ratePerMillion: matchedTier.inputPerMillion,
          costUSD: Number(inputCost.toFixed(4))
        },
        cache: {
          tokens: cache,
          ratePerMillion: matchedTier.cacheReadPerMillion,
          costUSD: Number(cacheCost.toFixed(4))
        },
        output: {
          tokens: output,
          ratePerMillion: matchedTier.outputPerMillion,
          costUSD: Number(outputCost.toFixed(4))
        }
      },
      isSimulation: !hasBreakdown && total > 0 && !!options.simulationSplit,
      unpricedTokens,
      hybrid,
      exclusionsNote: '估值未包含项目：缓存存储费用、超大上下文单请求分档溢价、向量检索与搜索接地费用。',
      pricingNote: '缓存读取按官方 10% 优惠费率折算，不作普通输入计价；输出已含 thinking token，不重复计算。'
    };
  }

  // Official presets by subscription acquisition channel (verified: 2026-11-09)
  const SUBSCRIPTION_ACQUISITION_PRESETS = [
    {
      id: 'normal_paid',
      name: '正常付费订阅',
      category: 'paid',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://one.google.com/about/plans',
      defaultPaid: 19.99,
      note: '按月或按年常规全额付费订阅'
    },
    {
      id: 'student_offer',
      name: '学生认证优惠 (Google One AI Student)',
      category: 'discount',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://support.google.com/googleone/thread/460703251/updates-to-google-one-ai-student-offers-for-2026',
      defaultPaid: 0,
      note: '学生资格验证试用或专享折扣 (按地区提供 Plus/Pro)'
    },
    {
      id: 'pixel_bundle',
      name: 'Google Pixel 设备赠送',
      category: 'bundle_free',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://support.google.com/pixelphone/answer/13529884',
      defaultPaid: 0,
      note: '购买指定 Pixel 机型附赠权益 (如 Pixel 11 Pro 系列赠送 6 个月)'
    },
    {
      id: 'chromebook_bundle',
      name: 'Chromebook Plus 设备赠送',
      category: 'bundle_free',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://www.google.com/chromebook/chromebookplus/',
      defaultPaid: 0,
      note: '符合资格的 Chromebook Plus 设备赠送 Google AI Pro 权益'
    },
    {
      id: 'samsung_galaxy',
      name: 'Samsung Galaxy 设备指定活动',
      category: 'bundle_free',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://www.samsung.com/hk_en/offer/content-services-offer/tnc/',
      defaultPaid: 0,
      note: '指定 Galaxy 机型区域专享 Google AI Pro 活动 (需在有效领取期内)'
    },
    {
      id: 'jio_offer',
      name: 'Jio 运营商套餐权益',
      category: 'partner',
      status: 'expired_claim_active_use',
      verifiedDate: '2026-11-09',
      sourceUrl: 'https://www.jio.com/help/faq/mobile/offers/google-gemini-offer/',
      defaultPaid: 0,
      note: '历史活动 (新领取已截止，已成功兑换者享有最长 18 个月权益)'
    },
    {
      id: 'partner_carrier',
      name: '其他运营商 / 合作伙伴权益',
      category: 'partner',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: '',
      defaultPaid: 0,
      note: '宽带、通信套餐或第三方平台绑定的 AI 订阅权益'
    },
    {
      id: 'family_sharing',
      name: '家庭组共享 / 他人赠送',
      category: 'sharing',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: '',
      defaultPaid: 0,
      note: '加入家庭组成员车位或受赠权益 (非公开促销)'
    },
    {
      id: 'official_promo',
      name: 'Google 官方限时试用 / 促销活动',
      category: 'promo',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: '',
      defaultPaid: 0,
      note: '新用户首月免费或其他官方优惠码兑换'
    },
    {
      id: 'custom_source',
      name: '其他 / 自由自定义来源',
      category: 'custom',
      status: 'active',
      verifiedDate: '2026-11-09',
      sourceUrl: '',
      defaultPaid: null,
      note: '用户自定义填写的特定渠道或活动'
    }
  ];

  const CURRENCY_SYMBOLS = {
    USD: '$',
    CNY: '¥',
    JPY: '¥',
    HKD: 'HK$',
    EUR: '€',
    GBP: '£',
    SGD: 'S$',
    TRY: '₺',
    NGN: '₦',
    TWD: 'NT$',
    PHP: '₱',
    INR: '₹',
    BRL: 'R$',
    CAD: 'CA$',
    AUD: 'AU$',
    MYR: 'RM ',
    KRW: '₩',
    NZD: 'NZ$',
    THB: '฿',
    VND: '₫',
    IDR: 'Rp ',
    PKR: '₨ ',
    MXN: '$',
    ARS: '$',
    CLP: '$',
    COP: '$',
    PEN: 'S/ ',
    CHF: 'CHF ',
    UAH: '₴',
    PLN: 'zł ',
    SEK: 'kr ',
    NOK: 'kr ',
    DKK: 'kr ',
    CZK: 'Kč ',
    HUF: 'Ft ',
    RON: 'lei ',
    ZAR: 'R ',
    EGP: 'E£ ',
    KES: 'KSh ',
    AED: 'AED ',
    SAR: 'SAR ',
    ILS: '₪ '
  };

  // Regional subscription reference prices and static FX rates for local estimation (base currency: CNY)
  const SUBSCRIPTION_REGIONS_PRESET = [
    // Asia-Pacific & Oceania
    { id: 'TW', name: '中国台湾', nameTw: '中國台灣', nameEn: 'Taiwan', flag: '🇹🇼', currency: 'TWD', symbol: 'NT$', monthlyPrice: 650, rateToCNY: 0.21, aliases: ['tw', 'ntd', 'twd', 'taiwan', '台湾', '台灣', '中国台湾', '中國台灣', '台区', '台區'] },
    { id: 'HK', name: '中国香港', nameTw: '中國香港', nameEn: 'Hong Kong', flag: '🇭🇰', currency: 'HKD', symbol: 'HK$', monthlyPrice: 158.00, rateToCNY: 0.857, aliases: ['hk', 'hong kong', '香港', '中国香港', '中國香港', '港区', '港區'] },
    { id: 'JP', name: '日本', nameTw: '日本', nameEn: 'Japan', flag: '🇯🇵', currency: 'JPY', symbol: '¥', monthlyPrice: 2900, rateToCNY: 0.0425, aliases: ['jp', 'japan', '日本', '日区', '日區'] },
    { id: 'KR', name: '韩国', nameTw: '韓國', nameEn: 'South Korea', flag: '🇰🇷', currency: 'KRW', symbol: '₩', monthlyPrice: 29000, rateToCNY: 0.0051, aliases: ['kr', 'korea', 'south korea', '韩国', '韓國', '韩区', '韓區'] },
    { id: 'AU', name: '澳大利亚 (澳区)', nameTw: '澳洲 (澳區)', nameEn: 'Australia', flag: '🇦🇺', currency: 'AUD', symbol: 'AU$', monthlyPrice: 32.99, rateToCNY: 4.45, aliases: ['au', 'aud', 'australia', '澳大利亚', '澳洲', '澳大利亞', '澳区', '澳區'] },
    { id: 'NZ', name: '新西兰', nameTw: '紐西蘭', nameEn: 'New Zealand', flag: '🇳🇿', currency: 'NZD', symbol: 'NZ$', monthlyPrice: 34.99, rateToCNY: 4.05, aliases: ['nz', 'nzd', 'new zealand', '新西兰', '紐西蘭'] },
    { id: 'SG', name: '新加坡', nameTw: '新加坡', nameEn: 'Singapore', flag: '🇸🇬', currency: 'SGD', symbol: 'S$', monthlyPrice: 27.99, rateToCNY: 5.12, aliases: ['sg', 'singapore', '新加坡', '星洲'] },
    { id: 'MY', name: '马来西亚', nameTw: '馬來西亞', nameEn: 'Malaysia', flag: '🇲🇾', currency: 'MYR', symbol: 'RM ', monthlyPrice: 97.99, rateToCNY: 1.55, aliases: ['my', 'myr', 'malaysia', '马来西亚', '馬來西亞', '大马', '大馬'] },
    { id: 'TH', name: '泰国', nameTw: '泰國', nameEn: 'Thailand', flag: '🇹🇭', currency: 'THB', symbol: '฿', monthlyPrice: 750, rateToCNY: 0.20, aliases: ['th', 'thb', 'thailand', '泰国', '泰國'] },
    { id: 'VN', name: '越南', nameTw: '越南', nameEn: 'Vietnam', flag: '🇻🇳', currency: 'VND', symbol: '₫', monthlyPrice: 489000, rateToCNY: 0.00028, aliases: ['vn', 'vnd', 'vietnam', '越南'] },
    { id: 'ID', name: '印度尼西亚', nameTw: '印度尼西亞', nameEn: 'Indonesia', flag: '🇮🇩', currency: 'IDR', symbol: 'Rp ', monthlyPrice: 309000, rateToCNY: 0.00044, aliases: ['id', 'idr', 'indonesia', '印度尼西亚', '印度尼西亞', '印尼'] },
    { id: 'PH', name: '菲律宾', nameTw: '菲律賓', nameEn: 'Philippines', flag: '🇵🇭', currency: 'PHP', symbol: '₱', monthlyPrice: 1100, rateToCNY: 0.117, aliases: ['ph', 'php', 'philippines', '菲律宾', '菲律賓'] },
    { id: 'IN', name: '印度', nameTw: '印度', nameEn: 'India', flag: '🇮🇳', currency: 'INR', symbol: '₹', monthlyPrice: 1950, rateToCNY: 0.076, aliases: ['in', 'inr', 'india', '印度', '印区', '印區'] },
    { id: 'PK', name: '巴基斯坦', nameTw: '巴基斯坦', nameEn: 'Pakistan', flag: '🇵🇰', currency: 'PKR', symbol: '₨ ', monthlyPrice: 5600, rateToCNY: 0.024, aliases: ['pk', 'pkr', 'pakistan', '巴基斯坦'] },

    // North & Latin America
    { id: 'US', name: '美国', nameTw: '美國', nameEn: 'United States', flag: '🇺🇸', currency: 'USD', symbol: '$', monthlyPrice: 19.99, rateToCNY: 6.72, aliases: ['us', 'usa', 'united states', '美国', '美國', '美区', '美區'] },
    { id: 'CA', name: '加拿大', nameTw: '加拿大', nameEn: 'Canada', flag: '🇨🇦', currency: 'CAD', symbol: 'CA$', monthlyPrice: 26.99, rateToCNY: 4.88, aliases: ['ca', 'cad', 'canada', '加拿大'] },
    { id: 'MX', name: '墨西哥', nameTw: '墨西哥', nameEn: 'Mexico', flag: '🇲🇽', currency: 'MXN', symbol: '$', monthlyPrice: 395, rateToCNY: 0.36, aliases: ['mx', 'mxn', 'mexico', '墨西哥'] },
    { id: 'BR', name: '巴西', nameTw: '巴西', nameEn: 'Brazil', flag: '🇧🇷', currency: 'BRL', symbol: 'R$', monthlyPrice: 96.99, rateToCNY: 1.18, aliases: ['br', 'brl', 'brazil', '巴西'] },
    { id: 'TR', name: '土耳其', nameTw: '土耳其', nameEn: 'Turkey', flag: '🇹🇷', currency: 'TRY', symbol: '₺', monthlyPrice: 869.99, rateToCNY: 0.133, aliases: ['tr', 'try', 'turkey', '土耳其', '土区', '土區'] },
    { id: 'AR', name: '阿根廷', nameTw: '阿根廷', nameEn: 'Argentina', flag: '🇦🇷', currency: 'ARS', symbol: '$', monthlyPrice: 19999, rateToCNY: 0.0065, aliases: ['ar', 'ars', 'argentina', '阿根廷'] },
    { id: 'CL', name: '智利', nameTw: '智利', nameEn: 'Chile', flag: '🇨🇱', currency: 'CLP', symbol: '$', monthlyPrice: 18990, rateToCNY: 0.0072, aliases: ['cl', 'clp', 'chile', '智利'] },
    { id: 'CO', name: '哥伦比亚', nameTw: '哥倫比亞', nameEn: 'Colombia', flag: '🇨🇴', currency: 'COP', symbol: '$', monthlyPrice: 84900, rateToCNY: 0.0016, aliases: ['co', 'cop', 'colombia', '哥伦比亚', '哥倫比亞'] },
    { id: 'PE', name: '秘鲁', nameTw: '秘魯', nameEn: 'Peru', flag: '🇵🇪', currency: 'PEN', symbol: 'S/ ', monthlyPrice: 76.90, rateToCNY: 1.82, aliases: ['pe', 'pen', 'peru', '秘鲁', '秘魯'] },

    // Europe & Eurasia
    { id: 'GB', name: '英国', nameTw: '英國', nameEn: 'United Kingdom', flag: '🇬🇧', currency: 'GBP', symbol: '£', monthlyPrice: 18.99, rateToCNY: 8.75, aliases: ['gb', 'uk', 'gbp', 'united kingdom', '英国', '英國', '英区', '英區'] },
    { id: 'EU', name: '欧洲/欧盟 (德法意西荷等)', nameTw: '歐洲/歐盟 (德法義西荷等)', nameEn: 'Europe / EU', flag: '🇪🇺', currency: 'EUR', symbol: '€', monthlyPrice: 21.99, rateToCNY: 7.52, aliases: ['eu', 'eur', 'euro', 'europe', 'europe / eu', '欧洲', '歐洲', '欧盟', '歐盟', '德国', '德國', '法国', '法國', '意大利', '義大利', '西班牙', '荷兰', '荷蘭'] },
    { id: 'CH', name: '瑞士', nameTw: '瑞士', nameEn: 'Switzerland', flag: '🇨🇭', currency: 'CHF', symbol: 'CHF ', monthlyPrice: 17.00, rateToCNY: 7.85, aliases: ['ch', 'chf', 'switzerland', '瑞士'] },
    { id: 'UA', name: '乌克兰', nameTw: '烏克蘭', nameEn: 'Ukraine', flag: '🇺🇦', currency: 'UAH', symbol: '₴', monthlyPrice: 900, rateToCNY: 0.162, aliases: ['ua', 'uah', 'ukraine', '乌克兰', '烏克蘭'] },
    { id: 'PL', name: '波兰', nameTw: '波蘭', nameEn: 'Poland', flag: '🇵🇱', currency: 'PLN', symbol: 'zł ', monthlyPrice: 97.99, rateToCNY: 1.72, aliases: ['pl', 'pln', 'poland', '波兰', '波蘭'] },
    { id: 'SE', name: '瑞典', nameTw: '瑞典', nameEn: 'Sweden', flag: '🇸🇪', currency: 'SEK', symbol: 'kr ', monthlyPrice: 239, rateToCNY: 0.65, aliases: ['se', 'sek', 'sweden', '瑞典'] },
    { id: 'NO', name: '挪威', nameTw: '挪威', nameEn: 'Norway', flag: '🇳🇴', currency: 'NOK', symbol: 'kr ', monthlyPrice: 239, rateToCNY: 0.63, aliases: ['no', 'nok', 'norway', '挪威'] },
    { id: 'DK', name: '丹麦', nameTw: '丹麥', nameEn: 'Denmark', flag: '🇩🇰', currency: 'DKK', symbol: 'kr ', monthlyPrice: 169, rateToCNY: 1.01, aliases: ['dk', 'dkk', 'denmark', '丹麦', '丹麥'] },
    { id: 'CZ', name: '捷克', nameTw: '捷克', nameEn: 'Czechia', flag: '🇨🇿', currency: 'CZK', symbol: 'Kč ', monthlyPrice: 529, rateToCNY: 0.30, aliases: ['cz', 'czk', 'czech', 'czechia', '捷克'] },
    { id: 'HU', name: '匈牙利', nameTw: '匈牙利', nameEn: 'Hungary', flag: '🇭🇺', currency: 'HUF', symbol: 'Ft ', monthlyPrice: 8990, rateToCNY: 0.0185, aliases: ['hu', 'huf', 'hungary', '匈牙利'] },
    { id: 'RO', name: '罗马尼亚', nameTw: '羅馬尼亞', nameEn: 'Romania', flag: '🇷🇴', currency: 'RON', symbol: 'lei ', monthlyPrice: 109.99, rateToCNY: 1.51, aliases: ['ro', 'ron', 'romania', '罗马尼亚', '羅馬尼亞'] },

    // Middle East & Africa
    { id: 'NG', name: '尼日利亚', nameTw: '奈及利亞', nameEn: 'Nigeria', flag: '🇳🇬', currency: 'NGN', symbol: '₦', monthlyPrice: 28500, rateToCNY: 0.0042, aliases: ['ng', 'ngn', 'nigeria', '尼日利亚', '奈及利亞', '尼区', '尼區'] },
    { id: 'ZA', name: '南非', nameTw: '南非', nameEn: 'South Africa', flag: '🇿🇦', currency: 'ZAR', symbol: 'R ', monthlyPrice: 429.99, rateToCNY: 0.38, aliases: ['za', 'zar', 'south africa', '南非'] },
    { id: 'EG', name: '埃及', nameTw: '埃及', nameEn: 'Egypt', flag: '🇪🇬', currency: 'EGP', symbol: 'E£ ', monthlyPrice: 999, rateToCNY: 0.136, aliases: ['eg', 'egp', 'egypt', '埃及'] },
    { id: 'KE', name: '肯尼亚', nameTw: '肯亞', nameEn: 'Kenya', flag: '🇰🇪', currency: 'KES', symbol: 'KSh ', monthlyPrice: 2800, rateToCNY: 0.052, aliases: ['ke', 'kes', 'kenya', '肯尼亚', '肯亞'] },
    { id: 'AE', name: '阿联酋', nameTw: '阿聯酋', nameEn: 'United Arab Emirates', flag: '🇦🇪', currency: 'AED', symbol: 'AED ', monthlyPrice: 76.99, rateToCNY: 1.83, aliases: ['ae', 'aed', 'uae', 'emirates', 'united arab emirates', '阿联酋', '阿聯酋', '迪拜', '杜拜'] },
    { id: 'SA', name: '沙特阿拉伯', nameTw: '沙烏地阿拉伯', nameEn: 'Saudi Arabia', flag: '🇸🇦', currency: 'SAR', symbol: 'SAR ', monthlyPrice: 85.99, rateToCNY: 1.79, aliases: ['sa', 'sar', 'saudi', 'saudi arabia', '沙特', '沙特阿拉伯', '沙烏地阿拉伯'] },
    { id: 'IL', name: '以色列', nameTw: '以色列', nameEn: 'Israel', flag: '🇮🇱', currency: 'ILS', symbol: '₪ ', monthlyPrice: 79.90, rateToCNY: 1.85, aliases: ['il', 'ils', 'israel', '以色列'] },

    // Greater China / CNY & Custom
    { id: 'CN', name: '中国大陆 (CNY)', nameTw: '中國大陸 (CNY)', nameEn: 'China Mainland', flag: '🇨🇳', currency: 'CNY', symbol: '¥', monthlyPrice: 140.00, rateToCNY: 1.0, aliases: ['cn', 'cny', 'china', 'china mainland', '中国', '中國', '中国大陆', '中國大陸', '人民币', '人民幣', '国内', '國內'] }
  ];

  function findRegionPreset(regionQuery) {
    if (!regionQuery || typeof regionQuery !== 'string') return null;
    const raw = regionQuery.trim();
    if (!raw) return null;
    const q = raw.toLowerCase();
    const stripped = raw.replace(/\s*\([A-Za-z]{2,4}\)\s*$/i, '').trim().toLowerCase();
    return SUBSCRIPTION_REGIONS_PRESET.find(r =>
      r.id.toLowerCase() === q ||
      r.name.toLowerCase() === q ||
      (r.nameTw && r.nameTw.toLowerCase() === q) ||
      (r.nameEn && r.nameEn.toLowerCase() === q) ||
      (stripped && (
        r.name.toLowerCase() === stripped ||
        (r.nameTw && r.nameTw.toLowerCase() === stripped) ||
        (r.nameEn && r.nameEn.toLowerCase() === stripped)
      )) ||
      r.aliases.some(a => a.toLowerCase() === q || q.includes(a.toLowerCase()))
    ) || null;
  }

  function resolveCurrencyRateToCNY(currency, regionQuery = null) {
    let cur = String(currency || '').toUpperCase();
    if (cur === 'NTD') cur = 'TWD';
    if (cur === 'CNY') return 1.0;
    let preset = findRegionPreset(regionQuery);
    if (!preset || (cur && preset.currency !== cur)) {
      preset = SUBSCRIPTION_REGIONS_PRESET.find(r => r.currency === cur);
    }
    if (preset && preset.rateToCNY) return preset.rateToCNY;
    if (cur === 'USD') return 6.72;
    if (cur === 'HKD') return 0.857;
    if (cur === 'TWD') return 0.21;
    if (cur === 'JPY') return 0.0425;
    if (cur === 'EUR') return 7.52;
    if (cur === 'GBP') return 8.75;
    return null;
  }

  function convertToCNY(amount, currency, regionQuery = null) {
    if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return null;
    const num = Number(amount);
    if (num === 0) return 0;
    const rate = resolveCurrencyRateToCNY(currency, regionQuery);
    if (!rate) return null;
    return Number((num * rate).toFixed(2));
  }

  /**
   * Cross-currency conversion using CNY-based static FX rates (supports USD / HKD / TWD / CNY and all preset regional currencies).
   */
  function convertCurrency(amount, fromCurrency, toCurrency, regionQuery = null) {
    if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return null;
    const num = Number(amount);
    if (num === 0) return 0;
    let from = String(fromCurrency || 'USD').trim().toUpperCase();
    let to = String(toCurrency || 'USD').trim().toUpperCase();
    if (from === 'NTD') from = 'TWD';
    if (to === 'NTD') to = 'TWD';
    if (from === to) return Number(num.toFixed(2));
    const fromRate = resolveCurrencyRateToCNY(from, regionQuery);
    const toRate = resolveCurrencyRateToCNY(to, null);
    if (!fromRate || !toRate) return null;
    return Number(((num * fromRate) / toRate).toFixed(2));
  }

  function resolveEffectivePlanStatus(livePlanStatus, customSettings, options = {}) {
    const rawLive = livePlanStatus && typeof livePlanStatus === 'object' ? livePlanStatus : null;
    const rawCustom = customSettings && typeof customSettings === 'object' ? customSettings : null;
    const cachedLive = options.cachedLivePlan && typeof options.cachedLivePlan === 'object' ? options.cachedLivePlan : null;

    // Current account identifier
    const currentEmail = rawLive?.email || options.currentEmail || cachedLive?.email || null;
    const customAccount = rawCustom?.email || rawCustom?.account || null;

    // Account isolation check: if custom settings specify a concrete account (not default) that differs from the current account (not default), do not apply them
    const normCustomAcc = customAccount ? String(customAccount).trim().toLowerCase() : '';
    const normCurrentEmail = currentEmail ? String(currentEmail).trim().toLowerCase() : '';
    const isCustomAccountMatched = !normCustomAcc || normCustomAcc === 'default' || !normCurrentEmail || normCurrentEmail === 'default' || normCustomAcc === normCurrentEmail;
    const effectiveCustom = isCustomAccountMatched ? rawCustom : null;

    // 1. Plan name and identification status
    let status = 'unidentified';
    let tierKey = 'unknown';
    let tierName = '未知';
    let tierId = null;
    let teamsTier = null;
    let planName = '未知';
    let tierSource = 'unknown';

    if (rawLive && rawLive.status === 'identified' && rawLive.tierKey !== 'unknown') {
      status = 'identified';
      tierKey = rawLive.tierKey;
      tierName = rawLive.tierName;
      tierId = rawLive.tierId;
      teamsTier = rawLive.teamsTier || null;
      planName = rawLive.planName || rawLive.tierName;
      tierSource = 'live';
    } else if (effectiveCustom && effectiveCustom.tierName) {
      status = 'custom';
      tierKey = effectiveCustom.tierKey || 'custom';
      tierName = effectiveCustom.tierName;
      tierId = effectiveCustom.tierId || rawLive?.tierId || cachedLive?.tierId || null;
      teamsTier = effectiveCustom.teamsTier || rawLive?.teamsTier || cachedLive?.teamsTier || null;
      planName = effectiveCustom.tierName;
      tierSource = 'custom';
    } else if (cachedLive && cachedLive.status === 'identified' && cachedLive.tierKey !== 'unknown') {
      status = 'identified';
      tierKey = cachedLive.tierKey;
      tierName = cachedLive.tierName;
      tierId = cachedLive.tierId;
      teamsTier = cachedLive.teamsTier || null;
      planName = cachedLive.planName || cachedLive.tierName;
      tierSource = 'cached_live';
    }

    // 2A. Account region (accountRegion / country) resolved independently: local record only, does not affect subscription country or currency
    let country = '未知';
    let countrySource = 'unknown';
    const customAccVal = effectiveCustom?.accountRegion || effectiveCustom?.country;
    const isLiveCountryValid = rawLive?.country && rawLive.countrySource !== 'custom' && !String(rawLive.country).includes('未知');
    const isCachedCountryValid = cachedLive?.country && !String(cachedLive.country).includes('未知');
    if (isLiveCountryValid) {
      country = String(rawLive.country).trim();
      countrySource = 'live';
    } else if (customAccVal && typeof customAccVal === 'string' && customAccVal.trim() && !customAccVal.includes('未知')) {
      country = customAccVal.trim();
      countrySource = 'custom';
    } else if (isCachedCountryValid) {
      country = String(cachedLive.country).trim();
      countrySource = 'cached_live';
    }

    // 2B. Subscription country (subscriptionCountry / subscriptionRegion / region) resolved independently: purchase/billing region, may differ from account region
    let region = '未知';
    let regionSource = 'unknown';
    const liveRegVal = rawLive?.subscriptionCountry || rawLive?.subscriptionRegion || rawLive?.region;
    const customRegVal = effectiveCustom?.subscriptionCountry || effectiveCustom?.subscriptionRegion || effectiveCustom?.region;
    const cachedRegVal = cachedLive?.subscriptionCountry || cachedLive?.subscriptionRegion || cachedLive?.region;
    const isLiveRegionValid = liveRegVal && rawLive?.regionSource !== 'custom' && rawLive?.regionSource !== 'preset_region' && !String(liveRegVal).includes('未知');
    const isCachedRegionValid = cachedRegVal && !String(cachedRegVal).includes('未知');

    if (isLiveRegionValid) {
      region = String(liveRegVal).trim();
      regionSource = 'live';
    } else if (customRegVal && typeof customRegVal === 'string' && customRegVal.trim() && !customRegVal.includes('未知')) {
      region = customRegVal.trim();
      regionSource = 'custom';
    } else if (isCachedRegionValid) {
      region = String(cachedRegVal).trim();
      regionSource = 'cached_live';
    }
    const subscriptionRegion = region;
    const subscriptionCountry = region;

    // 3. Subscription acquisition channel and campaign validity
    const customAcqId = effectiveCustom?.acquisitionSource || 'normal_paid';
    const presetAcq = SUBSCRIPTION_ACQUISITION_PRESETS.find(p => p.id === customAcqId) || null;
    const acquisitionSource = customAcqId;
    const acquisitionSourceName = effectiveCustom?.acquisitionSourceName || presetAcq?.name || '正常付费订阅';
    const acquisitionCategory = effectiveCustom?.acquisitionCategory || presetAcq?.category || 'paid';
    const validStartDate = effectiveCustom?.validStartDate || null;
    const validEndDate = effectiveCustom?.validEndDate || null;

    let isExpired = false;
    if (validEndDate && /^\d{4}-\d{2}-\d{2}$/.test(String(validEndDate))) {
      const today = new Date().toISOString().slice(0, 10);
      if (String(validEndDate) < today) {
        isExpired = true;
      }
    }

    // 4. Subscription currency (subscriptionCurrency / currency), price mode, and actual paid price resolution
    // Explicitly distinguish two price modes:
    // 'preset': follow subscription country reference price (dynamically derive reference price & currency by selected country, without fixing user-paid amount)
    // 'custom': custom actual paid amount (respect user-entered amount including 0, not overwritten when switching country)
    let priceMode = effectiveCustom?.priceMode;
    if (priceMode !== 'preset' && priceMode !== 'custom') {
      const hasCustomPaid = Boolean(effectiveCustom && (effectiveCustom.isZeroExtraCost || (effectiveCustom.actualPricePaid !== null && effectiveCustom.actualPricePaid !== undefined && effectiveCustom.actualPricePaid !== '')));
      if (effectiveCustom?.priceSource === 'preset_region') {
        priceMode = 'preset';
      } else if (hasCustomPaid && (effectiveCustom?.priceSource === 'custom' || !findRegionPreset(region) || effectiveCustom?.actualPricePaid !== findRegionPreset(region)?.monthlyPrice)) {
        priceMode = 'custom';
      } else {
        priceMode = 'preset';
      }
    }

    let actualPricePaid = null;
    let officialPriceMonthly = rawLive?.officialPriceMonthly ?? cachedLive?.officialPriceMonthly ?? null;
    const matchedRegionPreset = findRegionPreset(region);
    let rawCur = (effectiveCustom?.subscriptionCurrency || effectiveCustom?.currency) ? String(effectiveCustom.subscriptionCurrency || effectiveCustom.currency).trim().toUpperCase() : '';
    if (rawCur === 'NTD') rawCur = 'TWD';
    const isValidCustomCurrency = Boolean(rawCur && (CURRENCY_SYMBOLS[rawCur] || SUBSCRIPTION_REGIONS_PRESET.some(p => p.currency === rawCur)));
    // Explicitly locked currency: declared custom source, currency specified in custom mode, or currency explicitly passed differing from current region preset
    const isManualCurrency = isValidCustomCurrency && (
      effectiveCustom?.currencySource === 'custom' ||
      priceMode === 'custom' ||
      (matchedRegionPreset && rawCur !== matchedRegionPreset.currency && effectiveCustom?.currencySource !== 'preset_region')
    );

    let currency = 'USD';
    let currencySource = 'default';
    if (isManualCurrency) {
      currency = rawCur;
      currencySource = 'custom';
    } else if (matchedRegionPreset) {
      currency = matchedRegionPreset.currency;
      currencySource = 'preset_region';
    } else if (rawLive?.currency) {
      currency = rawLive.currency;
      currencySource = 'live';
    } else if (isValidCustomCurrency) {
      currency = rawCur;
      currencySource = 'custom';
    } else {
      currency = 'USD';
      currencySource = 'default';
    }
    if (currency === 'NTD') currency = 'TWD';
    if (!CURRENCY_SYMBOLS[currency]) currency = matchedRegionPreset?.currency || 'USD';

    const matchedCurrencyPreset = SUBSCRIPTION_REGIONS_PRESET.find(p => p.currency === currency);
    const curSymbol = CURRENCY_SYMBOLS[currency]
      || (matchedRegionPreset && matchedRegionPreset.currency === currency ? matchedRegionPreset.symbol : null)
      || (matchedCurrencyPreset ? matchedCurrencyPreset.symbol : null)
      || (currency + ' ');
    let billingCycle = '未知';
    let priceRangeNote = '未知';
    let isPriceEstimated = true;
    let priceSource = 'unknown';

    const isLivePaidValid = rawLive && rawLive.priceSource !== 'custom' && rawLive.priceSource !== 'preset_region' && rawLive.actualPricePaid !== null && rawLive.actualPricePaid !== undefined && Number.isFinite(Number(rawLive.actualPricePaid)) && Number(rawLive.actualPricePaid) >= 0;

    if (isLivePaidValid) {
      priceMode = 'live';
      actualPricePaid = Number(rawLive.actualPricePaid);
      isPriceEstimated = false;
      priceSource = 'live';
      billingCycle = rawLive.billingCycle || '月付';
      priceRangeNote = `${acquisitionSourceName} · 实际结算 ${curSymbol}${actualPricePaid} · ${billingCycle}`;
    } else if (priceMode === 'custom') {
      const isCustomZeroConfirmed = Boolean(effectiveCustom && (effectiveCustom.isZeroExtraCost || effectiveCustom.actualPricePaid === 0 || effectiveCustom.actualPricePaid === '0'));
      const isCustomPaidValid = Boolean(effectiveCustom && effectiveCustom.actualPricePaid !== null && effectiveCustom.actualPricePaid !== undefined && effectiveCustom.actualPricePaid !== '' && Number.isFinite(Number(effectiveCustom.actualPricePaid)) && Number(effectiveCustom.actualPricePaid) >= 0);

      if (isCustomZeroConfirmed) {
        actualPricePaid = 0;
        isPriceEstimated = false;
        priceSource = 'custom';
        billingCycle = effectiveCustom?.billingCycle || '随套餐赠送/免费';
        priceRangeNote = isExpired
          ? `${acquisitionSourceName} · 权益已到期`
          : `${acquisitionSourceName} · 订阅额外实付 ${curSymbol}0 · 用户确认`;
      } else if (isCustomPaidValid) {
        actualPricePaid = Number(effectiveCustom.actualPricePaid);
        isPriceEstimated = false;
        priceSource = 'custom';
        billingCycle = effectiveCustom.billingCycle || '月付';
        priceRangeNote = isExpired
          ? `${acquisitionSourceName} · 权益已到期`
          : `${acquisitionSourceName} · 用户实付 ${curSymbol}${actualPricePaid} · ${billingCycle}`;
      } else {
        actualPricePaid = null;
        isPriceEstimated = false;
        priceSource = 'custom';
        billingCycle = effectiveCustom?.billingCycle || '月付';
        priceRangeNote = `${acquisitionSourceName} · 待设置实付金额`;
      }
    } else {
      // priceMode === 'preset' (follow subscription country reference price: apply regional reference table only to single-standard-price plans like Pro; Pro $19.99 reference does not apply to Ultra, etc.)
      priceMode = 'preset';
      const isUltraTier = tierKey === 'ultra';
      if (matchedRegionPreset && !isUltraTier) {
        actualPricePaid = Number(matchedRegionPreset.monthlyPrice);
        isPriceEstimated = true;
        priceSource = 'preset_region';
        billingCycle = effectiveCustom?.billingCycle || '月付';
        priceRangeNote = `${acquisitionSourceName} · 地区参考价 ${curSymbol}${actualPricePaid} · ${billingCycle}`;
      } else if (officialPriceMonthly !== null) {
        actualPricePaid = null;
        priceSource = 'official_reference';
        billingCycle = '月付 · 公开参考';
        priceRangeNote = `${acquisitionSourceName} · 公开参考价 $${officialPriceMonthly}/月`;
      } else {
        actualPricePaid = null;
        isPriceEstimated = false;
        priceSource = 'unknown';
        billingCycle = isUltraTier ? (effectiveCustom?.billingCycle || '月付') : '未知';
        priceRangeNote = isUltraTier
          ? `${acquisitionSourceName} · Google AI Ultra 待设置实付月费`
          : `${acquisitionSourceName} · 待设置订阅国家与价格`;
      }
    }

    // 5. User custom notes (display only, excluded from calculations)
    const customNote = effectiveCustom?.customNote ? String(effectiveCustom.customNote).trim() : null;

    // 6. Quota pool
    const promptCredits = rawLive?.promptCredits || cachedLive?.promptCredits || null;
    const flowCredits = rawLive?.flowCredits || cachedLive?.flowCredits || null;

    // Auto-convert to CNY based on region and currency
    const rateRegion = (matchedRegionPreset && matchedRegionPreset.currency === currency) ? region : null;
    const effectiveRate = (matchedRegionPreset && matchedRegionPreset.currency === currency)
      ? matchedRegionPreset.rateToCNY
      : (matchedCurrencyPreset ? matchedCurrencyPreset.rateToCNY : (currency === 'USD' ? 6.72 : (currency === 'HKD' ? 0.857 : (currency === 'JPY' ? 0.0425 : (currency === 'CNY' ? 1.0 : null)))));
    const actualPricePaidCNY = actualPricePaid !== null ? convertToCNY(actualPricePaid, currency, rateRegion) : null;
    const actualPricePaidUSD = actualPricePaid !== null ? convertCurrency(actualPricePaid, currency, 'USD', rateRegion) : null;
    const cnyFormatted = actualPricePaidCNY !== null ? (currency === 'CNY' ? ('¥' + actualPricePaidCNY) : ('折合 ≈ ¥' + actualPricePaidCNY.toFixed(1) + ' CNY')) : null;

    if (actualPricePaidCNY !== null && actualPricePaid > 0 && currency !== 'CNY') {
      priceRangeNote += ' (' + cnyFormatted + ')';
    }

    return {
      status,
      tierKey,
      tierName,
      tierId,
      teamsTier,
      planName,
      email: currentEmail,
      accountRegion: country,
      country,
      countrySource,
      subscriptionCountry: region,
      subscriptionRegion,
      region,
      regionSource,
      regionPreset: matchedRegionPreset,
      subscriptionCurrency: currency,
      currency,
      currencySource,
      currencySymbol: curSymbol,
      actualPricePaidUSD,
      actualPricePaidCNY,
      cnyFormatted,
      exchangeRateToCNY: effectiveRate,
      billingCycle,
      acquisitionSource,
      acquisitionSourceName,
      acquisitionCategory,
      isZeroExtraCost: actualPricePaid === 0,
      validStartDate,
      validEndDate,
      isExpired,
      officialPriceMonthly,
      priceRangeNote,
      priceMode,
      actualPricePaid,
      isPriceEstimated,
      priceSource,
      customNote,
      promptCredits,
      flowCredits,
      sources: {
        tier: tierSource,
        country: countrySource,
        region: regionSource,
        currency: currencySource,
        price: priceSource,
        acquisition: effectiveCustom?.acquisitionSource ? 'custom' : 'default'
      },
      hasCustomSettings: Boolean(effectiveCustom && (effectiveCustom.country || effectiveCustom.region || effectiveCustom.subscriptionRegion || effectiveCustom.currency || effectiveCustom.actualPricePaid !== undefined || effectiveCustom.customNote || effectiveCustom.acquisitionSource)),
      pricingTableVerifiedDate: '2026-11-09',
      updatedAt: rawLive?.updatedAt || new Date().toISOString()
    };
  }

  function normalizeTokenHistoryPayload(payload, options = {}) {
    if (!payload || typeof payload !== 'object') return null;
    const source = options.source || 'all';
    const pricingDate = options.pricingDate || '2026-11-09';
    const modelId = options.modelId || 'gemini-3.8-flash';

    const dailyMapBySource = payload.dailyMapBySource && typeof payload.dailyMapBySource === 'object'
      ? payload.dailyMapBySource
      : { all: payload.dailyMap || {}, desktop: {}, cli: {} };

    const targetMap = dailyMapBySource[source] || dailyMapBySource.all || payload.dailyMap || {};
    const normalizedMap = {};
    for (const [k, rec] of Object.entries(targetMap)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !rec) continue;
      normalizedMap[k] = {
        total: Number(rec.total) || 0,
        input: Number(rec.input) || 0,
        output: Number(rec.output) || 0,
        cache: Number(rec.cache) || 0,
        steps: Number(rec.steps) || 0
      };
    }

    const todayStr = options.todayStr || (new Date()).toISOString().slice(0, 10);
    const currentMonthPrefix = todayStr.slice(0, 7);
    const currentYearPrefix = todayStr.slice(0, 4);

    let grandTotalTokens = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCacheTokens = 0;
    let todayTokens = 0;
    let monthTokens = 0;
    let yearTokens = 0;
    let currentMonthInput = 0;
    let currentMonthOutput = 0;
    let currentMonthCache = 0;
    let activeDaysCount = 0;

    for (const [k, rec] of Object.entries(normalizedMap)) {
      if (rec.total > 0) activeDaysCount++;
      grandTotalTokens += rec.total;
      totalInputTokens += rec.input;
      totalOutputTokens += rec.output;
      totalCacheTokens += rec.cache;

      if (k === todayStr) todayTokens += rec.total;
      if (k.startsWith(currentMonthPrefix)) {
        monthTokens += rec.total;
        currentMonthInput += rec.input;
        currentMonthOutput += rec.output;
        currentMonthCache += rec.cache;
      }
      if (k.startsWith(currentYearPrefix)) {
        yearTokens += rec.total;
      }
    }

    const rawSum = payload.summary || {};
    const isScopedAccountView = Boolean(options.scopedAccountView || payload.scopedAccountView);
    if (source === 'all' && !isScopedAccountView) {
      if (Number(rawSum.totalInputTokens) > totalInputTokens) totalInputTokens = Number(rawSum.totalInputTokens);
      if (Number(rawSum.totalOutputTokens) > totalOutputTokens) totalOutputTokens = Number(rawSum.totalOutputTokens);
      if (Number(rawSum.totalCacheTokens) > totalCacheTokens) totalCacheTokens = Number(rawSum.totalCacheTokens);
      if (Number(rawSum.grandTotalTokens) > grandTotalTokens) grandTotalTokens = Number(rawSum.grandTotalTokens);
      if (Number(rawSum.currentMonthInput) > currentMonthInput) currentMonthInput = Number(rawSum.currentMonthInput);
      if (Number(rawSum.currentMonthOutput) > currentMonthOutput) currentMonthOutput = Number(rawSum.currentMonthOutput);
      if (Number(rawSum.currentMonthCache) > currentMonthCache) currentMonthCache = Number(rawSum.currentMonthCache);
      if (Number(rawSum.monthTokens) > monthTokens) monthTokens = Number(rawSum.monthTokens);
    }

    const refMonth = payload.referenceCost?.currentMonth;
    const refAll = payload.referenceCost?.all;
    if (refMonth && !isScopedAccountView) {
      if (refMonth.inputTokens && !currentMonthInput) currentMonthInput = Number(refMonth.inputTokens);
      if (refMonth.cacheTokens && !currentMonthCache) currentMonthCache = Number(refMonth.cacheTokens);
      if (refMonth.outputTokens && !currentMonthOutput) currentMonthOutput = Number(refMonth.outputTokens);
      if (refMonth.totalTokens && !monthTokens) monthTokens = Number(refMonth.totalTokens);
      else if (!monthTokens && (currentMonthInput || currentMonthOutput || currentMonthCache)) {
        monthTokens = currentMonthInput + currentMonthOutput + currentMonthCache;
      }
    }
    if (refAll && !isScopedAccountView) {
      if (refAll.inputTokens && !totalInputTokens) totalInputTokens = Number(refAll.inputTokens);
      if (refAll.cacheTokens && !totalCacheTokens) totalCacheTokens = Number(refAll.cacheTokens);
      if (refAll.outputTokens && !totalOutputTokens) totalOutputTokens = Number(refAll.outputTokens);
      if (refAll.totalTokens && !grandTotalTokens) grandTotalTokens = Number(refAll.totalTokens);
      else if (!grandTotalTokens && (totalInputTokens || totalOutputTokens || totalCacheTokens)) {
        grandTotalTokens = totalInputTokens + totalOutputTokens + totalCacheTokens;
      }
    }

    const allCacheStats = summarizeDailyMapCacheStats(normalizedMap);
    const monthCacheStats = summarizeDailyMapCacheStats(normalizedMap, currentMonthPrefix);
    const cacheReadStatsBySource = (payload.cacheReadStatsBySource && typeof payload.cacheReadStatsBySource === 'object')
      ? payload.cacheReadStatsBySource
      : {
          all: summarizeDailyMapCacheStats(dailyMapBySource.all || normalizedMap),
          desktop: summarizeDailyMapCacheStats(dailyMapBySource.desktop || {}),
          cli: summarizeDailyMapCacheStats(dailyMapBySource.cli || {})
        };

    const rawConvs = Object.prototype.hasOwnProperty.call(rawSum, 'totalConversations')
      ? Number(rawSum.totalConversations)
      : null;
    const activeKeysSorted = Object.keys(normalizedMap)
      .filter(k => normalizedMap[k] && normalizedMap[k].total > 0)
      .sort();
    const computedFirstUseDate = activeKeysSorted.length > 0 ? activeKeysSorted[0] : null;
    const declaredFirstUseDate = Object.prototype.hasOwnProperty.call(payload, 'firstUseDate')
      ? (payload.firstUseDate || null)
      : (rawSum.firstUseDate || null);
    // When switching accounts or data sources, firstRecordDate must strictly converge to the true valid date of the current filter scope
    const effectiveFirstUseDate = (isScopedAccountView || source !== 'all')
      ? computedFirstUseDate
      : (declaredFirstUseDate && computedFirstUseDate
        ? (computedFirstUseDate < declaredFirstUseDate ? computedFirstUseDate : declaredFirstUseDate)
        : (declaredFirstUseDate || computedFirstUseDate || null));
    const effectiveConversations = (source !== 'all' && grandTotalTokens === 0 && activeDaysCount === 0)
      ? 0
      : ((rawConvs !== null && Number.isFinite(rawConvs)) ? rawConvs : activeDaysCount);
    const summary = {
      grandTotalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalCacheTokens,
      todayTokens,
      monthTokens,
      yearTokens,
      currentMonthInput,
      currentMonthOutput,
      currentMonthCache,
      activeDaysCount,
      totalConversations: effectiveConversations,
      firstUseDate: effectiveFirstUseDate,
      cacheReadStats: allCacheStats,
      currentMonthCacheReadStats: monthCacheStats
    };

    let referenceCost = payload.referenceCost;
    if (!referenceCost || !referenceCost.all || !referenceCost.currentMonth) {
      const calcRefAll = calculateReferenceModelCost({
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        cacheTokens: totalCacheTokens,
        totalTokens: grandTotalTokens
      }, modelId, { pricingDate, mode: 'all' });

      const calcRefMonth = calculateReferenceModelCost({
        inputTokens: currentMonthInput,
        outputTokens: currentMonthOutput,
        cacheTokens: currentMonthCache,
        totalTokens: monthTokens
      }, modelId, { pricingDate, mode: 'all' });

      referenceCost = {
        all: calcRefAll,
        currentMonth: calcRefMonth,
        hybrid: referenceCost?.hybrid || calcRefAll,
        currentMonthHybrid: referenceCost?.currentMonthHybrid || calcRefMonth
      };
    }

    const dailyModelMapBySource = payload.dailyModelMapBySource && typeof payload.dailyModelMapBySource === 'object'
      ? payload.dailyModelMapBySource
      : null;
    const dailyModelMap = dailyModelMapBySource
      ? (dailyModelMapBySource[source] || dailyModelMapBySource.all || {})
      : (payload.dailyModelMap || {});
    const hourlyModelMapBySource = payload.hourlyModelMapBySource && typeof payload.hourlyModelMapBySource === 'object'
      ? payload.hourlyModelMapBySource
      : null;
    const hourlyModelMap = hourlyModelMapBySource
      ? (hourlyModelMapBySource[source] || hourlyModelMapBySource.all || {})
      : (payload.hourlyModelMap || {});

    return {
      schemaVersion: payload.schemaVersion || '0.8.8',
      version: payload.version || '0.8.8',
      updatedAt: payload.updatedAt || '',
      firstUseDate: summary.firstUseDate,
      currentPeriod: payload.currentPeriod || {
        key: currentMonthPrefix,
        periodType: 'calendar_month',
        label: currentMonthPrefix,
        isCurrentMonth: true
      },
      planStatus: payload.planStatus || null,
      rawPlanStatus: payload.rawPlanStatus || payload.planStatus || null,
      customPlanSettings: payload.customPlanSettings || null,
      costEstimate: payload.costEstimate || null,
      costEstimateCurrentMonth: payload.costEstimateCurrentMonth || null,
      costEstimateBySource: payload.costEstimateBySource || null,
      referenceCost,
      summary,
      cacheReadStatsBySource,
      dailyMap: normalizedMap,
      dailyMapBySource,
      dailyModelMap,
      dailyModelMapBySource,
      hourlyModelMap,
      hourlyModelMapBySource,
      modelMetaByKey: payload.modelMetaByKey || null
    };
  }

  /**
   * Map token usage to heatmap 5-level color scale (0..4) by period granularity
   * @param {number} value - Current token usage
   * @param {'day'|'week'|'month'} [kind='day'] - Aggregation period
   * @param {number} [maxInWindow=0] - Window maximum (used for relative quantile calculation in week/month mode)
   * @returns {number} Level index in 0..4
   *
   * Quantile strategy:
   * - day: uses absolute daily thresholds (0, <3M, <15M, <60M, >=60M) to preserve fine-grained daily usage perception.
   * - week / month: uses relative quantiles against window max (0: 0, <=25%: 1, <=50%: 2, <=75%: 3, >75%: 4)
   *   to compare cross-period usage adaptively without saturating all cells at peak level under daily thresholds.
   */