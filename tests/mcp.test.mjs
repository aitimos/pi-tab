import assert from 'node:assert/strict';
import test from 'node:test';
import {effectiveExposure, exposesTool, mcpPromptSection, mcpToolName, normalizeMcpServers, parseMcpConfig, uniqueToolName} from '../src/mcp.js';

const servers = config => normalizeMcpServers(parseMcpConfig(config).value);

test('accepts a full mcp.json, a bare servers map and an empty string', () => {
  assert.deepEqual(parseMcpConfig('').value, {mcpServers: {}});
  const file = parseMcpConfig('{"mcpServers":{"docs":{"url":"https://example.com/mcp"}},"autoEnableCodemode":false}');
  assert.equal(file.value.mcpServers.docs.url, 'https://example.com/mcp');
  const bare = parseMcpConfig('{"docs":{"url":"https://example.com/mcp"},"env":{"TOKEN":"x"}}');
  assert.equal(bare.value.mcpServers.docs.url, 'https://example.com/mcp');
  assert.equal(bare.value.env.TOKEN, 'x');
  assert.match(file.text, /\n {2}"mcpServers"/);
});

test('rejects unusable documents instead of silently dropping them', () => {
  assert.throws(() => parseMcpConfig('{"mcpServers":'), /不是有效的 JSON/);
  assert.throws(() => parseMcpConfig('[]'), /需要一个 JSON 对象/);
  assert.throws(() => parseMcpConfig('{"mcpServers":[]}'), /mcpServers 必须是对象/);
  assert.throws(() => parseMcpConfig('{"foo":1}'), /缺少 mcpServers/);
  const override = parseMcpConfig('{"mcpServers":{"a":{"description":"only a description"}}}');
  const {servers: overrideServers, problems} = normalizeMcpServers(override.value);
  assert.deepEqual(overrideServers, []);
  assert.match(problems[0].message, /缺少 url/);
});

test('normalizes remote servers and interpolates values from env', () => {
  const {servers: list, problems} = servers({mcpServers: {
    docs: {url: 'https://example.com/mcp', headers: {Authorization: 'Bearer ${TOKEN}'}, env: {IGNORED: '1'}, timeout: 30, description: 'Documentation', exposure: 'deferred'},
  }, env: {TOKEN: 'secret'}});
  assert.deepEqual(problems, []);
  assert.equal(list.length, 1);
  const [docs] = list;
  assert.equal(docs.name, 'docs');
  assert.equal(docs.url, 'https://example.com/mcp');
  assert.equal(docs.headers.Authorization, 'Bearer secret');
  assert.equal(docs.timeout, 30);
  assert.equal(docs.exposure, 'deferred');
  assert.equal(docs.supported, true);
});

test('keeps stdio entries visible and marks them unsupported', () => {
  const parsed = parseMcpConfig('{"mcpServers":{"local":{"command":"npx","args":["-y","server"]}}}');
  const {servers: list, problems} = normalizeMcpServers(parsed.value);
  assert.equal(list[0].transport, 'stdio');
  assert.equal(list[0].supported, false);
  assert.match(list[0].reason, /stdio/);
  assert.equal(parsed.value.mcpServers.local.command, 'npx');
  assert.deepEqual(problems.filter(problem => problem.name === 'local'), []);
});

test('reports invalid names, collisions, sse transports and missing variables', () => {
  const {servers: list, problems} = servers({mcpServers: {
    'bad name': {url: 'https://example.com/mcp'},
    'dev-radius': {url: 'https://example.com/a'},
    dev_radius: {url: 'https://example.com/b'},
    legacy: {type: 'sse', url: 'https://example.com/sse'},
    unknown: {url: 'https://example.com/c', keepAlive: true},
    guarded: {url: 'https://example.com/d', headers: {Authorization: 'Bearer ${MISSING}'}},
    command: {url: 'https://example.com/e', headers: {Authorization: '!gh auth token'}},
    oauth: {url: 'https://example.com/f', oauth: {}},
  }});
  assert.deepEqual(list.map(server => server.name), ['dev-radius', 'legacy', 'unknown', 'oauth']);
  const messages = problems.map(problem => `${problem.name}: ${problem.message}`).join('\n');
  assert.match(messages, /bad name: 名称只能包含/);
  assert.match(messages, /dev_radius: 与 dev-radius/);
  assert.match(messages, /legacy: Pi 不支持旧版 SSE/);
  assert.match(messages, /unknown: 忽略未知字段：keepAlive/);
  assert.match(messages, /guarded: 请求头 Authorization 引用了变量 MISSING/);
  assert.match(messages, /command: 请求头 Authorization 使用了 !command/);
  assert.match(messages, /oauth: 需要 OAuth 登录/);
});

test('tool names follow Pi spelling and colliding names get a stable suffix', () => {
  assert.equal(mcpToolName('dev-radius', 'search.code'), 'mcp__dev_radius__search_code');
  const used = new Set([mcpToolName('dev-radius', 'a.b')]);
  const first = uniqueToolName('dev-radius', 'a.b', used);
  const second = uniqueToolName('dev-radius', 'a.b', new Set([...used, first]));
  assert.notEqual(first, `${mcpToolName('dev-radius', 'a.b')}`);
  assert.match(first, /^mcp__dev_radius__a_b_[0-9a-f]{6}$/);
  assert.notEqual(second, first);
});

test('hidden tools are filtered by exact name before patterns', () => {
  const server = {exposure: 'codemode', toolExposure: {'search_*': 'hidden', 'search_all': 'direct', 'get_*': 'codemode'}};
  assert.equal(exposesTool(server, 'search_all'), true);
  assert.equal(exposesTool(server, 'search_code'), false);
  assert.equal(exposesTool(server, 'get_file'), true);
  assert.equal(exposesTool(server, 'delete_all'), true);
  assert.equal(effectiveExposure(server, 'search_all'), 'direct');
  assert.equal(effectiveExposure({exposure: 'hidden'}, 'anything'), 'hidden');
});

test('the prompt section lists connected servers and their tool names', () => {
  assert.equal(mcpPromptSection([]), '');
  const text = mcpPromptSection([
    {name: 'docs', description: 'Documentation', status: 'connected', toolNames: ['mcp__docs__search']},
    {name: 'broken', status: 'error', toolNames: []},
  ]);
  assert.match(text, /<mcp_servers>/);
  assert.match(text, /docs（Documentation）：mcp__docs__search/);
  assert.doesNotMatch(text, /broken/);
});
