import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createBookmarklet } from '../src/bookmarklet.js';

test('bookmark runs once, awaits startup and preserves URL-sensitive config', { timeout:2000 }, async () => {
  const source = `window.loads=(window.loads||0)+1;window.pi={__piConsolePlugin:true,ready:Promise.resolve().then(()=>window.started=true)};`;
  const config = { api:'openai-completions', model:'模型 "test"', apiKey:'test-only-\n-<&%20?#😀-key' };
  const url = createBookmarklet(source, {
    config,
    openChat: function(config) { window.done({ config, started:window.started }); },
  });
  assert.equal(new URL(url).search, '');
  assert.equal(new URL(url).hash, '');
  const page = {};
  const context = { window:page, console };
  for (let i=0; i<2; i++) {
    const completed = new Promise(resolve => { page.done=resolve; });
    assert.equal(runInNewContext(decodeURIComponent(url.slice('javascript:'.length)), context), undefined);
    const result = await completed;
    assert.deepEqual(JSON.parse(JSON.stringify(result.config)), config);
    assert.equal(result.started, true);
    assert.equal(page.loads, 1);
  }
});

test('startup errors are shown instead of failing silently', { timeout:2000 }, async () => {
  const source = 'throw new Error("启动测试");';
  const result = new Promise(resolve => {
    runInNewContext(decodeURIComponent(createBookmarklet(source).slice(11)), {
      window:{ alert:resolve }, console:{error() {}},
    });
  });
  assert.equal(await result, 'Pi Tab 无法启动：启动测试');
});

test('oversized bookmarks are rejected before they can be saved', () => {
  assert.throws(() => createBookmarklet('A'.repeat(2 * 1024 * 1024)), /书签内容过大/);
});

test('shipped chat and Console bookmarks stay below the browser URL limit', async () => {
  const html = await readFile(new URL('../pi-bookmarklet-chat-install.html', import.meta.url), 'utf8');
  const runtime = JSON.parse(html.match(/<script id="pi-runtime"[^>]*>(.*?)<\/script>/s)[1]);
  const source = await readFile(new URL('../dist/pi-console.js', import.meta.url), 'utf8');
  assert.equal(runtime, source);
  const openChatSource = html.match(/<script>\s*(function openChat[\s\S]*?)\nconst PI_RUNTIME/)[1];
  const openChat = runInNewContext(openChatSource + ';openChat');
  const chat = createBookmarklet(source, { openChat, config:{ api:'openai-completions',apiKey:'k'.repeat(16384) } });
  const consoleBookmark = await readFile(new URL('../dist/pi-bookmarklet.txt', import.meta.url), 'utf8');
  assert.ok(chat.length < 2 * 1024 * 1024);
  assert.ok(consoleBookmark.length < 2 * 1024 * 1024);
});
