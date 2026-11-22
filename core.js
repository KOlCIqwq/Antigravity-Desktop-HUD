'use strict';
const Module = require('module');
const path = require('path');
const { assembleCore } = require('./scripts/build-renderer');

const code = assembleCore(__dirname);
const mod = new Module(path.join(__dirname, 'src', 'core', 'index.js'), module);
mod.filename = path.join(__dirname, 'src', 'core', 'index.js');
mod.paths = Module._nodeModulePaths(__dirname);
mod._compile(code, mod.filename);

module.exports = mod.exports;
