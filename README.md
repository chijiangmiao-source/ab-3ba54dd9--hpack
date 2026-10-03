# 星载中继网关 · HPACK 连续解码复核台

地面审查员用于复核星载中继网关连续接收的 HTTP/2 头块（HPACK，RFC 7541）的工具。
按接收顺序粘贴 1–8 段 Base64 编码的原始头块，在同一动态表上连续解码，逐段查看
字段、引用来源、插入/驱逐记录与段末表快照；压缩上下文错位导致的非法块会被精确定位
到块内字节偏移，且不会污染已提交的表状态。

## 功能与复核规则

- **连续解码**：一次复核会话内，同一动态表贯穿全部块；后块可引用前块插入的字段。
- **完整表示法**：变长整数、静态/动态索引、三种字面量索引策略（增量索引 / 不索引 /
  永不索引）、块首动态表容量更新、Huffman 字符串。
- **事务性**：块内任一错误使整块作废——已提交快照不变，后续块标记为"未解码"；
  修正后重新复核即可（每次复核从空表开始，会话间无状态泄漏）。
- **错误定位**：截断整数、越界索引、非法 Huffman 填充或 EOS、错误位置的容量更新、
  字段超限，均报告**块内首字节偏移**与错误码。
- **界面**：输入变更即清除旧结论（含旧的成功结论）；可一键清空草稿、清除结论。
- **限制**：每次 1–8 段；输入总量 ≤ 64 KiB；动态表容量 ≤ 4096 字节；
  单字段名/值 ≤ 8192 字节。

## 本地运行

```bash
npm start          # 启动服务，默认 :8080（PORT 环境变量可改）
npm test           # 连续解码规则代码测试（RFC 7541 Appendix C 向量 + 错误语义）
npm run build      # 页面构建检查，产出 dist/index.html
npm run verify     # 完整验收（需服务已运行于 :8080 或指定 URL）
node scripts/verify.js http://127.0.0.1:8080
```

页面：<http://127.0.0.1:8080/> ；健康路径：<http://127.0.0.1:8080/health>

## Docker / Compose 验收

```bash
docker compose up -d app              # 启动复核台
docker compose run --rm verify        # 运行验收：退出码 0 通过，1 失败
# 或：docker compose up --abort-on-container-exit verify
```

`verify` 依次执行：连续解码规则代码测试（`node --test`）→ 页面构建检查 →
对页面（`GET /`）与健康路径（`GET /health`）及解码 API 的 HTTP 冒烟
（含跨块引用、失败块不污染两项端到端断言），完成后退出并以退出码报告结果。

## API

### `POST /api/decode`

```json
{
  "tableSize": 4096,
  "blocks": ["goSGQ...", "goaEvlgIbm8tY2FjaGU="]
}
```

- `blocks`：1–8 段 Base64（标准字母表，可含空白），解码后总量 ≤ 64 KiB。
- `tableSize`：可选，0–4096，默认 4096。

响应（始终 200；请求非法时 400）：

```json
{
  "ok": false,
  "tableSize": 4096,
  "limits": { "MAX_BLOCKS": 8, "MAX_TOTAL_INPUT": 65536, "...": "..." },
  "blocks": [
    {
      "index": 0, "status": "ok", "bytes": 20,
      "fields": [
        { "offset": 3, "representation": "incremental",
          "name": ":authority", "value": "www.example.com",
          "nameRef": { "source": "static", "index": 1 },
          "valueRef": { "source": "literal", "huffman": false },
          "indexed": true }
      ],
      "sizeUpdates": [{ "offset": 0, "size": 4096 }],
      "insertions": [{ "offset": 3, "index": 62, "name": "...", "value": "...",
                       "size": 57, "inserted": true }],
      "evictions": [{ "name": "...", "value": "...", "size": 57, "origin": 0 }],
      "snapshot": { "maxSize": 4096, "size": 57,
                    "entries": [{ "index": 62, "name": "...", "value": "...",
                                  "size": 57, "origin": 0 }] }
    },
    {
      "index": 1, "status": "error", "bytes": 2,
      "error": { "code": "invalid_index", "message": "...", "offset": 0 },
      "snapshot": { "...": "失败前快照，未被污染" }
    },
    { "index": 2, "status": "skipped", "bytes": 10 }
  ],
  "finalTable": { "maxSize": 4096, "size": 57, "entries": ["..."] },
  "summary": { "totalFields": 4, "totalInsertions": 1, "totalEvictions": 0,
               "failedBlock": 1 }
}
```

`status`：`ok` 成功 / `error` 失败（整块作废）/ `skipped`（前序块失败，未解码）。
引用来源 `source`：`static`（静态表 #1–61）/ `dynamic`（动态表 #62+，含 `origin`
插入段号）/ `literal`（字面量，含 `huffman` 标记）。

### 错误码

| code | 含义 |
| --- | --- |
| `truncated_integer` | 变长整数续位字节缺失 |
| `integer_overflow` | 变长整数位数超限 |
| `invalid_index` | 索引 0 或越界（静态 1–61 / 动态 62+） |
| `truncated_string` | 字符串声明长度超过块内剩余字节 |
| `huffman_padding` | Huffman 填充超过 7 位或非全 1 |
| `huffman_eos` | Huffman 流中出现 EOS 符号 |
| `size_update_not_at_start` | 容量更新未位于块首 |
| `size_update_exceeds_max` | 容量更新超过复核上限 |
| `field_too_large` | 字段名/值超过 8192 字节 |
| `invalid_request` | 请求校验失败（段数 / 容量 / 总量 / Base64） |

### 其他路径

- `GET /`：复核页面（优先 `dist/` 构建产物，回退 `public/`）。
- `GET /health`：`{"status":"ok", ...}`。

## 项目结构

```
src/hpack.js         HPACK 解码核心（整数/字符串/Huffman/动态表/连续会话）
src/huffman-table.js RFC 7541 Appendix B Huffman 表（由 RFC 文本生成并校验）
src/static-table.js  RFC 7541 Appendix A 静态表（同上）
src/review.js        请求校验与复核会话
src/server.js        零依赖 HTTP 服务
public/index.html    复核页面（单文件，构建后至 dist/）
scripts/build.js     页面构建检查
scripts/verify.js    验收：代码测试 + 构建检查 + HTTP 冒烟，退出码报告结果
test/                node:test 测试（RFC 向量、错误语义、API、页面逻辑）
Dockerfile / docker-compose.yml
```
