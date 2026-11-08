// Configuration rules shared by the bookmark runtime and extension storage owner.
// Persist raw JSON, never the normalized connection records (or expanded tokens).
import {normalizeMcpServers,parseMcpConfig} from './mcp.js';

export const MCP_EXPOSURES = ['codemode','codemode-deferred','deferred','direct','hidden'];
const entryKeys = new Set(['command','args','env','cwd','url','headers','oauth','type','timeout','enabled','exposure','toolExposure','description']);
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const mcpIdentity = name => String(name).replaceAll('-','_').toLowerCase();
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b);
const put = (object,key,value) => Object.defineProperty(object,key,{value,enumerable:true,writable:true,configurable:true});

export class McpConfigError extends Error {
  constructor(message, diagnostics = []) { super(message); this.name='McpConfigError'; this.diagnostics=diagnostics; }
}

/** JSON.parse validates syntax; this walk additionally rejects duplicate keys,
 * including escaped equivalents. No JSON content is included in errors. */
export function readMcpJson(text) {
  let value;
  try { value=JSON.parse(text); }
  catch { throw new McpConfigError('MCP 配置不是有效的 JSON。'); }
  let offset=0;
  const whitespace=()=>{while (/\s/.test(text[offset] ?? '') && offset<text.length) offset++;};
  const string=()=>{
    const start=offset++;
    while(offset<text.length) {
      if(text[offset++]==='"')return JSON.parse(text.slice(start,offset));
      if(text[offset-1]==='\\')offset++;
    }
  };
  const walk=()=>{
    whitespace();
    if(text[offset]==='"'){string();return;}
    if(text[offset]==='{'){
      offset++;whitespace();const keys=new Set();
      if(text[offset]==='}'){offset++;return;}
      for(;;){
        whitespace();const key=string();
        if(keys.has(key))throw new McpConfigError('JSON 包含重复字段，请合并后重新导入。');
        keys.add(key);whitespace();offset++;walk();whitespace();
        if(text[offset++]==='}')return;
      }
    }
    if(text[offset]==='['){
      offset++;whitespace();if(text[offset]===']'){offset++;return;}
      for(;;){walk();whitespace();if(text[offset++]===']')return;}
    }
    while(offset<text.length&&!/[\s,}\]]/.test(text[offset]))offset++;
  };
  try { walk(); }
  catch(error){if(error instanceof McpConfigError)throw error;throw new McpConfigError('JSON 嵌套过深。');}
  return value;
}

export function mcpVersion(config, revision=0) {
  // Two independent accumulators keep the token small without exposing raw values.
  // This is optimistic concurrency metadata, not an authentication primitive.
  let a=0x811c9dc5,b=0x9e3779b9;
  for(const c of JSON.stringify(config)){a=Math.imul(a^c.charCodeAt(0),0x01000193);b=Math.imul(b^c.charCodeAt(0),0x85ebca6b);}
  return `${revision}:${(a>>>0).toString(16).padStart(8,'0')}${(b>>>0).toString(16).padStart(8,'0')}`;
}

export function validateMcpEntry(name,entry,env={},path=`mcpServers.${name}`) {
  const errors=[],warnings=[];
  const fail=(field,message)=>errors.push({path:field?`${path}.${field}`:path,message});
  if(typeof name!=='string'||!/^[a-zA-Z0-9_-]+$/.test(name))fail('','名称只能包含字母、数字、_ 和 -。');
  if(!record(entry)){fail('','配置必须是一个对象。');return {errors,warnings,unsupported:false};}
  if(entry.enabled!==undefined&&typeof entry.enabled!=='boolean')fail('enabled','必须是布尔值。');
  if(entry.description!==undefined&&typeof entry.description!=='string')fail('description','必须是字符串。');
  if(entry.type!==undefined&&!['http','streamable-http','stdio','sse'].includes(entry.type))fail('type','不支持此传输类型。');
  if(entry.timeout!==undefined&&(typeof entry.timeout!=='number'||!Number.isFinite(entry.timeout)||entry.timeout<1||entry.timeout>600))fail('timeout','应为 1 到 600 之间的秒数。');
  if(entry.exposure!==undefined&&!MCP_EXPOSURES.includes(entry.exposure))fail('exposure','无效的工具可见性。');
  if(entry.toolExposure!==undefined&&(!record(entry.toolExposure)||Object.values(entry.toolExposure).some(value=>!MCP_EXPOSURES.includes(value))))fail('toolExposure','必须是工具名称或模式到有效可见性的映射。');
  if(entry.env!==undefined&&(!record(entry.env)||Object.values(entry.env).some(value=>typeof value!=='string')))fail('env','必须是字符串映射。');
  if(entry.cwd!==undefined&&typeof entry.cwd!=='string')fail('cwd','必须是字符串。');
  const stdio=entry.command!==undefined||entry.type==='stdio';
  if(stdio){
    if(typeof entry.command!=='string'||!entry.command.trim())fail('command','stdio 配置需要 command 字符串。');
    if(entry.args!==undefined&&(!Array.isArray(entry.args)||entry.args.some(value=>typeof value!=='string')))fail('args','必须是字符串数组。');
  }else{
    let url;
    if(typeof entry.url==='string'){try{url=new URL(entry.url);}catch{ /* diagnostic below */ }}
    if(!url||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.hash||entry.url.includes('#'))fail('url','需要不含登录信息和 # 的 HTTP(S) 地址。');
  }
  if(entry.headers!==undefined){
    if(!record(entry.headers))fail('headers','必须是字符串映射。');
    else {
      const seen=new Set();
      for(const [key,value] of Object.entries(entry.headers)){
        const lower=key.toLowerCase();
        if(!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(key)||seen.has(lower))fail('headers','请求头名称无效或重复。');
        seen.add(lower);
        if(['content-type','accept','mcp-session-id','mcp-protocol-version'].includes(lower))fail('headers','不能覆盖 MCP 客户端保留的请求头。');
        if(typeof value!=='string'||/[\r\n]/.test(value))fail(`headers.${key}`,'请求头值必须是无换行的字符串。');
        else {
          if(value.startsWith('!'))fail(`headers.${key}`,'浏览器无法执行 !command。');
          if(!stdio)for(const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)){
            if(!Object.hasOwn(env,match[1]))fail(`headers.${key}`,'引用的变量未在全局环境变量中定义。');
            else if(typeof env[match[1]]!=='string'||/[\r\n]/.test(env[match[1]]))fail(`headers.${key}`,'引用的变量不是有效的请求头值。');
          }
        }
      }
    }
  }
  const unknown=Object.keys(entry).filter(key=>!entryKeys.has(key));
  if(unknown.length)warnings.push({path,message:'未知字段会保留，但不参与浏览器连接。',fields:unknown});
  const unsupported=stdio||entry.type==='sse'||Object.hasOwn(entry,'oauth');
  if(unsupported)warnings.push({path,message:'浏览器不支持此配置，保存后不会连接。'});
  return {errors,warnings,unsupported};
}

function validateVariables(env) {
  const errors=[];
  if(!record(env))return [{path:'env',message:'环境变量必须是字符串映射。'}];
  for(const [name,value] of Object.entries(env))if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||typeof value!=='string')errors.push({path:`env.${name}`,message:'变量名无效或值不是字符串。'});
  return errors;
}

export function parseMcpImport(input) {
  const value=typeof input==='string'?readMcpJson(input):structuredClone(input);
  const unpack=item=>{
    if(!record(item)||typeof item.name!=='string'||!Object.hasOwn(item,'config')||Object.keys(item).some(key=>!['name','config'].includes(key)))throw new McpConfigError('单条格式应为 {name, config}；特殊名称可使用 mcpServers 文档。');
    return {name:item.name,config:item.config};
  };
  let entries=[],globals={};
  if(Array.isArray(value))entries=value.map(unpack);
  else if(record(value)&&Object.hasOwn(value,'mcpServers')){
    if(!record(value.mcpServers))throw new McpConfigError('mcpServers 必须是对象。');
    entries=Object.entries(value.mcpServers).map(([name,config])=>({name,config}));
    globals=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='mcpServers'));
  }else if(record(value)&&Object.hasOwn(value,'name')&&Object.hasOwn(value,'config'))entries=[unpack(value)];
  else if(record(value)){
    entries=Object.entries(value).filter(([key])=>!['env','autoEnableCodemode'].includes(key)).map(([name,config])=>({name,config}));
    globals=Object.fromEntries(Object.entries(value).filter(([key])=>['env','autoEnableCodemode'].includes(key)));
  }else throw new McpConfigError('MCP 配置需要一个 JSON 对象或单条配置数组。');
  if(!entries.length)throw new McpConfigError('未发现服务器，不会修改已有配置。');
  return {entries,globals};
}

/** Plan contains raw candidate data only for its storage owner; publicPlan below
 * is the sole projection sent to list/preview UI or runtime events. */
export function planMcpImport(current,input,choices={}) {
  const {entries,globals}=parseMcpImport(input);
  const candidate=structuredClone(current),rows=[],errors=[],warnings=[],changed=[];
  candidate.mcpServers={...(current.mcpServers||{})};
  const counts={added:0,replaced:0,unchanged:0,skipped:0,unsupported:0};
  const seen=new Set();
  for(const [key,value] of Object.entries(globals)){
    if(key==='env'){
      errors.push(...validateVariables(value));
      if(!record(value))continue;
      candidate.env={...(current.env||{})};
      for(const [name,variable] of Object.entries(value))mergeGlobal(`env.${name}`,candidate.env,name,variable,current.env||{});
    }else mergeGlobal(`global.${key}`,candidate,key,value,current);
  }
  function mergeGlobal(id,target,key,value,old){
    const exists=Object.hasOwn(old,key),identical=exists&&same(old[key],value),conflict=exists&&!identical;
    const action=identical?'unchanged':conflict&&choices[id]!=='replace'?'keep':exists?'replace':'add';
    const affected=key.startsWith('env.')?[]:Object.entries(current.mcpServers||{}).filter(([,entry])=>Object.values(entry?.headers||{}).some(v=>typeof v==='string'&&v.includes('${'+key+'}'))).map(([name])=>name);
    rows.push({id,name:key,kind:id.startsWith('env.')?'env':'global',action,conflict,affected});
    if(['add','replace'].includes(action))put(target,key,structuredClone(value));
  }
  for(let index=0;index<entries.length;index++){
    const {name,config}=entries[index],id=`server.${index}`,choice=choices[id]||{};
    const target=choice.name??name,identity=mcpIdentity(target);
    if(seen.has(identity))errors.push({path:`items[${index}].name`,message:'批次内有重复名称或命名冲突。'});
    seen.add(identity);
    const validation=validateMcpEntry(target,config,candidate.env||{},`items[${index}].config`);
    errors.push(...validation.errors);warnings.push(...validation.warnings);
    const existing=Object.keys(current.mcpServers||{}).find(key=>mcpIdentity(key)===identity);
    const exists=existing!==undefined,alias=exists&&existing!==target,identical=exists&&!alias&&same(current.mcpServers[existing],config);
    let action=identical?'unchanged':exists?'keep':'add';
    if(choice.action==='skip')action='skip';
    else if(alias)action='conflict';
    else if(exists&&!identical&&choice.action==='replace')action='replace';
    if(action==='conflict')errors.push({path:`items[${index}].name`,message:'名称仅大小写或 -/_ 不同，请改名或跳过。'});
    rows.push({id,name,target,kind:'server',action,conflict:exists&&!identical,alias,existing,unsupported:validation.unsupported});
    if(['add','replace'].includes(action)){
      put(candidate.mcpServers,target,structuredClone(config));changed.push(target);
      counts[action==='add'?'added':'replaced']++;
      if(validation.unsupported)counts.unsupported++;
    }else counts[action==='unchanged'?'unchanged':'skipped']++;
  }
  errors.push(...affectedVariableErrors(current,candidate,changed));
  return {candidate,rows,errors,warnings,counts,changed:!same(candidate,current)};
}

function affectedVariableErrors(current,candidate,alreadyChecked=[]){
  const changed=new Set([...Object.keys(current.env||{}),...Object.keys(candidate.env||{})].filter(key=>current.env?.[key]!==candidate.env?.[key]));
  const errors=[];
  for(const [name,entry] of Object.entries(candidate.mcpServers||{})){
    if(alreadyChecked.includes(name))continue;
    const affected=Object.values(entry?.headers||{}).some(value=>typeof value==='string'&&[...changed].some(key=>value.includes('${'+key+'}')));
    if(!affected)continue;
    // Existing unrelated errors do not block management of another server.
    const previous=validateMcpEntry(name,entry,current.env||{}).errors.map(error=>JSON.stringify(error));
    errors.push(...validateMcpEntry(name,entry,candidate.env||{}).errors.filter(error=>!previous.includes(JSON.stringify(error))));
  }
  return errors;
}

export function publicMcpPlan(plan,version){
  return {version,rows:plan.rows,errors:plan.errors,warnings:plan.warnings,counts:plan.counts,changed:plan.changed};
}

export function mergeMcpBookmark(current,input){
  const {value}=parseMcpConfig(input);
  const merged={...value,...current,mcpServers:{...current.mcpServers},...(value.env?{env:{...value.env,...current.env}}:{})},skipped=[];
  const identities=new Set(Object.keys(merged.mcpServers).map(mcpIdentity));
  for(const [name,entry] of Object.entries(value.mcpServers||{})){
    if(identities.has(mcpIdentity(name))){skipped.push(name);continue;}
    put(merged.mcpServers,name,structuredClone(entry));identities.add(mcpIdentity(name));
  }
  return {value:merged,result:{skipped}};
}

export function changeMcpConfig(current,operation){
  if(operation.kind==='bootstrap')return mergeMcpBookmark(current,operation.input);
  if(operation.kind==='import'){
    const plan=planMcpImport(current,operation.input,operation.choices);
    if(plan.errors.length)throw new McpConfigError('请修正导入错误后重试，尚未写入任何条目。',plan.errors);
    return {value:plan.candidate,result:publicMcpPlan(plan)};
  }
  const value=structuredClone(current);value.mcpServers={...(current.mcpServers||{})};
  let errors=[];
  if(operation.kind==='delete'){
    if(!Object.hasOwn(value.mcpServers,operation.name))throw new McpConfigError('服务器不存在，请重新加载配置。');
    delete value.mcpServers[operation.name];
  }else if(operation.kind==='upsert'){
    const {name,previousName,patch}=operation;
    if(previousName!==undefined&&!Object.hasOwn(value.mcpServers,previousName))throw new McpConfigError('服务器不存在，请重新加载配置。');
    if(!record(patch))throw new McpConfigError('服务器字段必须是对象。');
    const original=previousName===undefined?{}:value.mcpServers[previousName];
    const entry={...(record(original)?original:{}),...patch};
    for(const key of operation.removeFields||[])delete entry[key];
    const collision=Object.keys(value.mcpServers).find(key=>key!==previousName&&mcpIdentity(key)===mcpIdentity(name));
    if(collision)errors.push({path:'name',message:'名称与已有服务器冲突。'});
    const limited=record(original)&&(original.command!==undefined||original.type==='stdio'||original.type==='sse'||Object.hasOwn(original,'oauth'));
    if(limited&&Object.keys(patch).some(key=>!['enabled','description'].includes(key)))throw new McpConfigError('不支持的配置仅可修改名称、说明和启用状态。');
    errors.push(...validateMcpEntry(name,entry,value.env||{}).errors);
    if(!errors.length){if(previousName!==undefined)delete value.mcpServers[previousName];put(value.mcpServers,name,entry);}
  }else if(operation.kind==='variables'){
    errors.push(...validateVariables(operation.env));
    value.env=structuredClone(operation.env);
    errors.push(...affectedVariableErrors(current,value));
  }else if(operation.kind==='replace'){
    if(!record(operation.value)||!record(operation.value.mcpServers))throw new McpConfigError('mcpServers 必须是对象。');
    if(operation.value.env!==undefined)errors.push(...validateVariables(operation.value.env));
    const identities=new Set();
    for(const [name,entry] of Object.entries(operation.value.mcpServers)){
      if(identities.has(mcpIdentity(name)))errors.push({path:'mcpServers',message:'服务器名称冲突。'});
      identities.add(mcpIdentity(name));errors.push(...validateMcpEntry(name,entry,operation.value.env||{}).errors);
    }
    if(!errors.length)return {value:structuredClone(operation.value)};
  }else throw new McpConfigError('未知 MCP 配置操作。');
  if(errors.length)throw new McpConfigError('配置校验失败，尚未保存。',errors);
  return {value};
}

export function mcpVariableReferences(config){
  const result={};
  for(const [name,entry] of Object.entries(config.mcpServers||{}))for(const value of Object.values(entry?.headers||{})){
    if(typeof value!=='string')continue;
    for(const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)){
      const key=match[1],names=Object.hasOwn(result,key)?result[key]:[];
      if(!names.includes(name))names.push(name);
      put(result,key,names);
    }
  }
  return result;
}

export function mcpPublicSummary(config,runtime=[],version=''){
  const {servers,problems}=normalizeMcpServers(config);
  const secrets=[...Object.values(config.env||{})];
  for(const entry of Object.values(config.mcpServers||{})){
    secrets.push(...Object.values(entry?.headers||{}),...Object.values(entry?.env||{}));
    if(typeof entry?.url==='string'){try{secrets.push(...new URL(entry.url).searchParams.values());}catch{ /* no raw URL is displayed */ }}
  }
  const clean=text=>{
    let result=String(text??'');
    for(const secret of secrets.filter(value=>typeof value==='string'&&value).sort((a,b)=>b.length-a.length))result=result.split(secret).join('••••');
    return result;
  };
  return {version,servers:Object.keys(config.mcpServers||{}).map(name=>{
    const raw=config.mcpServers[name],normal=servers.find(server=>server.name===name),live=runtime.find(server=>server.name===name);
    let url='';if(typeof raw?.url==='string'){try{const u=new URL(raw.url);if(['http:','https:'].includes(u.protocol))url=clean(u.origin+u.pathname);}catch{ /* invalid entries remain visible */ }}
    const issue=problems.find(problem=>problem.name===name);
    return {name,url,enabled:raw?.enabled!==false,unsupported:normal?.supported===false,
      status:live?.status||(normal?.supported===false?'unsupported':issue?'invalid':raw?.enabled===false?'disabled':'idle'),
      reason:normal?.supported===false?clean(normal.reason):issue?'配置存在问题，请编辑检查。':'',
      error:live?.error?clean(live.error):'',toolCount:live?.toolCount||0,
      unknownFields:record(raw)?Object.keys(raw).filter(key=>!entryKeys.has(key)):[]};
  }),problems:[],variables:Object.keys(config.env||{}),busy:false};
}
