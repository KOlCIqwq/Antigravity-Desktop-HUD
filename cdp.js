'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');

const LOOPBACK_RE = /^https?:\/\/127\.0\.0\.1:(\d+)$/;
const CANDIDATE_CDP_PORTS = [58321, 58322, 58323, 58324, 58325, 9222];

function normalizeLoopbackOrigin(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const origin = new URL(raw.trim()).origin;
    const m = origin.match(LOOPBACK_RE);
    const port = m ? Number(m[1]) : 0;
    return port >= 1 && port <= 65535 ? origin : null;
  } catch {
    return null;
  }
}

function getAppDataDir(opts = {}) {
  if (opts.appDataDir) return path.resolve(opts.appDataDir);
  if (process.env.APPDATA) return process.env.APPDATA;
  const home = opts.homeDir || os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (process.platform === 'win32') return path.join(home, 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(home, '.config');
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

function discoverLiveDaemonHubs(opts = {}) {
  const daemonDir = opts.daemonDir || path.join(opts.homeDir || os.homedir(), '.gemini', 'antigravity', 'daemon');
  if (!fs.existsSync(daemonDir)) return [];
  const hubs = [];
  for (const name of fs.readdirSync(daemonDir)) {
    if (!/^hub_.*\.json$/i.test(name)) continue;
    const filePath = path.join(daemonDir, name);
    try {
      const st = fs.statSync(filePath);
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const csrfToken = typeof raw?.csrfToken === 'string' ? raw.csrfToken.trim() : '';
      const httpsPort = Number(raw?.httpsPort) || 0;
      const httpPort = Number(raw?.httpPort) || 0;
      if (!csrfToken || (!httpsPort && !httpPort) || !isPidAlive(raw?.pid)) continue;
      hubs.push({
        origin: httpsPort ? `https://127.0.0.1:${httpsPort}` : `http://127.0.0.1:${httpPort}`,
        httpOrigin: httpPort ? `http://127.0.0.1:${httpPort}` : null,
        httpsPort,
        httpPort,
        csrfToken,
        pid: Number(raw.pid),
        mtimeMs: Number(st.mtimeMs) || 0
      });
    } catch {}
  }
  return hubs.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function discoverDaemonHubTokenForOrigin(origin, opts = {}) {
  const norm = normalizeLoopbackOrigin(origin);
  if (!norm) return '';
  const port = Number(new URL(norm).port);
  for (const hub of discoverLiveDaemonHubs(opts)) {
    if (hub.httpsPort === port || hub.httpPort === port) return hub.csrfToken;
  }
  return '';
}

function rpcCall(origin, method, body, token, signal = null, timeoutMs = 20000) {
  const url = method ? `${origin}/exa.language_server_pb.LanguageServerService/${method}` : `${origin}/`;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const err = new Error('Request aborted');
      err.name = 'AbortError';
      return reject(err);
    }
    const transport = url.startsWith('https:') ? https : http;
    const req = transport.request(url, {
      agent: false,
      rejectUnauthorized: false,
      method: method ? 'POST' : 'GET',
      headers: method ? {
        'Content-Type': 'application/json',
        'Connect-Protocol-Version': '1',
        'x-codeium-csrf-token': token || ''
      } : {},
      ...(signal ? { signal } : {})
    }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', c => {
        size += c.length;
        if (size > 96 * 1024 * 1024) {
          req.destroy(new Error('Response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        if (!method) return resolve(text);
        try { resolve(JSON.parse(text)); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Request timeout')));
    req.on('error', reject);
    req.end(method ? JSON.stringify(body || {}) : undefined);
  });
}

async function resolveCsrfToken(origin, opts = {}) {
  const hubToken = discoverDaemonHubTokenForOrigin(origin, opts);
  if (hubToken) return hubToken;
  try {
    const html = await rpcCall(origin, null, null, null, opts.signal);
    const m = html.match(/window\.__APP_CONFIG__\s*=\s*(\{.*?\})\s*;/s);
    if (m) return JSON.parse(m[1]).csrfToken || '';
  } catch {}
  return '';
}

function fetchJson(url, timeoutMs = 1500) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('CDP timeout')));
    req.on('error', reject);
  });
}

function getDevToolsPort(opts = {}) {
  const portFile = path.join(getAppDataDir(opts), 'Antigravity', 'DevToolsActivePort');
  try {
    const first = fs.readFileSync(portFile, 'utf8').split(/\r?\n/)[0];
    const port = Number(first);
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

async function discoverCdp(explicitPort = null, opts = {}) {
  const ports = [];
  if (explicitPort) ports.push(Number(explicitPort));
  const active = getDevToolsPort(opts);
  if (active && !ports.includes(active)) ports.push(active);
  for (const p of CANDIDATE_CDP_PORTS) {
    if (!ports.includes(p)) ports.push(p);
  }
  for (const port of ports) {
    try {
      const list = await fetchJson(`http://127.0.0.1:${port}/json/list`, 1200);
      if (Array.isArray(list)) {
        const pages = list.filter(t => t?.type === 'page' && t.webSocketDebuggerUrl);
        if (pages.length) return { port, pages };
      }
    } catch {}
  }
  return null;
}

async function createCdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP WebSocket connect timeout')), 4000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', err => { clearTimeout(timer); reject(err?.error || new Error('CDP WebSocket error')); }, { once: true });
  });

  ws.addEventListener('message', ev => {
    try {
      const msg = JSON.parse(String(ev.data));
      if (!msg.id || !pending.has(msg.id)) return;
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
      else resolve(msg.result);
    } catch {}
  });

  ws.addEventListener('close', () => {
    for (const { reject } of pending.values()) reject(new Error('CDP closed'));
    pending.clear();
  });

  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async function evaluate(expression) {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res?.exceptionDetails) {
      throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Evaluation failed');
    }
    return res?.result?.value;
  }

  function close() {
    try { ws.close(); } catch {}
  }

  return { send, evaluate, close };
}

async function connectLocalServer(opts = {}) {
  let origin = normalizeLoopbackOrigin(opts.origin);
  let token = '';
  if (!origin) {
    const hubs = discoverLiveDaemonHubs(opts);
    if (hubs.length) {
      origin = hubs[0].origin;
      token = hubs[0].csrfToken;
    }
  }
  if (!origin) throw new Error('No live Antigravity language server found');
  if (!token) token = await resolveCsrfToken(origin, opts);

  return {
    origin,
    token,
    async call(method, body = {}, signal = null) {
      try {
        return await rpcCall(origin, method, body, token, signal);
      } catch (err) {
        const msg = String(err?.message || '');
        if (/HTTP 400|EPROTO|wrong version number|ECONNRESET/i.test(msg) && !signal?.aborted) {
          const flipped = origin.startsWith('http://')
            ? origin.replace(/^http:\/\//, 'https://')
            : origin.replace(/^https:\/\//, 'http://');
          try {
            const res = await rpcCall(flipped, method, body, token, signal);
            origin = flipped;
            return res;
          } catch {}
        }
        if (/HTTP 40[13]/.test(msg) && !signal?.aborted) {
          token = await resolveCsrfToken(origin, { ...opts, signal });
          return await rpcCall(origin, method, body, token, signal);
        }
        throw err;
      }
    }
  };
}

module.exports = {
  normalizeLoopbackOrigin,
  getAppDataDir,
  discoverLiveDaemonHubs,
  discoverDaemonHubTokenForOrigin,
  resolveCsrfToken,
  rpcCall,
  discoverCdp,
  createCdpClient,
  connectLocalServer,
  connect: connectLocalServer
};
