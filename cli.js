#!/usr/bin/env node
'use strict';
process.noAsar = true;

const { findAsarPath } = require('./asar');
const { install, restore, getStatus, liveInject } = require('./installer');

function parseArgs(argv) {
  const args = { cmd: argv[2] || 'status', path: null, port: null };
  for (let i = 3; i < argv.length; i++) {
    if (argv[i] === '--path' && argv[i + 1]) args.path = argv[++i];
    else if (argv[i] === '--port' && argv[i + 1]) args.port = Number(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.cmd === 'check') {
    const asarPath = findAsarPath(args.path);
    console.log(JSON.stringify({ ok: true, asarPath }, null, 2));
  } else if (args.cmd === 'status') {
    console.log(JSON.stringify(await getStatus(args), null, 2));
  } else if (args.cmd === 'install') {
    console.log(JSON.stringify(install(args), null, 2));
  } else if (args.cmd === 'restore') {
    console.log(JSON.stringify(restore(args), null, 2));
  } else if (args.cmd === 'live') {
    const res = await liveInject(args);
    console.log(`Live-injected into ${res.injected} window(s) on CDP port ${res.cdpPort}. Bridge: http://127.0.0.1:${res.port} (Ctrl+C to stop)`);
    process.on('SIGINT', () => { res.server.close(); process.exit(0); });
  } else {
    console.error('Usage: node cli.js <check|status|install|live|restore> [--path <app.asar>] [--port <cdpPort>]');
    process.exit(1);
  }
}

main().catch(err => {
  console.error(err.message || err);
  process.exit(1);
});
