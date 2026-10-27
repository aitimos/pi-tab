import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createBookmarklet } from '../src/bookmarklet.js';

test('bookmark runs once, awaits startup and preserves URL-sensitive config', { timeout:2000 }, async () => {
  const source = `var PiConsolePlugin={install(){window.loads=(window.loads||0)+1;return window.pi={__piConsolePlugin:true,listChats:async()=>[],history:async()=>({entries:[]}),ready:Promise.resolve().then(()=>window.started=true)};}};`;
  const config = { api:'openai-completions', model:'模型 "test"', apiKey:'test-only-\n-<&%20?#😀-key' };
  const url = createBookmarklet(source, {
    config,
    openChat: function(config) { window.done({ config, started:window.started }); },
  });
  assert.equal(new URL(url).search, '');
  assert.equal(new URL(url).hash, '');
  const page = {};
  const context = { window:page, console, sessionStorage:{getItem:()=>null} };
  for (let i=0; i<2; i++) {
    const completed = new Promise(resolve => { page.done=resolve; });
    assert.equal(runInNewContext(decodeURIComponent(url.slice('javascript:'.length)), context), undefined);
    const result = await completed;
    assert.deepEqual(JSON.parse(JSON.stringify(result.config)), config);
    assert.equal(result.started, true);
    assert.equal(page.loads, 1);
  }
});

test('startup errors show a dismissible page notice without a browser alert', async () => {
  const source = 'throw new Error("启动测试");';
  const notices = [];
  runInNewContext(decodeURIComponent(createBookmarklet(source).slice(11)), {
    localStorage:{getItem:()=>null},navigator:{languages:['zh-CN']},
    window:{ alert() { throw new Error('不应弹出浏览器 alert'); } },
    document:{
      createElement(tag) { return {tag,style:{},children:[],setAttribute(){},append(child){this.children.push(child);},remove(){this.removed=true;}}; },
      body:{append(node){notices.push(node);}},
    },
    console:{error() {}},
  });
  assert.equal(notices[0].textContent, 'Pi Tab 无法启动：启动测试');
  assert.equal(notices[0].children[0].textContent, '关闭');
  notices[0].children[0].onclick();
  assert.equal(notices[0].removed, true);
});

test('a page using window.pi can still start Pi Tab', async () => {
  const source = `var PiConsolePlugin={install({globalName}){const pi={__piConsolePlugin:true,listChats:async()=>[],history:async()=>({entries:[]}),ready:Promise.resolve()};window[globalName]=pi;return pi;}};`;
  const page = {pi:{pageOwned:true}};
  const opened = new Promise(resolve => { page.opened=resolve; });
  const url = createBookmarklet(source, {openChat:function() { window.opened(window.__piTabAgent); }});
  runInNewContext(decodeURIComponent(url.slice(11)), {window:page,sessionStorage:{getItem:()=>null},console:{error() {}}});
  assert.equal((await opened).__piConsolePlugin, true);
  assert.equal(page.pi.pageOwned, true);
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

test('bookmark opens blank conversations but resumes unfinished tasks', async () => {
  for (const {name, chats, entries, manager, openIds = [], expected} of [
    {name:'first use', chats:[{id:1,active:true,busy:false}], entries:[], expected:{chatId:1}},
    {name:'completed history', chats:[{id:1,active:true,busy:false}], entries:[{}], expected:{newAgent:true,inheritFrom:1}},
    {name:'active task', chats:[{id:1,active:true,busy:true}], entries:[{}], expected:{chatId:1}},
    {name:'background task', chats:[{id:1,active:true,busy:false},{id:2,busy:true}], entries:[{}], expected:{chatId:2}},
    {name:'prefer active task', chats:[{id:2,busy:true},{id:1,active:true,busy:true}], entries:[{}], expected:{chatId:1}},
    {name:'last opened empty conversation', chats:[{id:1,active:true},{id:2}], openIds:[2], entries:[], expected:{chatId:2}},
    {name:'last opened model inheritance', chats:[{id:1,active:true},{id:2}], openIds:[2], entries:[{}], expected:{newAgent:true,inheritFrom:2}},
    {name:'existing windows', chats:[], entries:[{}], manager:{}, expected:{}},
  ]) {
    const page={pi:{__piConsolePlugin:true,ready:Promise.resolve(),listChats:async()=>chats,agent:()=>({history:async()=>({entries})})},__piQuickChatOverlay:manager};
    const opened=new Promise(resolve=>{page.opened=resolve;});
    const url=createBookmarklet('', {openChat:function(config,options){window.opened(options);}});
    runInNewContext(decodeURIComponent(url.slice(11)), {window:page,console,sessionStorage:{getItem:()=>JSON.stringify(openIds)}});
    assert.deepEqual(JSON.parse(JSON.stringify(await opened)),expected,name);
  }
});
