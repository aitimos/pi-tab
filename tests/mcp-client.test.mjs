import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import test from 'node:test';
import {createMcpHttpClient, mcpToolOutput} from '../src/mcp-client.js';

function startServer(handler) {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      const message = body ? JSON.parse(body) : null;
      handler({request, response, message, reply: value => {
        response.writeHead(200, {'Content-Type': 'application/json'});
        response.end(JSON.stringify(value));
      }});
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({server, url: `http://127.0.0.1:${server.address().port}/mcp`})));
}

const initializeResult = {protocolVersion: '2025-06-18', capabilities: {tools: {}}, serverInfo: {name: 'fixture', version: '1.0.0'}, instructions: 'Use search.\nMore.'};

test('performs the handshake, lists tools across pages and calls one', async t => {
  const seen = [];
  const {server, url} = await startServer(({request, response, message, reply}) => {
    seen.push({method: message?.method, headers: request.headers});
    if (message?.method === 'initialize') {
      response.setHeader('Mcp-Session-Id', 'session-1');
      return reply({jsonrpc: '2.0', id: message.id, result: initializeResult});
    }
    if (!message || message.id === undefined) { response.writeHead(202); response.end(); return; }
    if (message.method === 'tools/list') {
      if (!message.params?.cursor) return reply({jsonrpc: '2.0', id: message.id, result: {tools: [{name: 'search', description: 'Search docs', inputSchema: {type: 'object', properties: {q: {type: 'string'}}, required: ['q']}}], nextCursor: 'page-2'}});
      return reply({jsonrpc: '2.0', id: message.id, result: {tools: [{name: 'fetch', inputSchema: {type: 'object'}}]}});
    }
    if (message.method === 'tools/call') return reply({jsonrpc: '2.0', id: message.id, result: {content: [{type: 'text', text: `echo ${message.params.arguments.q}`}]}});
  });
  t.after(() => server.close());
  const client = createMcpHttpClient({url, headers: {Authorization: 'Bearer test'}, server: 'fixture'});
  const info = await client.initialize();
  assert.equal(info.serverInfo.name, 'fixture');
  assert.equal(seen[0].method, 'initialize');
  assert.equal(seen[0].headers.authorization, 'Bearer test');
  assert.equal(seen[1].method, 'notifications/initialized');
  assert.equal(seen[1].headers['mcp-session-id'], 'session-1');
  const tools = await client.listTools();
  assert.deepEqual(tools.map(tool => tool.name), ['search', 'fetch']);
  assert.equal(seen.at(-1).headers['mcp-protocol-version'], '2025-06-18');
  const result = await client.callTool('search', {q: 'pi'});
  assert.deepEqual(mcpToolOutput(result), [{type: 'text', text: 'echo pi'}]);
});

test('reads a streamable HTTP response carried by server-sent events', async t => {
  const {server, url} = await startServer(({response, message}) => {
    if (!message) { response.writeHead(202); response.end(); return; }
    response.writeHead(200, {'Content-Type': 'text/event-stream'});
    response.write('event: message\ndata: ' + JSON.stringify({jsonrpc: '2.0', method: 'notifications/message', params: {level: 'info'}}) + '\n\n');
    response.write('data: ' + JSON.stringify({jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? initializeResult : {content: [{type: 'text', text: 'streamed'}]}}) + '\n\n');
  });
  t.after(() => server.close());
  const client = createMcpHttpClient({url, server: 'sse'});
  await client.initialize();
  assert.deepEqual(mcpToolOutput(await client.callTool('anything', {})), [{type: 'text', text: 'streamed'}]);
});

test('surfaces server errors, bad responses and rejected credentials', async t => {
  const {server, url} = await startServer(({response, message}) => {
    if (message?.method === 'initialize') {
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({jsonrpc: '2.0', id: message.id, error: {code: -32603, message: 'boom'}}));
      return;
    }
    response.writeHead(401);
    response.end('unauthorized');
  });
  t.after(() => server.close());
  const client = createMcpHttpClient({url, server: 'broken'});
  await assert.rejects(client.initialize(), /broken：boom/);
  await assert.rejects(client.listTools(), /broken：服务器拒绝访问（HTTP 401）/);
});

test('reports an unreachable server with the address and CORS hint', async () => {
  const client = createMcpHttpClient({url: 'http://127.0.0.1:1/mcp', server: 'offline', timeout: 2});
  await assert.rejects(client.initialize(), /offline：无法连接服务器.*CORS/);
});

test('tool results keep images and fall back to structured content', () => {
  assert.deepEqual(mcpToolOutput({content: [{type: 'image', data: 'AAAA', mimeType: 'image/png'}]}), [{type: 'image', data: 'AAAA', mimeType: 'image/png'}]);
  assert.deepEqual(mcpToolOutput({content: [{type: 'resource', resource: {uri: 'file://a', text: 'hi'}}]}), [{type: 'text', text: JSON.stringify({uri: 'file://a', text: 'hi'}, null, 2)}]);
  assert.deepEqual(mcpToolOutput({structuredContent: {ok: true}}), [{type: 'text', text: JSON.stringify({ok: true}, null, 2)}]);
  assert.deepEqual(mcpToolOutput({}), [{type: 'text', text: '（MCP 工具没有返回内容。）'}]);
});
