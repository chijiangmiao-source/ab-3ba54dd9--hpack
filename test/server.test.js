// HTTP 层测试：页面、健康路径、解码 API。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../src/server');

const C3_1 = Buffer.from('8286 8441 0f77 7777 2e65 7861 6d70 6c65 2e63 6f6d'.replace(/\s+/g, ''), 'hex').toString('base64');
const C3_2 = Buffer.from('8286 84be 5808 6e6f 2d63 6163 6865'.replace(/\s+/g, ''), 'hex').toString('base64');

let base;

test.before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server.close());

test('GET /health 返回 ok', async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
});

test('GET / 返回复核页面', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /HPACK 连续解码复核台/);
  assert.match(html, /\/api\/decode/);
});

test('POST /api/decode 连续两块解码成功', async () => {
  const res = await fetch(`${base}/api/decode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tableSize: 4096, blocks: [C3_1, C3_2] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.blocks[1].fields[3].nameRef.source, 'dynamic');
  assert.equal(body.finalTable.entries.length, 2);
});

test('POST /api/decode 失败块返回块内偏移且不污染表', async () => {
  const bad = Buffer.from('ff 7e', 'hex').toString('base64'); // 越界索引
  const res = await fetch(`${base}/api/decode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ blocks: [C3_1, bad] }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.equal(body.blocks[1].error.offset, 0);
  assert.equal(body.finalTable.entries.length, 1); // 保持块 1 快照
});

test('POST /api/decode 非法请求返回 400', async () => {
  const cases = [
    { blocks: [] },
    { blocks: Array(9).fill('gg==') },
    { blocks: ['gg=='], tableSize: 4097 },
    { blocks: ['not-base64!!!'] },
  ];
  for (const body of cases) {
    const res = await fetch(`${base}/api/decode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 400, JSON.stringify(body));
    const json = await res.json();
    assert.equal(json.error.code, 'invalid_request');
  }
});

test('POST /api/decode 非法 JSON 返回 400', async () => {
  const res = await fetch(`${base}/api/decode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{oops',
  });
  assert.equal(res.status, 400);
});

test('未知路径返回 404', async () => {
  const res = await fetch(`${base}/nope`);
  assert.equal(res.status, 404);
});
