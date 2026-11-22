'use strict';
const path = require('path');
const os = require('os');
const core = require('../../core');
const MAX_BROWSER_TEXT_LEN = 24000;
const MAX_CMD_OUTPUT_LEN = 8000;
const MAX_SCHEMA_TEXT_LEN = 12000;
function boundText(raw, maxLen = MAX_BROWSER_TEXT_LEN) {
  if (raw === undefined || raw === null) return { text: '', truncated: false, fullLength: 0 };
  const str = typeof raw === 'string' ? raw : (() => {
    try { return JSON.stringify(raw, null, 2); } catch { return String(raw); }
  })();
  if (str.length <= maxLen) {
    return { text: str, truncated: false, fullLength: str.length };
  }
  return { text: str.slice(0, maxLen), truncated: true, fullLength: str.length };
}

function unwrapQuotedArg(val) {
  let s = String(val || '').trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const parsed = JSON.parse(s);
      if (typeof parsed === 'string') s = parsed.trim();
    } catch {
      s = s.slice(1, -1).trim();
    }
  }
  return s;
}

function normalizeFilePath(raw) {
  if (!raw || typeof raw !== 'string') return { display: '', key: '' };
  let p = unwrapQuotedArg(raw);
  if (!p) return { display: '', key: '' };
  if (/^file:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = decodeURIComponent(u.pathname || '');
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
    } catch {
      p = p.replace(/^file:\/\/\/?/i, '');
      try { p = decodeURIComponent(p); } catch {}
    }
  }
  const normalized = p.replace(/\\/g, '/');
  return {
    display: normalized,
    key: process.platform === 'win32' || /^[a-zA-Z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
  };
}

function basenameOf(normPath) {
  if (!normPath) return '';
  const parts = normPath.split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : normPath;
}

function parseTimestampMs(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function parseStepTimestampMs(step) {
  if (!step || typeof step !== 'object') return null;
  const m = step.metadata || {};
  return (
    parseTimestampMs(m.createdAt) ??
    parseTimestampMs(m.startedAt) ??
    parseTimestampMs(m.viewableAt) ??
    parseTimestampMs(m.completedAt) ??
    parseTimestampMs(step.createdAt) ??
    parseTimestampMs(step.timestamp) ??
    null
  );
}

function computeStepDurationMs(step) {
  const m = step?.metadata || {};
  const start = parseTimestampMs(m.startedAt) ?? parseTimestampMs(m.createdAt);
  const end = parseTimestampMs(m.completedAt) ?? parseTimestampMs(m.finishedGeneratingAt);
  if (start != null && end != null && end >= start) {
    return Math.round(end - start);
  }
  return null;
}

function parseDurationMs(value) {
  const sec = core.parseDurationSec(value);
  return sec != null ? Math.round(sec * 1000) : null;
}

function extractPrimaryProgram(commandLine) {
  const raw = unwrapQuotedArg(commandLine);
  if (!raw) return 'shell';
  let rest = raw;
  // Strip leading `cd ... &&` / `Set-Location ... ;` / env assignments
  for (let i = 0; i < 4; i++) {
    const cdMatch = rest.match(/^(?:cd|pushd|set-location)\s+(?:"[^"]*"|'[^']*'|[^;&|\s]+)\s*(?:&&|;)\s*(.+)$/is);
    if (cdMatch) {
      rest = cdMatch[1].trim();
      continue;
    }
    const envMatch = rest.match(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)(.+)$/);
    if (envMatch) {
      rest = envMatch[1].trim();
      continue;
    }
    const psPrefix = rest.match(/^(?:cmd(?:\.exe)?\s+\/c|powershell(?:\.exe)?\s+(?:-[A-Za-z]+\s+)*-Command)\s+(.+)$/i);
    if (psPrefix) {
      rest = psPrefix[1].trim().replace(/^["']/, '');
      continue;
    }
    break;
  }
  const tokenMatch = rest.match(/^(?:"([^"]+)"|'([^']+)'|([^\s;|&]+))/);
  const token = (tokenMatch && (tokenMatch[1] || tokenMatch[2] || tokenMatch[3])) || 'shell';
  const base = token.replace(/\\/g, '/').split('/').pop() || token;
  return base.replace(/\.(exe|cmd|bat|ps1)$/i, '').toLowerCase() || 'shell';
}

function safeJsonParse(str) {
  if (!str || typeof str !== 'string') return null;
  try { return JSON.parse(str); } catch { return null; }
}

function inferToolSource(name, item) {
  if (item?.mcpServerName || item?.serverName) {
    return `mcp:${item.mcpServerName || item.serverName}`;
  }
  const n = String(name || '');
  if (n.startsWith('mcp_') || n.includes(':')) {
    const parts = n.split(/[:_]/);
    return `mcp:${parts[1] || parts[0]}`;
  }
  return 'builtin';
}

function parseStepToolInfo(step) {
  const toolCall = step?.metadata?.toolCall;
  const name = String(toolCall?.name || '').trim();
  const parsedArgs = safeJsonParse(toolCall?.argumentsJson) || step?.generic?.args || null;
  return { name, toolCall, parsedArgs };
}

function countDiffLines(codeAction) {
  const stats = codeAction?.diffStats;
  let additions = Number(stats?.additions ?? stats?.addedLines ?? 0) || 0;
  let deletions = Number(stats?.deletions ?? stats?.deletedLines ?? stats?.removals ?? 0) || 0;
  const lines = codeAction?.actionResult?.edit?.diff?.unifiedDiff?.lines;
  if (!additions && !deletions && Array.isArray(lines)) {
    for (const ln of lines) {
      if (ln?.type === 'UNIFIED_DIFF_LINE_TYPE_INSERT') additions++;
      else if (ln?.type === 'UNIFIED_DIFF_LINE_TYPE_DELETE') deletions++;
    }
  }
  return { additions, deletions };
}

function extractMediaFromStep(step) {
  const out = [];
  const seen = new Set();
  const walk = (val) => {
    if (!val || typeof val !== 'object') return;
    if (Array.isArray(val)) {
      for (const item of val) walk(item);
      return;
    }
    if (val.uri && (val.mimeType || val.inlineData !== undefined)) {
      const norm = normalizeFilePath(val.uri);
      if (norm.display && !seen.has(norm.key)) {
        seen.add(norm.key);
        out.push({
          uri: norm.display,
          key: norm.key,
          name: String(val.description || basenameOf(norm.display)),
          mime: String(val.mimeType || '')
        });
      }
      return;
    }
    for (const [k, v] of Object.entries(val)) {
      if (k === 'metadata' || k === 'userConfig' || k === 'thinkingSignature' || k === 'inlineData' || k === 'thumbnail') continue;
      walk(v);
    }
  };
  if (step?.userInput) walk(step.userInput.media?.length ? step.userInput.media : step.userInput.items);
  else if (step?.plannerResponse) walk(step.plannerResponse);
  else walk(step);
  return out;
}

function mapTokenGroupBucket(group) {
  const type = String(group?.type || '').toUpperCase();
  const name = String(group?.name || '').toLowerCase();
  if (type === 'TOKEN_TYPE_SYSTEM_PROMPT' || name.includes('system prompt')) return 'systemPrompt';
  if (type === 'TOKEN_TYPE_TOOLS' || name === 'tools') return 'tools';
  if (type === 'TOKEN_TYPE_SKILLS' || name === 'skills') return 'skills';
  if (type === 'TOKEN_TYPE_SUBAGENTS' || name === 'subagents') return 'subagents';
  if (type === 'TOKEN_TYPE_PLUGINS' || name === 'plugins') return 'plugins';
  if (type === 'TOKEN_TYPE_CHAT_MESSAGES' || name.includes('chat')) return 'chatMessages';
  return 'other';
}

function extractContextWindowBuckets(cwm) {
  const buckets = { systemPrompt: 0, tools: 0, skills: 0, subagents: 0, plugins: 0, chatMessages: 0, other: 0 };
  const groups = Array.isArray(cwm?.tokenBreakdown?.groups) ? cwm.tokenBreakdown.groups : [];
  for (const g of groups) {
    const key = mapTokenGroupBucket(g);
    buckets[key] += Number(g?.numTokens) || 0;
  }
  return buckets;
}

function extractChatMessageTokenMap(cwm) {
  const map = new Map();
  const groups = Array.isArray(cwm?.tokenBreakdown?.groups) ? cwm.tokenBreakdown.groups : [];
  for (const g of groups) {
    if (mapTokenGroupBucket(g) !== 'chatMessages') continue;
    for (const child of (g.children || [])) {
      const m = String(child?.name || '').match(/^(\d+)\s*:/);
      if (m) {
        const idx = Number(m[1]);
        const prev = map.get(idx) || 0;
        map.set(idx, prev + (Number(child?.numTokens) || 0));
      }
    }
  }
  return map;
}

function isSkillFilePath(normPath) {
  return /(?:^|\/)skill\.md$/i.test(String(normPath || ''));
}

function extractCleanSessionTitle(rawText) {
  if (!rawText || typeof rawText !== 'string') return '';
  let str = rawText;
  const reqMatch = str.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/i);
  if (reqMatch) str = reqMatch[1];
  str = str.replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, '');
  str = str.replace(/<SKILL>[\s\S]*?<\/SKILL>/gi, '');
  str = str.replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, '');
  str = str.replace(/<[^>]+>/g, '');
  str = str.replace(/@\[[^\]]+\]/g, '');
  str = str.replace(/(?:^|\s)\/[a-z0-9_-]+/gi, '');
  str = str.replace(/```[\s\S]*?```/g, '');
  str = str.replace(/`([^`]+)`/g, '$1');
  const lines = str.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  let line = lines[0];
  if (line.length < 5 && lines.length > 1) {
    line = `${line} ${lines[1]}`;
  }
  line = line.replace(/^[#*->\s]+/, '').trim();
  if (line.length > 70) {
    line = line.slice(0, 67).trim() + '…';
  }
  return line;
}

function extractWorkspaceDisplay(trajectory) {
  const steps = Array.isArray(trajectory?.steps) ? trajectory.steps : [];
  for (const s of steps) {
    const items = s?.userInput?.items;
    if (Array.isArray(items)) {
      for (const it of items) {
        const uri = it?.item?.directory?.absoluteUri || it?.item?.file?.absoluteUri;
        if (uri) return normalizeFilePath(uri).display;
      }
    }
  }
  return '';
}

function summarizeStepBriefText(step) {
  if (!step || typeof step !== 'object') return '';
  if (step.userInput) {
    const raw = step.userInput.userResponse || (step.userInput.items || []).map(i => i.text || '').join(' ');
    return core.sanitizeTurnPreviewText ? core.sanitizeTurnPreviewText(raw, 110) : String(raw || '').slice(0, 110);
  }
  if (step.plannerResponse) {
    const calls = Array.isArray(step.plannerResponse.toolCalls) ? step.plannerResponse.toolCalls : [];
    const txt = String(step.plannerResponse.modifiedResponse || step.plannerResponse.response || '').trim();
    if (txt) return txt.replace(/\s+/g, ' ').slice(0, 110);
    if (calls.length) return calls.map(c => c.name).filter(Boolean).join(', ');
    if (step.plannerResponse.thinking) return String(step.plannerResponse.thinking).replace(/\s+/g, ' ').slice(0, 110);
  }
  const { name, parsedArgs } = parseStepToolInfo(step);
  if (step.viewFile || name === 'read_file') {
    const p = normalizeFilePath(step.viewFile?.absolutePathUri || parsedArgs?.Path || '').display;
    return `read ${basenameOf(p) || p}`;
  }
  if (step.codeAction || name === 'edit_file' || name === 'write_file' || name === 'write_to_file') {
    const p = normalizeFilePath(step.codeAction?.actionSpec?.command?.file?.absoluteUri || parsedArgs?.Path || parsedArgs?.TargetFile || '').display;
    return `edit ${basenameOf(p) || p}`;
  }
  if (step.runCommand || name === 'run_command') {
    const cmd = step.runCommand?.commandLine || parsedArgs?.CommandLine || '';
    return `run ${String(cmd).replace(/\s+/g, ' ').slice(0, 80)}`;
  }
  if (step.checkpoint) return `checkpoint: ${String(step.checkpoint.sessionSummary || '').slice(0, 80)}`;
  if (step.errorMessage) return `error: ${String(step.errorMessage.error?.shortError || step.errorMessage.error?.modelErrorMessage || '').slice(0, 80)}`;
  if (name) return name;
  return String(step.type || '').replace(/^CORTEX_STEP_TYPE_/, '').toLowerCase();
}

/**
 * 将单条 Antigravity trajectory 与 generatorMetadata 组装为完整的深度洞察载荷
 */
module.exports = {
  MAX_BROWSER_TEXT_LEN, MAX_CMD_OUTPUT_LEN, MAX_SCHEMA_TEXT_LEN,
  boundText, unwrapQuotedArg, normalizeFilePath, basenameOf, parseTimestampMs,
  parseStepTimestampMs, computeStepDurationMs, parseDurationMs, extractPrimaryProgram,
  safeJsonParse, inferToolSource, parseStepToolInfo, countDiffLines, extractMediaFromStep,
  mapTokenGroupBucket, extractContextWindowBuckets, extractChatMessageTokenMap, isSkillFilePath,
  extractCleanSessionTitle, extractWorkspaceDisplay, summarizeStepBriefText
};