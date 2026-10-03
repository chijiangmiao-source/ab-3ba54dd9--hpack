// 连续解码规则测试：RFC 7541 Appendix C 官方向量 + 错误语义。
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  decodeInteger, decodeString, huffmanDecode, decodeSequence,
  HpackError, LIMITS,
} = require('../src/hpack');
const { runReview, RequestError } = require('../src/review');

const hex = (s) => Buffer.from(s.replace(/\s+/g, ''), 'hex');
const b64 = (s) => hex(s).toString('base64');

// RFC 7541 C.3：请求示例（无 Huffman），同一连接上的连续三块
const C3 = [
  '8286 8441 0f77 7777 2e65 7861 6d70 6c65 2e63 6f6d',
  '8286 84be 5808 6e6f 2d63 6163 6865',
  '8287 85bf 400a 6375 7374 6f6d 2d6b 6579 0c63 7573 746f 6d2d 7661 6c75 65',
];
// RFC 7541 C.4：请求示例（Huffman）
const C4 = [
  '8286 8441 8cf1 e3c2 e5f2 3a6b a0ab 90f4 ff',
  '8286 84be 5886 a8eb 1064 9cbf',
  '8287 85bf 4088 25a8 49e9 5ba9 7d7f 8925 a849 e95b b8e8 b4bf',
];
// RFC 7541 C.5：响应示例（无 Huffman，容量 256）
const C5 = [
  '4803 3330 3258 0770 7269 7661 7465 611d 4d6f 6e2c 2032 3120 4f63 7420' +
  '3230 3133 2032 303a 3133 3a32 3120 474d 546e 1768 7474 7073 3a2f 2f77' +
  '7777 2e65 7861 6d70 6c65 2e63 6f6d',
  '4803 3330 37c1 c0bf',
  '88c1 611d 4d6f 6e2c 2032 3120 4f63 7420 3230 3133 2032 303a 3133 3a32' +
  '3220 474d 54c0 5a04 677a 6970 7738 666f 6f3d 4153 444a 4b48 514b 425a' +
  '584f 5157 454f 5049 5541 5851 5745 4f49 553b 206d 6178 2d61 6765 3d33' +
  '3630 303b 2076 6572 7369 6f6e 3d31',
];
// RFC 7541 C.6：响应示例（Huffman，容量 256）
const C6 = [
  '4882 6402 5885 aec3 771a 4b61 96d0 7abe 9410 54d4 44a8 2005 9504 0b81' +
  '66e0 82a6 2d1b ff6e 919d 29ad 1718 63c7 8f0b 97c8 e9ae 82ae 43d3',
  '4883 640e ffc1 c0bf',
  '88c1 6196 d07a be94 1054 d444 a820 0595 040b 8166 e084 a62d 1bff c05a' +
  '839b d9ab 77ad 94e7 821d d7f2 e6c7 b335 dfdf cd5b 3960 d5af 2708 7f36' +
  '72c1 ab27 0fb5 291f 9587 3160 65c0 03ed 4ee5 b106 3d50 07',
];

// ---------------------------------------------------------------------------
// 变长整数（RFC 7541 C.1）
// ---------------------------------------------------------------------------

test('整数：5 位前缀编码 10（C.1.1）', () => {
  assert.deepEqual(decodeInteger(hex('0a'), 0, 5, 0), { value: 10, pos: 1 });
});

test('整数：5 位前缀编码 1337（C.1.2）', () => {
  assert.deepEqual(decodeInteger(hex('1f 9a 0a'), 0, 5, 0), { value: 1337, pos: 3 });
});

test('整数：8 位前缀编码 42（C.1.3）', () => {
  assert.deepEqual(decodeInteger(hex('2a'), 0, 8, 0), { value: 42, pos: 1 });
});

test('整数：续位字节缺失报截断并给出首字节偏移', () => {
  assert.throws(
    () => decodeInteger(hex('1f 9a'), 0, 5, 0),
    (e) => e instanceof HpackError && e.code === 'truncated_integer' && e.offset === 0,
  );
});

// ---------------------------------------------------------------------------
// Huffman（RFC 7541 C.4 / C.6 中的字符串）
// ---------------------------------------------------------------------------

test('Huffman：www.example.com', () => {
  assert.equal(huffmanDecode(hex('f1e3 c2e5 f23a 6ba0 ab90 f4ff'), 0), 'www.example.com');
});

test('Huffman：no-cache / custom-key / custom-value / private', () => {
  assert.equal(huffmanDecode(hex('a8eb 1064 9cbf'), 0), 'no-cache');
  assert.equal(huffmanDecode(hex('25a8 49e9 5ba9 7d7f'), 0), 'custom-key');
  assert.equal(huffmanDecode(hex('25a8 49e9 5bb8 e8b4 bf'), 0), 'custom-value');
  assert.equal(huffmanDecode(hex('aec3 771a 4b'), 0), 'private');
});

test('Huffman：日期与 URL 字符串', () => {
  assert.equal(
    huffmanDecode(hex('d07a be94 1054 d444 a820 0595 040b 8166 e082 a62d 1bff'), 0),
    'Mon, 21 Oct 2013 20:13:21 GMT',
  );
  assert.equal(
    huffmanDecode(hex('9d29 ad17 1863 c78f 0b97 c8e9 ae82 ae43 d3'), 0),
    'https://www.example.com',
  );
});

test('Huffman：302（C.6.1）', () => {
  assert.equal(huffmanDecode(hex('6402'), 0), '302');
});

test('Huffman：非全 1 填充报错', () => {
  assert.throws(
    () => huffmanDecode(hex('00'), 3),
    (e) => e.code === 'huffman_padding' && e.offset === 3,
  );
});

test('Huffman：EOS 符号报错', () => {
  assert.throws(
    () => huffmanDecode(hex('ff ff ff ff'), 1),
    (e) => e.code === 'huffman_eos' && e.offset === 1,
  );
});

test('Huffman：填充超过 7 位报错', () => {
  // 8 个 1 位不构成符号且超过 7 位填充上限
  assert.throws(
    () => huffmanDecode(hex('ff ff'), 0),
    (e) => e.code === 'huffman_padding',
  );
});

// ---------------------------------------------------------------------------
// 连续解码：RFC 7541 C.3（跨块引用、动态表延续）
// ---------------------------------------------------------------------------

test('C.3 连续三块：后块引用前块插入的字段', () => {
  const r = decodeSequence(C3.map(hex), 4096);
  assert.equal(r.ok, true);
  assert.equal(r.blocks.length, 3);

  // 块 1：四个字段，:authority 进入动态表
  const b1 = r.blocks[0];
  assert.deepEqual(b1.fields.map((f) => [f.name, f.value]), [
    [':method', 'GET'], [':scheme', 'http'], [':path', '/'],
    [':authority', 'www.example.com'],
  ]);
  assert.equal(b1.fields[0].nameRef.source, 'static');
  assert.equal(b1.snapshot.entries.length, 1);
  assert.equal(b1.snapshot.size, 57); // 10 + 15 + 32

  // 块 2：0xbe 引用块 1 插入的动态表项（索引 62）
  const b2 = r.blocks[1];
  const auth = b2.fields[3];
  assert.equal(auth.name, ':authority');
  assert.equal(auth.value, 'www.example.com');
  assert.deepEqual(auth.nameRef, { source: 'dynamic', index: 62, origin: 0 });
  assert.equal(b2.fields[4].name, 'cache-control');
  assert.equal(b2.snapshot.entries.length, 2);

  // 块 3：0xbf 引用索引 63（块 1 插入项移位后）
  const b3 = r.blocks[2];
  assert.equal(b3.fields[3].name, ':authority');
  assert.deepEqual(b3.fields[3].nameRef, { source: 'dynamic', index: 63, origin: 0 });
  assert.equal(b3.fields[4].name, 'custom-key');
  assert.equal(b3.fields[4].value, 'custom-value');
  assert.equal(b3.fields[4].nameRef.source, 'literal');

  // 最终表：custom-key(54) + cache-control(53) + :authority(57) = 164
  assert.equal(r.finalTable.size, 164);
  assert.equal(r.finalTable.entries.length, 3);
  assert.equal(r.summary.totalFields, 14);
});

test('C.4 连续三块（Huffman）', () => {
  const r = decodeSequence(C4.map(hex), 4096);
  assert.equal(r.ok, true);
  assert.equal(r.blocks[0].fields[3].value, 'www.example.com');
  assert.equal(r.blocks[1].fields[4].value, 'no-cache');
  assert.equal(r.blocks[2].fields[4].value, 'custom-value');
  assert.equal(r.blocks[2].fields[4].valueRef.huffman, true);
  assert.equal(r.finalTable.size, 164);
});

// ---------------------------------------------------------------------------
// 连续解码：RFC 7541 C.5 / C.6（容量 256，含驱逐）
// ---------------------------------------------------------------------------

test('C.5 容量 256：插入与驱逐记录正确', () => {
  const r = decodeSequence(C5.map(hex), 256);
  assert.equal(r.ok, true);

  const b1 = r.blocks[0];
  assert.deepEqual(b1.fields.map((f) => [f.name, f.value]), [
    [':status', '302'], ['cache-control', 'private'],
    ['date', 'Mon, 21 Oct 2013 20:13:21 GMT'], ['location', 'https://www.example.com'],
  ]);
  assert.equal(b1.snapshot.size, 222);

  // 块 2：插入 :status 307 驱逐 :status 302
  const b2 = r.blocks[1];
  assert.equal(b2.fields[0].value, '307');
  assert.deepEqual(b2.evictions.map((e) => [e.name, e.value]), [[':status', '302']]);
  assert.equal(b2.fields[1].nameRef.source, 'dynamic'); // cache-control 来自动态表

  // 块 3：多次驱逐后仅剩 3 项，215 字节
  const b3 = r.blocks[2];
  assert.equal(b3.fields[0].value, '200');
  assert.equal(b3.fields[5].name, 'set-cookie');
  assert.equal(r.finalTable.entries.length, 3);
  assert.equal(r.finalTable.size, 215);
  assert.deepEqual(r.finalTable.entries.map((e) => e.name), [
    'set-cookie', 'content-encoding', 'date',
  ]);
});

test('C.6 容量 256（Huffman）与 C.5 结果一致', () => {
  const r = decodeSequence(C6.map(hex), 256);
  assert.equal(r.ok, true);
  assert.equal(r.blocks[0].fields[2].value, 'Mon, 21 Oct 2013 20:13:21 GMT');
  assert.equal(r.blocks[2].fields[3].value, 'https://www.example.com');
  assert.equal(r.blocks[2].fields[4].value, 'gzip');
  assert.equal(r.finalTable.size, 215);
});

// ---------------------------------------------------------------------------
// 错误语义：偏移、事务性、不污染
// ---------------------------------------------------------------------------

test('截断整数：报块内首字节偏移，块作废', () => {
  const r = decodeSequence([hex('1f')], 4096); // 4 位前缀需续位但字节缺失
  assert.equal(r.ok, false);
  assert.equal(r.blocks[0].status, 'error');
  assert.equal(r.blocks[0].error.code, 'truncated_integer');
  assert.equal(r.blocks[0].error.offset, 0);
  assert.equal(r.finalTable.entries.length, 0);
});

test('越界索引：空动态表引用索引 62', () => {
  const r = decodeSequence([hex('7e')], 4096);
  assert.equal(r.blocks[0].error.code, 'invalid_index');
  assert.equal(r.blocks[0].error.offset, 0);
});

test('索引 0 非法', () => {
  const r = decodeSequence([hex('80')], 4096);
  assert.equal(r.blocks[0].error.code, 'invalid_index');
});

test('非法 Huffman 填充：偏移指向字符串首字节', () => {
  // 不索引 + 新名称：名称是 1 字节 Huffman 0x00（填充非全 1）
  const r = decodeSequence([hex('00 81 00 00')], 4096);
  assert.equal(r.blocks[0].error.code, 'huffman_padding');
  assert.equal(r.blocks[0].error.offset, 1);
});

test('Huffman EOS：偏移指向字符串首字节', () => {
  const r = decodeSequence([hex('00 84 ff ff ff ff')], 4096);
  assert.equal(r.blocks[0].error.code, 'huffman_eos');
  assert.equal(r.blocks[0].error.offset, 1);
});

test('错误位置的容量更新：字段之后出现容量更新', () => {
  const r = decodeSequence([hex('82 20')], 4096); // :method GET 之后更新容量
  assert.equal(r.blocks[0].error.code, 'size_update_not_at_start');
  assert.equal(r.blocks[0].error.offset, 1);
});

test('容量更新超过复核上限', () => {
  const r = decodeSequence([hex('3f 46')], 100); // 31 + 70 = 101 > 100
  assert.equal(r.blocks[0].error.code, 'size_update_exceeds_max');
  assert.equal(r.blocks[0].error.offset, 0);
});

test('块首容量更新合法并清空表', () => {
  // 容量更新为 0，随后 :authority 插入因超容量不入表
  const r = decodeSequence([hex('20 410f 7777 772e 6578 616d 706c 652e 636f 6d')], 4096);
  assert.equal(r.ok, true);
  assert.deepEqual(r.blocks[0].sizeUpdates, [{ offset: 0, size: 0 }]);
  assert.equal(r.blocks[0].insertions[0].inserted, false);
  assert.equal(r.finalTable.entries.length, 0);
});

test('字段超限：字符串声明长度超过 8192', () => {
  // 不索引 + 新名称，名称长度 8193（0x7f c2 3f）
  const r = decodeSequence([hex('00 7f c2 3f')], 4096);
  assert.equal(r.blocks[0].error.code, 'field_too_large');
  assert.equal(r.blocks[0].error.offset, 1);
});

test('字符串截断：声明长度超过块内剩余字节', () => {
  const r = decodeSequence([hex('00 05 61 62')], 4096);
  assert.equal(r.blocks[0].error.code, 'truncated_string');
  assert.equal(r.blocks[0].error.offset, 1);
});

test('字符串截断：长度字节缺失', () => {
  const r = decodeSequence([hex('40')], 4096); // 增量索引+新名称，但名称长度字节缺失
  assert.equal(r.blocks[0].error.code, 'truncated_string');
  assert.equal(r.blocks[0].error.offset, 1);
});

test('整数截断：首字节缺失', () => {
  // 不索引 + 名称索引前缀满（15）+ 续位 0x81 0x01 → 名称索引 144 越界
  const r = decodeSequence([hex('0f 81 01')], 4096);
  assert.equal(r.blocks[0].error.code, 'invalid_index');
  // 续位自身被截断
  const r2 = decodeSequence([hex('0f 81')], 4096);
  assert.equal(r2.blocks[0].error.code, 'truncated_integer');
  assert.equal(r2.blocks[0].error.offset, 0);
});

test('失败块不污染已提交表状态，后续块跳过', () => {
  const good = C3[0]; // 插入 :authority
  // 块内先插入 a=b，再以越界索引结尾：整块必须作废
  const bad = '40 01 61 01 62 ff 7e';
  const r = decodeSequence([hex(good), hex(bad), hex(C3[1])], 4096);

  assert.equal(r.ok, false);
  assert.equal(r.blocks[0].status, 'ok');
  assert.equal(r.blocks[1].status, 'error');
  assert.equal(r.blocks[1].error.code, 'invalid_index');
  assert.equal(r.blocks[1].error.offset, 5); // 0xff 位于块内偏移 5
  assert.equal(r.blocks[2].status, 'skipped');

  // 快照保持块 1 状态：仅 :authority，a=b 未入表
  assert.equal(r.finalTable.entries.length, 1);
  assert.equal(r.finalTable.entries[0].name, ':authority');
  assert.equal(r.finalTable.size, 57);
  // 失败块自身报告的快照同样是失败前状态
  assert.equal(r.blocks[1].snapshot.size, 57);
});

test('修正失败块后重新复核可成功（会话间无状态泄漏）', () => {
  const polluted = decodeSequence([hex(C3[0]), hex('ff 7e')], 4096);
  assert.equal(polluted.ok, false);

  const fresh = decodeSequence([hex(C3[0]), hex(C3[1])], 4096);
  assert.equal(fresh.ok, true);
  assert.equal(fresh.blocks[1].fields[3].nameRef.source, 'dynamic');
});

test('每次复核从空动态表开始', () => {
  // 单独解码 C.3 块 2：0xbe 引用不存在的动态表项
  const r = decodeSequence([hex(C3[1])], 4096);
  assert.equal(r.blocks[0].error.code, 'invalid_index');
});

test('空块合法：零字段，表不变', () => {
  const r = decodeSequence([Buffer.alloc(0), hex(C3[0])], 4096);
  assert.equal(r.ok, true);
  assert.equal(r.blocks[0].fields.length, 0);
  assert.equal(r.finalTable.entries.length, 1);
});

// ---------------------------------------------------------------------------
// 请求校验（runReview）
// ---------------------------------------------------------------------------

test('校验：块数 1..8、容量 ≤4096、总量 ≤64KiB、Base64 合法', () => {
  assert.throws(() => runReview({ blocks: [] }), RequestError);
  assert.throws(() => runReview({ blocks: Array(9).fill('gg==') }), RequestError);
  assert.throws(() => runReview({ blocks: ['gg=='], tableSize: 4097 }), RequestError);
  assert.throws(() => runReview({ blocks: ['gg=='], tableSize: -1 }), RequestError);
  assert.throws(() => runReview({ blocks: ['!!!'] }), RequestError);
  assert.throws(() => runReview({ blocks: [Buffer.alloc(65537).toString('base64')] }), RequestError);
  assert.throws(() => runReview(null), RequestError);

  const ok = runReview({ blocks: C3.map(b64), tableSize: 4096 });
  assert.equal(ok.ok, true);
  assert.equal(ok.tableSize, 4096);
});

test('校验：默认容量 4096', () => {
  const r = runReview({ blocks: [b64(C3[0])] });
  assert.equal(r.tableSize, LIMITS.MAX_TABLE_CAPACITY);
});
