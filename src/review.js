// 复核请求的校验与执行：1..8 段 Base64、总输入 ≤64KiB、容量 ≤4096。
'use strict';

const { decodeSequence, LIMITS } = require('./hpack');

class RequestError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'RequestError';
    this.code = 'invalid_request';
    this.details = details;
  }
}

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeBase64Strict(input, index) {
  const cleaned = String(input).replace(/\s+/g, '');
  if (!BASE64_RE.test(cleaned)) {
    throw new RequestError(`第 ${index + 1} 段不是合法的 Base64 编码`);
  }
  return Buffer.from(cleaned, 'base64');
}

// 校验请求体，返回 { buffers, capacity }；非法时抛 RequestError。
function validatePayload(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError('请求体必须是 JSON 对象');
  }

  let capacity = LIMITS.MAX_TABLE_CAPACITY;
  if (body.tableSize !== undefined && body.tableSize !== null) {
    if (!Number.isInteger(body.tableSize) || body.tableSize < 0) {
      throw new RequestError('动态表容量必须是非负整数');
    }
    if (body.tableSize > LIMITS.MAX_TABLE_CAPACITY) {
      throw new RequestError(`动态表容量 ${body.tableSize} 超过上限 ${LIMITS.MAX_TABLE_CAPACITY} 字节`);
    }
    capacity = body.tableSize;
  }

  if (!Array.isArray(body.blocks) || body.blocks.length === 0) {
    throw new RequestError('至少需要 1 段 HPACK 块');
  }
  if (body.blocks.length > LIMITS.MAX_BLOCKS) {
    throw new RequestError(`最多 ${LIMITS.MAX_BLOCKS} 段，收到 ${body.blocks.length} 段`);
  }
  body.blocks.forEach((b, i) => {
    if (typeof b !== 'string') throw new RequestError(`第 ${i + 1} 段必须是 Base64 字符串`);
  });

  const buffers = body.blocks.map((b, i) => decodeBase64Strict(b, i));
  const total = buffers.reduce((n, b) => n + b.length, 0);
  if (total > LIMITS.MAX_TOTAL_INPUT) {
    throw new RequestError(`输入总量 ${total} 字节超过 ${LIMITS.MAX_TOTAL_INPUT} 字节（64KiB）上限`);
  }

  return { buffers, capacity };
}

// 执行一次复核会话：每次调用都从空动态表开始，同一动态表贯穿全部块。
function runReview(body) {
  const { buffers, capacity } = validatePayload(body);
  const result = decodeSequence(buffers, capacity);
  return { limits: LIMITS, ...result };
}

module.exports = { runReview, validatePayload, RequestError };
