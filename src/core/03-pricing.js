  function calculateRequestApiCost(req) {
    if (!req) return { costUSD: null, isPriced: false, reason: '缺失请求数据' };
    const rawModel = extractModelString(req);
    const modelKey = normalizeModelId(rawModel);
    if (!modelKey || !GEMINI_PRICING_TABLE[modelKey]) {
      return { costUSD: null, isPriced: false, modelKey: null, rawModel, reason: !rawModel ? '缺模型名称' : '未知模型或无官方公开费率' };
    }
    const input = Number(req.inputTokens ?? req.input_tokens ?? req.input ?? 0);
    const cache = Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? req.cached ?? 0);
    const output = Number(req.outputTokens ?? req.output_tokens ?? req.output ?? 0);
    const thinking = Number(req.thinkingTokens ?? req.thinking_output_tokens ?? req.thinking ?? 0);
    const totalPrompt = input + cache;

    const reqDate = (() => {
      let d = '2026-11-08';
      const hasExplicitDate = req.date && /^\d{4}-\d{2}-\d{2}/.test(String(req.date));
      const isProv = req.dateIsProvisional === true || req.dateSource === 'provisional';
      if (!isProv && req.created_at && (!hasExplicitDate || !req.dateSource || req.dateSource === 'created_at')) {
        const dt = new Date(req.created_at);
        if (!Number.isNaN(dt.getTime())) {
          d = formatLocalDateStr(dt);
        } else if (hasExplicitDate) {
          d = String(req.date).slice(0, 10);
        }
      } else if (hasExplicitDate) {
        d = String(req.date).slice(0, 10);
      } else if (req.created_at) {
        const dt = new Date(req.created_at);
        d = !Number.isNaN(dt.getTime()) ? formatLocalDateStr(dt) : String(req.created_at).slice(0, 10);
      }
      return d;
    })();
    const tierRules = GEMINI_PRICING_TABLE[modelKey];
    let matchedTier = null;

    for (const rule of tierRules) {
      if (rule.effectiveTo && reqDate > rule.effectiveTo) continue;
      if (rule.effectiveFrom && reqDate < rule.effectiveFrom) continue;
      if (rule.maxPromptTokens && totalPrompt > rule.maxPromptTokens) continue;
      if (rule.minPromptTokens && totalPrompt < rule.minPromptTokens) continue;
      matchedTier = rule;
      break;
    }

    if (!matchedTier) {
      matchedTier = tierRules[0];
    }

    const costInput = (input * matchedTier.inputPerMillion) / 1000000;
    const costCache = (cache * matchedTier.cacheReadPerMillion) / 1000000;
    const costOutput = (output * matchedTier.outputPerMillion) / 1000000;
    const totalCost = costInput + costCache + costOutput;
    const cacheSavingsUSD = Math.max(0, ((cache * matchedTier.inputPerMillion) / 1000000) - costCache);

    return {
      costUSD: Number(totalCost.toFixed(6)),
      costInputUSD: Number(costInput.toFixed(6)),
      costCacheUSD: Number(costCache.toFixed(6)),
      cacheSavingsUSD: Number(cacheSavingsUSD.toFixed(6)),
      isPriced: true,
      modelKey,
      matchedTier,
      inputTokens: input,
      cacheTokens: cache,
      cacheReadTokens: cache,
      outputTokens: output,
      thinkingTokens: thinking,
      totalTokens: input + cache + output
    };
  }

  function summarizeApiCost(requests = [], extraUnpricedCount = 0, extraUnpricedReasons = {}, extraUnpricedTokens = 0) {
    let pricedCostUSD = 0;
    let pricedInputCostUSD = 0;
    let cacheSavingsUSD = 0;
    let pricedTokens = 0;
    let pricedInputTokens = 0;
    let pricedCacheTokens = 0;
    let pricedOutputTokens = 0;
    let pricedThinkingTokens = 0;
    let unpricedTokens = Number(extraUnpricedTokens) || 0;
    let pricedRequestsCount = 0;
    let unpricedRequestsCount = Number(extraUnpricedCount) || 0;
    const unpricedReasons = {
      missingModel: Number(extraUnpricedReasons.missingModel || 0),
      unsupportedModel: Number(extraUnpricedReasons.unsupportedModel || 0),
      missingUsage: Number(extraUnpricedReasons.missingUsage || 0)
    };
    const byModel = {};

    for (const req of requests) {
      const calc = calculateRequestApiCost(req);
      if (calc.isPriced) {
        pricedCostUSD += calc.costUSD;
        pricedInputCostUSD += (calc.costInputUSD || 0) + (calc.costCacheUSD || 0);
        cacheSavingsUSD += (calc.cacheSavingsUSD || 0);
        pricedTokens += calc.totalTokens;
        pricedInputTokens += (calc.inputTokens || 0);
        pricedCacheTokens += (calc.cacheTokens || 0);
        pricedOutputTokens += (calc.outputTokens || 0);
        pricedThinkingTokens += (calc.thinkingTokens || 0);
        pricedRequestsCount += 1;
        if (!byModel[calc.modelKey]) {
          byModel[calc.modelKey] = { requests: 0, costUSD: 0, tokens: 0 };
        }
        byModel[calc.modelKey].requests += 1;
        byModel[calc.modelKey].costUSD = Number((byModel[calc.modelKey].costUSD + calc.costUSD).toFixed(6));
        byModel[calc.modelKey].tokens += calc.totalTokens;
      } else {
        unpricedRequestsCount += 1;
        const inp = Number(req.inputTokens ?? req.input_tokens ?? req.input ?? 0);
        const cap = Number(req.cacheTokens ?? req.cacheReadTokens ?? req.cache_read_tokens ?? req.cached ?? 0);
        const outp = Number(req.outputTokens ?? req.output_tokens ?? req.output ?? 0);
        const tot = inp + cap + outp;
        unpricedTokens += tot;
        const rawM = extractModelString(req);
        if (!rawM) unpricedReasons.missingModel += 1;
        else if (tot === 0) unpricedReasons.missingUsage += 1;
        else unpricedReasons.unsupportedModel += 1;
      }
    }

    const totalRequests = pricedRequestsCount + unpricedRequestsCount;
    const totalTok = pricedTokens + unpricedTokens;
    let coveragePercent = null;
    let tokenCoveragePercent = null;
    let requestCoveragePercent = null;
    let isPartialCoverage = false;

    if (totalRequests > 0 || unpricedTokens > 0) {
      if (totalRequests > 0) {
        requestCoveragePercent = Number(((pricedRequestsCount / totalRequests) * 100).toFixed(1));
      }
      if (totalTok > 0) {
        tokenCoveragePercent = Number(((pricedTokens / totalTok) * 100).toFixed(1));
      }
      if (pricedRequestsCount === 0) {
        coveragePercent = 0;
      } else if (unpricedRequestsCount > 0 || unpricedTokens > 0) {
        isPartialCoverage = true;
        // 当存在未计价历史记录或未知 token 未计时，不能虚假呈现 100% 覆盖
        if (unpricedTokens === 0) {
          coveragePercent = requestCoveragePercent;
        } else {
          const baseReqCov = requestCoveragePercent ?? 100;
          coveragePercent = Math.min(tokenCoveragePercent ?? baseReqCov, baseReqCov);
        }
        if (coveragePercent >= 100) coveragePercent = 99.9;
      } else {
        coveragePercent = 100;
      }
    }

    const totalPromptTokens = pricedInputTokens + pricedCacheTokens;
    const effectiveInputPerMillion = totalPromptTokens > 0
      ? Number(((pricedInputCostUSD / totalPromptTokens) * 1000000).toFixed(4))
      : null;

    return {
      pricedCostUSD: Number((Math.round((pricedCostUSD + Number.EPSILON) * 10000) / 10000).toFixed(4)),
      cacheSavingsUSD: Number((Math.round((cacheSavingsUSD + Number.EPSILON) * 10000) / 10000).toFixed(4)),
      effectiveInputPerMillion,
      pricedRequestsCount,
      unpricedRequestsCount,
      pricedTokens,
      unpricedTokens,
      byCategory: {
        inputTokens: pricedInputTokens,
        cacheTokens: pricedCacheTokens,
        outputTokens: pricedOutputTokens,
        thinkingTokens: pricedThinkingTokens
      },
      coveragePercent,
      tokenCoveragePercent,
      requestCoveragePercent,
      isPartialCoverage,
      unpricedReasons,
      byModel
    };
  }

  function extractCallId(row, cascadeId = null, fallbackStepIndex = null) {
    if (!row || typeof row !== 'object') return '';
    const u = row.chatModel?.usage || row.usage || {};
    const explicit =
      u.responseId ||
      u.response_id ||
      row.response_id ||
      row.responseId ||
      u.messageId ||
      u.message_id ||
      row.message_id ||
      row.messageId ||
      row.callId ||
      row.call_id ||
      '';
    if (explicit) return String(explicit);
    const stepIdx = row.stepIndices?.[0] ?? row.stepIndex ?? row.step_index ?? fallbackStepIndex;
    if (cascadeId && stepIdx !== null && stepIdx !== undefined) {
      return `${cascadeId}#${stepIdx}`;
    }
    return '';
  }

  function parseGeneratorCall(row, cascadeId = null, source = 'desktop', options = {}) {
    if (!row || typeof row !== 'object') return null;
    const cm = row.chatModel || {};
    const u = cm.usage || {};
    const hasExplicitInput = u.inputTokens !== undefined || row.inputTokens !== undefined || row.input_tokens !== undefined;
    const hasExplicitCache = u.cacheReadTokens !== undefined || row.cacheTokens !== undefined || row.cacheReadTokens !== undefined || row.cache_read_tokens !== undefined;
    const hasExplicitOutput = u.outputTokens !== undefined || row.outputTokens !== undefined || row.output_tokens !== undefined;
    const hasInputCacheFields = Boolean(hasExplicitInput || hasExplicitCache);
    const model = cm.modelDisplayName || cm.responseModel || cm.model || row.model || row.modelId || '';
    const modelKey = normalizeModelId(model);
    const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];
    const modelExactId = resolveStableModelId(row, cascadeConfigs) || resolveStableModelId(model, cascadeConfigs) || null;
    const modelLabelRaw = String(cm.modelDisplayName || row.modelLabel || model || modelExactId || '').trim();
    const productMeta = groupModelProduct({
      modelId: modelExactId || cm.modelId || cm.model || row.modelId,
      label: modelLabelRaw,
      effort: cm.effort || row.effort
    });

    const input = hasExplicitInput ? (Number(u.inputTokens ?? row.inputTokens ?? row.input_tokens) || 0) : 0;
    const cached = hasExplicitCache ? (Number(u.cacheReadTokens ?? row.cacheTokens ?? row.cacheReadTokens ?? row.cache_read_tokens) || 0) : 0;
    const output = hasExplicitOutput ? (Number(u.outputTokens ?? row.outputTokens ?? row.output_tokens) || 0) : 0;
    const thinking = Number(u.thinkingOutputTokens ?? row.thinkingTokens ?? row.thinking_output_tokens ?? 0);
    const responseTokens = Number(u.responseOutputTokens ?? row.responseTokens ?? (output - thinking > 0 ? output - thinking : output));
    const totalTokens = input + cached + output;

    const lastRetry = Array.isArray(cm.retryInfos) && cm.retryInfos.length ? cm.retryInfos[cm.retryInfos.length - 1] : null;
    const rawError = String(lastRetry?.error || cm.error || row.error || '').trim();
    const errorClassification = rawError
      ? classifyRequestError(rawError, {
        currentModel: modelLabelRaw || model,
        cascadeModelConfigs: cascadeConfigs,
        userStatus: options.userStatus || null
      })
      : null;

    const rawStepIdx = row.stepIndices?.[0] ?? row.stepIndex ?? row.step_index;
    const parsedStepIdx = rawStepIdx !== undefined && rawStepIdx !== null && rawStepIdx !== '' ? Number(rawStepIdx) : NaN;
    const stepIndex = Number.isInteger(parsedStepIdx) && parsedStepIdx >= 0 ? parsedStepIdx : null;

    const callId = extractCallId(row, cascadeId, stepIndex ?? 0);
    if (!callId) return null;

    // 完成状态管理：依据完成标记或耗时证据判定 final，流式中或只有部分文本时判定 streaming
    const hasExplicitFinish = Boolean(
      row.status === 'final' ||
      row.status === 'completed' ||
      cm.finishReason ||
      row.finishReason ||
      row.done === true ||
      (cm.streamingDuration != null && cm.timeToFirstToken != null)
    );
    const hasUsage = totalTokens > 0;
    const status = hasExplicitFinish || (hasUsage && !row.isStreaming && row.status !== 'streaming') ? 'final' : 'streaming';
    const isEstimated = !hasUsage || output === 0;

    // 日期与时间戳：优先按真实创建时间转为本地日历日；RPC 缺失时间时显式标记 provisional 以便后续被权威时间校准覆盖
    let callDate = null;
    let callTimestamp = null;
    let dateSource = null;
    let dateIsProvisional = false;
    const rawCreatedAt = row.created_at || row.createdAt || row.timestamp;
    if (rawCreatedAt) {
      const dt = new Date(rawCreatedAt);
      if (!Number.isNaN(dt.getTime())) {
        callDate = formatLocalDateStr(dt);
        callTimestamp = dt.getTime();
        dateSource = 'created_at';
      }
    } else if (row.date && /^\d{4}-\d{2}-\d{2}/.test(String(row.date))) {
      callDate = String(row.date).slice(0, 10);
      callTimestamp = new Date(callDate).getTime();
      dateIsProvisional = Boolean(row.dateIsProvisional || row.dateSource === 'provisional');
      dateSource = dateIsProvisional ? 'provisional' : (row.dateSource || 'explicit_date');
    } else if (source === 'desktop' && typeof window !== 'undefined') {
      callTimestamp = Date.now();
      callDate = formatLocalDateStr(new Date(callTimestamp));
      dateSource = 'provisional';
      dateIsProvisional = true;
    } else {
      dateIsProvisional = true;
    }

    let sourceRevision = null;
    const rawRev = row.sourceRevision ?? row.revision ?? row.metadataRevision;
    if (rawRev !== undefined && rawRev !== null && rawRev !== '') {
      const revNum = Number(rawRev);
      if (Number.isFinite(revNum)) sourceRevision = revNum;
    } else {
      const rawUpdated = row.updated_at ?? row.sourceUpdatedAt;
      if (rawUpdated !== undefined && rawUpdated !== null && rawUpdated !== '') {
        const updTs = typeof rawUpdated === 'number' ? rawUpdated : Date.parse(String(rawUpdated));
        if (Number.isFinite(updTs)) sourceRevision = updTs;
      }
    }

    const reqObj = {
      model,
      inputTokens: input,
      cacheTokens: cached,
      cacheReadTokens: cached,
      outputTokens: output,
      thinkingTokens: thinking,
      date: callDate,
      ...(dateSource ? { dateSource } : {}),
      dateIsProvisional
    };
    const costCalc = calculateRequestApiCost(reqObj);

    // 解析实测速度字段（绝不补零或估算缺失速度）
    const ttftSecRaw = parseDurationSec(cm.timeToFirstToken) ?? (row.ttftSec !== undefined && row.ttftSec !== null && Number.isFinite(Number(row.ttftSec)) && Number(row.ttftSec) >= 0 ? Number(row.ttftSec) : null);
    const streamingSecRaw = parseDurationSec(cm.streamingDuration) ?? (row.streamingSec !== undefined && row.streamingSec !== null && Number.isFinite(Number(row.streamingSec)) && Number(row.streamingSec) >= 0 ? Number(row.streamingSec) : null);
    let durationSecRaw = null;
    if (ttftSecRaw !== null && streamingSecRaw !== null) {
      durationSecRaw = ttftSecRaw + streamingSecRaw;
    } else if (ttftSecRaw !== null || streamingSecRaw !== null) {
      durationSecRaw = ttftSecRaw ?? streamingSecRaw;
    } else if (row.durationSec !== undefined && row.durationSec !== null && Number.isFinite(Number(row.durationSec)) && Number(row.durationSec) > 0) {
      durationSecRaw = Number(row.durationSec);
    }

    const speedFields = {};
    if (status === 'final' && !isEstimated && output > 0 && durationSecRaw !== null && durationSecRaw > 0) {
      if (ttftSecRaw !== null) speedFields.ttftSec = Number(ttftSecRaw.toFixed(2));
      if (streamingSecRaw !== null) speedFields.streamingSec = Number(streamingSecRaw.toFixed(2));
      speedFields.durationSec = Number(durationSecRaw.toFixed(2));
      speedFields.tps = (row.tps !== undefined && row.tps !== null && Number.isFinite(Number(row.tps)) && Number(row.tps) > 0)
        ? Number(Number(row.tps).toFixed(1))
        : Number((output / durationSecRaw).toFixed(1));
      if (streamingSecRaw !== null && streamingSecRaw > 0.05) {
        speedFields.streamingTps = Number((output / streamingSecRaw).toFixed(1));
      }
      speedFields.origin = row.origin === 'speed-test' ? 'speed-test' : 'chat';
    } else {
      if (ttftSecRaw !== null && ttftSecRaw >= 0) speedFields.ttftSec = Number(ttftSecRaw.toFixed(2));
      if (streamingSecRaw !== null && streamingSecRaw >= 0) speedFields.streamingSec = Number(streamingSecRaw.toFixed(2));
      if (durationSecRaw !== null && durationSecRaw > 0) speedFields.durationSec = Number(durationSecRaw.toFixed(2));
    }

    let outcomeStatus = status === 'streaming' ? 'streaming' : 'success';
    if (rawError) {
      outcomeStatus = (errorClassification && errorClassification.kind && errorClassification.kind !== 'none')
        ? errorClassification.kind
        : 'failed';
      if (outcomeStatus === 'context_overflow') outcomeStatus = 'exceeded';
      else if (outcomeStatus === 'network_error') outcomeStatus = 'network';
      else if (outcomeStatus === 'unknown') outcomeStatus = 'failed';
    }

    const callRecord = {
      callId,
      source,
      cascadeId,
      stepIndex,
      model,
      modelKey,
      modelExactId: modelExactId || undefined,
      modelLabel: (modelLabelRaw && modelLabelRaw !== model) ? modelLabelRaw : undefined,
      effort: productMeta.effort || undefined,
      inputTokens: input,
      cacheTokens: cached,
      cacheReadTokens: cached,
      outputTokens: output,
      thinkingTokens: thinking,
      responseTokens,
      totalTokens,
      hasInputCacheFields,
      status,
      outcomeStatus,
      ...(rawError ? { error: rawError, errorClassification } : {}),
      isEstimated,
      isPriced: costCalc.isPriced,
      costUSD: costCalc.costUSD ?? 0,
      date: callDate,
      ...(dateSource ? { dateSource } : {}),
      dateIsProvisional,
      created_at: rawCreatedAt ? String(rawCreatedAt) : null,
      timestamp: callTimestamp,
      ...(sourceRevision !== null ? { sourceRevision } : {}),
      ...speedFields
    };
    return callRecord;
  }
