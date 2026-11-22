'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function getRawFs() {
  if (process.versions?.electron) {
    try { return require('original-fs'); } catch {}
  }
  return fs;
}

function getStateDir() {
  const dir = process.env.CONTEXT_BAR_STATE_DIR
    ? path.resolve(process.env.CONTEXT_BAR_STATE_DIR)
    : path.join(os.homedir(), '.antigravity-context-bar');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readHeader(archivePath) {
  const rawFs = getRawFs();
  const fd = rawFs.openSync(archivePath, 'r');
  try {
    const pre = Buffer.alloc(16);
    rawFs.readSync(fd, pre, 0, 16, 0);
    const jsonSize = pre.readUInt32LE(12);
    const padding = (4 - (jsonSize % 4)) % 4;
    const jsonBuf = Buffer.alloc(jsonSize);
    rawFs.readSync(fd, jsonBuf, 0, jsonSize, 16);
    return { header: JSON.parse(jsonBuf.toString('utf8')), baseOffset: 16 + jsonSize + padding };
  } finally {
    rawFs.closeSync(fd);
  }
}

function getNode(header, relPath) {
  const parts = String(relPath).replace(/^[\\/]+/, '').split(/[\\/]+/).filter(Boolean);
  let cur = header;
  for (const part of parts) {
    if (!cur?.files || !Object.prototype.hasOwnProperty.call(cur.files, part)) {
      throw new Error(`File not found in ASAR: ${relPath}`);
    }
    cur = cur.files[part];
  }
  return cur;
}

function extractFile(archivePath, relPath) {
  const rawFs = getRawFs();
  const { header, baseOffset } = readHeader(archivePath);
  const node = getNode(header, relPath);
  if (node.unpacked) {
    const unpackedSrc = path.join(archivePath + '.unpacked', relPath);
    return rawFs.existsSync(unpackedSrc) ? rawFs.readFileSync(unpackedSrc) : Buffer.alloc(node.size || 0);
  }
  const buf = Buffer.alloc(node.size);
  const fd = rawFs.openSync(archivePath, 'r');
  try {
    rawFs.readSync(fd, buf, 0, node.size, baseOffset + Number(node.offset));
    return buf;
  } finally {
    rawFs.closeSync(fd);
  }
}

function listPackage(archivePath) {
  const { header } = readHeader(archivePath);
  const out = [];
  (function walk(tree, prefix) {
    for (const [name, info] of Object.entries(tree.files || {})) {
      const cur = `${prefix}/${name}`;
      out.push(cur);
      if (info.files) walk(info, cur);
    }
  })(header, '');
  return out;
}

function collectUnpackedPaths(archivePath) {
  const { header } = readHeader(archivePath);
  const unpacked = new Set();
  (function walk(tree, prefix) {
    for (const [name, info] of Object.entries(tree.files || {})) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (info.unpacked) unpacked.add(rel);
      if (info.files) walk(info, rel);
    }
  })(header, '');
  return unpacked;
}

function extractAll(archivePath, destDir) {
  const rawFs = getRawFs();
  const { header, baseOffset } = readHeader(archivePath);
  const fd = rawFs.openSync(archivePath, 'r');
  try {
    (function walk(tree, currentDir, relDir) {
      fs.mkdirSync(currentDir, { recursive: true });
      for (const [name, info] of Object.entries(tree.files || {})) {
        const target = path.join(currentDir, name);
        const rel = relDir ? path.join(relDir, name) : name;
        if (info.files) {
          walk(info, target, rel);
        } else if (info.unpacked) {
          const unpackedSrc = path.join(archivePath + '.unpacked', rel);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          if (rawFs.existsSync(unpackedSrc)) rawFs.copyFileSync(unpackedSrc, target);
          else fs.writeFileSync(target, Buffer.alloc(0));
        } else {
          const buf = Buffer.alloc(info.size);
          rawFs.readSync(fd, buf, 0, info.size, baseOffset + Number(info.offset));
          fs.writeFileSync(target, buf);
        }
      }
    })(header, destDir, '');
  } finally {
    rawFs.closeSync(fd);
  }
}

function createPackage(srcDir, destAsar, unpackedSet = new Set()) {
  const rawFs = getRawFs();
  let offset = 0;
  const chunks = [];
  const blockSize = 4 * 1024 * 1024;

  function build(currentDir, relPosix) {
    const files = {};
    for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
      const fullPath = path.join(currentDir, entry.name);
      const childPosix = relPosix ? `${relPosix}/${entry.name}` : entry.name;
      const isUnpacked = unpackedSet.has(childPosix);
      if (entry.isDirectory()) {
        const node = { files: build(fullPath, childPosix) };
        if (isUnpacked) node.unpacked = true;
        files[entry.name] = node;
      } else if (entry.isFile()) {
        const buf = fs.readFileSync(fullPath);
        const hash = crypto.createHash('sha256').update(buf).digest('hex');
        const blocks = [];
        for (let i = 0; i < buf.length; i += blockSize) {
          blocks.push(crypto.createHash('sha256').update(buf.subarray(i, i + blockSize)).digest('hex'));
        }
        if (blocks.length === 0) blocks.push(crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
        const integrity = { algorithm: 'SHA256', hash, blockSize, blocks };
        if (isUnpacked) {
          const unpackedTarget = path.join(destAsar + '.unpacked', childPosix);
          fs.mkdirSync(path.dirname(unpackedTarget), { recursive: true });
          fs.copyFileSync(fullPath, unpackedTarget);
          files[entry.name] = { size: buf.length, unpacked: true, integrity };
        } else {
          files[entry.name] = { size: buf.length, offset: String(offset), integrity };
          offset += buf.length;
          chunks.push(buf);
        }
      }
    }
    return files;
  }

  const jsonBuf = Buffer.from(JSON.stringify({ files: build(srcDir, '') }), 'utf8');
  const padding = (4 - (jsonBuf.length % 4)) % 4;
  const alignedSize = jsonBuf.length + padding;
  const headerBuf = Buffer.alloc(16 + alignedSize);
  headerBuf.writeUInt32LE(4, 0);
  headerBuf.writeUInt32LE(8 + alignedSize, 4);
  headerBuf.writeUInt32LE(4 + alignedSize, 8);
  headerBuf.writeUInt32LE(jsonBuf.length, 12);
  jsonBuf.copy(headerBuf, 16);

  const fd = rawFs.openSync(destAsar, 'w');
  try {
    rawFs.writeSync(fd, headerBuf);
    for (const chunk of chunks) rawFs.writeSync(fd, chunk);
  } finally {
    rawFs.closeSync(fd);
  }
}

function findAsarPath(customPath) {
  const rawFs = getRawFs();
  const explicit = customPath || process.env.AG_ASAR_PATH || '';
  if (explicit) {
    const resolved = path.resolve(explicit);
    if (rawFs.existsSync(resolved) && rawFs.statSync(resolved).isDirectory()) {
      for (const rel of ['Contents/Resources/app.asar', 'resources/app.asar', 'app.asar']) {
        const candidate = path.join(resolved, rel);
        if (rawFs.existsSync(candidate)) return candidate;
      }
    }
    if (rawFs.existsSync(resolved)) return resolved;
    throw new Error(`app.asar not found at: ${explicit}`);
  }
  if (process.versions?.electron && process.execPath) {
    const execDir = path.dirname(process.execPath);
    for (const p of [path.join(execDir, 'resources', 'app.asar'), path.join(execDir, '..', 'Resources', 'app.asar')]) {
      if (rawFs.existsSync(p)) return path.resolve(p);
    }
  }
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    candidates.push(
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'antigravity', 'resources', 'app.asar'),
      path.join(programFiles, 'Google Antigravity', 'resources', 'app.asar')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(home, 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'),
      '/Applications/Google Antigravity.app/Contents/Resources/app.asar'
    );
  } else {
    candidates.push(
      '/opt/antigravity/resources/app.asar',
      '/usr/lib/antigravity/resources/app.asar',
      path.join(home, '.local', 'share', 'antigravity', 'resources', 'app.asar')
    );
  }
  for (const p of candidates) {
    if (rawFs.existsSync(p)) return p;
  }
  throw new Error('Could not auto-detect Antigravity app.asar. Pass --path <path-to-app.asar>.');
}

module.exports = {
  getRawFs,
  getStateDir,
  extractFile,
  listPackage,
  collectUnpackedPaths,
  extractAll,
  createPackage,
  findAsarPath
};
