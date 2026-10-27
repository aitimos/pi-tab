import { build, transform } from 'esbuild';
import { minify } from 'terser';
import { mkdir, readFile, rm, writeFile, cp } from 'node:fs/promises';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
import { makeBookmarklet } from './make-bookmarklet.mjs';
import { deflateSync, gzipSync } from 'node:zlib';
import { createBookmarklet } from './src/bookmarklet.js';
import * as radixColors from '@radix-ui/colors';

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
// Keep the complete runtime below Chromium's bookmark URL limit.
const optimized = await minify(await readFile('dist/pi-console.js','utf8'), {compress:{passes:2},mangle:true,format:{comments:'some',ascii_only:true}});
const markdownLicense = await readFile('node_modules/marked/LICENSE','utf8');
await writeFile('dist/pi-console.js',optimized.code + '\n/*! Marked license\n' + markdownLicense.replace(/\*\//g,'* /') + '\n*/');
await makeBookmarklet();

const installer = 'pi-bookmarklet-chat-install.html';
const html = await readFile('src/install-template.html', 'utf8');
const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] + html.match(/const chatStyles = `([\s\S]*?)`;/)?.[1];
const radixValues = new Set(Object.values(radixColors).flatMap(scale => Object.values(scale)).filter(value => typeof value === 'string' && value.startsWith('#')));
for (const color of css.match(/#[\da-fA-F]{3,8}\b/g) || []) {
  if (!radixValues.has(color)) throw new Error(`界面颜色 ${color} 不在 Radix Colors 中`);
}
const source = await readFile('dist/pi-console.js', 'utf8');
const runtime = JSON.stringify(source).replace(/</g, '\\u003c');
const codec = (await readFile('src/bookmarklet.js', 'utf8')).replace(/^export /gm, '');
const originalChat = html.match(/<script>\s*(async function openChat[\s\S]*?)\nconst PI_RUNTIME/)[1];
const chatCss = originalChat.match(/const chatStyles = `([\s\S]*?)`;/)[1];
const packedCss = gzipSync((await transform(chatCss,{loader:'css',minify:true})).code,{level:9}).toString('base64');
const packedChat = originalChat.replace(/const chatStyles = `[\s\S]*?`;/, () => `const chatStyles = await new Response(new Blob([Uint8Array.from(atob('${packedCss}'), c => c.charCodeAt(0))]).stream().pipeThrough(new DecompressionStream('gzip'))).text();`);
const chatSource = (await transform(packedChat, {minifyWhitespace:true,minifyIdentifiers:true,minifySyntax:true,legalComments:'none'})).code.trim();
// Check the actual chat bookmark too, with room for saved model credentials.
const chatBookmark = createBookmarklet(source, { openChat:chatSource, config:{apiKey:'k'.repeat(16384)} });
console.log(`聊天书签长度：${chatBookmark.length} 个字符（含 16 KB 配置预留）`);
const landingLocale = await readFile('src/locales/landing.en.json', 'utf8');
const builtHtml = html
  .replace(/(<script id="pi-landing-locale"[^>]*>)[\s\S]*?(<\/script>)/, (_match, open, close) => open + landingLocale.replace(/</g,'\\u003c') + close)
  .replace(originalChat, () => chatSource)
  .replace(/(<script id="pi-runtime"[^>]*>)[\s\S]*?(<\/script>)/, (_match, open, close) => open + runtime + close)
  .replace(/(<script id="pi-bookmark-codec">)[\s\S]*?(<\/script>)/, (_match, open, close) => open + '\n' + codec + close);
await writeFile(installer, builtHtml);
await writeFile('dist/pi-bookmarklet-install.html', builtHtml);

await rm('dist/extension', { recursive: true, force: true });
await mkdir('dist/extension', { recursive: true });
await writeFile('dist/extension/LICENSE', await readFile('LICENSE'));
await writeFile('dist/extension/NOTICE', await readFile('NOTICE'));
await writeFile('dist/extension/manifest.json', await readFile('extension/manifest.json'));
await cp('extension/_locales','dist/extension/_locales',{recursive:true});
await build({entryPoints:['src/extension-worker.js'],bundle:true,format:'esm',platform:'browser',target:'chrome110',minify:true,outfile:'dist/extension/worker.js'});
const extensionBootstrap = await readFile('src/extension-content.js', 'utf8');
await writeFile('dist/extension/content.js', `if (!globalThis.__piTabExtensionLoaded) {\nglobalThis.__piTabExtensionLoaded = true;\n(() => {\nglobalThis.__piTabDeferredInstall = true;\n${source}\n${chatSource}\n${extensionBootstrap}\n})();\n}`);
const engineBootstrap = await readFile('src/extension-engine.js', 'utf8');
await writeFile('dist/extension/engine.js', `globalThis.__piTabDeferredInstall = true;\n${source}\n${engineBootstrap}`);
await writeFile('dist/extension/engine.html', '<!doctype html><html><head><meta charset="utf-8"></head><body><script src="engine.js"></script></body></html>');

const iconColors = [
  ['#e48a7a', '#e48a7a', '#e48a7a', null],
  ['#4f8eb3', null, '#e48a7a', null],
  ['#4f8eb3', '#4f8eb3', null, '#eab65d'],
  ['#4f8eb3', null, null, '#eab65d'],
];
const pixel = color => color ? [...Buffer.from(color.slice(1), 'hex'), 255] : [0, 0, 0, 0];
const crc32 = bytes => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};
const pngChunk = (name, data) => {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, checksum]);
};
const size = 128;
const rows = Buffer.alloc(size * (size * 4 + 1));
for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
  const rgba = pixel(iconColors[Math.floor(y / 32)][Math.floor(x / 32)]);
  Buffer.from(rgba).copy(rows, y * (size * 4 + 1) + 1 + x * 4);
}
const header = Buffer.alloc(13); header.writeUInt32BE(size); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
await writeFile('dist/extension/icon.png', Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(rows)), pngChunk('IEND', Buffer.alloc(0)),
]));

const extensionFiles = ['LICENSE', 'NOTICE', 'manifest.json', 'worker.js', 'content.js', 'engine.html', 'engine.js', 'icon.png', '_locales/en/messages.json', '_locales/zh_CN/messages.json'];
const localParts = [], centralParts = [];
let offset = 0;
for (const filename of extensionFiles) {
  const name = Buffer.from(`pi-tab-extension/${filename}`);
  const data = await readFile(`dist/extension/${filename}`);
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  localParts.push(local, name, data);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
  centralParts.push(central, name);
  offset += local.length + name.length + data.length;
}
const directory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);
end.writeUInt16LE(extensionFiles.length, 8); end.writeUInt16LE(extensionFiles.length, 10);
end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
await writeFile('dist/pi-tab-extension.zip', Buffer.concat([...localParts, directory, end]));
