// Minimal MCP client for the page runtime. Only streamable HTTP is implemented:
// a browser cannot spawn the stdio processes Pi uses for local servers.
import {MCP_PROTOCOL_VERSION} from './mcp.js';

const CLIENT_INFO = {name: 'pi-tab', version: '1.2.0'};
const MAX_PAGES = 20;
const MAX_TOOLS = 200;

export class McpError extends Error {
  constructor(message, {server = '', status = 0} = {}) {
    super(server ? `${server}：${message}` : message);
    this.name = 'McpError';
    this.server = server;
    this.status = status;
  }
}

function linkSignals(signal, timeoutMs) {
  const controller = new AbortController();
  const abort = reason => controller.abort(reason);
  if (signal?.aborted) abort(signal.reason);
  const onAbort=()=>abort(signal.reason);
  if(!signal?.aborted)signal?.addEventListener('abort',onAbort,{once:true});
  const timer = setTimeout(() => abort(new McpError('请求超时。')), timeoutMs);
  return {signal: controller.signal, controller, cleanup: () => { clearTimeout(timer);signal?.removeEventListener('abort',onAbort); }};
}

async function readSseMessage(stream, id, controller) {
  const reader = stream.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      buffer += decoder.decode(value, {stream: true});
      let boundary;
      while ((boundary = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
        const data = block.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let message;
        try { message = JSON.parse(data); } catch { continue; }
        if (Array.isArray(message)) {
          const match = message.find(item => item?.id === id);
          if (match) return match;
          continue;
        }
        if (message?.id === id) return message;
      }
    }
    if (buffer.trim()) {
      const data = buffer.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) { try { const message = JSON.parse(data); if (message?.id === id) return message; } catch {} }
    }
    throw new McpError('服务器关闭了连接，没有返回结果。');
  } finally {
    controller.abort();
    void reader.cancel().catch(() => {});
  }
}

async function readMessage(response, id, controller) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('text/event-stream') && response.body) return readSseMessage(response.body, id, controller);
  const text = await response.text();
  if (!text.trim()) throw new McpError('服务器返回了空响应。');
  let message;
  try { message = JSON.parse(text); } catch { throw new McpError('服务器返回了无法解析的内容。'); }
  if (Array.isArray(message)) {
    const match = message.find(item => item?.id === id);
    if (!match) throw new McpError('服务器没有返回本次请求的结果。');
    return match;
  }
  return message;
}

/** MCP content blocks → pi-ai tool output. */
export function mcpToolOutput(result) {
  const output = [];
  for (const item of Array.isArray(result?.content) ? result.content : []) {
    if (item?.type === 'text' && typeof item.text === 'string') output.push({type: 'text', text: item.text});
    else if (item?.type === 'image' && typeof item.data === 'string') output.push({type: 'image', data: item.data, mimeType: item.mimeType || 'image/png'});
    else if (item?.type === 'resource' && item.resource) output.push({type: 'text', text: JSON.stringify(item.resource, null, 2)});
    else if (item?.type === 'resource_link') output.push({type: 'text', text: `${item.name || item.uri || '资源'}：${item.uri || ''}`});
    else if (item) output.push({type: 'text', text: JSON.stringify(item, null, 2)});
  }
  if (!output.length && result?.structuredContent !== undefined) output.push({type: 'text', text: JSON.stringify(result.structuredContent, null, 2)});
  if (!output.length) output.push({type: 'text', text: '（MCP 工具没有返回内容。）'});
  return output;
}

/**
 * Creates a client for one server. Requests are independent POSTs; the session
 * id and negotiated protocol version are reused for the calls that follow.
 */
export function createMcpHttpClient({url, headers = {}, timeout = 60, fetch: fetchImpl = globalThis.fetch?.bind(globalThis), clientInfo = CLIENT_INFO, server = ''} = {}) {
  if (typeof fetchImpl !== 'function') throw new McpError('当前环境不支持 fetch。', {server});
  const timeoutMs = Math.max(1, Number(timeout) || 60) * 1000;
  let sessionId = '', protocolVersion = '', nextId = 0, closed = false;
  const pending=new Set();

  async function post(body, {id, signal} = {}) {
    if (closed) throw new McpError('连接已关闭。', {server});
    const linked = linkSignals(signal, timeoutMs);
    pending.add(linked.controller);
    try {
      let response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            ...headers,
            ...(sessionId ? {'Mcp-Session-Id': sessionId} : {}),
            ...(protocolVersion ? {'MCP-Protocol-Version': protocolVersion} : {}),
          },
          body: JSON.stringify(body),
          signal: linked.signal,
        });
      } catch (error) {
        if (linked.signal.aborted && linked.signal.reason instanceof Error) throw linked.signal.reason;
        throw new McpError('无法连接服务器。请检查地址、网络，以及网页是否允许跨域请求（CORS）。', {server});
      }
      const assigned = response.headers.get('mcp-session-id');
      if (assigned) sessionId = assigned;
      if (response.status === 401 || response.status === 403) throw new McpError(`服务器拒绝访问（HTTP ${response.status}），请检查 Authorization 等请求头。`, {server, status: response.status});
      if (!response.ok && response.status !== 202) {
        throw new McpError(`服务器返回 HTTP ${response.status}。`, {server, status: response.status});
      }
      if (id === undefined || response.status === 202 || !response.body) {
        await response.body?.cancel().catch(()=>{});
        return undefined;
      }
      const message = await readMessage(response, id, linked.controller);
      if (message?.error) throw new McpError('服务器返回 MCP 协议错误。', {server});
      return message?.result;
    } finally { linked.controller.abort();linked.cleanup();pending.delete(linked.controller); }
  }

  async function notify(method, params) {
    await post({jsonrpc: '2.0', method, ...(params === undefined ? {} : {params})});
  }

  async function request(method, params, signal) {
    const id = ++nextId;
    return post({jsonrpc: '2.0', id, method, ...(params === undefined ? {} : {params})}, {id, signal});
  }

  return {
    get sessionId() { return sessionId; },
    get protocolVersion() { return protocolVersion; },
    async initialize(signal) {
      const result = await request('initialize', {protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo}, signal);
      protocolVersion = typeof result?.protocolVersion === 'string' ? result.protocolVersion : MCP_PROTOCOL_VERSION;
      await notify('notifications/initialized');
      return result ?? {};
    },
    async listTools(signal) {
      const tools = [];
      let cursor;
      for (let page = 0; page < MAX_PAGES; page++) {
        const result = await request('tools/list', cursor ? {cursor} : {}, signal);
        for (const tool of Array.isArray(result?.tools) ? result.tools : []) {
          if (tool && typeof tool.name === 'string' && tool.name) tools.push(tool);
        }
        cursor = result?.nextCursor;
        if (!cursor || tools.length >= MAX_TOOLS) break;
      }
      return tools.slice(0, MAX_TOOLS);
    },
    async callTool(name, args = {}, signal) {
      const result = await request('tools/call', {name, arguments: args && typeof args === 'object' ? args : {}}, signal);
      if (result?.isError) {
        const text = mcpToolOutput(result).map(item => item.text ?? '').join('\n').slice(0, 4000);
        throw new McpError(text || '工具调用失败。', {server});
      }
      return result ?? {};
    },
    async close() {
      if (closed) return;
      closed = true;
      for(const controller of pending)controller.abort(new McpError('连接已关闭。'));
      pending.clear();
      if (!sessionId) return;
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
      try { await fetchImpl(url, {method:'DELETE',headers:{...headers,'Mcp-Session-Id':sessionId},signal:controller.signal}); } catch {}
      finally {clearTimeout(timer);controller.abort();}
    },
  };
}
