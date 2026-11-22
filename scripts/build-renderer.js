'use strict';
const fs = require('fs');
const path = require('path');

function readDirParts(dirPath) {
  if (!fs.existsSync(dirPath)) return '';
  const files = fs.readdirSync(dirPath).filter(f => !f.startsWith('.')).sort();
  return files.map(f => fs.readFileSync(path.join(dirPath, f), 'utf8')).join('\n');
}

function assembleCore(rootDir = path.resolve(__dirname, '..')) {
  return readDirParts(path.join(rootDir, 'src', 'core'));
}

function assembleRenderer(rootDir = path.resolve(__dirname, '..')) {
  const srcDir = path.join(rootDir, 'src', 'renderer');
  const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  const meterVersion = pkg.version || '0.8.8';
  const displayVersion = `v${meterVersion}`;

  const readPart = name => fs.readFileSync(path.join(srcDir, name), 'utf8').trim();
  const styles = readPart('styles.css');
  let template = readPart('template.html');
  template = template.replace(/<span id="v">[^<]*<\/span>/g, `<span id="v">${displayVersion}</span>`);
  template = template.replace(/<span id="up-pop-ver"[^>]*>[^<]*<\/span>/g, `<span id="up-pop-ver" class="key-pill pill-good" style="font-size:10px">${displayVersion}</span>`);

  const colors = readPart('colors.js');
  const i18n = readPart('i18n.js');
  const budget = readPart('budget.js');
  const dropdown = readPart('dropdown.js');
  const heatmap = readPart('heatmap.js');
  const inspector = readPart('inspector.js');
  let main = readDirParts(path.join(srcDir, 'main'));

  if (main.includes('const METER_VERSION =')) {
    main = main.replace(/const METER_VERSION = '[^']*';/, `const METER_VERSION = '${meterVersion}';`);
  }
  if (main.includes('const METER_DISPLAY_VERSION =')) {
    main = main.replace(/const METER_DISPLAY_VERSION = '[^']*';/, `const METER_DISPLAY_VERSION = '${displayVersion}';`);
  }

  const esc = s => s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\${/g, '\\${');
  const domString = `  shadow.innerHTML = \`<style>\n    ${esc(styles)}\n  </style>\n\n  ${esc(template)}\`;`;

  return main
    .replace('  /* @INSERT_STYLES_AND_TEMPLATE */', () => domString)
    .replace('  /* @INSERT_I18N_MODULE */', () => i18n)
    .replace('  /* @INSERT_BUDGET_ENGINE_MODULE */', () => budget)
    .replace('  /* @INSERT_COLORS_MODULE */', () => colors)
    .replace('  /* @INSERT_DROPDOWN_MODULE */', () => dropdown)
    .replace('  /* @INSERT_HEATMAP_MODULE */', () => heatmap)
    .replace('  /* @INSERT_INSPECTOR_MODULE */', () => inspector);
}

if (require.main === module) {
  const core = assembleCore();
  const renderer = assembleRenderer();
  console.log(`Verified assembly: core=${Buffer.byteLength(core, 'utf8')}B, renderer=${Buffer.byteLength(renderer, 'utf8')}B`);
}

module.exports = { readDirParts, assembleCore, assembleRenderer };
