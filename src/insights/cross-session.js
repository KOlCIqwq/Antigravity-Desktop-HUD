'use strict';
const fs = require('fs');
const path = require('path');
const core = require('../../core');
const collector = require('../../collector');
const {
  basenameOf,
  parseTimestampMs,
  extractPrimaryProgram,
  isSkillFilePath,
  extractCleanSessionTitle,
  normalizeFilePath
} = require('./helpers');
const { resolveGeminiBaseDirs } = require('./deep-dive');

const INSIGHTS_CACHE_TTL_MS = 12000;
const insightsCache = new Map();
const transcriptInsightsCache = new Map();

function scanTranscriptSummaryStats(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    return { toolCounts: {}, commandCounts: {}, skillCounts: {}, title: '', tokens: { input: 0, cacheRead: 0, output: 0, total: 0 }, costUSD: 0, callsCount: 0, modelLabel: '' };
  }
  try {
    const st = fs.statSync(transcriptPath);
    const prev = transcriptInsightsCache.get(transcriptPath);
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      return prev.data;
    }
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const toolCounts = {};
    const commandCounts = {};
    const skillCounts = {};
    const tokens = { input: 0, cacheRead: 0, output: 0, total: 0 };
    let costUSD = 0;
    let callsCount = 0;
    let modelLabel = '';
    let extractedTitle = '';

    for (const line of raw.split(/\r?\n/)) {
      if (!line) continue;
      if (!extractedTitle && (line.includes('"USER_INPUT"') || line.includes('<USER_REQUEST>') || line.includes('"userInput"'))) {
        try {
          const entry = JSON.parse(line);
          const content = entry.content || entry.userInput?.userResponse || (entry.userInput?.items || []).map(x => x.text || '').join('\n') || '';
          extractedTitle = extractCleanSessionTitle(content);
        } catch {}
      }

      const hasTokens = line.includes('tokens') || line.includes('Tokens') || line.includes('usage') || line.includes('Usage') || line.includes('model') || line.includes('PLANNER_RESPONSE');
      const hasTools = line.includes('"tool_calls"');
      if (!hasTokens && !hasTools) continue;

      try {
        const entry = JSON.parse(line);
        const u = entry.usage || entry.tokenUsage || entry.modelUsage || entry.chatModel?.usage || {};

        const inp = Number(entry.input_tokens ?? entry.inputTokens ?? entry.prompt_tokens ?? u.inputTokens ?? u.promptTokens ?? 0) || 0;
        const cache = Number(entry.cache_read_tokens ?? entry.cacheReadTokens ?? entry.cached_tokens ?? u.cacheReadTokens ?? u.cachedContentTokenCount ?? 0) || 0;
        const out = Number(entry.output_tokens ?? entry.outputTokens ?? u.outputTokens ?? u.candidatesTokenCount ?? 0) || 0;
        const m = String(entry.model || entry.modelId || u.model || entry.chatModel?.model || '').trim();

        if (inp + cache + out > 0) {
          tokens.input += inp;
          tokens.cacheRead += cache;
          tokens.output += out;
          tokens.total += inp + cache + out;
          callsCount++;
          if (m) modelLabel = m;
          const calc = core.calculateRequestApiCost?.({ inputTokens: inp, cacheReadTokens: cache, outputTokens: out, model: m || modelLabel });
          if (calc?.isPriced && Number.isFinite(calc.costUSD)) {
            costUSD += calc.costUSD;
          }
        }

        const calls = Array.isArray(entry.tool_calls) ? entry.tool_calls : [];
        for (const tc of calls) {
          const name = String(tc?.name || '').trim();
          if (!name) continue;
          toolCounts[name] = (toolCounts[name] || 0) + 1;
          const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
          if (name === 'run_command' && args.CommandLine) {
            const prog = extractPrimaryProgram(args.CommandLine);
            commandCounts[prog] = (commandCounts[prog] || 0) + 1;
          }
          if ((name === 'read_file' || name === 'view_file') && args.Path && isSkillFilePath(normalizeFilePath(args.Path).display)) {
            const folder = basenameOf(normalizeFilePath(args.Path).display.replace(/\/SKILL\.md$/i, '')) || 'SKILL.md';
            skillCounts[folder] = (skillCounts[folder] || 0) + 1;
          }
        }
      } catch {}
    }

    const data = { toolCounts, commandCounts, skillCounts, title: extractedTitle, tokens, costUSD, callsCount, modelLabel, lastModifiedMs: st.mtimeMs, createdAtMs: st.birthtimeMs || st.mtimeMs };
    transcriptInsightsCache.set(transcriptPath, { mtimeMs: st.mtimeMs, size: st.size, data });
    return data;
  } catch {
    return { toolCounts: {}, commandCounts: {}, skillCounts: {}, title: '', tokens: { input: 0, cacheRead: 0, output: 0, total: 0 }, costUSD: 0, callsCount: 0, modelLabel: '', lastModifiedMs: 0, createdAtMs: 0 };
  }
}

function mergeCountMap(target, src, sessionId, sessionMap) {
  for (const [k, v] of Object.entries(src || {})) {
    target[k] = (target[k] || 0) + v;
    if (sessionMap) {
      if (!sessionMap[k]) sessionMap[k] = new Set();
      sessionMap[k].add(sessionId);
    }
  }
}

function resolveTranscriptPath(cid, agDir, agCliDir) {
  for (const base of [agDir, agCliDir]) {
    if (!base) continue;
    const p1 = path.join(base, 'brain', cid, '.system_generated', 'logs', 'transcript.jsonl');
    if (fs.existsSync(p1)) return p1;
    const p2 = path.join(base, 'brain', cid, 'transcript.jsonl');
    if (fs.existsSync(p2)) return p2;
  }
  return null;
}

function readAnnotationMeta(cid, agDir, agCliDir) {
  for (const base of [agDir, agCliDir]) {
    if (!base) continue;
    const p = path.join(base, 'annotations', `${cid}.pbtxt`);
    if (!fs.existsSync(p)) continue;
    try {
      const txt = fs.readFileSync(p, 'utf8');
      let title = '';
      const tm = txt.match(/title:\s*"((?:[^"\\]|\\.)*)"/);
      if (tm && tm[1]) {
        try { title = JSON.parse(`"${tm[1]}"`).trim(); } catch { title = tm[1].trim(); }
      }
      let lastViewMs = null;
      const vm = txt.match(/last_user_view_time:\s*\{\s*seconds:\s*(\d+)/);
      if (vm && vm[1]) {
        const sec = Number(vm[1]);
        if (Number.isFinite(sec) && sec > 0) lastViewMs = sec * 1000;
      }
      if (title || lastViewMs) return { title, lastViewMs };
    } catch {}
  }
  return { title: '', lastViewMs: null };
}

/**
 * Aggregate cross-session insights data (session cards, 7-day trends, top tools/commands/skills distribution)
 */
async function collectCrossSessionInsights(origin, options = {}) {
  const cacheKey = `${origin || '__local__'}|${options.agDir || ''}`;
  const cached = insightsCache.get(cacheKey);
  if (!options.force && cached && (Date.now() - cached.at < INSIGHTS_CACHE_TTL_MS)) {
    return cached.data;
  }

  let trajectorySummaries = options.trajectorySummaries || null;
  if (!trajectorySummaries && origin) {
    try {
      const connector = typeof options.connect === 'function' ? options.connect : require('../../cdp').connectLocalServer;
      const api = await connector({ origin });
      const res = await api.call('GetAllCascadeTrajectories', {});
      if (res?.trajectorySummaries && typeof res.trajectorySummaries === 'object') {
        trajectorySummaries = res.trajectorySummaries;
      }
    } catch {}
  }

  const { agDir, agCliDir } = resolveGeminiBaseDirs(options);
  const ledger = collector.loadPricingLedger ? collector.loadPricingLedger(agDir) : null;
  const callsBySession = new Map();
  const dailyMap = new Map();

  for (const lc of Object.values(ledger?.calls || {})) {
    if (!lc || !lc.cascadeId) continue;
    const cid = String(lc.cascadeId);
    const normIn = Number(lc.inputTokens) || 0;
    const normCache = Number(lc.cacheReadTokens ?? lc.cacheTokens ?? 0) || 0;
    const normOut = Number(lc.outputTokens) || 0;
    const tot = normIn + normCache + normOut;
    const calc = core.calculateRequestApiCost(lc);
    const cost = calc?.isPriced && Number.isFinite(calc.costUSD) ? calc.costUSD : 0;

    let agg = callsBySession.get(cid);
    if (!agg) {
      agg = { input: 0, cacheRead: 0, output: 0, total: 0, costUSD: 0, callsCount: 0, lastTs: 0, modelLabel: '' };
      callsBySession.set(cid, agg);
    }
    agg.input += normIn;
    agg.cacheRead += normCache;
    agg.output += normOut;
    agg.total += tot;
    agg.costUSD += cost;
    agg.callsCount++;
    const ts = parseTimestampMs(lc.created_at) ?? Number(lc.timestamp || 0);
    if (ts >= agg.lastTs) {
      agg.lastTs = ts;
      agg.modelLabel = lc.modelLabel || lc.model || agg.modelLabel;
    }

    if (lc.date && /^\d{4}-\d{2}-\d{2}$/.test(lc.date)) {
      let day = dailyMap.get(lc.date);
      if (!day) {
        day = { date: lc.date, tokens: 0, costUSD: 0, calls: 0 };
        dailyMap.set(lc.date, day);
      }
      day.tokens += tot;
      day.costUSD += cost;
      day.calls++;
    }
  }

  const allSessionIds = new Set([
    ...Object.keys(trajectorySummaries || {}),
    ...callsBySession.keys()
  ]);

  // Always include local brain session directories alongside live RPC trajectories and ledger calls
  for (const baseDir of [agDir, agCliDir]) {
    if (!baseDir) continue;
    const brainDir = path.join(baseDir, 'brain');
    if (fs.existsSync(brainDir)) {
      try {
        const ents = fs.readdirSync(brainDir, { withFileTypes: true });
        for (const e of ents) {
          if (e.isDirectory() && /^[0-9a-f-]{36}$/i.test(e.name)) {
            allSessionIds.add(e.name);
          }
        }
      } catch {}
    }
  }

  const toolTotals = {};
  const toolSessions = {};
  const cmdTotals = {};
  const cmdSessions = {};
  const skillTotals = {};
  const skillSessions = {};
  const sessions = [];

  for (const cid of allSessionIds) {
    const sum = trajectorySummaries?.[cid] || {};
    const agg = callsBySession.get(cid) || { input: 0, cacheRead: 0, output: 0, total: 0, costUSD: 0, callsCount: 0, lastTs: 0, modelLabel: '' };
    const ann = readAnnotationMeta(cid, agDir, agCliDir);
    const createdMs = parseTimestampMs(sum.createdTime) ?? parseTimestampMs(sum.trajectoryMetadata?.createdAt) ?? agg.lastTs ?? ann.lastViewMs ?? null;
    const modifiedMs = parseTimestampMs(sum.lastModifiedTime) ?? agg.lastTs ?? ann.lastViewMs ?? createdMs ?? null;
    const title = String(sum.annotations?.title || sum.summary || ann.title || '').trim() || cid.slice(0, 8);
    sessions.push({
      cascadeId: cid,
      title,
      stepCount: Number(sum.stepCount || 0) || 0,
      status: String(sum.status || '').replace(/^CASCADE_RUN_STATUS_/, '').toLowerCase() || 'idle',
      createdAtMs: createdMs,
      lastModifiedMs: modifiedMs,
      workspace: String(sum.trajectoryMetadata?.projectId || ''),
      tokens: { input: agg.input, cacheRead: agg.cacheRead, output: agg.output, total: agg.total },
      cacheHitRate: (agg.input + agg.cacheRead) > 0 ? agg.cacheRead / (agg.input + agg.cacheRead) : null,
      estimatedCostUSD: agg.costUSD,
      callsCount: agg.callsCount,
      modelLabel: agg.modelLabel,
      tools: [],
      commands: [],
      skills: []
    });
  }

  sessions.sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0));

  // Scan transcript tools/commands/skills and tokens for recent 40 sessions
  for (const sess of sessions.slice(0, 40)) {
    const tp = resolveTranscriptPath(sess.cascadeId, agDir, agCliDir);
    if (!tp) continue;
    const tsStats = scanTranscriptSummaryStats(tp);
    sess.tools = Object.keys(tsStats.toolCounts);
    sess.commands = Object.keys(tsStats.commandCounts);
    sess.skills = Object.keys(tsStats.skillCounts);
    if (sess.tokens.total === 0 && tsStats.tokens?.total > 0) {
      sess.tokens = tsStats.tokens;
      sess.cacheHitRate = (tsStats.tokens.input + tsStats.tokens.cacheRead) > 0
        ? tsStats.tokens.cacheRead / (tsStats.tokens.input + tsStats.tokens.cacheRead)
        : null;
      sess.estimatedCostUSD = tsStats.costUSD || 0;
      sess.callsCount = tsStats.callsCount || 0;
      if (!sess.modelLabel && tsStats.modelLabel) sess.modelLabel = tsStats.modelLabel;
    }
    if (!sess.lastModifiedMs || sess.lastModifiedMs === 0) {
      sess.lastModifiedMs = tsStats.lastModifiedMs || 0;
      sess.createdAtMs = tsStats.createdAtMs || sess.lastModifiedMs;
    }
    if (tsStats.title && (!sess.title || /^[0-9a-f-]{36}$/i.test(sess.title) || sess.title.startsWith('session-') || sess.title === sess.cascadeId.slice(0, 8))) {
      sess.title = tsStats.title;
    }
    mergeCountMap(toolTotals, tsStats.toolCounts, sess.cascadeId, toolSessions);
    mergeCountMap(cmdTotals, tsStats.commandCounts, sess.cascadeId, cmdSessions);
    mergeCountMap(skillTotals, tsStats.skillCounts, sess.cascadeId, skillSessions);
  }

  sessions.sort((a, b) => (b.lastModifiedMs || 0) - (a.lastModifiedMs || 0));

  // If dailyMap is empty, populate from session history
  if (dailyMap.size === 0) {
    for (const sess of sessions) {
      if (sess.tokens?.total > 0 && sess.lastModifiedMs) {
        const d = new Date(sess.lastModifiedMs).toISOString().slice(0, 10);
        let day = dailyMap.get(d);
        if (!day) {
          day = { date: d, tokens: 0, costUSD: 0, calls: 0 };
          dailyMap.set(d, day);
        }
        day.tokens += sess.tokens.total;
        day.costUSD += (sess.estimatedCostUSD || 0);
        day.calls += (sess.callsCount || sess.stepCount || 1);
      }
    }
  }

  const toRanked = (totals, sessMap) => Object.entries(totals)
    .map(([name, count]) => ({ name, count, sessionIds: Array.from(sessMap[name] || []) }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 20);

  const dailyList = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

  const data = {
    sessions,
    daily7d: dailyList.slice(-7),
    dailyAll: dailyList,
    topTools: toRanked(toolTotals, toolSessions),
    topCommands: toRanked(cmdTotals, cmdSessions),
    topSkills: toRanked(skillTotals, skillSessions),
    generatedAt: Date.now()
  };
  insightsCache.set(cacheKey, { at: Date.now(), data });
  return data;
}

module.exports = {
  scanTranscriptSummaryStats,
  mergeCountMap,
  resolveTranscriptPath,
  collectCrossSessionInsights
};
