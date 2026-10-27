import english from './locales/en.json' with {type:'json'};

export function resolveLanguage(mode, languages) {
  if (mode === 'zh-CN' || mode === 'en') return mode;
  for (const language of languages) {
    if (/^zh(?:-|$)/i.test(language)) return 'zh-CN';
    if (/^en(?:-|$)/i.test(language)) return 'en';
  }
  return 'en';
}

// Chinese source messages are the catalog keys. Parameters stay separate from
// translations so page text, model IDs, filenames, and conversation titles are untouched.
export function createI18n({mode = 'auto', languages = ['en'], save = () => {}} = {}) {
  const messages = {...english};
  const bindings = new Map();
  const listeners = new Set();
  const reverse = new Map(Object.entries(messages).map(([key,value]) => [value,key]));
  const patterns = Object.entries(messages).filter(([key]) => /\{\d+\}/.test(key)).flatMap(([key,value]) => [key,value].map(template => ({
    key,
    indexes: [...template.matchAll(/\{(\d+)\}/g)].map(match => Number(match[1])),
    regex: new RegExp('^' + template.split(/(\{\d+\})/).map(part => /^\{\d+\}$/.test(part) ? '([\\s\\S]*?)' : part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('') + '$'),
  })));
  let selected = mode;
  let preferred = languages;
  let language = resolveLanguage(selected, preferred);
  const t = (source, ...args) => {
    let key = String(source ?? '');
    if (!Object.hasOwn(messages,key)) {
      const original = reverse.get(key);
      if (original) key = original;
      else if (!args.length) {
        for (const pattern of patterns) {
          const match = key.match(pattern.regex);
          if (!match) continue;
          key = pattern.key;
          pattern.indexes.forEach((index,i) => {args[index] = match[i+1];});
          break;
        }
      }
    }
    const template = language === 'en' ? messages[key] ?? key : key;
    return template.replace(/\{(\d+)\}/g,(match,index) => args[index] === undefined ? match : String(args[index]));
  };
  function bind(node, property, value) {
    let properties = bindings.get(node);
    if (typeof value === 'function') {
      if (!properties) bindings.set(node, properties = new Map());
      properties.set(property,value);
    } else properties?.delete(property);
    const text = String(typeof value === 'function' ? value() : value);
    if (property === 'textContent') { if (node.textContent !== text) node.textContent = text; }
    else if (node.getAttribute(property) !== text) node.setAttribute(property,text);
  }
  function refresh() {
    language = resolveLanguage(selected,preferred);
    for (const [node,properties] of bindings) {
      if (!node.isConnected) {bindings.delete(node);continue;}
      for (const [property,value] of properties) bind(node,property,value);
    }
    for (const listener of listeners) listener();
  }
  const api = {
    t,
    addMessages(values) {
      Object.assign(messages,values);
      for (const [key,value] of Object.entries(values)) reverse.set(value,key);
    },
    get language() {return language;},
    get mode() {return selected;},
    setMode(value, persist = true) {
      if (!['auto','zh-CN','en'].includes(value)) throw new Error('Invalid language preference');
      selected = value;
      if (persist) save(value);
      refresh();
    },
    setLanguages(values) {preferred = values;refresh();},
    onChange(listener) {listeners.add(listener);return () => listeners.delete(listener);},
    text: (node,value) => bind(node,'textContent',value),
    attr: bind,
    option(label,value) {const option=new Option('',value);bind(option,'textContent',label);return option;},
    html(node,markup) {node.innerHTML=markup;api.mount(node);},
    // Mount only markup authored by Pi Tab, never the host page or user content.
    mount(root) {
      const nodes = [root];
      const walker = document.createTreeWalker(root,NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,{
        acceptNode(node) {return node.nodeType === 1 && node.matches('script,style,pre,[data-i18n-skip]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;},
      });
      while (walker.nextNode()) nodes.push(walker.currentNode);
      for (const node of nodes) {
        if (node.nodeType === 3) {
          if (node.parentElement?.closest('textarea')) continue;
          const source = node.textContent.trim();
          if (Object.hasOwn(messages,source)) {
            const whitespace = node.textContent.match(/^(\s*)[\s\S]*?(\s*)$/);
            bind(node,'textContent',() => whitespace[1]+t(source)+whitespace[2]);
          }
        } else if (node.nodeType === 1) {
          for (const name of ['title','aria-label','placeholder','content']) {
            const source=node.getAttribute(name);
            if (source && Object.hasOwn(messages,source)) bind(node,name,() => t(source));
          }
        }
      }
    },
  };
  return api;
}

let instance;
export function getI18n() {
  if (instance) return instance;
  const key='pi-tab-language';
  const stored=localStorage.getItem(key);
  instance=createI18n({mode:['zh-CN','en'].includes(stored)?stored:'auto',languages:navigator.languages,save:value=>localStorage.setItem(key,value)});
  window.addEventListener('languagechange',()=>instance.setLanguages(navigator.languages));
  window.addEventListener('storage',event=>{if(event.key===key)instance.setMode(event.newValue||'auto',false);});
  return instance;
}
