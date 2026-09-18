# feishu-mcp

部署在 Cloudflare Workers 上、本地的飞书 MCP 服务，通过 Streamable HTTP 协议暴露飞书文档、云空间、知识库和多维表格能力，可在 Cursor、Claude Desktop、Cherry Studio 等支持远程 MCP 的客户端中直接调用。

## 已实现工具

| 工具 | 说明 |
| --- | --- |
| `createDocument` | 创建飞书文档，返回 document_id 和链接 |
| `getDocumentRawContent` | 获取文档纯文本内容 |
| `getDocumentBlocks` | 获取文档块级结构（block JSON） |
| `appendTextBlocks` | 向文档追加纯文本段落 |
| `appendBlocks` | 向文档追加富文本块（标题/列表/代码块等 Block JSON） |
| `listFolderFiles` | 列出云空间文件夹内容 |
| `createFolder` | 在云空间创建文件夹 |
| `searchWiki` | 在知识库（Wiki）中搜索文档 |
| `listBitableTables` | 列出多维表格中的数据表，取得 `table_id` |
| `listBitableFields` | 列出数据表字段，确认字段名与字段类型 |
| `createBitableRecord` | 新增一条多维表格记录 |
| `getBitableRecord` | 获取一条多维表格记录 |
| `listBitableRecords` | 分页查询记录，支持视图、筛选与排序 |
| `updateBitableRecord` | 更新一条记录的指定字段 |
| `deleteBitableRecord` | 删除一条记录 |

## 一、飞书侧准备（已完成可跳过）

1. 打开 [飞书开放平台](https://open.feishu.cn/app) 创建「自建应用」，记录 **App ID** 和 **App Secret**。
2. 「权限管理」中开通以下权限并发布版本：
   - `docx:document` — 查看、评论、编辑和管理文档
   - `drive:drive` — 查看、评论、编辑和管理云空间文件
   - `wiki:wiki` — 查看、编辑和管理知识库
   - `bitable:app` — 查看、编辑和管理多维表格（新增、更新、删除记录需要）
3. 「应用发布」中创建版本并发布（企业内部应用需管理员审核）。
4. 让应用能访问文档：打开目标文档 → 右上角「...」→「添加文档应用」，把你的应用加为协作者（或把应用加进目标文件夹/知识库成员）。
5. 让应用能访问目标多维表格：在多维表格的「分享/协作」中将应用添加为协作者，并在开放平台发布包含 `bitable:app` 权限的新版本。

## 二、本地运行（已验证）

```bash
npm install
# 凭据写入 .dev.vars（已存在，勿提交 git）
npm run dev
# MCP 地址: http://127.0.0.1:8787/mcp
```

## 三、部署到 Cloudflare 生成公网 URL

```bash
npx wrangler login                 # 浏览器授权 Cloudflare 账号
wrangler secret put FEISHU_APP_ID        
wrangler secret put FEISHU_APP_SECRET   
npm run deploy
```

部署成功后输出即公网地址，MCP 接入 URL 为：

```
https://feishu-mcp.<你的子域>.workers.dev/mcp
```

## 四、在 MCP 客户端中使用

以 Cursor 为例：`Settings → MCP → Add new MCP server`，类型选 **HTTP**（Streamable HTTP），URL 填上面的 `/mcp` 地址。Cherry Studio、Claude Desktop 同理（选择 remote/streamable-http 类型）。

## 说明

- 服务端无状态，每次请求独立处理，无需 Durable Objects/KV。
- `tenant_access_token` 缓存在 Worker 内存中，过期前自动复用。
- 想加新工具：在 `src/mcp.ts` 的 `createServer` 里照现有格式 `server.tool(name, 描述, zod 参数, handler)` 追加即可，handler 内用 `feishuApi(env, method, path, body)` 调任意飞书 OpenAPI。
- 多维表格记录操作以 `app_token + table_id + record_id` 定位目标。先调用 `listBitableTables` 与 `listBitableFields`，再用返回的字段名作为 `fields` 的键；不同字段类型的值格式遵循飞书多维表格字段值规范。
