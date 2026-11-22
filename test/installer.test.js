'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createPackage, extractFile } = require('../asar');
const { install, restore, isAsarPatched } = require('../installer');
const { startLiveServer } = require('../live-server');
const { assembleRenderer } = require('../scripts/build-renderer');

test('live-server responds to /runtime-info, /token-history, /get-settings, and CORS preflight', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-live-test-'));
  const prevState = process.env.AG_METER_STATE_DIR;
  process.env.AG_METER_STATE_DIR = tmp;
  const live = await startLiveServer();
  try {
    const optRes = await fetch(`http://127.0.0.1:${live.port}/quota`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://127.0.0.1:45678' }
    });
    assert.equal(optRes.status, 204);
    assert.equal(optRes.headers.get('access-control-allow-private-network'), 'true');

    const headers = { 'Content-Type': 'application/json', 'X-AG-Context-Token': live.token, Origin: 'http://127.0.0.1:45678' };
    const rt = await (await fetch(`http://127.0.0.1:${live.port}/runtime-info`, { method: 'POST', headers, body: '{}' })).json();
    assert.equal(rt.ok, true);

    const settings = await (await fetch(`http://127.0.0.1:${live.port}/get-settings`, { method: 'POST', headers, body: '{}' })).json();
    assert.equal(settings.ok, true);

    const hist = await (await fetch(`http://127.0.0.1:${live.port}/token-history`, { method: 'POST', headers, body: '{}' })).json();
    assert.equal(hist.ok, true);
    assert.ok(hist.data && typeof hist.data.summary === 'object');
  } finally {
    live.close();
    if (prevState === undefined) delete process.env.AG_METER_STATE_DIR;
    else process.env.AG_METER_STATE_DIR = prevState;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('install and restore round-trip on mock app.asar', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-asar-test-'));
  const prevState = process.env.CONTEXT_BAR_STATE_DIR;
  process.env.CONTEXT_BAR_STATE_DIR = path.join(tmp, 'state');

  try {
    assert.ok(assembleRenderer(path.resolve(__dirname, '..')).length > 1000);
    const srcDir = path.join(tmp, 'app');
    fs.mkdirSync(path.join(srcDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'dist', 'utils.js'), '"use strict";\nasync function openWin(win, url) {\n  await win.loadURL(url);\n}\n');
    fs.writeFileSync(path.join(srcDir, 'dist', 'preload.js'), '"use strict";\nconst electron_1 = require("electron");\n');

    const asarPath = path.join(tmp, 'app.asar');
    createPackage(srcDir, asarPath);
    assert.equal(isAsarPatched(asarPath), false);

    const inst = install({ path: asarPath });
    assert.equal(inst.ok, true);
    assert.equal(isAsarPatched(asarPath), true);
    assert.ok(extractFile(asarPath, 'dist/utils.js').toString('utf8').includes('await win.loadURL(url);'));
    assert.ok(extractFile(asarPath, 'dist/context-bar-main.js').length > 0);

    const rest = restore({ path: asarPath });
    assert.equal(rest.ok, true);
    assert.equal(isAsarPatched(asarPath), false);
  } finally {
    if (prevState === undefined) delete process.env.CONTEXT_BAR_STATE_DIR;
    else process.env.CONTEXT_BAR_STATE_DIR = prevState;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
