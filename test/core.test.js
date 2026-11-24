'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core');

test('analyzeSteps aggregates user, assistant, thinking, and tool tokens', () => {
  const res = core.analyzeSteps([
    { userInput: { userResponse: 'Hello world' } },
    { plannerResponse: { response: 'Hi there!', thinking: 'Considering greeting' } },
    { runCommand: { command: 'ls -la', output: 'file1.js\nfile2.js' } }
  ]);
  assert.equal(res.userMessages, 1);
  assert.equal(res.assistantMessages, 1);
  assert.equal(res.steps, 3);
  assert.ok(res.groups.user.high > 0);
  assert.ok(res.groups.assistant.high > 0);
  assert.ok(res.groups.thinking.high > 0);
  assert.ok(res.groups.tools.high > 0);
});

test('summarize computes context percent, speed, and TTFT', () => {
  const out = core.summarize({
    chatModel: {
      modelDisplayName: 'Gemini 4 Hydrogen',
      model: 'gemini-4-hydrogen',
      timeToFirstToken: '1.5s',
      streamingDuration: '2.0s',
      usage: { inputTokens: 10000, cacheReadTokens: 40000, outputTokens: 200, thinkingOutputTokens: 50 },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 100000, estimatedTokensUsed: 48000 } }
    }
  });
  assert.equal(out.actual, 50200);
  assert.equal(out.budget, 100000);
  assert.equal(out.modelInputCap, null);
  assert.equal(out.status, 'reported');
  assert.equal(out.speed.ttft, 1.5);
  assert.equal(out.speed.duration, 3.5);
  assert.equal(out.speed.streamingTps, 100);
});

test('summarize derives modelInputCap from cascadeModelConfigs and computes percent against it', () => {
  const out = core.summarize({
    chatModel: {
      modelDisplayName: 'Gemini 4 Hydrogen',
      model: 'gemini-4-hydrogen',
      usage: { inputTokens: 57000, cacheReadTokens: 0, outputTokens: 0 },
      chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 100000 } }
    }
  }, {
    cascadeModelConfigs: [{ model: 'gemini-4-hydrogen', maxTokens: 1048576, maxOutputTokens: 262144 }]
  });
  assert.equal(out.budget, 100000);
  assert.equal(out.modelInputCap, 786432);
  assert.ok(Math.abs(out.percent - (57000 / 786432) * 100) < 0.001);
});

test('classifyRequestError detects context overflow', () => {
  const cls = core.classifyRequestError('maximum context length exceeded');
  assert.equal(cls.kind, 'context_overflow');
});

test('parseUserPlanStatus identifies tier and email', () => {
  const p = core.parseUserPlanStatus({
    userStatus: {
      email: 'dev@example.com',
      userTier: { name: 'Google AI Pro' },
      planStatus: { availableAiCredits: 420 }
    }
  });
  assert.equal(p.tierKey, 'pro');
  assert.equal(p.email, 'dev@example.com');
  assert.equal(p.aiCredits, 420);
});

test('parseStrictResetTimestamp and formatQuotaResetMeta reject epoch-0 and invalid calendar dates', () => {
  assert.equal(core.parseStrictResetTimestamp('1970-01-01T00:00:00Z'), null);
  assert.equal(core.parseStrictResetTimestamp('1970-01-01T00:00:00.000+00:00'), null);
  assert.equal(core.parseStrictResetTimestamp('2026-02-30T00:00:00Z'), null);
  assert.equal(core.parseStrictResetTimestamp('1970'), null);
  assert.equal(core.formatQuotaResetMeta('1970-01-01T00:00:00Z').hasResetTime, false);

  const valid = core.formatQuotaResetMeta('2026-12-01T12:00:00Z', Date.parse('2026-12-01T11:00:00Z'));
  assert.equal(valid.hasResetTime, true);
  assert.equal(valid.isResetPassed, false);
});

test('summarizeApiCost computes Gemini 4 Neon, GPT-OSS 120B, cacheSavingsUSD, and effectiveInputPerMillion', () => {
  const res = core.summarizeApiCost([
    { model: 'gemini-4-neon', inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 0 },
    { model: 'gpt-oss-120b', inputTokens: 1_000_000, cacheReadTokens: 0, outputTokens: 1_000_000 }
  ]);
  // Neon: $3.00 input + $0.15 cache = $3.15 (cache saved $3.00 - $0.15 = $2.85)
  // GPT-OSS: $0.09 input + $0.36 output = $0.45
  assert.equal(res.pricedCostUSD, 3.6);
  assert.equal(res.cacheSavingsUSD, 2.85);
  // Total prompt tokens = 3M, total input+cache cost = $3.24 -> $1.08 / 1M
  assert.equal(res.effectiveInputPerMillion, 1.08);
});
