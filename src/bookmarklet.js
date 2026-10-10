export function createBookmarklet(source, { openChat, config } = {}) {
  const code = `void(async()=>{try{
    if(!window.pi?.__piConsolePlugin){${source}\n}
    if(!window.pi?.__piConsolePlugin)throw new Error('无法载入 Pi Tab，页面可能限制了脚本运行。');
    await window.pi.ready;
    ${openChat ? `(${openChat.toString()})(${JSON.stringify(config || {})});` : ''}
  }catch(error){console.error('[Pi Tab]',error);window.alert('Pi Tab 无法启动：'+(error.message||error));}})();`;
  // Keep the script in the URL's opaque path: a raw "?" makes the browser treat
  // the rest as a query and apply additional escaping, inflating its stored size.
  // Escape literal percent signs too, so "%xx" in strings survives execution.
  const url = new URL(`javascript:${code.replace(/[%?#\r\n\t]/g, char => encodeURIComponent(char))}`).href;
  // Chromium replaces URLs above this limit with an empty URL between processes.
  if (url.length > 2 * 1024 * 1024) throw new Error('书签内容过大，无法保存。');
  return url;
}
