// Optional CORS relay. The actual agent and its tools stay inside the browser.
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PI_RELAY_PORT || 41784);
const token = process.env.PI_RELAY_TOKEN || randomBytes(24).toString('hex');
const bundlePath = fileURLToPath(new URL('./dist/pi-console.js', import.meta.url));
const server = http.createServer(async (request, response) => {
  const origin = request.headers.origin;
  if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
  response.setHeader('Vary', 'Origin');
  response.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pi-Token');
  response.setHeader('Access-Control-Allow-Private-Network', 'true');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  try {
    if (request.method === 'GET' && request.url === '/pi-console.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      response.end(await readFile(bundlePath)); return;
    }
    if (request.method !== 'POST' || request.url !== '/proxy') { response.writeHead(404); response.end('Use /pi-console.js or /proxy'); return; }
    if (request.headers['x-pi-token'] !== token) { response.writeHead(401); response.end('Invalid relay token'); return; }
    let body = '';
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 8 * 1024 * 1024) { response.writeHead(413); response.end('Request too large'); return; }
    }
    const payload = JSON.parse(body), target = new URL(payload.url);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid target URL');
    if (!['POST', 'GET'].includes(payload.method)) throw new Error('Only GET/POST requests are supported');
    const controller = new AbortController();
    response.on('close', () => { if (!response.writableEnded) controller.abort(); });
    const timer = setTimeout(() => controller.abort(), 180000);
    try {
      const headers = new Headers(payload.headers ?? {});
      for (const name of [...headers.keys()]) {
        if (name.startsWith('sec-') || ['host', 'origin', 'referer', 'cookie', 'connection', 'content-length'].includes(name)) headers.delete(name);
      }
      // These browser SDK hints are unnecessary when forwarding from Node.
      headers.delete('anthropic-dangerous-direct-browser-access');
      const upstream = await fetch(target, { method: payload.method, headers, body: payload.method === 'GET' ? undefined : payload.body, signal: controller.signal });
      response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
      if (upstream.body) {
        const stream = Readable.fromWeb(upstream.body);
        await new Promise((resolve, reject) => { stream.once('error', reject); response.once('finish', resolve); response.once('close', resolve); stream.pipe(response); });
      } else response.end();
    } finally { clearTimeout(timer); }
  } catch (error) {
    if (!response.headersSent) { response.writeHead(502, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error.message } })); }
    else response.destroy();
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Pi CORS relay: http://127.0.0.1:${port}`);
  console.log(`Configuration: { proxyUrl: 'http://127.0.0.1:${port}', proxyToken: '${token}' }`);
  console.log('This server forwards model HTTP requests only; the pi-durable runtime stays in the page.');
});
