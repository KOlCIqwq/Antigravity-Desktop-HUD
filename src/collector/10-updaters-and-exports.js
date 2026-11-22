// ============================================================================
// One-click CLI launcher mode has been extracted to meter-cli-launcher.js; this file preserves full backward-compatible exports
// ============================================================================

// ============================================================================
// Online updater module (GitHub Releases probing, SHA-256 verification, and zero-dependency hot installation)
// ============================================================================

const OFFICIAL_REPO = 'elviscjn-cjn/antigravity-context-viewer';
const OFFICIAL_RELEASES_API = `https://api.github.com/repos/${OFFICIAL_REPO}/releases`;
const OFFICIAL_RELEASES_WEB_BASE = `https://github.com/${OFFICIAL_REPO}/releases`;
const OFFICIAL_RELEASES_ATOM = `${OFFICIAL_RELEASES_WEB_BASE}.atom`;
const OFFICIAL_RELEASES_LATEST = `${OFFICIAL_RELEASES_WEB_BASE}/latest`;
const MAX_GITHUB_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_GITHUB_STREAM_BYTES = 100 * 1024 * 1024;

let cachedUpdateCheck = null;
let cachedUpdateCheckAt = 0;
let isApplyingUpdate = false;

/**
 * Verify that a download redirect URL belongs to a trusted GitHub / official asset CDN (resolving relative paths against baseUrl)
 */
function isAllowedDownloadRedirectUrl(targetUrlStr, baseUrlStr = null) {
  try {
    if (!targetUrlStr || typeof targetUrlStr !== 'string') return false;
    const u = baseUrlStr ? new URL(targetUrlStr, baseUrlStr) : new URL(targetUrlStr);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com')) return true;
    if (host === 'objects.githubusercontent.com' || host.endsWith('.githubusercontent.com')) return true;
    if (host.endsWith('.amazonaws.com') && host.includes('github-production-release-asset')) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Strictly verify that an asset download URL belongs to the official repository release path; block path traversal and external redirects
 */
function isOfficialAssetDownloadUrl(urlStr, filename, expectedTag = null) {
  if (!urlStr || typeof urlStr !== 'string') return false;
  if (urlStr.includes('\\') || urlStr.includes('..') || /%2e%2e|%2f|%5c/i.test(urlStr)) return false;
  try {
    const u = new URL(urlStr);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return false;
    if (u.username || u.password || u.search || u.hash) return false;
    const expectedPrefix = `/${OFFICIAL_REPO}/releases/download/`;
    if (!u.pathname.startsWith(expectedPrefix)) return false;
    const rest = u.pathname.slice(expectedPrefix.length);
    const segments = rest.split('/');
    if (segments.length !== 2 || !segments[0] || !segments[1]) return false;
    if (segments.some(seg => seg === '.' || seg === '..' || seg.includes('..'))) return false;
    if (expectedTag && decodeURIComponent(segments[0]) !== expectedTag && segments[0] !== expectedTag) return false;
    if (filename && segments[1] !== filename) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Distinguish between Node and Electron runtime environments and resolve an available Node CLI execution environment
 */
function resolveNodeRuntime() {
  const isElectron = Boolean(process.versions && process.versions.electron);
  if (isElectron) {
    return {
      runtime: process.execPath,
      args: [],
      env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
      isElectron: true
    };
  }
  const cleanEnv = Object.assign({}, process.env);
  delete cleanEnv.ELECTRON_RUN_AS_NODE;
  return {
    runtime: process.execPath || 'node',
    args: [],
    env: cleanEnv,
    isElectron: false
  };
}

// Tunnel establishment and timeout classification helpers have been unified into meter-proxy.js exports and imported at the top of this file.


function requestGithubUrl(rawUrl, options = {}) {
  return new Promise((resolve, reject) => {
    try {
      const startMs = Date.now();
      const timeoutMs = options.timeout || 8000;
      const redirectCount = options.redirectCount || 0;
      const parsedUrl = new URL(rawUrl);
      const isApiHost = parsedUrl.hostname.toLowerCase() === 'api.github.com';
      const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
        ? options.maxBytes
        : (options.streamTo ? MAX_GITHUB_STREAM_BYTES : MAX_GITHUB_TEXT_BYTES);
      const phase = options.phase || (isApiHost ? 'release_query' : (options.streamTo ? 'download_asset' : 'request'));
      const hopTrace = Array.isArray(options._hopTrace) ? options._hopTrace : [];

      // Credentials may only be sent to api.github.com; never forward them to web pages, redirect targets, or external CDNs
      const rawHeaders = Object.assign({}, options.headers || {});
      for (const hKey of Object.keys(rawHeaders)) {
        if (!isApiHost && hKey.toLowerCase() === 'authorization') {
          delete rawHeaders[hKey];
        }
      }
      const headers = Object.assign({
        'User-Agent': `AntigravityContextMeter/${PROJECT_VERSION}`,
        'Accept': isApiHost ? 'application/vnd.github.v3+json' : (options.accept || '*/*')
      }, rawHeaders);
      const token = options.token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
      if (isApiHost && token && !Object.keys(headers).some(k => k.toLowerCase() === 'authorization')) {
        headers.Authorization = `Bearer ${String(token).trim()}`;
      }

      const proxyInfo = options.useProxy === false
        ? null
        : detectProxyConfig(options.proxyConfigOptions || {});
      const pluginProxyConfigured = Boolean(proxyInfo && proxyInfo.enabled && proxyInfo.httpProxy);
      const bypassMatched = pluginProxyConfigured
        ? Boolean(matchesNoProxy(parsedUrl.hostname, proxyInfo.noProxy))
        : false;
      const parsedProxy = pluginProxyConfigured && !bypassMatched
        ? parseAndValidateProxyUrl(proxyInfo.httpProxy)
        : null;
      const willUseProxyTunnel = Boolean(pluginProxyConfigured && !bypassMatched);
      const hopEntry = {
        phase,
        hop: redirectCount + 1,
        host: parsedUrl.hostname,
        port: Number(parsedUrl.port) || 443,
        proxySource: willUseProxyTunnel
          ? 'plugin_config'
          : (bypassMatched ? 'plugin_bypass' : (options.useProxy === false ? 'disabled' : 'direct')),
        proxyProtocol: parsedProxy?.ok ? parsedProxy.protocol : 'direct',
        proxyEndpoint: (pluginProxyConfigured && !bypassMatched) ? redactProxyUrl(proxyInfo.httpProxy) : null,
        bypassMatched,
        outcome: 'pending',
        timeoutPhase: null,
        durationMs: 0,
        error: null
      };
      hopTrace.push(hopEntry);

      let settledOuter = false;
      const finishResolve = val => {
        if (settledOuter) return;
        settledOuter = true;
        hopEntry.durationMs = Date.now() - startMs;
        if (hopEntry.outcome === 'pending') hopEntry.outcome = 'ok';
        resolve(val);
      };
      const finishReject = err => {
        if (settledOuter) return;
        settledOuter = true;
        hopEntry.durationMs = Date.now() - startMs;
        hopEntry.outcome = 'error';
        hopEntry.timeoutPhase = hopEntry.timeoutPhase || classifyRequestTimeoutPhase(err, willUseProxyTunnel);
        hopEntry.error = sanitizeDiagnosticErrorText(err);
        if (err && typeof err === 'object' && !err.diagnostics) {
          err.diagnostics = {
            phase,
            targetHost: hopEntry.host,
            targetPort: hopEntry.port,
            proxySource: hopEntry.proxySource,
            proxyProtocol: hopEntry.proxyProtocol,
            proxyEndpoint: hopEntry.proxyEndpoint,
            bypassMatched: hopEntry.bypassMatched,
            timeoutPhase: hopEntry.timeoutPhase,
            hops: hopTrace.map(h => ({ ...h }))
          };
        }
        try {
          console.warn('[Update Diagnostics]', JSON.stringify({
            phase: hopEntry.phase,
            hop: hopEntry.hop,
            host: hopEntry.host,
            port: hopEntry.port,
            proxySource: hopEntry.proxySource,
            proxyProtocol: hopEntry.proxyProtocol,
            proxyEndpoint: hopEntry.proxyEndpoint,
            bypassMatched: hopEntry.bypassMatched,
            timeoutPhase: hopEntry.timeoutPhase,
            durationMs: hopEntry.durationMs,
            error: hopEntry.error
          }));
        } catch { }
        reject(err);
      };

      if (willUseProxyTunnel) {
        if (!parsedProxy || !parsedProxy.ok) {
          return finishReject(new Error(`代理配置无效: ${parsedProxy?.error || '无法解析代理地址'}`));
        }
        const targetPort = Number(parsedUrl.port) || 443;
        const tunnelPromise = (parsedProxy.protocol === 'socks5:' || parsedProxy.protocol === 'socks5h:')
          ? openSocks5Tunnel(parsedProxy, parsedUrl.hostname, targetPort, timeoutMs)
          : openHttpConnectTunnel(parsedProxy, parsedUrl.hostname, targetPort, timeoutMs, {
            ca: options.proxyCa || options.ca,
            rejectUnauthorized: options.proxyRejectUnauthorized
          });
        // When proxy is enabled and bypass rules do not match, tunnel failure must fail immediately; never silently fall back to direct connection
        tunnelPromise.then(
          socket => doRequest(socket),
          err => {
            hopEntry.timeoutPhase = 'proxy_tunnel_connect';
            finishReject(err);
          }
        );
        return;
      }

      doRequest(null);

      function doRequest(tunnelSocket) {
        let tunnelConsumed = false;
        const releaseUnusedTunnel = () => {
          if (tunnelSocket && !tunnelConsumed && !tunnelSocket.destroyed) {
            try { tunnelSocket.destroy(); } catch { }
          }
        };
        const settleResolve = val => {
          releaseUnusedTunnel();
          finishResolve(val);
        };
        const settleReject = err => {
          releaseUnusedTunnel();
          finishReject(err);
        };
        const reqOpts = {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: parsedUrl.pathname + parsedUrl.search,
          method: options.method || 'GET',
          headers
        };
        if (options.ca) reqOpts.ca = options.ca;
        if (typeof options.rejectUnauthorized === 'boolean') {
          reqOpts.rejectUnauthorized = options.rejectUnauthorized;
        }
        if (tunnelSocket) {
          const tls = require('tls');
          // Node https.request ignores reqOpts.createConnection when agent:false; must bind a dedicated Agent with createConnection
          const tunnelAgent = new https.Agent({ keepAlive: false });
          tunnelAgent.createConnection = () => {
            tunnelConsumed = true;
            const tlsOpts = { socket: tunnelSocket, servername: parsedUrl.hostname };
            if (options.ca) tlsOpts.ca = options.ca;
            if (typeof options.rejectUnauthorized === 'boolean') {
              tlsOpts.rejectUnauthorized = options.rejectUnauthorized;
            }
            return tls.connect(tlsOpts);
          };
          reqOpts.agent = tunnelAgent;
        }

        const req = https.request(reqOpts, res => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const rawLocation = String(res.headers.location);
            let nextUrlStr = null;
            try {
              nextUrlStr = new URL(rawLocation, parsedUrl).toString();
            } catch {
              nextUrlStr = null;
            }
            res.resume();
            if (redirectCount >= 5) {
              if (options.streamTo) { try { options.streamTo.destroy(); } catch { } }
              return settleReject(new Error('GitHub 请求重定向次数过多 (>5)'));
            }
            const redirectOk = typeof options._isAllowedRedirectUrl === 'function'
              ? options._isAllowedRedirectUrl(nextUrlStr, parsedUrl.toString())
              : isAllowedDownloadRedirectUrl(nextUrlStr, parsedUrl.toString());
            if (!nextUrlStr || !redirectOk) {
              if (options.streamTo) { try { options.streamTo.destroy(); } catch { } }
              return settleReject(new Error(`下载重定向地址不受信任或协议不安全: ${rawLocation}`));
            }
            // Strip old headers and Authorization, then re-evaluate credential attachment and proxy bypass based on the new target domain
            hopEntry.outcome = 'redirect';
            hopEntry.durationMs = Date.now() - startMs;
            try { hopEntry.redirectToHost = new URL(nextUrlStr).hostname; } catch {}
            const nextHeaders = Object.assign({}, options.headers || {});
            for (const hKey of Object.keys(nextHeaders)) {
              if (hKey.toLowerCase() === 'authorization') delete nextHeaders[hKey];
            }
            const nextOptions = Object.assign({}, options, {
              headers: nextHeaders,
              redirectCount: redirectCount + 1,
              phase,
              _hopTrace: hopTrace
            });
            releaseUnusedTunnel();
            return requestGithubUrl(nextUrlStr, nextOptions).then(finishResolve, finishReject);
          }
          if (res.statusCode !== 200) {
            if (options.streamTo) { try { options.streamTo.destroy(); } catch { } }
            let errBody = '';
            res.on('data', c => {
              if (errBody.length < 1024) errBody += c;
            });
            res.on('end', () => {
              const err = new Error(`GitHub HTTP ${res.statusCode}: ${errBody.slice(0, 150)}`);
              err.statusCode = res.statusCode;
              err.responseBody = errBody;
              settleReject(err);
            });
            return;
          }
          let totalBytes = 0;
          let abortedOrInvalid = false;
          const rawContentLen = !res.headers['content-encoding'] ? res.headers['content-length'] : null;
          const expectedContentLen = (rawContentLen != null && /^\d+$/.test(String(rawContentLen).trim()))
            ? Number(String(rawContentLen).trim())
            : null;

          const validateResponseComplete = () => {
            if (res.complete === false || res.aborted) {
              return new Error('响应流未完整结束，连接可能已提前中断');
            }
            if (expectedContentLen !== null && totalBytes !== expectedContentLen) {
              return new Error(`响应长度不完整 (期望 ${expectedContentLen} 字节，实际接收 ${totalBytes} 字节)`);
            }
            return null;
          };

          if (options.streamTo) {
            let resEnded = false;
            let streamFinished = false;
            const tryResolveStream = () => {
              if (abortedOrInvalid || !resEnded || !streamFinished) return;
              const integrityErr = validateResponseComplete();
              if (integrityErr) {
                abortedOrInvalid = true;
                try { options.streamTo.destroy(integrityErr); } catch { }
                return settleReject(integrityErr);
              }
              settleResolve();
            };

            res.on('data', chunk => {
              totalBytes += chunk.length;
              if (totalBytes > maxBytes && !abortedOrInvalid) {
                abortedOrInvalid = true;
                const err = new Error(`响应体超出大小限制 (>${maxBytes} 字节)`);
                err.code = 'RESPONSE_TOO_LARGE';
                if (typeof res.destroy === 'function') res.destroy(err);
                try { options.streamTo.destroy(err); } catch { }
                settleReject(err);
              }
            });
            res.on('aborted', () => {
              if (abortedOrInvalid) return;
              abortedOrInvalid = true;
              const err = new Error('下载响应流意外中断 (aborted)');
              try { options.streamTo.destroy(err); } catch { }
              settleReject(err);
            });
            res.on('end', () => {
              resEnded = true;
              tryResolveStream();
            });
            res.on('close', () => {
              if (!resEnded && !abortedOrInvalid && !res.complete) {
                abortedOrInvalid = true;
                const err = new Error('下载连接未完整结束即关闭');
                try { options.streamTo.destroy(err); } catch { }
                settleReject(err);
              }
            });
            res.on('error', err => {
              abortedOrInvalid = true;
              try { options.streamTo.destroy(err); } catch { }
              settleReject(err);
            });
            options.streamTo.on('finish', () => {
              streamFinished = true;
              tryResolveStream();
            });
            options.streamTo.on('error', err => {
              abortedOrInvalid = true;
              settleReject(err);
            });
            res.pipe(options.streamTo);
          } else {
            const chunks = [];
            res.on('data', chunk => {
              const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              totalBytes += buf.length;
              if (totalBytes > maxBytes) {
                abortedOrInvalid = true;
                const err = new Error(`响应体超出大小限制 (>${maxBytes} 字节)`);
                err.code = 'RESPONSE_TOO_LARGE';
                if (typeof res.destroy === 'function') res.destroy(err);
                settleReject(err);
                return;
              }
              chunks.push(buf);
            });
            res.on('aborted', () => {
              if (abortedOrInvalid) return;
              abortedOrInvalid = true;
              settleReject(new Error('响应流意外中断 (aborted)'));
            });
            res.on('end', () => {
              if (abortedOrInvalid) return;
              const integrityErr = validateResponseComplete();
              if (integrityErr) {
                abortedOrInvalid = true;
                return settleReject(integrityErr);
              }
              const data = Buffer.concat(chunks).toString('utf8');
              if (options.resolveWithMeta) {
                settleResolve({ data, finalUrl: parsedUrl.toString(), statusCode: res.statusCode });
              } else {
                settleResolve(data);
              }
            });
            res.on('close', () => {
              if (!abortedOrInvalid && !res.complete) {
                abortedOrInvalid = true;
                settleReject(new Error('响应连接未完整结束即关闭'));
              }
            });
            res.on('error', err => {
              if (!abortedOrInvalid) settleReject(err);
            });
          }
        });

        req.setTimeout(timeoutMs, () => {
          if (options.streamTo) { try { options.streamTo.destroy(); } catch { } }
          req.destroy(new Error(`请求超时 (${timeoutMs}ms)`));
        });
        req.on('error', err => {
          if (options.streamTo) { try { options.streamTo.destroy(); } catch { } }
          settleReject(err);
        });
        if (options.body) req.write(options.body);
        req.end();
      }
    } catch (e) {
      reject(e);
    }
  });
}

function getInstalledMeterVersion(options = {}) {
  try {
    if (options && options.installedVersion) return String(options.installedVersion);
    const { getStateDir, findAsarPath } = require('./asar-engine');
    const stateDir = getStateDir();

    let targetAsar = null;
    try {
      targetAsar = options.asarPath || findAsarPath(options.customPath || null);
    } catch { }

    const candidatePaths = [
      options && options.installationJsonPath,
      path.join(stateDir, 'installation.json'),
      path.join(__dirname, 'installation.json')
    ].filter(Boolean);

    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (manifest && manifest.meterVersion) {
          // Strictly verify that the install target recorded in the manifest matches the current host target
          if (targetAsar && manifest.installed) {
            try {
              const manifestTarget = path.resolve(manifest.installed).toLowerCase();
              const currentTarget = path.resolve(targetAsar).toLowerCase();
              if (manifestTarget !== currentTarget) {
                continue; // Stale record belonging to another host path; never trust it
              }
            } catch {
              continue;
            }
          }
          if (manifest.installed && !fs.existsSync(manifest.installed)) {
            continue; // Recorded physical file no longer exists; treat as an invalid record
          }
          return String(manifest.meterVersion);
        }
      }
    }
  } catch { }
  return null;
}

function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, dec) => {
      const code = Number(dec);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = Number.parseInt(hex, 16);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    })
    .replace(/&amp;/g, '&');
}

function stripHtmlToPlainText(rawHtml) {
  const decoded = decodeHtmlEntities(rawHtml);
  return decoded
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(?:p|div|li|h[1-6]|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseReleasesAtom(xmlText) {
  if (!xmlText || typeof xmlText !== 'string' || !/<feed\b/i.test(xmlText) || !/<entry\b/i.test(xmlText)) {
    throw new Error('releases.atom 响应结构异常，未能解析版本条目');
  }
  const releases = [];
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xmlText)) !== null) {
    const entryXml = match[1];
    const linkMatch = entryXml.match(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/i);
    const titleMatch = entryXml.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
    const idMatch = entryXml.match(/<id\b[^>]*>([\s\S]*?)<\/id>/i);
    const updatedMatch = entryXml.match(/<updated\b[^>]*>([\s\S]*?)<\/updated>/i);
    const contentMatch = entryXml.match(/<content\b[^>]*>([\s\S]*?)<\/content>/i);

    let tagName = '';
    let htmlUrl = '';
    if (linkMatch) {
      try {
        const u = new URL(decodeHtmlEntities(linkMatch[1]), 'https://github.com');
        const expectedPrefix = `/${OFFICIAL_REPO}/releases/tag/`;
        if (u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname.startsWith(expectedPrefix)) {
          tagName = decodeURIComponent(u.pathname.slice(expectedPrefix.length).split('/')[0] || '').trim();
          htmlUrl = `${OFFICIAL_RELEASES_WEB_BASE}/tag/${encodeURIComponent(tagName)}`;
        }
      } catch { }
    }
    if (!tagName && idMatch) {
      const idText = decodeHtmlEntities(idMatch[1]).trim();
      const parts = idText.split('/');
      const cand = parts[parts.length - 1]?.trim();
      if (cand && /^v?\d+\.\d+\.\d+/.test(cand)) tagName = cand;
    }
    if (!tagName && titleMatch) {
      const titleText = decodeHtmlEntities(titleMatch[1]).trim();
      const verToken = titleText.match(/\bv?\d+\.\d+\.\d+\b/);
      if (verToken) tagName = verToken[0];
    }
    if (!tagName) continue;
    if (!htmlUrl) htmlUrl = `${OFFICIAL_RELEASES_WEB_BASE}/tag/${encodeURIComponent(tagName)}`;

    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : tagName;
    const body = contentMatch ? stripHtmlToPlainText(contentMatch[1]) : '';
    const publishedAt = updatedMatch ? decodeHtmlEntities(updatedMatch[1]).trim() : '';
    const isPre = /alpha|beta|rc|pre-?release|draft/i.test(tagName) || /pre-?release/i.test(title);
    releases.push({
      tag_name: tagName,
      name: title,
      html_url: htmlUrl,
      body,
      published_at: publishedAt,
      draft: false,
      prerelease: isPre,
      assets: []
    });
  }
  if (!releases.length) {
    throw new Error('releases.atom 未包含有效的官方版本条目');
  }
  return releases;
}

function parseLatestReleaseHtml(htmlText, finalUrl = '') {
  const candidates = [];
  if (finalUrl) candidates.push(String(finalUrl));
  if (htmlText && typeof htmlText === 'string') {
    const canonicalMatch = htmlText.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)["']/i);
    if (canonicalMatch) candidates.push(decodeHtmlEntities(canonicalMatch[1]));
    const ogMatch = htmlText.match(/<meta\b[^>]*property=["']og:url["'][^>]*content=["']([^"']+)["']/i);
    if (ogMatch) candidates.push(decodeHtmlEntities(ogMatch[1]));
    const tagLinkRegex = new RegExp(`href=["'](?:https://github\\.com)?/${OFFICIAL_REPO}/releases/tag/([^"'?#\\s]+)["']`, 'i');
    const tagLinkMatch = htmlText.match(tagLinkRegex);
    if (tagLinkMatch) candidates.push(`https://github.com/${OFFICIAL_REPO}/releases/tag/${tagLinkMatch[1]}`);
  }
  const expectedPrefix = `/${OFFICIAL_REPO}/releases/tag/`;
  for (const cand of candidates) {
    try {
      const u = new URL(cand, 'https://github.com');
      if (u.protocol === 'https:' && u.hostname === 'github.com' && u.pathname.startsWith(expectedPrefix)) {
        const rawTag = u.pathname.slice(expectedPrefix.length).split('/')[0];
        const tagName = decodeURIComponent(rawTag || '').trim();
        if (tagName && !tagName.includes('..') && tagName !== 'latest') {
          return [{
            tag_name: tagName,
            name: tagName,
            html_url: `${OFFICIAL_RELEASES_WEB_BASE}/tag/${encodeURIComponent(tagName)}`,
            body: '',
            published_at: '',
            draft: false,
            prerelease: /alpha|beta|rc|pre-?release/i.test(tagName),
            assets: []
          }];
        }
      }
    } catch { }
  }
  throw new Error('releases/latest 页面结构异常，未能解析最新版本号');
}

function parseExpandedAssetsHtml(htmlText, tagName) {
  if (!htmlText || typeof htmlText !== 'string' || !tagName) {
    throw new Error('expanded_assets 响应为空或缺少版本标签');
  }
  const assets = [];
  const seen = new Set();
  const hrefRegex = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  let match;
  while ((match = hrefRegex.exec(htmlText)) !== null) {
    const rawHref = decodeHtmlEntities(match[1]).trim();
    if (!rawHref) continue;
    let absUrl;
    try {
      absUrl = new URL(rawHref, 'https://github.com').toString();
    } catch {
      continue;
    }
    const u = new URL(absUrl);
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') continue;
    const expectedPrefix = `/${OFFICIAL_REPO}/releases/download/`;
    if (!u.pathname.startsWith(expectedPrefix)) continue;
    const rest = u.pathname.slice(expectedPrefix.length);
    const segments = rest.split('/');
    if (segments.length !== 2) continue;
    const fileName = segments[1];
    if (!isOfficialAssetDownloadUrl(absUrl, fileName, tagName)) continue;
    if (seen.has(absUrl)) continue;
    seen.add(absUrl);
    assets.push({
      name: fileName,
      browser_download_url: absUrl
    });
  }
  return assets;
}

function shouldUseWebFallback(err, rawData) {
  if (err) {
    if (err.statusCode === 403 || err.statusCode === 429) return true;
    if (/403|429|rate limit|HTTP (?:403|429|5\d\d)|ENOTFOUND|ECONN|ETIMEDOUT|超时/i.test(String(err.message || ''))) {
      return true;
    }
    return true;
  }
  try {
    const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    return !Array.isArray(parsed);
  } catch {
    return true;
  }
}

async function fetchOfficialReleasesWithFallback(options = {}) {
  const effectiveCurrentVersion = options.currentVersion || PROJECT_VERSION;
  const fetcher = options._requestGithubUrl || requestGithubUrl;
  const timeout = options.timeout || 8000;
  let primaryErr = null;
  let usedSource = 'api';
  let releasesList = null;

  try {
    const rawData = await fetcher(OFFICIAL_RELEASES_API, { timeout });
    const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    if (Array.isArray(parsed)) {
      releasesList = parsed;
    } else {
      primaryErr = new Error(parsed?.message ? `GitHub API 返回异常: ${parsed.message}` : 'GitHub API 未返回版本列表');
    }
  } catch (err) {
    primaryErr = err;
  }

  if (!releasesList && shouldUseWebFallback(primaryErr)) {
    const fallbackErrors = [];
    try {
      const atomXml = await fetcher(OFFICIAL_RELEASES_ATOM, { timeout, accept: 'application/atom+xml, application/xml, text/xml, */*' });
      const atomText = typeof atomXml === 'object' && atomXml?.data ? atomXml.data : atomXml;
      releasesList = parseReleasesAtom(atomText);
      usedSource = 'atom';
    } catch (atomErr) {
      fallbackErrors.push(`releases.atom: ${atomErr.message}`);
    }

    if (!releasesList) {
      try {
        const latestRes = await fetcher(OFFICIAL_RELEASES_LATEST, {
          timeout,
          accept: 'text/html, */*',
          resolveWithMeta: true
        });
        const htmlBody = typeof latestRes === 'object' && latestRes !== null ? (latestRes.data || '') : latestRes;
        const finalUrl = typeof latestRes === 'object' && latestRes !== null ? (latestRes.finalUrl || '') : '';
        releasesList = parseLatestReleaseHtml(htmlBody, finalUrl);
        usedSource = 'latest';
      } catch (latestErr) {
        fallbackErrors.push(`releases/latest: ${latestErr.message}`);
      }
    }

    if (!releasesList) {
      const primaryMsg = primaryErr ? primaryErr.message : 'GitHub REST API 不可用';
      throw new Error(`${primaryMsg}（官方网页通道回退亦失败: ${fallbackErrors.join('; ')}；请前往发布页手动下载）`);
    }
  } else if (!releasesList) {
    throw primaryErr || new Error('未能获取有效的官方版本列表');
  }

  const valid = filterReleases(releasesList, effectiveCurrentVersion);
  return {
    releases: valid,
    source: usedSource,
    rawCount: Array.isArray(releasesList) ? releasesList.length : 0
  };
}

async function resolveAssetsForWebRelease(targetRelease, fetcher, timeout = 8000) {
  if (!targetRelease || !targetRelease.tagName) return targetRelease;
  if (Array.isArray(targetRelease.assets) && targetRelease.assets.length > 0) return targetRelease;
  const assetsUrl = `${OFFICIAL_RELEASES_WEB_BASE}/expanded_assets/${encodeURIComponent(targetRelease.tagName)}`;
  const rawHtml = await fetcher(assetsUrl, { timeout, accept: 'text/html, */*' });
  const htmlBody = typeof rawHtml === 'object' && rawHtml?.data ? rawHtml.data : rawHtml;
  const parsedAssets = parseExpandedAssetsHtml(htmlBody, targetRelease.tagName);
  if (!parsedAssets.length) {
    throw new Error(`发布页资产列表解析为空或结构异常 (${targetRelease.tagName})，请前往官方发布页手动下载`);
  }
  return Object.assign({}, targetRelease, { assets: parsedAssets });
}

async function checkUpdateAsync(options = {}) {
  const runtimeVersion = options.currentVersion || PROJECT_VERSION;
  const diskVersion = getInstalledMeterVersion(options);
  const effectiveCurrentVersion = (diskVersion && compareVersions(diskVersion, runtimeVersion) > 0)
    ? diskVersion
    : runtimeVersion;
  const installedVersion = diskVersion || runtimeVersion;

  const now = Date.now();
  const cacheTtl = 6 * 3600 * 1000;
  if (!options.force && cachedUpdateCheck && (now - cachedUpdateCheckAt < cacheTtl)) {
    // Immediately invalidate cache if current runtime version differs from the cached runtime version (e.g., runtime version aligned after restart)
    if (cachedUpdateCheck.currentVersion && cachedUpdateCheck.currentVersion !== runtimeVersion) {
      cachedUpdateCheck = null;
      cachedUpdateCheckAt = 0;
    } else if (cachedUpdateCheck.hasUpdate && cachedUpdateCheck.latestVersion) {
      // Immediately invalidate cache if current on-disk or effective version has caught up to or surpassed the cached latest release version
      if (compareVersions(effectiveCurrentVersion, cachedUpdateCheck.latestVersion) >= 0) {
        cachedUpdateCheck = null;
        cachedUpdateCheckAt = 0;
      } else {
        return cachedUpdateCheck;
      }
    } else {
      return cachedUpdateCheck;
    }
  }

  try {
    const fetcher = options._requestGithubUrl || requestGithubUrl;
    const { releases: valid, source } = await fetchOfficialReleasesWithFallback({
      currentVersion: effectiveCurrentVersion,
      _requestGithubUrl: fetcher,
      timeout: 8000
    });
    if (valid.length > 0) {
      let latest = valid[0];
      let assetsWarning = null;
      if (source !== 'api' && (!latest.assets || latest.assets.length === 0)) {
        try {
          latest = await resolveAssetsForWebRelease(latest, fetcher, 8000);
        } catch (assetErr) {
          assetsWarning = assetErr.message;
        }
      }
      const bodyLines = (latest.body || '').split(/\r?\n/).slice(0, 8).join('\n');
      cachedUpdateCheck = {
        ok: true,
        hasUpdate: true,
        currentVersion: runtimeVersion,
        installedVersion,
        latestVersion: latest.version,
        tagName: latest.tagName,
        releaseNotes: bodyLines,
        htmlUrl: latest.htmlUrl || `${OFFICIAL_RELEASES_WEB_BASE}/tag/${encodeURIComponent(latest.tagName)}`,
        publishedAt: latest.publishedAt,
        assets: latest.assets,
        source,
        ...(assetsWarning ? { assetsWarning } : {})
      };
      cachedUpdateCheckAt = now;
      return cachedUpdateCheck;
    }
    cachedUpdateCheck = {
      ok: true,
      hasUpdate: false,
      currentVersion: runtimeVersion,
      installedVersion,
      latestVersion: effectiveCurrentVersion,
      diskPendingRestart: compareVersions(installedVersion, runtimeVersion) > 0,
      source
    };
    cachedUpdateCheckAt = now;
    return cachedUpdateCheck;
  } catch (err) {
    return {
      ok: false,
      hasUpdate: false,
      currentVersion: runtimeVersion,
      installedVersion,
      htmlUrl: OFFICIAL_RELEASES_WEB_BASE,
      error: sanitizeDiagnosticErrorText(err),
      ...(err?.diagnostics ? { diagnostics: err.diagnostics } : {})
    };
  }
}

function safeCloseStream(stream) {
  return new Promise(resolve => {
    if (!stream || stream.destroyed || stream.closed) {
      return setImmediate(resolve);
    }
    let resolved = false;
    const done = () => {
      if (!resolved) {
        resolved = true;
        resolve();
      }
    };
    const timer = setTimeout(done, 1500);
    stream.once('close', () => { clearTimeout(timer); done(); });
    stream.once('error', () => { clearTimeout(timer); done(); });
    try {
      stream.destroy();
    } catch {
      clearTimeout(timer);
      done();
    }
  });
}

/**
 * Wait for the writable file stream to finish flushing and auto-closing, preventing read races caused by test doubles or custom downloaders returning early.
 * @param {import('fs').WriteStream} stream
 * @returns {Promise<void>}
 */
function waitWritableStreamClose(stream) {
  return new Promise((resolve, reject) => {
    if (!stream || stream.closed || stream.destroyed) {
      return resolve();
    }
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, 3000);
    function cleanup() {
      clearTimeout(timer);
      stream.removeListener('close', onClose);
      stream.removeListener('error', onError);
    }
    stream.once('close', onClose);
    stream.once('error', onError);
    if (stream.writableFinished && !stream.closed) {
      // When writableFinished is true, autoClose will immediately emit close next
    }
  });
}

const LIVE_RUNTIME_FILES = [
  'package.json',
  'cli.js',
  'install.js',
  'restore.js',
  'live-host.js',
  'local-api.js',
  'meter-main.js',
  'meter-core.js',
  'meter-renderer.js',
  'meter-collector.js',
  'meter-storage.js',
  'meter-proxy.js',
  'meter-cli-launcher.js',
  'meter-context-unlock.js',
  'meter-enhance.js',
  'meter-accounts.js',
  'meter-insights.js',
  'macos-binary-utils.js',
  'attachment_scan.py',
  'asar-engine.js',
  'modules-config.js',
  'modular-installer.js',
  'i18n/zh-CN.json',
  'i18n/i18n-runtime.js'
];

function getLiveRuntimeDir(customStateDir = null) {
  const { getStateDir } = require('./asar-engine');
  const stateDir = customStateDir || getStateDir();
  return path.join(stateDir, 'live-runtime');
}

/**
 * Atomically sync pure JS/config runtime files required to run the external live-host to stateDir/live-runtime.
 * Ensures the hot-loaded background process continues running stably until client restart even if the online updater cleans up temp dirs or modifies the install dir.
 */
function syncLiveRuntimeBundle(sourceDir, options = {}) {
  try {
    if (!sourceDir || !fs.existsSync(path.join(sourceDir, 'live-host.js')) || !fs.existsSync(path.join(sourceDir, 'meter-core.js'))) {
      return null;
    }
    const { getStateDir } = require('./asar-engine');
    const stateDir = options.stateDir || getStateDir();
    if ((process.env.AG_METER_TEST_MODE === '1' || process.env.NODE_ENV === 'test') && !options.stateDir) {
      const lowerState = stateDir.toLowerCase();
      const lowerTmp = os.tmpdir().toLowerCase();
      if (!lowerState.includes(lowerTmp)) {
        return null;
      }
    }
    const targetDir = getLiveRuntimeDir(stateDir);
    fs.mkdirSync(targetDir, { recursive: true });
    let copiedCount = 0;
    for (const rel of LIVE_RUNTIME_FILES) {
      const src = path.join(sourceDir, rel);
      if (!fs.existsSync(src)) continue;
      const dst = path.join(targetDir, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      const tmpDst = `${dst}.tmp-${process.pid}-${Date.now()}`;
      fs.copyFileSync(src, tmpDst);
      fs.renameSync(tmpDst, dst);
      copiedCount++;
    }
    let pkgVersion = options.version || null;
    try {
      if (!pkgVersion && fs.existsSync(path.join(sourceDir, 'package.json'))) {
        pkgVersion = JSON.parse(fs.readFileSync(path.join(sourceDir, 'package.json'), 'utf8')).version || null;
      }
    } catch {}
    safeWriteJsonSync(path.join(targetDir, '.runtime-manifest.json'), {
      version: pkgVersion || PROJECT_VERSION,
      copiedCount,
      updatedAt: new Date().toISOString()
    });
    return targetDir;
  } catch {
    return null;
  }
}

function parseInstallStdoutMeta(stdout = '') {
  try {
    const lines = String(stdout || '').split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      const idx = lines[i].indexOf('__AG_INSTALL_META__=');
      if (idx >= 0) {
        const jsonPart = lines[i].slice(idx + '__AG_INSTALL_META__='.length).trim();
        return JSON.parse(jsonPart);
      }
    }
  } catch {}
  return null;
}

function isTransientUpdateDownloadError(err) {
  const msg = String(err?.message || err || '');
  const code = String(err?.code || '').toUpperCase();
  if (/代理配置无效|认证失败|不受信任|协议不安全|checksums|sha-?256|拒绝安装/i.test(msg)) {
    return false;
  }
  const statusCode = Number(err?.statusCode);
  if ([400, 401, 403, 404, 410, 451].includes(statusCode)) {
    return false;
  }
  if ([429, 500, 502, 503, 504].includes(statusCode)) {
    return true;
  }
  return ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNRESET', 'EPIPE', 'EAI_AGAIN'].includes(code) ||
    /ETIMEDOUT|ECONNRESET|EPIPE|ESOCKETTIMEDOUT|请求超时|意外中断|意外关闭|未完整结束|长度不完整|socket hang up/i.test(msg);
}

async function downloadAssetFileWithRetry(url, filePath, fetcher, options = {}) {
  const maxRetries = Number.isInteger(options.maxRetries) ? Math.max(0, options.maxRetries) : 2;
  const baseRetryDelayMs = Number.isFinite(Number(options.retryDelayMs))
    ? Number(options.retryDelayMs)
    : ((process.env.NODE_ENV === 'test' || process.env.AG_METER_TEST_MODE === '1') ? 10 : 600);
  const attempts = [];
  let lastErr = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
    const stream = fs.createWriteStream(filePath);
    stream.on('error', () => { });
    const hopTrace = [];
    try {
      await fetcher(url, {
        timeout: options.timeout || 15000,
        streamTo: stream,
        phase: options.phase || 'download_asset',
        _hopTrace: hopTrace,
        ...(options.proxyConfigOptions ? { proxyConfigOptions: options.proxyConfigOptions } : {})
      });
      await waitWritableStreamClose(stream);
      return {
        stream,
        attemptsCount: attempt + 1,
        diagnostics: {
          phase: options.phase || 'download_asset',
          attemptsCount: attempt + 1,
          hops: hopTrace
        }
      };
    } catch (err) {
      lastErr = err;
      await safeCloseStream(stream).catch(() => { });
      try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { }
      attempts.push({
        attempt: attempt + 1,
        error: sanitizeDiagnosticErrorText(err),
        diagnostics: err?.diagnostics || (hopTrace.length ? { phase: options.phase, hops: hopTrace } : null)
      });
      if (attempt < maxRetries && isTransientUpdateDownloadError(err)) {
        const delayMs = baseRetryDelayMs * (attempt + 1);
        if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
        continue;
      }
      if (lastErr && typeof lastErr === 'object') {
        lastErr.diagnostics = {
          ...(lastErr.diagnostics || {}),
          phase: options.phase || lastErr.diagnostics?.phase || 'download_asset',
          attemptsCount: attempt + 1,
          attempts
        };
      }
      throw lastErr;
    }
  }
  throw lastErr;
}

async function applyUpdateAsync(options = {}) {
  if (isApplyingUpdate) {
    return { ok: false, error: '更新任务正在执行中，请勿重复操作' };
  }
  isApplyingUpdate = true;

  const currentVersion = options.currentVersion || PROJECT_VERSION;
  let tmpDir = null;
  let checksumStream = null;
  let zipStream = null;

  try {
    // Renderer passes only the version identifier, never external asset URLs or download links
    const requestedVersion = typeof options === 'string'
      ? options
      : (options?.version || options?.release?.latestVersion || null);

    const fetcher = options._requestGithubUrl || requestGithubUrl;
    let releaseQuery;
    try {
      releaseQuery = await fetchOfficialReleasesWithFallback({
        currentVersion,
        _requestGithubUrl: fetcher,
        timeout: 10000
      });
    } catch (e) {
      return { ok: false, error: `查询官方发布信息失败: ${e.message}`, htmlUrl: OFFICIAL_RELEASES_WEB_BASE };
    }

    const validReleases = releaseQuery.releases;
    if (!validReleases || validReleases.length === 0) {
      return { ok: false, error: '未获取到可用的官方发布版本', htmlUrl: OFFICIAL_RELEASES_WEB_BASE };
    }

    let targetRelease = null;
    if (requestedVersion) {
      targetRelease = validReleases.find(r => r.version === requestedVersion || r.tagName === requestedVersion || r.tagName === `v${requestedVersion}`);
      if (!targetRelease) {
        return { ok: false, error: `未在官方仓库中找到版本 ${requestedVersion}`, htmlUrl: OFFICIAL_RELEASES_WEB_BASE };
      }
    } else {
      targetRelease = validReleases[0];
    }

    if (releaseQuery.source !== 'api' && (!targetRelease.assets || targetRelease.assets.length === 0)) {
      try {
        targetRelease = await resolveAssetsForWebRelease(targetRelease, fetcher, 10000);
      } catch (assetErr) {
        return {
          ok: false,
          error: assetErr.message,
          htmlUrl: targetRelease.htmlUrl || OFFICIAL_RELEASES_WEB_BASE
        };
      }
    }

    const effectivePlatform = options.platform || options._platform || process.platform;
    const effectiveArch = options.arch || options._arch || process.arch;
    const { packageAsset, checksumAsset, targetOs, targetArch } = findReleaseAsset(targetRelease.assets, effectivePlatform, effectiveArch);
    if (!packageAsset || !checksumAsset) {
      return {
        ok: false,
        error: '当前版本未提供对应系统架构资产或缺少 checksums.txt 校验文件，请前往发布页手动下载',
        htmlUrl: targetRelease.htmlUrl || `https://github.com/${OFFICIAL_REPO}/releases`
      };
    }

    // Strictly validate asset filename against the naming convention (aligned with official packaging script, while remaining backward-compatible with v-prefixed names)
    if (checksumAsset.name !== 'checksums.txt') {
      return { ok: false, error: '校验资产文件名异常，拒绝安装', htmlUrl: targetRelease.htmlUrl };
    }
    const standardPackageName = `antigravity-context-viewer_${targetRelease.version}_${targetOs}_${targetArch}.zip`;
    const legacyPackageName = `antigravity-context-viewer_v${targetRelease.version}_${targetOs}_${targetArch}.zip`;
    if (packageAsset.name !== standardPackageName && packageAsset.name !== legacyPackageName) {
      return { ok: false, error: `安装包文件名 (${packageAsset.name}) 不符合官方命名规范 (${standardPackageName})，拒绝安装`, htmlUrl: targetRelease.htmlUrl };
    }

    // Strictly validate that the download URL belongs to the official repository
    if (!isOfficialAssetDownloadUrl(checksumAsset.browser_download_url, 'checksums.txt')) {
      return { ok: false, error: '校验文件下载地址不属于官方仓库，拒绝安装', htmlUrl: targetRelease.htmlUrl };
    }
    if (!isOfficialAssetDownloadUrl(packageAsset.browser_download_url, packageAsset.name)) {
      return { ok: false, error: '安装包下载地址不属于官方仓库，拒绝安装', htmlUrl: targetRelease.htmlUrl };
    }

    const crypto = require('crypto');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-meter-update-'));
    const zipPath = path.join(tmpDir, packageAsset.name);
    const checksumPath = path.join(tmpDir, 'checksums.txt');
    const extractDir = path.join(tmpDir, 'extracted');

    const checksumDl = await downloadAssetFileWithRetry(
      checksumAsset.browser_download_url,
      checksumPath,
      fetcher,
      {
        timeout: options._checksumTimeoutMs || 15000,
        phase: 'download_checksums',
        maxRetries: options._maxDownloadRetries,
        retryDelayMs: options._retryDelayMs,
        proxyConfigOptions: options.proxyConfigOptions
      }
    );
    checksumStream = checksumDl.stream;

    const packageDl = await downloadAssetFileWithRetry(
      packageAsset.browser_download_url,
      zipPath,
      fetcher,
      {
        timeout: options._packageTimeoutMs || 60000,
        phase: 'download_package',
        maxRetries: options._maxDownloadRetries,
        retryDelayMs: options._retryDelayMs,
        proxyConfigOptions: options.proxyConfigOptions
      }
    );
    zipStream = packageDl.stream;

    const checksumContent = fs.readFileSync(checksumPath, 'utf8');
    const lines = checksumContent.split(/\r?\n/);
    let expectedSha = null;
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2 && parts[1] === packageAsset.name) {
        const candSha = parts[0].toLowerCase();
        if (/^[0-9a-f]{64}$/.test(candSha)) {
          expectedSha = candSha;
        }
        break;
      }
    }
    if (!expectedSha) {
      return { ok: false, error: 'checksums.txt 中未找到合法的 64 位 SHA-256 校验记录，拒绝安装', htmlUrl: targetRelease.htmlUrl };
    }

    const fileBuf = fs.readFileSync(zipPath);
    const actualSha = crypto.createHash('sha256').update(fileBuf).digest('hex').toLowerCase();
    if (actualSha !== expectedSha) {
      return { ok: false, error: `SHA-256 校验失败 (期望: ${expectedSha}, 实际: ${actualSha})，拒绝安装`, htmlUrl: targetRelease.htmlUrl };
    }

    fs.mkdirSync(extractDir, { recursive: true });
    let extractRes;
    if (typeof options._extractZip === 'function') {
      try {
        extractRes = await options._extractZip(zipPath, extractDir);
        if (extractRes === undefined) extractRes = { status: 0 };
      } catch (err) {
        extractRes = { status: 1, error: err };
      }
    } else if (process.platform === 'win32') {
      extractRes = spawnSync('tar', ['-xf', zipPath, '-C', extractDir], { stdio: 'ignore', windowsHide: true });
    } else {
      extractRes = spawnSync('unzip', ['-q', zipPath, '-d', extractDir], { stdio: 'ignore' });
    }
    if (extractRes && extractRes.status !== 0) {
      return { ok: false, error: '解压更新安装包失败，终止安装', htmlUrl: targetRelease.htmlUrl };
    }

    const cliPath = path.join(extractDir, 'cli.js');
    if (!fs.existsSync(cliPath)) {
      return { ok: false, error: '解压包中缺少 cli.js 安装入口', htmlUrl: targetRelease.htmlUrl };
    }

    const runtimeResolver = options._resolveNodeRuntime || resolveNodeRuntime;
    const runtimeInfo = runtimeResolver();
    const subArgs = [...runtimeInfo.args, cliPath, 'install'];

    // Check if a custom install path is recorded so the updater subprocess continues updating the original target
    let recordedInstalledPath = options.targetPath || null;
    if (!recordedInstalledPath) {
      try {
        const { getStateDir } = require('./asar-engine');
        const stateDir = getStateDir();
        const candidatePaths = [
          path.join(stateDir, 'installation.json'),
          path.join(__dirname, 'installation.json')
        ];
        for (const p of candidatePaths) {
          if (fs.existsSync(p)) {
            const manifestData = JSON.parse(fs.readFileSync(p, 'utf8'));
            if (manifestData && manifestData.installed && typeof manifestData.installed === 'string') {
              recordedInstalledPath = manifestData.installed;
              break;
            }
          }
        }
      } catch { }
    }
    if (recordedInstalledPath && typeof recordedInstalledPath === 'string') {
      subArgs.push('--path', recordedInstalledPath);
    }

    const spawner = options._spawn || spawn;
    const execRes = await new Promise((resolve, reject) => {
      let child;
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const timeoutMs = options._timeoutMs || 45000;
      const timer = setTimeout(() => {
        timedOut = true;
        if (child) {
          try { child.kill('SIGKILL'); } catch { }
          const closeGraceTimer = setTimeout(() => {
            reject(new Error(`更新安装子进程执行超时 (${timeoutMs}ms)`));
          }, 3000);
          child.once('close', () => {
            clearTimeout(closeGraceTimer);
            reject(new Error(`更新安装子进程执行超时 (${timeoutMs}ms)`));
          });
        } else {
          reject(new Error(`更新安装子进程执行超时 (${timeoutMs}ms)`));
        }
      }, timeoutMs);

      try {
        child = spawner(runtimeInfo.runtime, subArgs, {
          cwd: extractDir,
          env: { ...(runtimeInfo.env || {}), AG_EMIT_INSTALL_META: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        });
      } catch (err) {
        clearTimeout(timer);
        return reject(err);
      }

      child.stdout?.on('data', d => { stdout += d.toString('utf8'); });
      child.stderr?.on('data', d => { stderr += d.toString('utf8'); });
      child.on('error', err => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (timedOut) return;
        resolve({ code, signal, stdout, stderr });
      });
    });

    if (execRes.code !== 0) {
      const detail = (execRes.stderr || execRes.stdout || `退出码 ${execRes.code}`).trim();
      return { ok: false, error: `热安装执行失败: ${detail}` };
    }

    cachedUpdateCheck = null;
    cachedUpdateCheckAt = 0;

    const liveRuntimeDir = syncLiveRuntimeBundle(extractDir, {
      version: targetRelease.version,
      stateDir: options.stateDir
    });
    const installMeta = parseInstallStdoutMeta(execRes.stdout);
    const liveInjected = Boolean(
      installMeta?.liveInjected === true ||
      execRes.stdout.includes('已即时生效（无需重启）') ||
      execRes.stdout.includes('"liveInjected": true')
    );
    const finalInstalledVer = getInstalledMeterVersion(options) || targetRelease.version;
    return {
      ok: true,
      diskInstalled: true,
      liveInjected,
      backendHotReloaded: Boolean(installMeta?.backendHotReloaded),
      backendVersion: installMeta?.backendVersion || null,
      backendSource: installMeta?.backendSource || null,
      hotReloadReport: installMeta || null,
      liveRuntimeDir: liveRuntimeDir || null,
      version: targetRelease.version,
      installedVersion: finalInstalledVer,
      diagnostics: {
        checksums: checksumDl.diagnostics,
        package: packageDl.diagnostics
      }
    };
  } catch (err) {
    return {
      ok: false,
      error: `更新安装异常: ${sanitizeDiagnosticErrorText(err)}`,
      ...(err?.diagnostics ? { diagnostics: err.diagnostics } : {})
    };
  } finally {
    isApplyingUpdate = false;
    try {
      if (checksumStream) await safeCloseStream(checksumStream);
      if (zipStream) await safeCloseStream(zipStream);
      if (tmpDir && fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    } catch { }
  }
}

module.exports = {
  sanitizeCascadeModelConfig,
  parseAvailableModelsResponse,
  extractObservedModelInfoFromSteps,
  mergeModelCapabilitiesIntoConfigs,
  fetchUserStatusFromHost,
  fetchQuotaSnapshotFromHost,
  buildAccountScopeKey,
  resetQuotaHostCacheForTest,
  collect,
  collectTokenHistory,
  collectTokenHistoryAsync,
  parseLxssRegistryOutput,
  listRegisteredWslDistros,
  resolveWslDistroUncRoot,
  collectGeminiDirsFromLinuxRoot,
  discoverWslGeminiDirs,
  discoverWslGeminiDirsAsync,
  getEffectiveScanScopeKey,
  buildSqliteImmutableUri,
  extractStepModelsFromGenMetadataBlob,
  extractStepMetaFromGenMetadataBlob,
  extractTrajectoryBlobMeta,
  loadConversationDbMeta,
  loadStepModelMapFromSqlite,
  needsDbLabelEnrichment,
  backfillMissingModelsFromConversationDb,
  buildDailyModelBreakdown,
  collectSessionTimelineCoreAsync,
  collectSessionTimelineAsync,
  scanFiles,
  pythonScan,
  resolvePython,
  isCompanionOrTempFile,
  formatLocalDateKey,
  recordModelCalls,
  recordModelCallsAsync,
  resolveCallAccountAttribution,
  syncAccountLedgerPartitions,
  buildAccountUsageBreakdown,
  summarizeAccountWindowUsage,
  repairAndMigrateAccountLedger,
  loadPricingLedger,
  savePricingLedger,
  getPricingLedgerPath,
  isSyntheticCall,
  quarantineSyntheticCalls,
  getCustomPlanPath,
  sanitizeAccountPlanEntry,
  loadCustomPlanSettings,
  saveCustomPlanSettings,
  saveCustomPlanSettingsDetailed,
  setCustomPlanForAccount,
  clearCustomPlanForAccount,
  resolveAccountCustomPlan,
  getPluginSettings,
  savePluginSettings,
  sanitizeContextPreferenceEntry,
  resolveCliExecutable,
  resolveCliWorkspace,
  buildCliProxyEnv,
  launchCliSession,
  SUBSCRIPTION_ACQUISITION_PRESETS,
  checkUpdateAsync,
  applyUpdateAsync,
  LIVE_RUNTIME_FILES,
  getLiveRuntimeDir,
  syncLiveRuntimeBundle,
  parseReleasesAtom,
  parseLatestReleaseHtml,
  parseExpandedAssetsHtml,
  requestGithubUrl,
  isAllowedDownloadRedirectUrl,
  isOfficialAssetDownloadUrl,
  OFFICIAL_RELEASES_API,
  OFFICIAL_RELEASES_ATOM,
  OFFICIAL_RELEASES_LATEST,
  OFFICIAL_RELEASES_WEB_BASE,
  resolveNodeRuntime,
  OFFICIAL_REPO,
  openHttpConnectTunnel,
  openSocks5Tunnel,
  getContextUnlockStatus,
  applyContextUnlock,
  applyContextUnlockAsync,
  restoreContextUnlock,
  restoreContextUnlockAsync,
  CONTEXT_UNLOCK_AUTHOR
};
