// HPACK (RFC 7541) 连续解码器。
//
// 复核语义：
//  - 同一动态表在全部块间延续；
//  - 每块事务化解码：块内任一错误使整块作废，已提交快照不变；
//  - 错误携带块内字节偏移（出错构造的首个字节）。
'use strict';

const { STATIC_TABLE } = require('./static-table');
const { HUFFMAN_CODES } = require('./huffman-table');

const ENTRY_OVERHEAD = 32; // RFC 7541 §4.1
const STATIC_LEN = STATIC_TABLE.length; // 61

const LIMITS = Object.freeze({
  MAX_BLOCKS: 8,               // 每次复核 1..8 段
  MAX_TOTAL_INPUT: 64 * 1024,  // 全部块解码后总字节上限 64KiB
  MAX_TABLE_CAPACITY: 4096,    // 动态表容量上限
  MAX_FIELD_SIZE: 8192,        // 单个字段名/值解码后字节上限（字段超限）
  MAX_INTEGER_BITS: 35,        // 变长整数最大位数，超出视为非法
});

class HpackError extends Error {
  constructor(code, message, offset) {
    super(message);
    this.name = 'HpackError';
    this.code = code;
    this.offset = offset; // 块内字节偏移
  }
}

// ---------------------------------------------------------------------------
// Huffman（RFC 7541 Appendix B）
// ---------------------------------------------------------------------------

const huffmanTree = (() => {
  const root = {};
  for (let sym = 0; sym < HUFFMAN_CODES.length; sym++) {
    const [code, bits] = HUFFMAN_CODES[sym];
    let node = root;
    for (let i = bits - 1; i >= 0; i--) {
      const bit = (code >>> i) & 1;
      node = node[bit] || (node[bit] = {});
    }
    node.sym = sym;
  }
  return root;
})();

// 解码 Huffman 字符串。EOS 符号或非法填充（>7 位或非全 1）均为解码错误。
function huffmanDecode(bytes, errOffset) {
  const out = [];
  let node = huffmanTree;
  let cur = 0; // 自上个符号以来累积的位
  let len = 0;
  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) {
      const bit = (byte >>> i) & 1;
      node = node[bit];
      cur = (cur << 1) | bit;
      len++;
      if (node.sym !== undefined) {
        if (node.sym === 256) {
          throw new HpackError('huffman_eos',
            `Huffman 编码中出现 EOS 符号（字符串首字节偏移 ${errOffset}）`, errOffset);
        }
        out.push(node.sym);
        if (out.length > LIMITS.MAX_FIELD_SIZE) {
          throw new HpackError('field_too_large',
            `字段解码后超过 ${LIMITS.MAX_FIELD_SIZE} 字节上限（字符串首字节偏移 ${errOffset}）`, errOffset);
        }
        node = huffmanTree;
        cur = 0;
        len = 0;
      }
    }
  }
  if (len > 7) {
    throw new HpackError('huffman_padding',
      `Huffman 填充超过 7 位（字符串首字节偏移 ${errOffset}）`, errOffset);
  }
  if (len > 0 && cur !== (1 << len) - 1) {
    throw new HpackError('huffman_padding',
      `Huffman 填充位必须全为 1（字符串首字节偏移 ${errOffset}）`, errOffset);
  }
  return Buffer.from(out).toString('latin1');
}

// ---------------------------------------------------------------------------
// 基本类型（RFC 7541 §5）
// ---------------------------------------------------------------------------

// 变长整数。截断（首字节或续位字节缺失）或位数爆炸时报错，偏移指向整数首字节。
function decodeInteger(buf, pos, prefixBits, errOffset) {
  if (pos >= buf.length) {
    throw new HpackError('truncated_integer',
      `变长整数在偏移 ${errOffset} 处被截断（首字节缺失）`, errOffset);
  }
  const mask = (1 << prefixBits) - 1;
  let value = buf[pos] & mask;
  pos++;
  if (value < mask) return { value, pos };
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) {
      throw new HpackError('truncated_integer',
        `变长整数在偏移 ${errOffset} 处被截断（续位字节缺失）`, errOffset);
    }
    const b = buf[pos++];
    value += (b & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > LIMITS.MAX_INTEGER_BITS) {
      throw new HpackError('integer_overflow',
        `变长整数位数超限（首字节偏移 ${errOffset}）`, errOffset);
    }
    if (!(b & 0x80)) break;
  }
  return { value, pos };
}

// 字符串字面量：H 位 + 7 位前缀长度 + 内容。
function decodeString(buf, pos) {
  const start = pos;
  if (pos >= buf.length) {
    throw new HpackError('truncated_string',
      `字符串在偏移 ${start} 处被截断（长度字节缺失）`, start);
  }
  const huffman = (buf[pos] & 0x80) !== 0;
  const lenRes = decodeInteger(buf, pos, 7, start);
  pos = lenRes.pos;
  const len = lenRes.value;
  if (len > LIMITS.MAX_FIELD_SIZE) {
    throw new HpackError('field_too_large',
      `字符串声明长度 ${len} 超过 ${LIMITS.MAX_FIELD_SIZE} 字节上限（首字节偏移 ${start}）`, start);
  }
  if (pos + len > buf.length) {
    throw new HpackError('truncated_string',
      `字符串在偏移 ${start} 处声明长度 ${len}，块内剩余字节不足`, start);
  }
  const raw = buf.subarray(pos, pos + len);
  pos += len;
  const value = huffman ? huffmanDecode(raw, start) : raw.toString('latin1');
  return { value, pos, huffman };
}

// ---------------------------------------------------------------------------
// 动态表（RFC 7541 §2.3.2、§4）
// ---------------------------------------------------------------------------

class DynamicTable {
  constructor(maxSize) {
    this.maxSize = maxSize;
    this.entries = []; // 最新在前；{ name, value, size, origin }
    this.size = 0;
  }

  clone() {
    const t = new DynamicTable(this.maxSize);
    t.entries = this.entries.map((e) => ({ ...e }));
    t.size = this.size;
    return t;
  }

  evictTo(limit, evictions) {
    while (this.size > limit && this.entries.length > 0) {
      const e = this.entries.pop(); // 驱逐最旧条目
      this.size -= e.size;
      evictions.push({ name: e.name, value: e.value, size: e.size, origin: e.origin });
    }
  }

  setMaxSize(newMax, evictions) {
    this.maxSize = newMax;
    this.evictTo(newMax, evictions);
  }

  // RFC 7541 §4.4：条目大于容量时清空表且不插入（非错误）。
  add(name, value, origin, evictions) {
    const size = name.length + value.length + ENTRY_OVERHEAD;
    const entry = { name, value, size, origin };
    if (size > this.maxSize) {
      this.evictTo(0, evictions);
      return { inserted: false, entry };
    }
    this.entries.unshift(entry);
    this.size += size;
    this.evictTo(this.maxSize, evictions);
    return { inserted: true, entry, index: STATIC_LEN + 1 };
  }
}

// 绝对索引查表：1..61 静态表，62.. 动态表（62 为最新）。
function lookup(index, table, offset) {
  if (index >= 1 && index <= STATIC_LEN) {
    const [name, value] = STATIC_TABLE[index - 1];
    return { name, value, ref: { source: 'static', index } };
  }
  const dynIdx = index - STATIC_LEN - 1;
  if (dynIdx >= 0 && dynIdx < table.entries.length) {
    const e = table.entries[dynIdx];
    return { name: e.name, value: e.value, ref: { source: 'dynamic', index, origin: e.origin } };
  }
  throw new HpackError('invalid_index',
    `索引 ${index} 越界（静态表 1..${STATIC_LEN}，动态表 ${STATIC_LEN + 1}..${STATIC_LEN + table.entries.length}；首字节偏移 ${offset}）`,
    offset);
}

// ---------------------------------------------------------------------------
// 头块解码（RFC 7541 §6）
// ---------------------------------------------------------------------------

function decodeBlock(buf, table, capacityLimit, blockIndex) {
  const fields = [];
  const insertions = [];
  const evictions = [];
  const sizeUpdates = [];
  let pos = 0;
  let seenField = false; // 容量更新必须位于块首（任何字段表示之前）

  while (pos < buf.length) {
    const offset = pos;
    const b = buf[pos];

    if (b & 0x80) {
      // §6.1 索引表示
      const res = decodeInteger(buf, pos, 7, offset);
      pos = res.pos;
      const index = res.value;
      if (index === 0) {
        throw new HpackError('invalid_index', `索引 0 非法（首字节偏移 ${offset}）`, offset);
      }
      const hit = lookup(index, table, offset);
      fields.push({
        offset, representation: 'indexed',
        name: hit.name, value: hit.value, nameRef: hit.ref, valueRef: hit.ref,
      });
      seenField = true;
    } else if (b & 0x40) {
      // §6.2.1 字面量·增量索引
      const res = decodeInteger(buf, pos, 6, offset);
      pos = res.pos;
      const nameIdx = res.value;
      let name; let nameRef;
      if (nameIdx === 0) {
        const s = decodeString(buf, pos);
        pos = s.pos;
        name = s.value;
        nameRef = { source: 'literal', huffman: s.huffman };
      } else {
        const hit = lookup(nameIdx, table, offset);
        name = hit.name;
        nameRef = hit.ref;
      }
      const v = decodeString(buf, pos);
      pos = v.pos;
      const value = v.value;
      const valueRef = { source: 'literal', huffman: v.huffman };
      const added = table.add(name, value, blockIndex, evictions);
      insertions.push({
        offset, index: STATIC_LEN + 1, name, value,
        size: name.length + value.length + ENTRY_OVERHEAD,
        inserted: added.inserted,
      });
      fields.push({
        offset, representation: 'incremental',
        name, value, nameRef, valueRef, indexed: added.inserted,
      });
      seenField = true;
    } else if ((b & 0xe0) === 0x20) {
      // §6.3 动态表容量更新：必须位于块首且不超过容量上限
      if (seenField) {
        throw new HpackError('size_update_not_at_start',
          `容量更新出现在字段表示之后（首字节偏移 ${offset}）`, offset);
      }
      const res = decodeInteger(buf, pos, 5, offset);
      pos = res.pos;
      const newSize = res.value;
      if (newSize > capacityLimit) {
        throw new HpackError('size_update_exceeds_max',
          `容量更新值 ${newSize} 超过复核上限 ${capacityLimit}（首字节偏移 ${offset}）`, offset);
      }
      table.setMaxSize(newSize, evictions);
      sizeUpdates.push({ offset, size: newSize });
    } else {
      // §6.2.2 / §6.2.3 字面量·不索引 / 永不索引
      const neverIndexed = (b & 0x10) !== 0;
      const res = decodeInteger(buf, pos, 4, offset);
      pos = res.pos;
      const nameIdx = res.value;
      let name; let nameRef;
      if (nameIdx === 0) {
        const s = decodeString(buf, pos);
        pos = s.pos;
        name = s.value;
        nameRef = { source: 'literal', huffman: s.huffman };
      } else {
        const hit = lookup(nameIdx, table, offset);
        name = hit.name;
        nameRef = hit.ref;
      }
      const v = decodeString(buf, pos);
      pos = v.pos;
      fields.push({
        offset, representation: neverIndexed ? 'never_indexed' : 'without_indexing',
        name, value: v.value, nameRef, valueRef: { source: 'literal', huffman: v.huffman },
      });
      seenField = true;
    }
  }

  return { fields, insertions, evictions, sizeUpdates };
}

// ---------------------------------------------------------------------------
// 连续复核会话
// ---------------------------------------------------------------------------

function snapshotOf(table) {
  return {
    maxSize: table.maxSize,
    size: table.size,
    entries: table.entries.map((e, i) => ({
      index: STATIC_LEN + 1 + i,
      name: e.name,
      value: e.value,
      size: e.size,
      origin: e.origin,
    })),
  };
}

// 按接收顺序解码全部块；同一动态表贯穿始终。
// 块失败：该块不产生任何表变更，后续块标记为 skipped，快照保持失败前状态。
function decodeSequence(buffers, capacity) {
  const table = new DynamicTable(capacity);
  const blocks = [];
  let snapshot = snapshotOf(table);
  let failed = false;

  for (let i = 0; i < buffers.length; i++) {
    if (failed) {
      blocks.push({ index: i, status: 'skipped', bytes: buffers[i].length });
      continue;
    }
    const work = table.clone(); // 事务：成功才提交
    try {
      const r = decodeBlock(buffers[i], work, capacity, i);
      table.maxSize = work.maxSize;
      table.entries = work.entries;
      table.size = work.size;
      snapshot = snapshotOf(table);
      blocks.push({ index: i, status: 'ok', bytes: buffers[i].length, ...r, snapshot });
    } catch (e) {
      if (!(e instanceof HpackError)) throw e;
      failed = true;
      blocks.push({
        index: i, status: 'error', bytes: buffers[i].length,
        error: { code: e.code, message: e.message, offset: e.offset },
        snapshot, // 失败块不得改变此前快照
      });
    }
  }

  const totalFields = blocks.reduce((n, b) => n + (b.fields ? b.fields.length : 0), 0);
  const totalInsertions = blocks.reduce((n, b) => n + (b.insertions ? b.insertions.filter((x) => x.inserted).length : 0), 0);
  const totalEvictions = blocks.reduce((n, b) => n + (b.evictions ? b.evictions.length : 0), 0);
  const failedBlock = blocks.find((b) => b.status === 'error');

  return {
    ok: !failed,
    tableSize: capacity,
    blocks,
    finalTable: snapshot,
    summary: {
      totalFields,
      totalInsertions,
      totalEvictions,
      failedBlock: failedBlock ? failedBlock.index : null,
    },
  };
}

module.exports = {
  LIMITS,
  ENTRY_OVERHEAD,
  STATIC_LEN,
  HpackError,
  DynamicTable,
  decodeInteger,
  decodeString,
  huffmanDecode,
  decodeBlock,
  decodeSequence,
  snapshotOf,
};
