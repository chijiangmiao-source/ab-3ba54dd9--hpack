// 页面逻辑测试：以最小 DOM 桩执行 index.html 内联脚本，
// 模拟输入与点击，验证复核渲染、清空草稿、结论失效等交互。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runReview } = require('../src/review');

const C3_1 = Buffer.from('828684410f7777772e6578616d706c652e636f6d', 'hex').toString('base64');
const C3_2 = Buffer.from('828684be58086e6f2d6361636865', 'hex').toString('base64');

function makeEl(tag = 'div') {
  const el = {
    tagName: tag,
    children: [],
    _innerHTML: '',
    _handlers: {},
    value: '',
    hidden: false,
    className: '',
    textContent: '',
    appendChild(c) { el.children.push(c); return c; },
    addEventListener(type, fn) { el._handlers[type] = fn; },
    click() { if (el._handlers.click) el._handlers.click(); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._innerHTML; },
    set(v) { el._innerHTML = v; if (v === '') el.children = []; },
  });
  return el;
}

// 加载页面脚本并返回 { byId, fetchCalls }
function loadPage(fetchImpl) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const code = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const byId = new Map();
  const document = {
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeEl());
      return byId.get(id);
    },
    createElement(tag) { return makeEl(tag); },
  };
  const fetchCalls = [];
  const fetch = (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  };
  vm.runInNewContext(code, { document, fetch, parseInt }, { filename: 'index.html<script>' });
  return { byId, fetchCalls };
}

const flush = () => new Promise((r) => setImmediate(r));

test('页面加载生成 8 段输入框并绑定按钮', () => {
  const { byId } = loadPage(() => Promise.reject(new Error('no fetch')));
  assert.equal(byId.get('blocks').children.length, 8);
  for (const id of ['decodeBtn', 'clearDraftBtn', 'clearResultBtn', 'tableSize']) {
    assert.ok(byId.has(id), `缺少元素 ${id}`);
  }
});

test('点击复核：渲染成功结论与字段来源', async () => {
  const fetchImpl = (url, opts) => {
    assert.equal(url, '/api/decode');
    const data = runReview(JSON.parse(opts.body));
    return Promise.resolve({ status: 200, json: () => Promise.resolve(data) });
  };
  const { byId, fetchCalls } = loadPage(fetchImpl);
  byId.get('tableSize').value = '4096';
  byId.get('blk0').value = C3_1;
  byId.get('blk1').value = C3_2;

  byId.get('decodeBtn').click();
  await flush(); await flush(); await flush();

  assert.equal(fetchCalls.length, 1);
  const sent = JSON.parse(fetchCalls[0].opts.body);
  assert.deepEqual(sent.blocks, [C3_1, C3_2]); // 空段不参与复核

  const summary = byId.get('summary');
  assert.equal(summary.hidden, false);
  assert.match(summary.innerHTML, /全部块解码成功/);
  assert.match(summary.innerHTML, /字段 9 个/);

  const results = byId.get('results');
  assert.equal(results.children.length, 2);
  assert.match(results.children[1].innerHTML, /动态表 #62（第 1 段插入）/);
  assert.match(results.children[1].innerHTML, /段末动态表快照/);
});

test('失败块渲染块内偏移；输入变更清除旧结论', async () => {
  const fetchImpl = (url, opts) => {
    const data = runReview(JSON.parse(opts.body));
    return Promise.resolve({ status: 200, json: () => Promise.resolve(data) });
  };
  const { byId } = loadPage(fetchImpl);
  byId.get('tableSize').value = '4096';
  byId.get('blk0').value = C3_1;
  byId.get('blk1').value = Buffer.from('ff7e', 'hex').toString('base64'); // 越界索引

  byId.get('decodeBtn').click();
  await flush(); await flush(); await flush();

  const summary = byId.get('summary');
  assert.match(summary.innerHTML, /第 2 段解码失败/);
  const results = byId.get('results');
  assert.match(results.children[1].innerHTML, /块内字节偏移 <b class="mono">0<\/b>/);
  assert.match(results.children[1].innerHTML, /该块已整体作废/);

  // 输入变更 → 旧结论清除并提示
  byId.get('blk0').value = C3_1 + '  ';
  byId.get('blocks')._handlers.input();
  assert.equal(byId.get('results').children.length, 0);
  assert.equal(byId.get('summary').hidden, true);
  assert.equal(byId.get('staleHint').hidden, false);
});

test('清空草稿与清除结论', async () => {
  const fetchImpl = (url, opts) => {
    const data = runReview(JSON.parse(opts.body));
    return Promise.resolve({ status: 200, json: () => Promise.resolve(data) });
  };
  const { byId } = loadPage(fetchImpl);
  byId.get('blk0').value = C3_1;
  byId.get('decodeBtn').click();
  await flush(); await flush(); await flush();
  assert.equal(byId.get('results').children.length, 1);

  byId.get('clearResultBtn').click();
  assert.equal(byId.get('results').children.length, 0);
  assert.equal(byId.get('summary').hidden, true);

  byId.get('clearDraftBtn').click();
  assert.equal(byId.get('blk0').value, '');
  assert.equal(byId.get('tableSize').value, '4096');
});
