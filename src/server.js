// 星载中继网关 HPACK 复核台 HTTP 服务（零依赖）。
//   GET  /            复核页面（优先 dist/ 构建产物，回退 public/）
//   GET  /health      健康检查
//   POST /api/decode  连续解码复核
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { runReview, RequestError } = require('./review');

const PORT = Number(process.env.PORT || 8080);
const MAX_BODY = 256 * 1024; // 64KiB 原始输入的 Base64 约 87KiB，留足余量

const DIST_PAGE = path.join(__dirname, '..', 'dist', 'index.html');
const PUBLIC_PAGE = path.join(__dirname, '..', 'public', 'index.html');

function pagePath() {
  return fs.existsSync(DIST_PAGE) ? DIST_PAGE : PUBLIC_PAGE;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let len = 0;
    req.on('data', (c) => {
      len += c.length;
      if (len > MAX_BODY) {
        const err = new Error('请求体过大');
        err.statusCode = 413;
        reject(err);
        req.removeAllListeners('data');
        req.removeAllListeners('end');
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://internal');

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, {
      status: 'ok',
      service: 'hpack-relay-review',
      uptime: process.uptime(),
      time: new Date().toISOString(),
    });
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(pagePath()).pipe(res);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/decode') {
    try {
      const raw = await readBody(req);
      let body;
      try {
        body = JSON.parse(raw.toString('utf8'));
      } catch {
        sendJson(res, 400, { error: { code: 'invalid_json', message: '请求体不是合法 JSON' } });
        return;
      }
      const result = runReview(body);
      sendJson(res, 200, result);
    } catch (e) {
      if (e instanceof RequestError) {
        sendJson(res, 400, { error: { code: e.code, message: e.message } });
      } else if (e.statusCode) {
        sendJson(res, e.statusCode, { error: { code: 'request_error', message: e.message } });
      } else {
        sendJson(res, 500, { error: { code: 'internal_error', message: '服务内部错误' } });
      }
    }
    return;
  }

  sendJson(res, 404, { error: { code: 'not_found', message: '路径不存在' } });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`hpack-relay-review listening on :${PORT}`);
  });
}

module.exports = { server };
