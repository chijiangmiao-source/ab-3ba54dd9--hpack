// 验收脚本：连续解码规则代码测试 → 页面构建检查 → 页面/健康路径 HTTP 冒烟。
// 全部通过以退出码 0 结束，任一步失败以退出码 1 结束。
//
// 用法：node scripts/verify.js [baseURL]
//   baseURL 默认 http://127.0.0.1:8080，也可用 APP_URL 环境变量指定。
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_URL = (process.argv[2] || process.env.APP_URL || 'http://127.0.0.1:8080').replace(/\/$/, '');
const ROOT = path.join(__dirname, '..');

let failures = 0;
const ok = (name) => console.log(`  PASS  ${name}`);
const fail = (name, detail) => { failures++; console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); };

function step(title) {
  console.log(`\n== ${title}`);
}

function runStep(name, command, args) {
  const r = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status === 0) { ok(name); return true; }
  fail(name);
  process.stdout.write(r.stdout || '');
  process.stderr.write(r.stderr || '');
  return false;
}

// RFC 7541 C.3 连续两块：第二块经动态表引用第一块插入的 :authority
const C3_1 = Buffer.from('828684410f7777772e6578616d706c652e636f6d', 'hex').toString('base64');
const C3_2 = Buffer.from('828684be58086e6f2d6361636865', 'hex').toString('base64');
const BAD_INDEX = Buffer.from('ff7e', 'hex').toString('base64'); // 越界索引 253

async function smoke() {
  // 健康路径
  try {
    const res = await fetch(`${BASE_URL}/health`);
    const body = await res.json();
    if (res.status === 200 && body.status === 'ok') ok('GET /health');
    else fail('GET /health', `status=${res.status} body=${JSON.stringify(body)}`);
  } catch (e) { fail('GET /health', e.message); }

  // 页面路径
  try {
    const res = await fetch(`${BASE_URL}/`);
    const html = await res.text();
    if (res.status === 200 && html.includes('HPACK') && html.includes('/api/decode')) ok('GET / （复核页面）');
    else fail('GET / （复核页面）', `status=${res.status}`);
  } catch (e) { fail('GET / （复核页面）', e.message); }

  // 解码 API：连续解码 + 跨块引用
  try {
    const res = await fetch(`${BASE_URL}/api/decode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tableSize: 4096, blocks: [C3_1, C3_2] }),
    });
    const body = await res.json();
    const ref = body.blocks && body.blocks[1] && body.blocks[1].fields[3];
    if (res.status === 200 && body.ok === true && ref && ref.nameRef.source === 'dynamic') {
      ok('POST /api/decode （后块引用前块插入字段）');
    } else fail('POST /api/decode （连续解码）', `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
  } catch (e) { fail('POST /api/decode （连续解码）', e.message); }

  // 解码 API：非法后续块不污染已提交表状态
  try {
    const res = await fetch(`${BASE_URL}/api/decode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blocks: [C3_1, BAD_INDEX] }),
    });
    const body = await res.json();
    const clean = body.finalTable && body.finalTable.entries.length === 1
      && body.blocks[1].status === 'error' && typeof body.blocks[1].error.offset === 'number';
    if (res.status === 200 && body.ok === false && clean) {
      ok('POST /api/decode （失败块不污染已提交表状态）');
    } else fail('POST /api/decode （失败块事务性）', `status=${res.status} body=${JSON.stringify(body).slice(0, 200)}`);
  } catch (e) { fail('POST /api/decode （失败块事务性）', e.message); }
}

async function main() {
  step('1/3 连续解码规则代码测试');
  runStep('node --test test/', process.execPath, ['--test', 'test/']);

  step('2/3 页面构建检查');
  runStep('node scripts/build.js', process.execPath, ['scripts/build.js']);
  const dist = path.join(ROOT, 'dist', 'index.html');
  if (fs.existsSync(dist) && fs.readFileSync(dist, 'utf8').includes('/api/decode')) {
    ok('dist/index.html 产物校验');
  } else {
    fail('dist/index.html 产物校验', '产物缺失或缺少必需标记');
  }

  step(`3/3 页面与健康路径 HTTP 冒烟（${BASE_URL}）`);
  await smoke();

  console.log(`\n== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`verify 执行异常: ${e.stack || e}`);
  process.exit(1);
});
