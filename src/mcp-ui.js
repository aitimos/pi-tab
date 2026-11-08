// Embedded into openChat by build.mjs so bookmarks remain self-contained.
export function mountMcpSettings({root,runtimePi,i18n}) {
  const byId=id=>root.getElementById(id),t=i18n.t;
  const editor=byId('mcp-editor');
  let summary,version,saveAction,returnFocus,working=false,previewSequence=0;
  const text=(node,value)=>i18n.text(node,()=>t(value));
  function el(tag,label,className){const node=document.createElement(tag);if(label)text(node,label);if(className)node.className=className;return node;}
  function button(label,action,className='text-button'){
    const node=el('button',label,className);node.type='button';
    node.addEventListener('click',()=>void attempt(action));return node;
  }
  function error(error){
    const messages=[t(error.message||'操作失败，请重试。'),...(error.diagnostics||[]).map(item=>`${item.path}: ${t(item.message)}`)];
    byId('mcp-error').textContent=messages.join('\n');
    for(const input of editor.querySelectorAll('input,textarea,select')){
      const invalid=(error.diagnostics||[]).some(item=>item.path===input.dataset.path||item.path.endsWith('.'+input.dataset.path));
      input.setAttribute('aria-invalid',String(invalid));
    }
    byId('mcp-error').focus();
  }
  async function attempt(action){
    if(working)return;
    byId('mcp-error').textContent='';
    try{await action();}catch(failure){error(failure);}
  }
  async function load(){try{render(await runtimePi.mcpConfig());}catch(failure){error(failure);}}
  function render(next){
    if(!next)return;summary=next;
    const list=byId('mcp-status');i18n.release(list);list.replaceChildren();
    if(!next.servers?.length)list.append(el('p','还没有配置 MCP 服务器。','mcp-hint'));
    for(const server of next.servers||[]){
      const row=el('div',null,'mcp-server');row.dataset.server=server.name;
      const heading=el('div',null,'mcp-server-heading'),name=el('strong');name.textContent=server.name;
      const actions=el('div',null,'mcp-actions');
      const edit=button('编辑',()=>editServer(server.name)),remove=button('删除',()=>deleteServer(server.name));
      edit.setAttribute('aria-label',t('编辑服务器：{0}',server.name));remove.setAttribute('aria-label',t('删除服务器：{0}',server.name));
      actions.append(edit,remove);const identity=el('div');identity.append(name,el('span',server.enabled?'已启用':'已停用','mcp-enabled'));heading.append(identity,actions);row.append(heading);
      if(server.url){const url=el('div',null,'mcp-url');url.textContent=server.url;row.append(url);}
      const state=el('div',null,'mcp-state');
      if(server.status==='connected')i18n.text(state,()=>t('已连接（{0} 个工具）',server.toolCount));
      else if(server.status==='connecting')text(state,'连接中…');
      else if(server.status==='disabled')text(state,'已停用');
      else if(server.status==='unsupported')i18n.text(state,()=>t('不支持：{0}',t(server.reason)));
      else if(server.status==='error')i18n.text(state,()=>t('连接失败：{0}',t(server.error)));
      else if(server.status==='invalid')text(state,'配置存在问题，请编辑检查。');
      else text(state,'等待连接');
      row.append(state);list.append(row);
    }
    if(!editor.hidden&&version&&next.version!==version)text(byId('mcp-notice'),'配置已变化，请重新加载或预览。');
  }
  function close(focus=true){
    previewSequence++;i18n.release(editor);editor.replaceChildren();editor.hidden=true;byId('mcp-list-view').hidden=false;
    saveAction=null;version=null;byId('mcp-file').value='';byId('mcp-error').textContent='';
    if(focus)returnFocus?.focus();
  }
  function open(title,trigger){
    close(false);byId('mcp-notice').textContent='';returnFocus=trigger||root.activeElement;
    editor.hidden=false;byId('mcp-list-view').hidden=true;
    const heading=el('div',null,'mcp-editor-heading');heading.append(el('h3',title),button('取消',()=>close()));editor.append(heading);
  }
  function field(parent,label,id,value='',type='text'){
    const wrapper=el('label');wrapper.append(el('span',label));
    const input=document.createElement(type==='textarea'?'textarea':'input');
    if(type==='checkbox')wrapper.className='setting-row';
    input.id=id;if(type!=='textarea')input.type=type;input.value=value;input.dataset.path=id.replace('mcp-','');input.setAttribute('aria-describedby','mcp-error');wrapper.append(input);parent.append(wrapper);return input;
  }
  function select(parent,label,id,values,value){
    const wrapper=el('label');wrapper.append(el('span',label));const input=el('select');input.id=id;
    for(const item of values){const option=el('option');option.value=item;option.textContent=item;input.append(option);}
    input.value=value;wrapper.append(input);parent.append(wrapper);return input;
  }
  function pairs(parent,label,values,{secret=false,options=null}={}){
    const section=el('div');section.append(el('strong',label));const rows=el('div');section.append(rows);
    function add(key='',value=''){
      const row=el('div',null,'mcp-pair'),name=el('input');name.value=key;name.setAttribute('aria-label',t('名称'));
      const input=el(options?'select':'input');if(!options)input.type=secret?'password':'text';
      if(options)for(const item of options){const option=el('option');option.value=item;option.textContent=item;input.append(option);}
      input.value=value;input.setAttribute('aria-label',t('值'));row.append(name,input);
      if(secret){const toggle=button('显示',()=>{const show=input.type==='password';input.type=show?'text':'password';text(toggle,show?'隐藏':'显示');toggle.setAttribute('aria-pressed',String(show));});toggle.setAttribute('aria-pressed','false');input.autocomplete='new-password';row.append(toggle);}
      row.append(button('移除',()=>row.remove()));rows.append(row);
    }
    for(const [key,value] of Object.entries(values||{}))add(key,value);
    section.append(button('添加一行',()=>add('',options?.[0]||'')));parent.append(section);
    return ()=>{
      const entries=[],seen=new Set();
      for(const row of rows.children){
        const [name,value]=row.querySelectorAll('input,select');
        if(!name.value&&!value.value)continue;
        const key=name.value;
        if(seen.has(key))throw Error(t('名称重复，请合并后保存。'));
        seen.add(key);entries.push([key,value.value]);
      }
      return Object.fromEntries(entries);
    };
  }
  function finishButton(label,action){
    const actions=el('div',null,'mcp-actions');saveAction=()=>attempt(action);
    actions.append(button(label,saveAction,'primary'),button('取消',()=>close()));editor.append(actions);
  }
  async function commit(operation){
    working=true;for(const node of editor.querySelectorAll('button'))node.disabled=true;
    try{
      const result=await runtimePi.changeMcpConfig({expectedVersion:version,operation});
      close();await load();
      if(result.syncError)text(byId('mcp-notice'),result.syncError);
      else if(result.result?.counts){const c=result.result.counts;i18n.text(byId('mcp-notice'),()=>t('新增 {0}，替换 {1}，未变化 {2}，保留或跳过 {3}，不支持 {4}。',c.added,c.replaced,c.unchanged,c.skipped,c.unsupported));}
      else text(byId('mcp-notice'),result.saved===false?'配置未变化。':'已保存。连接状态将在列表中更新。');
    }finally{working=false;for(const node of editor.querySelectorAll('button'))node.disabled=false;}
  }
  async function editServer(name){
    const saved=name===undefined?{version:(await runtimePi.mcpConfig()).version,config:{}}:await runtimePi.getMcpServer(name);
    const original=saved.config??{};open(name===undefined?'添加服务器':'编辑服务器');version=saved.version;
    const nameField=field(editor,'名称','mcp-name',name||'');
    nameField.autocomplete='off';nameField.required=true;
    const limited=original.command!==undefined||original.type==='stdio'||original.type==='sse'||Object.hasOwn(original,'oauth');
    if(limited)editor.append(el('p','此配置无法在浏览器中连接。原始字段保留，仅可修改名称、说明和启用状态。','mcp-hint'));
    const url=limited?null:field(editor,'HTTP(S) 地址','mcp-url',original.url||'');if(url)url.required=true;
    const description=field(editor,'说明','mcp-description',original.description||'');
    const enabled=field(editor,'启用','mcp-enabled','', 'checkbox');enabled.checked=original.enabled!==false;
    let headers,timeout,exposure,toolExposure;
    const exposures=['codemode','codemode-deferred','deferred','direct','hidden'];
    if(!limited){
      headers=pairs(editor,'请求头',original.headers,{secret:true});
      const details=el('details');details.append(el('summary','高级选项'));editor.append(details);
      timeout=field(details,'超时（秒）','mcp-timeout',original.timeout??60,'number');timeout.min='1';timeout.max='600';timeout.step='any';
      exposure=select(details,'工具可见性','mcp-exposure',exposures,original.exposure||'codemode');
      toolExposure=pairs(details,'单个工具的可见性',original.toolExposure,{options:exposures});
      details.append(el('p','除 hidden 外，当前均直接注册工具。请求头可用 ${NAME} 引用全局环境变量。','mcp-hint'));
    }
    const known=['url','description','enabled','headers','timeout','exposure','toolExposure','type','command','args','env','cwd','oauth'];
    const unknown=Object.keys(original).filter(key=>!known.includes(key));
    if(unknown.length){const hint=el('p',null,'mcp-hint');hint.textContent=t('保留的未知字段：{0}',unknown.join(', '));editor.append(hint);}
    const read=()=>({description:description.value,enabled:enabled.checked,...limited?{}:{url:url.value,headers:headers(),timeout:Number(timeout.value),exposure:exposure.value,toolExposure:toolExposure()}});
    const initial=read();
    finishButton('保存服务器',async()=>{
      const next=read(),patch={};
      for(const [key,value]of Object.entries(next))if(name===undefined||JSON.stringify(value)!==JSON.stringify(initial[key]))Object.defineProperty(patch,key,{value,enumerable:true});
      await commit({kind:'upsert',name:nameField.value,previousName:name,patch});
    });nameField.focus();
  }
  async function deleteServer(name){
    const saved=await runtimePi.getMcpServer(name);open('删除服务器');version=saved.version;
    const notice=el('p');notice.textContent=t('删除 {0}？连接将断开，相关工具会移除。',name);editor.append(notice);
    finishButton('确认删除',()=>commit({kind:'delete',name}));editor.querySelector('.primary').focus();
  }
  async function editVariables(){
    const saved=await runtimePi.getMcpVariables();open('环境变量');version=saved.version;
    editor.append(el('p','仅用于请求头中的 ${NAME}，不会读取系统环境。','mcp-hint'));
    const read=pairs(editor,'环境变量',saved.env,{secret:true});
    const affected=el('p','保存会重新连接引用这些变量的服务器。','mcp-hint');editor.append(affected);
    for(const [variable,servers] of Object.entries(saved.references||{})){
      const names=el('p',null,'mcp-hint');names.textContent=`${variable}: ${servers.join(', ')}`;editor.append(names);
    }
    finishButton('保存环境变量',()=>commit({kind:'variables',env:read()}));editor.querySelector('input,button')?.focus();
  }
  function importView(){
    open('导入 JSON',byId('mcp-import'));
    editor.append(el('p','支持 {name, config}、其数组、mcpServers 文档和旧服务器映射。所有条目校验通过后一次写入。','mcp-hint'));
    const choose=button('选择 JSON 文件',()=>byId('mcp-file').click());editor.append(choose);
    const input=field(editor,'粘贴 JSON','mcp-import-text','','textarea');input.spellcheck=false;
    input.placeholder='{"name":"docs","config":{"url":"https://example.com/mcp"}}';
    finishButton('预览导入',()=>preview(input.value));input.focus();
  }
  async function preview(input,choices={}){
    const sequence=++previewSequence;
    const plan=await runtimePi.previewMcpImport(input,choices);
    if(sequence!==previewSequence)return;
    open('导入预览',byId('mcp-import'));version=plan.version;
    const counts=el('p');counts.textContent=t('新增 {0}，替换 {1}，未变化 {2}，保留或跳过 {3}，不支持 {4}。',plan.counts.added,plan.counts.replaced,plan.counts.unchanged,plan.counts.skipped,plan.counts.unsupported);editor.append(counts);
    editor.append(el('p','同名默认保留。选择替换将替换该服务器的整条配置。错误修正前不会写入任何条目。','mcp-hint'));
    const actions={add:'新增',replace:'替换',keep:'保留已有',skip:'跳过',unchanged:'未变化',conflict:'名称冲突'};
    for(const item of plan.rows){
      const row=el('div',null,'mcp-preview-row');row.dataset.importId=item.id;
      const label=el('strong');label.textContent=`${item.kind==='server'?item.target:item.name} — ${t(actions[item.action])}`;row.append(label);
      if(item.unsupported)row.append(el('p','不支持，保存后不会连接。','mcp-hint'));
      if(item.affected?.length){const affected=el('p');affected.textContent=t('影响服务器：{0}',item.affected.join(', '));row.append(affected);}
      const controls=el('div',null,'mcp-actions');
      if(item.kind==='server'){
        const selectNode=el('select');selectNode.setAttribute('aria-label',t('导入处理方式：{0}',item.name));
        const opts=item.alias?['conflict','skip']:item.conflict?['keep','replace','skip']:['add','skip'];
        if(item.action==='unchanged')opts.splice(0,opts.length,'unchanged','skip');
        for(const action of opts){const option=el('option',actions[action]);option.value=action;selectNode.append(option);}
        selectNode.value=item.action;
        selectNode.addEventListener('change',()=>void attempt(()=>preview(input,{...choices,[item.id]:{...choices[item.id],action:selectNode.value}})));
        const rename=el('input');rename.value=item.target;rename.setAttribute('aria-label',t('导入名称：{0}',item.name));
        const renameButton=button('应用名称',()=>preview(input,{...choices,[item.id]:{...choices[item.id],name:rename.value}}));
        controls.append(selectNode,rename,renameButton);
      }else if(item.conflict){
        const selection=el('select');selection.setAttribute('aria-label',t('导入处理方式：{0}',item.name));
        for(const action of ['keep','replace']){const option=el('option',actions[action]);option.value=action;selection.append(option);}
        selection.value=item.action;selection.addEventListener('change',()=>void attempt(()=>preview(input,{...choices,[item.id]:selection.value})));controls.append(selection);
      }
      row.append(controls);editor.append(row);
    }
    if(plan.warnings.length){const warnings=el('ul',null,'mcp-hint');for(const item of plan.warnings){const li=el('li');li.textContent=`${item.path}: ${t(item.message)}`;warnings.append(li);}editor.append(warnings);}
    if(plan.errors.length){const list=el('div',null,'error');list.setAttribute('role','alert');for(const item of plan.errors){const line=el('p');line.textContent=`${item.path}: ${t(item.message)}`;list.append(line);}editor.append(list);}
    finishButton('确认导入',()=>commit({kind:'import',input,choices}));editor.querySelector('.primary').disabled=Boolean(plan.errors.length);
    editor.append(button('修改 JSON',()=>{importView();byId('mcp-import-text').value=input;}));
    editor.querySelector('h3').tabIndex=-1;editor.querySelector('h3').focus();
  }
  byId('mcp-add').addEventListener('click',()=>void attempt(()=>editServer()));
  byId('mcp-import').addEventListener('click',importView);
  byId('mcp-variables').addEventListener('click',()=>void attempt(editVariables));
  byId('mcp-file').addEventListener('change',()=>void attempt(async()=>{
    const file=byId('mcp-file').files?.[0];byId('mcp-file').value='';if(file)await preview(await file.text());
  }));
  byId('mcp-reconnect').addEventListener('click',()=>void attempt(async()=>{render(await runtimePi.refreshMcp());}));
  editor.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();close();}});
  return {load,render,close,save:()=>saveAction?.()};
}
