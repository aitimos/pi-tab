import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { makeBookmarklet } from './make-bookmarklet.mjs';
import { gzipSync } from 'node:zlib';
import { createBookmarklet } from './src/bookmarklet.js';

const providers = builtinProviders();
const catalog = providers.flatMap(provider => provider.getModels());
const apis = [...new Set(catalog.map(model => model.api))].map(id => ({
  id,
  name: id,
  endpoints: [...new Map(catalog.filter(model => model.api === id).map(model => [model.baseUrl, {
    name: providers.find(provider => provider.id === model.provider)?.name || model.provider,
    url: model.baseUrl,
  }])).values()],
}));

await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/plugin.js'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  globalName: 'PiConsolePlugin',
  target: ['chrome110', 'firefox115', 'safari17'],
  minify: true,
  legalComments: 'eof',
  outfile: 'dist/pi-console.js',
  logLevel: 'info',
  plugins: [
    {
      // Bedrock's browser path uses the AWS SDK's fetch transport. Its static
      // Node-only proxy imports must not pull net/tls into the standalone bundle.
      name: 'browser-only-transports',
      setup(builder) {
        builder.onResolve({ filter: /^(@smithy\/node-http-handler|http-proxy-agent|https-proxy-agent)$/ }, args => ({ path: args.path, namespace: 'node-transport' }));
        builder.onLoad({ filter: /.*/, namespace: 'node-transport' }, () => ({
          contents: `class NodeTransport { constructor() { throw new Error('Node.js proxy transports are not available in this browser.'); } }
            export { NodeTransport as NodeHttpHandler, NodeTransport as HttpProxyAgent, NodeTransport as HttpsProxyAgent };`,
          loader: 'js',
        }));
      },
    },
    {
      name: 'pi-catalog',
      setup(builder) {
        builder.onResolve({ filter: /^#model-catalog$/ }, () => ({ path: 'catalog', namespace: 'pi-catalog' }));
        builder.onLoad({ filter: /.*/, namespace: 'pi-catalog' }, () => ({
          contents: `export default async function loadCatalog() {
            const bytes = Uint8Array.from(atob(${JSON.stringify(gzipSync(JSON.stringify({models:catalog,apis}), {level:9}).toString('base64'))}), char => char.charCodeAt(0));
            return JSON.parse(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text());
          }`,
          loader:'js',
        }));
      },
    },
  ],
});
await makeBookmarklet();

const installer = 'pi-bookmarklet-chat-install.html';
const html = await readFile(installer, 'utf8');
const source = await readFile('dist/pi-console.js', 'utf8');
const runtime = JSON.stringify(source).replace(/</g, '\\u003c');
const codec = (await readFile('src/bookmarklet.js', 'utf8')).replace(/^export /gm, '');
const chatSource = html.match(/<script>\s*(function openChat[\s\S]*?)\nconst PI_RUNTIME/)[1];
// Check the actual chat bookmark too, with room for saved model credentials.
const chatBookmark = createBookmarklet(source, { openChat:chatSource, config:{apiKey:'k'.repeat(16384)} });
console.log(`聊天书签长度：${chatBookmark.length} 个字符（含 16 KB 配置预留）`);
await writeFile(installer, html
  .replace(/(<script id="pi-runtime"[^>]*>)[\s\S]*?(<\/script>)/, (_match, open, close) => open + runtime + close)
  .replace(/(<script id="pi-bookmark-codec">)[\s\S]*?(<\/script>)/, (_match, open, close) => open + '\n' + codec + close));
