'use strict';
const http = require('http');
const crypto = require('crypto');
const collector = require('./collector');
const insights = require('./insights');
const { normalizeLoopbackOrigin, discoverLiveDaemonHubs } = require('./cdp');

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function resolveTargetOrigin(bodyOrigin, headerOrigin) {
  return (
    normalizeLoopbackOrigin(bodyOrigin) ||
    normalizeLoopbackOrigin(headerOrigin) ||
    discoverLiveDaemonHubs()[0]?.origin ||
    ''
  );
}

function startLiveServer() {
  const token = crypto.randomBytes(16).toString('hex');
  const server = http.createServer(async (req, res) => {
    const rawOrigin = typeof req.headers.origin === 'string' ? req.headers.origin.trim() : '';
    res.setHeader('Access-Control-Allow-Origin', rawOrigin || '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-AG-Context-Token');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.headers['x-ag-context-token'] !== token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    }
    try {
      const body = await readBody(req);
      const targetOrigin = resolveTargetOrigin(body.origin, rawOrigin);
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
      };

      if (req.url === '/runtime-info') {
        return sendJson({ ok: true, backendVersion: '0.8.8', backendSource: 'live-host', pid: process.pid });
      }
      if (req.url === '/scan') {
        const data = await collector.collect(targetOrigin, body.id || body.cascadeId, { force: body.force === true });
        return sendJson({ ok: true, data: { ...(data || {}), backendVersion: '0.8.8', backendSource: 'live-host' } });
      }
      if (req.url === '/quota') {
        const resData = await collector.fetchQuotaSnapshotFromHost({
          force: body.force === true,
          origin: targetOrigin,
          backendSource: 'live-host',
          currentModel: body.currentModel || null,
          browsePoolKey: body.browsePoolKey || null
        });
        const { _raw, ...safeData } = resData || {};
        return sendJson({ ok: true, data: safeData });
      }
      if (req.url === '/token-history') {
        const data = await collector.collectTokenHistoryAsync({ force: body.force === true });
        return sendJson({ ok: true, data });
      }
      if (req.url === '/session-timeline') {
        const opts = body.options && typeof body.options === 'object' ? body.options : body;
        const data = await collector.collectSessionTimelineAsync(body.id || '', { ...opts, origin: targetOrigin });
        return sendJson({ ok: true, data: { ...(data || {}), backendVersion: '0.8.8', backendSource: 'live-host' } });
      }
      if (req.url === '/session-deep-dive') {
        const opts = body.options && typeof body.options === 'object' ? body.options : body;
        const data = await insights.collectSessionDeepDive(targetOrigin, body.id || '', {
          force: opts?.force === true,
          ...(Array.isArray(opts?.cascadeModelConfigs) ? { cascadeModelConfigs: opts.cascadeModelConfigs } : {})
        });
        return sendJson({ ok: true, data: { ...(data || {}), backendVersion: '0.8.8', backendSource: 'live-host' } });
      }
      if (req.url === '/cross-session-insights') {
        const opts = body.options && typeof body.options === 'object' ? body.options : body;
        const data = await insights.collectCrossSessionInsights(targetOrigin, { force: opts?.force === true });
        return sendJson({ ok: true, data: { ...(data || {}), backendVersion: '0.8.8', backendSource: 'live-host' } });
      }
      if (req.url === '/record-calls') {
        const resCall = await collector.recordModelCallsAsync(Array.isArray(body.calls) ? body.calls : []);
        const changed = (resCall && typeof resCall === 'object') ? !!resCall.changed : !!resCall;
        return sendJson({ ok: true, changed });
      }
      if (req.url === '/get-settings') return sendJson(collector.getPluginSettings(body));
      if (req.url === '/save-settings') return sendJson(collector.savePluginSettings(body));
      return sendJson({ ok: false, disabled: true });
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, token, server, close: () => server.close() });
    });
  });
}

module.exports = { startLiveServer };
