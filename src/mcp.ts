import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export interface Env {
  FEISHU_APP_ID: string;
  FEISHU_APP_SECRET: string;
}

const FEISHU_BASE = 'https://open.feishu.cn';

let tokenCache: { token: string; expiresAt: number } | null = null;

async function getTenantToken(env: Env): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now() + 60_000) {
    return tokenCache.token;
  }
  const res = await fetch(`${FEISHU_BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.FEISHU_APP_ID, app_secret: env.FEISHU_APP_SECRET }),
  });
  const data: any = await res.json();
  if (data.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败 (code=${data.code}): ${data.msg}`);
  }
  tokenCache = { token: data.tenant_access_token, expiresAt: Date.now() + data.expire * 1000 };
  return tokenCache.token;
}

async function feishuApi(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  const token = await getTenantToken(env);
  const res = await fetch(`${FEISHU_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data: any = await res.json();
  if (data.code !== 0) {
    throw new Error(`飞书 API 调用失败 (code=${data.code}): ${data.msg} —— ${method} ${path}`);
  }
  return data;
}

function textResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** Encode an API path component without changing the route separators. */
function pathPart(value: string): string {
  return encodeURIComponent(value);
}

// 无状态传输层：每个 HTTP 请求内完成消息派发与响应收集
class StatelessTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private outgoing: JSONRPCMessage[] = [];

  async start(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.outgoing.push(message);
  }
  async close(): Promise<void> {}
  async dispatch(message: JSONRPCMessage): Promise<void> {
    await this.onmessage?.(message);
  }
  pending(): JSONRPCMessage[] {
    return this.outgoing;
  }
  drain(): JSONRPCMessage[] {
    return this.outgoing.splice(0);
  }
}

// 派发一条消息，并等待其 JSON-RPC 响应被收集（SDK 的响应通过异步链回传）
async function dispatchAndWait(transport: StatelessTransport, message: JSONRPCMessage): Promise<void> {
  const requestId = 'method' in message && 'id' in message ? (message as { id?: unknown }).id : undefined;
  await transport.dispatch(message);
  if (requestId === undefined) return;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (transport.pending().some((m) => 'id' in m && m.id === requestId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待 MCP 响应超时 (id=${String(requestId)})`);
}

function createServer(env: Env): McpServer {
  const server = new McpServer({ name: 'feishu-mcp', version: '1.0.0' });

  server.tool(
    'createDocument',
    '在飞书云文档中创建一篇新文档，返回 document_id 和访问链接',
    {
      title: z.string().describe('文档标题'),
      folder_token: z.string().optional().describe('父文件夹 token，不传则创建到根目录「我的空间」'),
    },
    async ({ title, folder_token }) => {
      const data = await feishuApi(env, 'POST', '/open-apis/docx/v1/documents', {
        title,
        folder_token: folder_token || undefined,
      });
      const doc = data.data.document;
      return textResult({
        document_id: doc.document_id,
        title: doc.title,
        url: `https://feishu.cn/docx/${doc.document_id}`,
      });
    }
  );

  server.tool(
    'getDocumentRawContent',
    '获取飞书文档的纯文本内容',
    { document_id: z.string().describe('文档 document_id，可从文档链接 /docx/ 后面获取') },
    async ({ document_id }) => {
      const data = await feishuApi(env, 'GET', `/open-apis/docx/v1/documents/${document_id}/raw_content`);
      return textResult({ document_id, content: data.data.content });
    }
  );

  server.tool(
    'getDocumentBlocks',
    '获取飞书文档的块级结构（段落、标题、列表、图片等 block JSON）',
    {
      document_id: z.string().describe('文档 document_id'),
      page_token: z.string().optional().describe('分页 token，首次调用可不传'),
    },
    async ({ document_id, page_token }) => {
      const qs = new URLSearchParams({ page_size: '500' });
      if (page_token) qs.set('page_token', page_token);
      const data = await feishuApi(env, 'GET', `/open-apis/docx/v1/documents/${document_id}/blocks?${qs}`);
      return textResult(data.data);
    }
  );

  server.tool(
    'appendTextBlocks',
    '向飞书文档追加纯文本段落',
    {
      document_id: z.string().describe('文档 document_id'),
      parent_id: z.string().optional().describe('目标父块 id，不传则追加到文档根节点末尾'),
      texts: z.array(z.string()).describe('要追加的文本数组，每个元素成为一个段落'),
    },
    async ({ document_id, parent_id, texts }) => {
      const children = texts.map((t) => ({
        block_type: 2,
        text: { elements: [{ text_run: { content: t } }], style: {} },
      }));
      const parent = parent_id || document_id;
      const data = await feishuApi(
        env,
        'POST',
        `/open-apis/docx/v1/documents/${document_id}/blocks/${parent}/children?document_revision_id=-1`,
        { children }
      );
      return textResult(data.data);
    }
  );

  server.tool(
    'appendBlocks',
    '向飞书文档追加富文本块（标题、列表、代码块、图片等，需传入飞书 Block JSON）',
    {
      document_id: z.string().describe('文档 document_id'),
      parent_id: z.string().optional().describe('目标父块 id，不传则追加到文档根节点末尾'),
      children: z.array(z.any()).describe('飞书 block JSON 数组，参考 docx API 的 Block 结构'),
    },
    async ({ document_id, parent_id, children }) => {
      const parent = parent_id || document_id;
      const data = await feishuApi(
        env,
        'POST',
        `/open-apis/docx/v1/documents/${document_id}/blocks/${parent}/children?document_revision_id=-1`,
        { children }
      );
      return textResult(data.data);
    }
  );

  server.tool(
    'listFolderFiles',
    '列出飞书云空间某个文件夹下的文件和子文件夹',
    {
      folder_token: z.string().describe('文件夹 token'),
      page_token: z.string().optional().describe('分页 token，首次调用可不传'),
    },
    async ({ folder_token, page_token }) => {
      const qs = new URLSearchParams({ folder_token, page_size: '50' });
      if (page_token) qs.set('page_token', page_token);
      const data = await feishuApi(env, 'GET', `/open-apis/drive/v1/files?${qs}`);
      return textResult(data.data);
    }
  );

  server.tool(
    'createFolder',
    '在飞书云空间创建文件夹',
    {
      name: z.string().describe('文件夹名称'),
      folder_token: z.string().optional().describe('父文件夹 token，不传则创建到根目录'),
    },
    async ({ name, folder_token }) => {
      const data = await feishuApi(env, 'POST', '/open-apis/drive/v1/files/create_folder', {
        name,
        folder_token: folder_token || undefined,
      });
      return textResult(data.data);
    }
  );

  server.tool(
    'searchWiki',
    '在飞书知识库（Wiki）中搜索文档节点，返回标题、token 和链接',
    {
      query: z.string().describe('搜索关键词'),
      page_size: z.number().optional().describe('每页数量，默认 20'),
    },
    async ({ query, page_size }) => {
      const data = await feishuApi(env, 'POST', '/open-apis/wiki/v1/nodes/search', {
        query,
        page_size: page_size || 20,
      });
      return textResult(data.data);
    }
  );

  server.tool(
    'listBitableTables',
    '列出飞书多维表格中的数据表，用于获取后续记录操作所需的 table_id',
    {
      app_token: z.string().describe('多维表格 app_token，可从链接中 /base/ 或 /wiki/ 后的 token 获取'),
      page_token: z.string().optional().describe('分页 token，首次调用可不传'),
      page_size: z.number().int().min(1).max(100).optional().describe('每页数量，默认 100，最大 100'),
    },
    async ({ app_token, page_token, page_size }) => {
      const qs = new URLSearchParams({ page_size: String(page_size ?? 100) });
      if (page_token) qs.set('page_token', page_token);
      const data = await feishuApi(env, 'GET', `/open-apis/bitable/v1/apps/${pathPart(app_token)}/tables?${qs}`);
      return textResult(data.data);
    }
  );

  server.tool(
    'listBitableFields',
    '列出多维表格数据表的字段定义和字段名；创建或更新记录前先调用此工具确认 fields 的键名和字段类型',
    {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 table_id，可通过 listBitableTables 获取'),
      page_token: z.string().optional().describe('分页 token，首次调用可不传'),
      page_size: z.number().int().min(1).max(100).optional().describe('每页数量，默认 100，最大 100'),
    },
    async ({ app_token, table_id, page_token, page_size }) => {
      const qs = new URLSearchParams({ page_size: String(page_size ?? 100) });
      if (page_token) qs.set('page_token', page_token);
      const data = await feishuApi(
        env,
        'GET',
        `/open-apis/bitable/v1/apps/${pathPart(app_token)}/tables/${pathPart(table_id)}/fields?${qs}`
      );
      return textResult(data.data);
    }
  );

  server.tool(
    'createBitableRecord',
    '在飞书多维表格的数据表中新增一条记录',
    {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 table_id'),
      fields: z.record(z.any()).describe('记录字段值。键为字段名；值须符合飞书该字段类型要求'),
    },
    async ({ app_token, table_id, fields }) => {
      const data = await feishuApi(
        env,
        'POST',
        `/open-apis/bitable/v1/apps/${pathPart(app_token)}/tables/${pathPart(table_id)}/records`,
        { fields }
      );
      return textResult(data.data);
    }
  );

  server.tool(
    'getBitableRecord',
    '获取飞书多维表格中一条记录的字段值',
    {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 table_id'),
      record_id: z.string().describe('记录 record_id，可从 listBitableRecords 或 createBitableRecord 返回值获得'),
    },
    async ({ app_token, table_id, record_id }) => {
      const data = await feishuApi(
        env,
        'GET',
        `/open-apis/bitable/v1/apps/${pathPart(app_token)}/tables/${pathPart(table_id)}/records/${pathPart(record_id)}`
      );
      return textResult(data.data);
    }
  );

  server.tool(
    'listBitableRecords',
    '查询飞书多维表格中的记录，支持按视图、筛选表达式和排序读取',
    {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 table_id'),
      view_id: z.string().optional().describe('可选的视图 view_id；不传则读取数据表记录'),
      filter: z.string().optional().describe('可选的飞书多维表格筛选表达式'),
      sort: z.string().optional().describe('可选的排序 JSON 字符串，例如 [{"field_name":"创建时间","desc":true}]'),
      page_token: z.string().optional().describe('分页 token，首次调用可不传'),
      page_size: z.number().int().min(1).max(500).optional().describe('每页数量，默认 100，最大 500'),
    },
    async ({ app_token, table_id, view_id, filter, sort, page_token, page_size }) => {
      const qs = new URLSearchParams({ page_size: String(page_size ?? 100) });
      if (view_id) qs.set('view_id', view_id);
      if (filter) qs.set('filter', filter);
      if (sort) qs.set('sort', sort);
      if (page_token) qs.set('page_token', page_token);
      const data = await feishuApi(
        env,
        'GET',
        `/open-apis/bitable/v1/apps/${pathPart(app_token)}/tables/${pathPart(table_id)}/records?${qs}`
      );
      return textResult(data.data);
    }
  );

  server.tool(
    'updateBitableRecord',
    '更新飞书多维表格中一条记录指定字段；未传入的字段保持不变',
    {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 table_id'),
      record_id: z.string().describe('要更新的记录 record_id'),
      fields: z.record(z.any()).describe('需更新的字段值。键为字段名；传入空值前请确认该字段允许清空'),
    },
    async ({ app_token, table_id, record_id, fields }) => {
      const data = await feishuApi(
        env,
        'PUT',
        `/open-apis/bitable/v1/apps/${pathPart(app_token)}/tables/${pathPart(table_id)}/records/${pathPart(record_id)}`,
        { fields }
      );
      return textResult(data.data);
    }
  );

  server.tool(
    'deleteBitableRecord',
    '删除飞书多维表格中的一条记录。此操作会从数据表移除该记录',
    {
      app_token: z.string().describe('多维表格 app_token'),
      table_id: z.string().describe('数据表 table_id'),
      record_id: z.string().describe('要删除的记录 record_id'),
    },
    async ({ app_token, table_id, record_id }) => {
      const data = await feishuApi(
        env,
        'DELETE',
        `/open-apis/bitable/v1/apps/${pathPart(app_token)}/tables/${pathPart(table_id)}/records/${pathPart(record_id)}`
      );
      return textResult(data.data);
    }
  );

  return server;
}

async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      { status: 400 }
    );
  }

  const isBatch = Array.isArray(body);
  const messages = (isBatch ? body : [body]) as JSONRPCMessage[];

  const server = createServer(env);
  const transport = new StatelessTransport();
  await server.connect(transport);

  for (const message of messages) {
    await dispatchAndWait(transport, message);
  }

  const responses = transport.drain().filter((m) => 'id' in m && m.id !== undefined);
  await server.close();

  if (responses.length === 0) {
    // 纯通知（如 notifications/initialized）：按规范返回 202
    return new Response(null, { status: 202 });
  }
  return Response.json(isBatch ? responses : responses[0], {
    headers: { 'Content-Type': 'application/json' },
  });
}

// 平台无关的 HTTP 入口：Worker / FC / 本地测试共用
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'GET' && url.pathname === '/') {
    return new Response(
      `Feishu MCP 运行中 ✅\n\nMCP 接入地址: ${url.origin}/mcp\n\n在支持远程 MCP(Streamable HTTP)的客户端中添加该 URL 即可使用。`,
      { headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
    );
  }

  if (url.pathname !== '/mcp') {
    return new Response('Not Found', { status: 404 });
  }
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  try {
    return await handleMcpRequest(request, env);
  } catch (err) {
    return Response.json(
      {
        jsonrpc: '2.0',
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
        id: null,
      },
      { status: 500 }
    );
  }
}
