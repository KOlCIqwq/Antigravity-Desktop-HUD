'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const core = require('../../core');
const {
  MAX_BROWSER_TEXT_LEN, MAX_CMD_OUTPUT_LEN, MAX_SCHEMA_TEXT_LEN,
  boundText, unwrapQuotedArg, normalizeFilePath, basenameOf, parseTimestampMs,
  parseStepTimestampMs, computeStepDurationMs, parseDurationMs, extractPrimaryProgram,
  safeJsonParse, inferToolSource, parseStepToolInfo, countDiffLines, extractMediaFromStep,
  mapTokenGroupBucket, extractContextWindowBuckets, extractChatMessageTokenMap, isSkillFilePath,
  extractCleanSessionTitle, extractWorkspaceDisplay, summarizeStepBriefText
} = require('./helpers');
const DEEP_DIVE_CACHE_TTL_MS = 5000;
const deepDiveCache = new Map();
function buildSessionDeepDive(trajectory, generatorMetadata = [], options = {}) {
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
  const gmFromTraj = Array.isArray(trajectory?.generatorMetadata) ? trajectory.generatorMetadata : [];
  const gmRpc = Array.isArray(generatorMetadata) ? generatorMetadata : [];
  // Prefer the generatorMetadata array that contains richer fields (systemPrompt / tools / promptSections / tokenBreakdown)
  const scoreGm = (arr) => arr.reduce((acc, g) => {
    const cm = g?.chatModel || {};
    return acc + (cm.systemPrompt ? 4 : 0) + (cm.tools ? 4 : 0) + (cm.promptSections ? 4 : 0) + (cm.chatStartMetadata?.contextWindowMetadata ? 2 : 0) + 1;
  }, 0);
  const gmList = scoreGm(gmRpc) >= scoreGm(gmFromTraj) ? gmRpc : gmFromTraj;

  const cascadeId = String(options.cascadeId || trajectory?.cascadeId || '').trim();
  const cascadeConfigs = Array.isArray(options.cascadeModelConfigs) ? options.cascadeModelConfigs : [];

  // 1. Assign turnIndex to every step & collect per-step base data
  const stepTurnMap = new Array(steps.length).fill(0);
  let currentTurn = 0;
  let userInputsCount = 0;
  let toolCallsCount = 0;
  let totalToolDurationMs = 0;

  // Find latest contextWindowMetadata for official per-step token breakdown
  let latestCwm = null;
  let latestPromptSections = null;
  let latestSystemPrompt = '';
  let latestTools = null;
  for (let i = gmList.length - 1; i >= 0; i--) {
    const cm = gmList[i]?.chatModel;
    if (!cm) continue;
    if (!latestCwm && cm.chatStartMetadata?.contextWindowMetadata) latestCwm = cm.chatStartMetadata.contextWindowMetadata;
    if (!latestPromptSections && Array.isArray(cm.promptSections) && cm.promptSections.length) latestPromptSections = cm.promptSections;
    if (!latestSystemPrompt && typeof cm.systemPrompt === 'string' && cm.systemPrompt) latestSystemPrompt = cm.systemPrompt;
    if (!latestTools && Array.isArray(cm.tools) && cm.tools.length) latestTools = cm.tools;
    if (latestCwm && latestPromptSections && latestSystemPrompt && latestTools) break;
  }
  const officialStepTokens = extractChatMessageTokenMap(latestCwm);

  const fileMap = new Map();
  const ensureFile = (rawPath) => {
    const norm = normalizeFilePath(rawPath);
    if (!norm.display) return null;
    let entry = fileMap.get(norm.key);
    if (!entry) {
      entry = {
        path: norm.display,
        name: basenameOf(norm.display),
        reads: 0,
        writes: 0,
        searches: 0,
        images: 0,
        additions: 0,
        deletions: 0,
        ops: []
      };
      fileMap.set(norm.key, entry);
    }
    return entry;
  };

  const commandExecutions = [];
  const programCountMap = new Map();
  const events = [];
  const fleetChildrenMap = new Map();
  const communications = [];
  const browserSteps = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i] || {};
    if (s.userInput) {
      currentTurn++;
      userInputsCount++;
    }
    stepTurnMap[i] = currentTurn;
    const tsMs = parseStepTimestampMs(s);
    const durMs = computeStepDurationMs(s);
    const { name: toolName, toolCall, parsedArgs } = parseStepToolInfo(s);
    const isToolStep = Boolean(
      toolName ||
      s.runCommand || s.viewFile || s.codeAction || s.grepSearch ||
      s.findByName || s.listDir || s.searchWeb || s.generic
    );
    if (isToolStep) {
      toolCallsCount++;
      if (durMs != null) totalToolDurationMs += durMs;
    }

    const mediaList = extractMediaFromStep(s);
    for (const m of mediaList) {
      if (m.mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(m.uri)) {
        const f = ensureFile(m.uri);
        if (f) {
          f.images++;
          f.ops.push({ kind: 'image', stepIndex: i, turnIndex: currentTurn, timestamp: tsMs, detail: m.mime || 'image' });
        }
      }
    }

    // Classify step for Context Browser + Activity + Events
    let category = 'system';
    let title = s.type ? String(s.type).replace(/^CORTEX_STEP_TYPE_/, '') : 'STEP';
    let text = '';
    let thinking = '';
    let toolCalls = [];
    let argsText = '';
    let resultText = '';
    let truncated = false;
    let status = String(s.status || '').replace(/^CORTEX_STEP_STATUS_/, '').toLowerCase() || 'done';

    if (s.userInput) {
      category = 'user';
      title = 'User Input';
      const raw = s.userInput.userResponse || (s.userInput.items || []).map(x => x.text || '').join('\n');
      const b = boundText(raw);
      text = b.text;
      truncated = b.truncated;
    } else if (s.plannerResponse) {
      category = 'assistant';
      title = 'Assistant Response';
      const resp = s.plannerResponse.modifiedResponse || s.plannerResponse.response || '';
      const think = s.plannerResponse.thinking || '';
      const bResp = boundText(resp);
      const bThink = boundText(think);
      text = bResp.text;
      thinking = bThink.text;
      truncated = bResp.truncated || bThink.truncated;
      toolCalls = (s.plannerResponse.toolCalls || []).map(c => ({
        id: c.id || '',
        name: c.name || '',
        argumentsJson: boundText(c.argumentsJson || '', 8000).text
      }));
    } else if (s.checkpoint) {
      category = 'summary';
      title = 'Checkpoint / Compaction';
      const b = boundText(s.checkpoint.sessionSummary || '');
      text = b.text;
      truncated = b.truncated;
      events.push({
        kind: 'checkpoint',
        stepIndex: i,
        turnIndex: currentTurn,
        timestamp: tsMs,
        title: 'Context Checkpoint',
        detail: text.slice(0, 180)
      });
    } else if (s.errorMessage) {
      category = 'error';
      title = 'Error';
      const e = s.errorMessage.error || {};
      const b = boundText(e.fullError || e.modelErrorMessage || e.shortError || '');
      text = b.text;
      truncated = b.truncated;
      events.push({
        kind: 'error',
        stepIndex: i,
        turnIndex: currentTurn,
        timestamp: tsMs,
        title: e.errorId || 'Step Error',
        detail: String(e.shortError || e.modelErrorMessage || text).slice(0, 180)
      });
    } else if (s.systemMessage) {
      category = 'system';
      title = s.systemMessage.renderInfo?.title || s.systemMessage.eventType || 'System Message';
      const b = boundText(s.systemMessage.message || s.systemMessage.agentMessage?.content || '');
      text = b.text;
      truncated = b.truncated;
      if (s.systemMessage.agentMessage) {
        const am = s.systemMessage.agentMessage;
        communications.push({
          stepIndex: i,
          turnIndex: currentTurn,
          timestamp: tsMs,
          sender: String(am.sender || ''),
          recipient: String(am.recipient || ''),
          title: String(am.renderDetails?.messageTitle || s.systemMessage.eventType || 'Agent Message'),
          content: String(am.content || '').slice(0, 500)
        });
      }
    } else if (s.viewFile || toolName === 'read_file') {
      const vf = s.viewFile || {};
      const filePath = vf.absolutePathUri || parsedArgs?.Path || '';
      const f = ensureFile(filePath);
      const rangeStr = (vf.startLine || parsedArgs?.StartLine) ? `L${vf.startLine || parsedArgs?.StartLine}-${vf.endLine || parsedArgs?.EndLine || ''}` : '';
      if (f) {
        f.reads++;
        f.ops.push({ kind: 'read', stepIndex: i, turnIndex: currentTurn, timestamp: tsMs, detail: rangeStr });
      }
      const isSkill = isSkillFilePath(f?.path || filePath);
      category = isSkill ? 'skill' : 'tool_result';
      title = isSkill ? `Skill: ${basenameOf(normalizeFilePath(filePath).display.replace(/\/SKILL\.md$/i, '')) || 'SKILL.md'}` : `read_file: ${f?.name || filePath}`;
      const bArgs = boundText(toolCall?.argumentsJson || { file: filePath, startLine: vf.startLine, endLine: vf.endLine }, 6000);
      const bRes = boundText(vf.content || s.generic?.result || '');
      argsText = bArgs.text;
      resultText = bRes.text;
      truncated = bRes.truncated;
      if (isSkill) {
        const skillFolder = basenameOf(normalizeFilePath(filePath).display.replace(/\/SKILL\.md$/i, '')) || 'SKILL.md';
        events.push({
          kind: 'skill_load',
          stepIndex: i,
          turnIndex: currentTurn,
          timestamp: tsMs,
          title: skillFolder,
          detail: f?.path || filePath
        });
      }
    } else if (s.codeAction || toolName === 'edit_file' || toolName === 'write_file' || toolName === 'write_to_file' || toolName === 'replace_file_content' || toolName === 'multi_replace_file_content') {
      category = 'tool_result';
      const ca = s.codeAction || {};
      const filePath = ca.actionSpec?.command?.file?.absoluteUri || ca.actionResult?.edit?.diff?.absoluteUri || parsedArgs?.Path || parsedArgs?.TargetFile || '';
      const { additions, deletions } = countDiffLines(ca);
      const f = ensureFile(filePath);
      if (f) {
        f.writes++;
        f.additions += additions;
        f.deletions += deletions;
        f.ops.push({ kind: 'write', stepIndex: i, turnIndex: currentTurn, timestamp: tsMs, detail: `+${additions} -${deletions}`, additions, deletions });
      }
      title = `${toolName || 'edit'}: ${f?.name || filePath}`;
      const diffLines = ca.actionResult?.edit?.diff?.unifiedDiff?.lines;
      const diffPreview = Array.isArray(diffLines)
        ? diffLines.map(ln => `${ln.type === 'UNIFIED_DIFF_LINE_TYPE_INSERT' ? '+' : ln.type === 'UNIFIED_DIFF_LINE_TYPE_DELETE' ? '-' : ' '} ${ln.text ?? ''}`).join('\n')
        : (s.generic?.result || '');
      argsText = boundText(toolCall?.argumentsJson || parsedArgs || '', 8000).text;
      const bRes = boundText(diffPreview);
      resultText = bRes.text;
      truncated = bRes.truncated;
    } else if (s.runCommand || toolName === 'run_command') {
      category = 'tool_result';
      const rc = s.runCommand || {};
      const cmdLine = String(rc.commandLine || rc.proposedCommandLine || parsedArgs?.CommandLine || '');
      const prog = extractPrimaryProgram(cmdLine);
      const exitCode = rc.exitCode !== undefined && rc.exitCode !== null ? Number(rc.exitCode) : (s.generic?.result?.stepRenderInfo?.contentBlocks?.[0]?.terminal?.exitCode ?? null);
      const rawOut = rc.combinedOutput?.full || rc.combinedOutput?.output || s.generic?.result?.stepRenderInfo?.contentBlocks?.[0]?.terminal?.output || '';
      const cmdStatus = status === 'running' || status === 'pending'
        ? 'running'
        : ((exitCode !== null && exitCode !== 0) || status === 'error' ? 'error' : 'ok');
      const bOut = boundText(rawOut, MAX_CMD_OUTPUT_LEN);
      commandExecutions.push({
        stepIndex: i,
        turnIndex: currentTurn,
        commandLine: cmdLine,
        program: prog,
        shellName: rc.shellName || 'shell',
        exitCode,
        status: cmdStatus,
        durationMs: durMs,
        outputPreview: bOut.text,
        truncated: bOut.truncated,
        createdAt: tsMs
      });
      programCountMap.set(prog, (programCountMap.get(prog) || 0) + 1);
      title = `run_command: ${prog}`;
      argsText = boundText(toolCall?.argumentsJson || { commandLine: cmdLine }, 6000).text;
      const bRes = boundText(rawOut);
      resultText = bRes.text;
      truncated = bRes.truncated;
      if (cmdStatus === 'error') {
        events.push({
          kind: 'error',
          stepIndex: i,
          turnIndex: currentTurn,
          timestamp: tsMs,
          title: `Command failed (${prog}, exit ${exitCode ?? '?'})`,
          detail: cmdLine.slice(0, 180)
        });
      }
    } else if (s.grepSearch || s.findByName || s.listDir || toolName === 'grep_search' || toolName === 'find_by_name' || toolName === 'list_dir') {
      category = 'tool_result';
      const searchObj = s.grepSearch || s.findByName || s.listDir || parsedArgs || {};
      const searchPath = searchObj.searchPathUri || searchObj.searchDirectory || searchObj.directoryPath || searchObj.SearchPath || searchObj.SearchDirectory || searchObj.DirectoryPath || '';
      const f = ensureFile(searchPath);
      if (f) {
        f.searches++;
        f.ops.push({ kind: 'search', stepIndex: i, turnIndex: currentTurn, timestamp: tsMs, detail: String(searchObj.query || searchObj.Query || searchObj.pattern || searchObj.Pattern || '') });
      }
      title = `${toolName || 'search'}: ${f?.name || searchPath || ''}`;
      argsText = boundText(toolCall?.argumentsJson || searchObj, 6000).text;
      const bRes = boundText(s.grepSearch || s.findByName || s.listDir || s.generic?.result || '');
      resultText = bRes.text;
      truncated = bRes.truncated;
    } else {
      category = isToolStep ? 'tool_result' : 'system';
      title = toolName || title;
      argsText = boundText(toolCall?.argumentsJson || parsedArgs || '', 6000).text;
      const payload = s.searchWeb || s.generic?.result || s.taskDetails || s;
      const bRes = boundText(payload);
      resultText = bRes.text;
      truncated = bRes.truncated;
    }

    // Track subagent invocations & agent messages
    if (toolName === 'invoke_subagent' || toolName === 'browser_subagent' || toolName === 'swarm') {
      const role = parsedArgs?.Role || parsedArgs?.name || toolName;
      const subType = parsedArgs?.TypeName || parsedArgs?.action || '';
      events.push({
        kind: 'subagent_spawn',
        stepIndex: i,
        turnIndex: currentTurn,
        timestamp: tsMs,
        title: `Subagent: ${role}`,
        detail: String(parsedArgs?.Prompt || parsedArgs?.brief || subType || '').slice(0, 180)
      });
      const cidMatch = JSON.stringify(s).match(/"(?:conversationId|cascadeId)"\s*:\s*"([0-9a-f-]{36})"/i);
      const childId = cidMatch ? cidMatch[1] : `step-${i}`;
      if (!fleetChildrenMap.has(childId.toLowerCase())) {
        fleetChildrenMap.set(childId.toLowerCase(), {
          cascadeId: cidMatch ? cidMatch[1] : null,
          stepIndex: i,
          role: String(role),
          type: String(subType),
          status,
          promptPreview: String(parsedArgs?.Prompt || parsedArgs?.brief || '').slice(0, 200),
          durationMs: durMs
        });
      }
    } else if (toolName === 'send_message') {
      communications.push({
        stepIndex: i,
        turnIndex: currentTurn,
        timestamp: tsMs,
        sender: 'main',
        recipient: String(parsedArgs?.Recipient || ''),
        title: 'send_message',
        content: String(parsedArgs?.Message || '').slice(0, 500)
      });
    }

    // Estimate step tokens if official map doesn't have this step
    const offTok = officialStepTokens.get(i);
    let tokenEstimate = offTok ?? null;
    let tokenEstimated = false;
    if (tokenEstimate == null) {
      const m = core.measure(`${text}\n${thinking}\n${argsText}\n${resultText}`);
      tokenEstimate = Math.max(1, Math.round((m.low + m.high) / 2));
      tokenEstimated = true;
    }

    browserSteps.push({
      stepIndex: i,
      turnIndex: currentTurn,
      type: s.type || '',
      category,
      title,
      toolName: toolName || '',
      status,
      timestamp: tsMs,
      durationMs: durMs,
      tokenEstimate,
      tokenEstimated,
      text,
      thinking,
      toolCalls,
      argsText,
      resultText,
      truncated,
      attachments: mediaList.map(m => ({ uri: m.uri, name: m.name, mime: m.mime }))
    });
  }

  // Merge DB / caller-discovered subagent links
  if (Array.isArray(options.subagents)) {
    for (const sub of options.subagents) {
      const cid = String(sub?.cascadeId || sub?.childCid || '').trim();
      if (!cid) continue;
      const key = cid.toLowerCase();
      const existing = fleetChildrenMap.get(key);
      if (existing) {
        if (!existing.role && sub.subagentRole) existing.role = sub.subagentRole;
        if (!existing.type && sub.subagentType) existing.type = sub.subagentType;
        if (sub.tokens != null) existing.tokens = sub.tokens;
        if (sub.stepCount != null) existing.stepCount = sub.stepCount;
        if (sub.title) existing.title = sub.title;
      } else {
        fleetChildrenMap.set(key, {
          cascadeId: cid,
          stepIndex: sub.parentStepIndex ?? null,
          role: sub.subagentRole || sub.title || 'Subagent',
          type: sub.subagentType || '',
          status: sub.status || 'done',
          tokens: sub.tokens ?? null,
          stepCount: sub.stepCount ?? null,
          title: sub.title || '',
          promptPreview: ''
        });
      }
    }
  }

  // 2. Build Context Trend (byStep & byTurn) + total token / cost / timing stats
  const trendByStep = [];
  let totalInput = 0;
  let totalCacheRead = 0;
  let totalOutput = 0;
  let totalThinkingOut = 0;
  let totalCostUSD = 0;
  let pricedCalls = 0;
  let totalTtftMs = 0;
  let totalStreamingMs = 0;
  let prevModelId = null;
  let prevCtxUsed = null;
  let prevStepIdxCursor = -1;

  for (let idx = 0; idx < gmList.length; idx++) {
    const g = gmList[idx] || {};
    const cm = g.chatModel || {};
    const usage = cm.usage || {};
    const rawStepIndices = Array.isArray(g.stepIndices) ? g.stepIndices.map(Number).filter(Number.isInteger) : [];
    const primaryStepIndex = rawStepIndices.length ? rawStepIndices[0] : (prevStepIdxCursor + 1);
    const turnIdx = (primaryStepIndex >= 0 && primaryStepIndex < stepTurnMap.length)
      ? stepTurnMap[primaryStepIndex]
      : currentTurn;

    const normUsage = core.normalizeCallInputCacheTokens(usage);
    const uncachedIn = normUsage.uncachedInput ?? (Number(usage.inputTokens) || 0);
    const cacheRead = normUsage.cacheRead ?? (Number(usage.cacheReadTokens ?? usage.cachedContentTokenCount ?? 0) || 0);
    const outTok = normUsage.output ?? (Number(usage.outputTokens) || 0);
    const thinkOut = Number(usage.thinkingOutputTokens) || 0;
    const respOut = Number(usage.responseOutputTokens) || Math.max(0, outTok - thinkOut);

    totalInput += uncachedIn;
    totalCacheRead += cacheRead;
    totalOutput += outTok;
    totalThinkingOut += thinkOut;

    const modelId = cm.model || usage.model || '';
    const modelLabel = cm.modelDisplayName || core.lookupModelDisplayLabel({ modelExactId: modelId, model: modelId }, cascadeConfigs) || modelId || 'Unknown';
    const costCalc = core.calculateRequestApiCost({
      modelExactId: modelId,
      modelLabel,
      inputTokens: uncachedIn,
      cacheTokens: cacheRead,
      outputTokens: outTok,
      thinkingTokens: thinkOut,
      created_at: (primaryStepIndex >= 0 && primaryStepIndex < steps.length) ? parseStepTimestampMs(steps[primaryStepIndex]) : undefined
    });
    if (costCalc?.isPriced && Number.isFinite(costCalc.costUSD)) {
      totalCostUSD += costCalc.costUSD;
      pricedCalls++;
    }

    const ttftMs = parseDurationMs(cm.timeToFirstToken) ?? 0;
    const streamingMs = parseDurationMs(cm.streamingDuration) ?? 0;
    totalTtftMs += ttftMs;
    totalStreamingMs += streamingMs;

    const cwm = cm.chatStartMetadata?.contextWindowMetadata || null;
    const buckets = extractContextWindowBuckets(cwm);
    const estimatedUsed = cwm?.estimatedTokensUsed != null
      ? Number(cwm.estimatedTokensUsed)
      : (uncachedIn + cacheRead);
    const maxContextTokens = cwm?.maxContextTokens != null ? Number(cwm.maxContextTokens) : null;
    const deltaTokens = prevCtxUsed != null ? (estimatedUsed - prevCtxUsed) : estimatedUsed;

    // Flags between prevStepIdxCursor and current step indices
    const maxStepIdx = rawStepIndices.length ? Math.max(...rawStepIndices) : primaryStepIndex;
    const flags = [];
    const checkpointIdx = cm.chatStartMetadata?.checkpointIndex;
    if (Number.isInteger(checkpointIdx) && checkpointIdx >= 0 && deltaTokens < 0) {
      flags.push('checkpoint');
    }
    if (prevModelId && modelId && prevModelId !== modelId) {
      flags.push('model_switch');
      events.push({
        kind: 'model_switch',
        stepIndex: primaryStepIndex,
        turnIndex: turnIdx,
        timestamp: (primaryStepIndex >= 0 && primaryStepIndex < steps.length) ? parseStepTimestampMs(steps[primaryStepIndex]) : null,
        title: `${prevModelId} -> ${modelLabel}`,
        detail: `Call #${idx + 1}`,
        tokenDelta: deltaTokens
      });
    }
    for (let si = Math.max(0, prevStepIdxCursor + 1); si <= Math.min(steps.length - 1, maxStepIdx); si++) {
      const st = steps[si];
      if (!st) continue;
      if (st.checkpoint && !flags.includes('checkpoint')) flags.push('checkpoint');
      if (st.errorMessage && !flags.includes('error')) flags.push('error');
      const { name: tn, parsedArgs: pa } = parseStepToolInfo(st);
      if ((tn === 'invoke_subagent' || tn === 'swarm') && !flags.includes('subagent')) flags.push('subagent');
      if ((st.viewFile || tn === 'read_file') && isSkillFilePath(st.viewFile?.absolutePathUri || pa?.Path || '') && !flags.includes('skill_load')) {
        flags.push('skill_load');
      }
    }

    // Step brief: user, newly added inputs since previous call, response
    let userBrief = '';
    for (let si = Math.min(steps.length - 1, maxStepIdx); si >= 0; si--) {
      if (steps[si]?.userInput) {
        userBrief = summarizeStepBriefText(steps[si]);
        break;
      }
    }
    const inParts = [];
    for (let si = Math.max(0, prevStepIdxCursor + 1); si < Math.min(steps.length, primaryStepIndex); si++) {
      if (steps[si] && !steps[si].userInput) {
        inParts.push(summarizeStepBriefText(steps[si]));
      }
    }
    const respParts = [];
    for (const si of (rawStepIndices.length ? rawStepIndices : [primaryStepIndex])) {
      if (steps[si]) respParts.push(summarizeStepBriefText(steps[si]));
    }

    trendByStep.push({
      index: idx,
      turnIndex: turnIdx,
      stepIndices: rawStepIndices,
      primaryStepIndex,
      model: modelId,
      modelLabel,
      usage: {
        inputTokens: uncachedIn,
        cacheReadTokens: cacheRead,
        promptTotal: uncachedIn + cacheRead,
        outputTokens: outTok,
        thinkingOutputTokens: thinkOut,
        responseOutputTokens: respOut
      },
      estimatedTokensUsed: estimatedUsed,
      maxContextTokens,
      buckets,
      deltaTokens,
      ttftMs,
      streamingMs,
      flags,
      brief: {
        user: userBrief,
        in: inParts.slice(0, 3).join(' · '),
        response: respParts.slice(0, 3).join(' · ')
      }
    });

    prevModelId = modelId || prevModelId;
    prevCtxUsed = estimatedUsed;
    prevStepIdxCursor = Math.max(prevStepIdxCursor, maxStepIdx);
  }

  // Group trend by turn
  const trendByTurn = [];
  const turnBucketsMap = new Map();
  for (const pt of trendByStep) {
    let tGroup = turnBucketsMap.get(pt.turnIndex);
    if (!tGroup) {
      tGroup = {
        turnIndex: pt.turnIndex,
        stepIndices: [],
        primaryStepIndex: pt.primaryStepIndex,
        model: pt.model,
        modelLabel: pt.modelLabel,
        usage: { inputTokens: 0, cacheReadTokens: 0, promptTotal: 0, outputTokens: 0, thinkingOutputTokens: 0, responseOutputTokens: 0 },
        estimatedTokensUsed: pt.estimatedTokensUsed,
        maxContextTokens: pt.maxContextTokens,
        buckets: pt.buckets,
        deltaTokens: 0,
        ttftMs: 0,
        streamingMs: 0,
        flags: [],
        brief: pt.brief,
        callsCount: 0
      };
      turnBucketsMap.set(pt.turnIndex, tGroup);
      trendByTurn.push(tGroup);
    }
    tGroup.callsCount++;
    tGroup.stepIndices.push(...pt.stepIndices);
    tGroup.model = pt.model;
    tGroup.modelLabel = pt.modelLabel;
    tGroup.estimatedTokensUsed = pt.estimatedTokensUsed;
    tGroup.maxContextTokens = pt.maxContextTokens || tGroup.maxContextTokens;
    tGroup.buckets = pt.buckets;
    tGroup.usage.inputTokens += pt.usage.inputTokens;
    tGroup.usage.cacheReadTokens += pt.usage.cacheReadTokens;
    tGroup.usage.promptTotal = pt.usage.promptTotal;
    tGroup.usage.outputTokens += pt.usage.outputTokens;
    tGroup.usage.thinkingOutputTokens += pt.usage.thinkingOutputTokens;
    tGroup.usage.responseOutputTokens += pt.usage.responseOutputTokens;
    tGroup.ttftMs += pt.ttftMs;
    tGroup.streamingMs += pt.streamingMs;
    tGroup.brief = pt.brief;
    for (const fl of pt.flags) {
      if (!tGroup.flags.includes(fl)) tGroup.flags.push(fl);
    }
  }
  for (let i = 0; i < trendByTurn.length; i++) {
    const prev = i > 0 ? trendByTurn[i - 1].estimatedTokensUsed : 0;
    trendByTurn[i].deltaTokens = trendByTurn[i].estimatedTokensUsed - prev;
  }

  // 3. Build Current Composition (official tokenBreakdown or fallback analyzeSteps)
  let currentComposition = null;
  if (latestCwm && latestCwm.tokenBreakdown) {
    const buckets = extractContextWindowBuckets(latestCwm);
    const groups = (latestCwm.tokenBreakdown.groups || []).map(g => ({
      name: g.name || '',
      type: g.type || '',
      bucket: mapTokenGroupBucket(g),
      numTokens: Number(g.numTokens) || 0,
      children: (g.children || []).map(ch => ({ name: ch.name || '', numTokens: Number(ch.numTokens) || 0 }))
    }));
    currentComposition = {
      source: 'official',
      estimatedTokensUsed: Number(latestCwm.estimatedTokensUsed ?? latestCwm.tokenBreakdown.totalTokens ?? 0),
      maxContextTokens: Number(latestCwm.maxContextTokens ?? 0) || null,
      totalTokens: Number(latestCwm.tokenBreakdown.totalTokens ?? latestCwm.estimatedTokensUsed ?? 0),
      buckets,
      groups
    };
  } else {
    const fallback = core.analyzeSteps(steps);
    const g = fallback.groups || {};
    const mid = (box) => box ? Math.round((box.low + box.high) / 2) : 0;
    const chatTotal = mid(g.user) + mid(g.assistant) + mid(g.thinking) + mid(g.tools) + mid(g.summaries);
    currentComposition = {
      source: 'estimated',
      estimatedTokensUsed: chatTotal,
      maxContextTokens: null,
      totalTokens: chatTotal,
      buckets: { systemPrompt: 0, tools: 0, skills: 0, subagents: 0, plugins: 0, chatMessages: chatTotal, other: 0 },
      groups: [
        { name: 'User', type: 'EST_USER', bucket: 'chatMessages', numTokens: mid(g.user), children: [] },
        { name: 'Assistant', type: 'EST_ASSISTANT', bucket: 'chatMessages', numTokens: mid(g.assistant), children: [] },
        { name: 'Thinking', type: 'EST_THINKING', bucket: 'chatMessages', numTokens: mid(g.thinking), children: [] },
        { name: 'Tool Steps', type: 'EST_TOOLS', bucket: 'chatMessages', numTokens: mid(g.tools), children: [] },
        { name: 'Summaries', type: 'EST_SUMMARIES', bucket: 'chatMessages', numTokens: mid(g.summaries), children: [] }
      ]
    };
  }

  // 4. Build Prompt Sections & Tool Schemas for Context Browser
  const sectionTokenMap = new Map();
  for (const g of (currentComposition.groups || [])) {
    if (g.bucket !== 'chatMessages') {
      for (const ch of (g.children || [])) {
        if (ch.name) sectionTokenMap.set(ch.name, (sectionTokenMap.get(ch.name) || 0) + ch.numTokens);
      }
    }
  }
  const promptSections = [];
  if (Array.isArray(latestPromptSections) && latestPromptSections.length) {
    for (const ps of latestPromptSections) {
      const title = String(ps.title || ps.metadata?.templateKey || 'section');
      const b = boundText(ps.content || '', MAX_BROWSER_TEXT_LEN);
      const tok = sectionTokenMap.get(title) ?? Math.max(1, Math.round(b.fullLength / 4));
      promptSections.push({
        title,
        tokenType: ps.tokenType || 'TOKEN_TYPE_SYSTEM_PROMPT',
        numTokens: tok,
        content: b.text,
        truncated: b.truncated,
        fullLength: b.fullLength
      });
    }
  } else if (latestSystemPrompt) {
    const b = boundText(latestSystemPrompt, MAX_BROWSER_TEXT_LEN);
    promptSections.push({
      title: 'systemPrompt',
      tokenType: 'TOKEN_TYPE_SYSTEM_PROMPT',
      numTokens: currentComposition.buckets.systemPrompt || Math.round(b.fullLength / 4),
      content: b.text,
      truncated: b.truncated,
      fullLength: b.fullLength
    });
  }

  const toolsGroup = (currentComposition.groups || []).find(g => g.bucket === 'tools');
  const toolTokMap = new Map();
  for (const ch of (toolsGroup?.children || [])) {
    if (ch.name) toolTokMap.set(ch.name, ch.numTokens);
  }
  const toolsList = Array.isArray(latestTools) ? latestTools.map(tl => {
    const bDesc = boundText(tl.description || '', 4000);
    const bSchema = boundText(tl.jsonSchemaString || tl.parameters || '', MAX_SCHEMA_TEXT_LEN);
    return {
      name: String(tl.name || ''),
      source: inferToolSource(tl.name, tl),
      numTokens: toolTokMap.get(tl.name) ?? Math.max(1, Math.round((bDesc.fullLength + bSchema.fullLength) / 4)),
      description: bDesc.text,
      schema: bSchema.text,
      truncated: bSchema.truncated
    };
  }) : [];

  // 5. Timing & Cache Stats
  const firstStepTs = steps.length ? parseStepTimestampMs(steps[0]) : null;
  const lastStepTs = steps.length ? (parseTimestampMs(steps[steps.length - 1]?.metadata?.completedAt) ?? parseStepTimestampMs(steps[steps.length - 1])) : null;
  const modelMs = totalTtftMs + totalStreamingMs;
  const activeMs = modelMs + totalToolDurationMs;
  const wallSpanMs = (firstStepTs != null && lastStepTs != null && lastStepTs >= firstStepTs) ? Math.round(lastStepTs - firstStepTs) : activeMs;
  const promptTotal = totalInput + totalCacheRead;
  const cacheHitRate = promptTotal > 0 ? totalCacheRead / promptTotal : null;

  events.sort((a, b) => (a.stepIndex - b.stepIndex) || ((a.timestamp || 0) - (b.timestamp || 0)));

  const fileItems = Array.from(fileMap.values()).sort((a, b) =>
    ((b.writes * 3 + b.reads + b.searches + b.images) - (a.writes * 3 + a.reads + a.searches + a.images)) || a.path.localeCompare(b.path)
  );
  const fileTotals = fileItems.reduce((acc, it) => {
    acc.files++;
    acc.reads += it.reads;
    acc.writes += it.writes;
    acc.searches += it.searches;
    acc.images += it.images;
    acc.additions += it.additions;
    acc.deletions += it.deletions;
    return acc;
  }, { files: 0, reads: 0, writes: 0, searches: 0, images: 0, additions: 0, deletions: 0 });

  const programCounts = Array.from(programCountMap.entries())
    .map(([program, count]) => ({ program, count }))
    .sort((a, b) => b.count - a.count || a.program.localeCompare(b.program));

  const rootConvId = String(trajectory?.metadata?.rootConversationId || '').trim();
  const parentCascadeId = (options.parentCascadeId && options.parentCascadeId !== cascadeId)
    ? options.parentCascadeId
    : ((rootConvId && rootConvId.toLowerCase() !== cascadeId.toLowerCase()) ? rootConvId : null);

  let extractedTitle = '';
  for (const step of steps) {
    if (step.userInput || step.type === 'USER_INPUT' || step.type === 'CORTEX_STEP_TYPE_USER_INPUT') {
      const raw = step.userInput?.userResponse || step.content || (step.userInput?.items || []).map(x => x.text || '').join('\n') || '';
      extractedTitle = extractCleanSessionTitle(raw);
      if (extractedTitle) break;
    }
  }
  const rawOptTitle = String(options.title || '').trim();
  const isGeneratedTitle = !rawOptTitle || /^[0-9a-f-]{36}$/i.test(rawOptTitle) || rawOptTitle.startsWith('session-') || rawOptTitle === cascadeId.slice(0, 8);
  const finalTitle = isGeneratedTitle ? (extractedTitle || rawOptTitle || cascadeId.slice(0, 8)) : rawOptTitle;

  const lastTrend = trendByStep[trendByStep.length - 1] || null;
  return {
    cascadeId,
    title: finalTitle,
    workspace: extractWorkspaceDisplay(trajectory),
    stats: {
      turns: currentTurn,
      steps: steps.length,
      userInputs: userInputsCount,
      toolCalls: toolCallsCount,
      modelCalls: gmList.length,
      tokens: {
        input: totalInput,
        cacheRead: totalCacheRead,
        output: totalOutput,
        thinking: totalThinkingOut,
        total: totalInput + totalCacheRead + totalOutput
      },
      estimatedCostUSD: pricedCalls > 0 ? totalCostUSD : null,
      cacheHitRate,
      timing: {
        modelMs,
        ttftMs: totalTtftMs,
        streamingMs: totalStreamingMs,
        toolMs: totalToolDurationMs,
        activeMs,
        wallSpanMs
      },
      modelLabel: lastTrend?.modelLabel || '',
      modelId: lastTrend?.model || ''
    },
    currentComposition,
    trend: {
      byStep: trendByStep,
      byTurn: trendByTurn
    },
    browser: {
      promptSections,
      tools: toolsList,
      steps: browserSteps
    },
    fileActivity: {
      totals: fileTotals,
      files: fileItems
    },
    commandExecutions: {
      total: commandExecutions.length,
      okCount: commandExecutions.filter(c => c.status === 'ok').length,
      errorCount: commandExecutions.filter(c => c.status === 'error').length,
      runningCount: commandExecutions.filter(c => c.status === 'running').length,
      programCounts,
      items: commandExecutions
    },
    events,
    fleet: {
      current: {
        cascadeId,
        title: options.title || cascadeId.slice(0, 8),
        modelLabel: lastTrend?.modelLabel || '',
        estimatedTokensUsed: currentComposition.estimatedTokensUsed,
        maxContextTokens: currentComposition.maxContextTokens,
        stepsCount: steps.length,
        status: options.status || 'done'
      },
      parent: parentCascadeId ? { cascadeId: parentCascadeId } : null,
      children: Array.from(fleetChildrenMap.values()),
      communications
    }
  };
}

function resolveGeminiBaseDirs(options = {}) {
  const home = options.homeDir || process.env.USERPROFILE || os.homedir();
  const explicitAg = options.agDir || process.env.AG_DIR || null;
  const agDir = explicitAg || path.join(home, '.gemini', 'antigravity');
  const agCliDir = options.agCliDir || process.env.AG_CLI_DIR || (
    explicitAg ? path.join(path.dirname(path.resolve(explicitAg)), 'antigravity-cli') : path.join(home, '.gemini', 'antigravity-cli')
  );
  return { home, agDir, agCliDir };
}

function findLocalSubagentsForSession(cascadeId, agDir, collector) {
  const out = [];
  if (!cascadeId || !agDir) return out;
  const convDir = path.join(agDir, 'conversations');
  if (!fs.existsSync(convDir)) return out;
  const normTarget = cascadeId.toLowerCase();
  try {
    for (const name of fs.readdirSync(convDir)) {
      if (!name.endsWith('.db')) continue;
      const cid = name.slice(0, -3);
      if (cid.toLowerCase() === normTarget) continue;
      try {
        const meta = collector.loadConversationDbMeta(path.join(convDir, name), cid);
        const p = String(meta?.parentCascadeId || '').toLowerCase();
        const r = String(meta?.rootCascadeId || '').toLowerCase();
        if (p === normTarget || r === normTarget) {
          out.push({
            cascadeId: cid,
            subagentType: meta.subagentType || '',
            subagentRole: meta.subagentRole || ''
          });
        }
      } catch {}
    }
  } catch {}
  return out;
}

async function collectSessionDeepDive(origin, cascadeId, options = {}) {
  const cid = String(cascadeId || '').trim();
  if (!cid || cid.includes('..') || cid.includes('/') || cid.includes('\\')) {
    throw new Error('无效的会话 ID');
  }
  const cacheKey = `${origin || '__local__'}|${cid}`;
  const cached = deepDiveCache.get(cacheKey);
  if (!options.force && cached && (Date.now() - cached.at < DEEP_DIVE_CACHE_TTL_MS)) {
    return cached.data;
  }

  let trajectory = options.trajectory || null;
  let generatorMetadata = options.generatorMetadata || null;
  let summaryMeta = null;

  if (!trajectory) {
    const cdpMod = require('../../cdp');
    const connector = typeof options.connect === 'function' ? options.connect : (cdpMod.connectLocalServer || cdpMod.connect);
    const api = await connector(origin ? { origin } : undefined);
    const [trajRes, gmRes, allRes] = await Promise.allSettled([
      api.call('GetCascadeTrajectory', { cascadeId: cid, trajectoryVerbosity: 3 }),
      api.call('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: cid, generatorMetadataOffset: 0, includeMessages: true }),
      api.call('GetAllCascadeTrajectories', {})
    ]);
    if (trajRes.status === 'fulfilled' && trajRes.value?.trajectory) {
      trajectory = trajRes.value.trajectory;
    } else if (trajRes.status === 'rejected') {
      throw trajRes.reason;
    } else {
      throw new Error('未取得会话轨迹数据');
    }
    if (gmRes.status === 'fulfilled' && Array.isArray(gmRes.value?.generatorMetadata)) {
      generatorMetadata = gmRes.value.generatorMetadata;
    }
    if (allRes.status === 'fulfilled' && allRes.value?.trajectorySummaries) {
      summaryMeta = allRes.value.trajectorySummaries[cid] || null;
    }
  }

  const collector = require('../../collector');
  const { agDir } = resolveGeminiBaseDirs(options);
  const localSubs = findLocalSubagentsForSession(cid, agDir, collector);

  const deepDive = buildSessionDeepDive(trajectory, generatorMetadata || [], {
    cascadeId: cid,
    title: options.title || summaryMeta?.annotations?.title || summaryMeta?.summary || '',
    status: summaryMeta?.status || '',
    cascadeModelConfigs: options.cascadeModelConfigs || [],
    subagents: localSubs
  });

  deepDiveCache.set(cacheKey, { at: Date.now(), data: deepDive });
  return deepDive;
}

module.exports = {
  buildSessionDeepDive,
  collectSessionDeepDive,
  findLocalSubagentsForSession,
  resolveGeminiBaseDirs
};