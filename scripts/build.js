// 页面构建：校验 public/index.html 的结构与内联脚本语法，产出 dist/index.html。
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'public', 'index.html');
const OUT_DIR = path.join(__dirname, '..', 'dist');
const OUT = path.join(OUT_DIR, 'index.html');

const REQUIRED_MARKERS = [
  '<html lang="zh-CN">',
  'id="blocks"',
  'id="tableSize"',
  '/api/decode',
  '/health',
  '<!--BUILD_STAMP-->',
];

function build() {
  const html = fs.readFileSync(SRC, 'utf8');

  for (const marker of REQUIRED_MARKERS) {
    if (!html.includes(marker)) {
      throw new Error(`页面缺少必需标记: ${marker}`);
    }
  }

  // 内联脚本语法检查（页面构建检查的一部分）
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length === 0) throw new Error('页面缺少内联脚本');
  for (const [, code] of scripts) {
    new vm.Script(code); // 语法错误会在此抛出
  }

  const stamped = html.replace(
    '<!--BUILD_STAMP-->',
    `<!-- built ${new Date().toISOString()} -->`
  );
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT, stamped);

  const stats = fs.statSync(OUT);
  if (stats.size === 0) throw new Error('构建产物为空');
  console.log(`build ok: ${path.relative(process.cwd(), OUT)} (${stats.size} bytes, ${scripts.length} script block(s) checked)`);
}

if (require.main === module) {
  try {
    build();
  } catch (e) {
    console.error(`build failed: ${e.message}`);
    process.exit(1);
  }
}

module.exports = { build };
