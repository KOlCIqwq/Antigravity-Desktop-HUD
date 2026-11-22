'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const collector = require('../collector');

test('collectTokenHistoryAsync aggregates transcript.jsonl usage in temp dir', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-hist-'));
  const prevState = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = path.join(tmp, 'state');
  try {
    const logDir = path.join(tmp, 'brain', '11111111-1111-1111-1111-111111111111', '.system_generated', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'transcript.jsonl'), [
      JSON.stringify({ timestamp: '2026-11-21T10:00:00Z', model: 'gemini-4-hydrogen', usage: { inputTokens: 1000, cacheReadTokens: 2000, outputTokens: 500 } }),
      JSON.stringify({ timestamp: '2026-11-21T11:00:00Z', model: 'gemini-3.8-flash', usage: { inputTokens: 500, outputTokens: 100 } })
    ].join('\n'));

    const res = await collector.collectTokenHistoryAsync({ agDir: tmp, force: true });
    assert.ok(res && typeof res.summary === 'object');
    assert.ok(res.dailyMap && typeof res.dailyMap === 'object');
  } finally {
    if (prevState === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevState;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getPluginSettings and savePluginSettings persist to state dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-set-'));
  const prevState = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = tmp;
  try {
    const saved = collector.savePluginSettings({ panelLanguage: 'en' });
    assert.equal(saved.ok, true);
    const loaded = collector.getPluginSettings();
    assert.equal(loaded.ok, true);
    assert.equal(loaded.panelLanguage, 'en');
  } finally {
    if (prevState === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevState;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('fetchQuotaSnapshotFromHost ignores empty {} or [] GetUserStatus payloads', async () => {
  collector.resetQuotaHostCacheForTest();
  const res = await collector.fetchQuotaSnapshotFromHost({
    force: true,
    origin: 'https://127.0.0.1:19999',
    connect: async () => ({
      call: async (method) => (method === 'GetUserStatus' ? {} : [])
    })
  });
  assert.equal(res.planStatus ?? null, null);
});

test('collectCrossSessionInsights merges brain/ sessions even when trajectorySummaries is non-empty', async () => {
  const insights = require('../insights');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-insights-'));
  try {
    const cid1 = '11111111-1111-1111-1111-111111111111';
    const cid2 = '22222222-2222-2222-2222-222222222222';
    const logDir2 = path.join(tmp, 'brain', cid2, '.system_generated', 'logs');
    fs.mkdirSync(logDir2, { recursive: true });
    fs.writeFileSync(path.join(logDir2, 'transcript.jsonl'), JSON.stringify({
      type: 'USER_INPUT',
      content: 'First user prompt that should not override annotation title',
      usage: { inputTokens: 100, outputTokens: 20 }
    }) + '\n');
    const annDir = path.join(tmp, 'annotations');
    fs.mkdirSync(annDir, { recursive: true });
    fs.writeFileSync(path.join(annDir, `${cid2}.pbtxt`), 'title:"Summary Tab Title" last_user_view_time:{seconds:1795345274 nanos:0}\n');

    const logDir1 = path.join(tmp, 'brain', cid1, '.system_generated', 'logs');
    fs.mkdirSync(logDir1, { recursive: true });
    fs.writeFileSync(path.join(logDir1, 'transcript.jsonl'), JSON.stringify({
      type: 'USER_INPUT',
      content: 'Chat 1',
      usage: { inputTokens: 100, outputTokens: 20 }
    }) + '\n');

    const res = await insights.collectCrossSessionInsights('', {
      agDir: tmp,
      force: true,
      trajectorySummaries: { [cid1]: { stepCount: 2, lastModifiedTime: '2026-11-22T10:00:00Z' } }
    });
    assert.equal(res.sessions.length, 2);
    const s2 = res.sessions.find(s => s.cascadeId === cid2);
    assert.equal(s2.title, 'Summary Tab Title');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
