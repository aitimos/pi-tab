import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export async function makeBookmarklet({
  input = join(here, 'dist/pi-console.js'),
  output = join(here, 'dist/pi-bookmarklet.txt'),
} = {}) {
  const source = await readFile(input, 'utf8');
  // 保留源码换行；编码后整个网址只有一行。void 避免执行结果替换网页。
  const code = `${source}\n;void(0);`;
  const bookmarklet = `javascript:${encodeURIComponent(code)}`;
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, bookmarklet);
  const installer = join(dirname(output), 'pi-bookmarklet-install.html');
  await writeFile(installer, `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><title>Pi Agent 书签</title>
<style>body{font:18px/1.7 system-ui;max-width:760px;margin:60px auto;padding:24px}a{display:inline-block;padding:10px 22px;background:#174ea6;color:white;border-radius:8px}code{background:#eee;padding:3px 6px}</style>
<h1>Pi Agent 书签</h1>
<p>把下面的链接拖到浏览器书签栏。然后打开要操作的网页，点击保存的书签。</p>
<p><a id="pi-bookmarklet" href="${bookmarklet}">Pi Agent</a></p>
<p>这个书签包含完整插件，注入时不下载外部脚本。模型请求仍会访问你配置的接口。</p>
<p>注入后在开发者工具 Console 输入 <code>pi.help()</code> 查看配置模型和调用方法。</p>
<p>网页的内容安全策略可能禁止执行 JavaScript 书签；浏览器内部页面也不支持。</p>
</html>`);
  console.log(`书签地址：${output}`);
  console.log(`安装页面：${installer}`);
  console.log(`书签长度：${bookmarklet.length} 个字符（包含完整插件）`);
}

// node make-bookmarklet.mjs [完整插件文件] [生成的书签文件]
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await makeBookmarklet({
    ...(process.argv[2] ? { input: resolve(process.argv[2]) } : {}),
    ...(process.argv[3] ? { output: resolve(process.argv[3]) } : {}),
  });
}
