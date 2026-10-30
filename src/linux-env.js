import {FileError,ExecutionError,LineScanner,ok,err,getOrThrow} from '@earendil-works/pi-durable/env';
import {LinuxMachine,operations as op} from './linux-machine.js';

const encoder=new TextEncoder();
const decode=bytes=>new TextDecoder('utf-8',{ignoreBOM:true}).decode(bytes);
const errnoCodes={2:'not_found',13:'permission_denied',20:'not_directory',21:'is_directory',22:'invalid',38:'not_supported',40:'invalid'};

function absolute(path,cwd) {
  const parts=(path.startsWith('/')?path:`${cwd}/${path}`).split('/');
  const result=[];
  for(const part of parts) { if(part==='..')result.pop();else if(part && part!=='.')result.push(part); }
  return '/'+result.join('/');
}

function metadata(bytes,parent) {
  const fields=decode(bytes).split('\0');
  fields.pop();
  const entries=[];
  for(let index=0;index<fields.length;index+=4) {
    const [name,kind,size,mtimeMs]=fields.slice(index,index+4);
    const path=name.startsWith('/')?name:absolute(name,parent);
    entries.push({name:path.split('/').at(-1),path,kind,size:Number(size),mtimeMs:Number(mtimeMs)});
  }
  return entries;
}

/** Pi's environment, backed exclusively by a conversation's Linux filesystem. */
export class LinuxEnv {
  constructor(id,{machineFactory=()=>new LinuxMachine()}={}) {
    this.id=id;
    this.cwd='/workspace';
    this.machineFactory=machineFactory;
  }
  getMachine() {
    if(!this.machine || this.machine.dead) this.machine=this.machineFactory();
    return this.machine;
  }
  dispose() { this.machine?.dispose(); }
  async cleanup() { this.dispose(); }

  // This is the file boundary: convert bridge/host errors to the SDK's Result.
  async file(path,context,operation) {
    try {
      context?.abortSignal?.throwIfAborted();
      return ok(await operation());
    } catch(error) {
      return err(error instanceof FileError?error:new FileError(context?.abortSignal?.aborted?'aborted':errnoCodes[error.errno]||'unknown',error.message,path,error));
    }
  }
  absolutePath(path,context) { return this.file(path,context,()=>absolute(path.replace(/^~(?=\/|$)/,'/workspace'),this.cwd)); }
  joinPath(parts,context) { return this.absolutePath(parts.join('/'),context); }
  canonicalPath(path,context) { return this.file(path,context,async()=>decode((await this.getMachine().request(op.realpath,[path],undefined,{signal:context?.abortSignal})).data)); }
  fileInfo(path,context) { return this.file(path,context,async()=>metadata((await this.getMachine().request(op.stat,[path],undefined,{signal:context?.abortSignal})).data,this.cwd)[0]); }
  async exists(path,context) {
    const result=await this.fileInfo(path,context);
    return result.ok?ok(true):result.error.code==='not_found'?ok(false):result;
  }
  listDir(path,context) { return this.file(path,context,async()=>metadata((await this.getMachine().request(op.list,[path],undefined,{signal:context?.abortSignal})).data,path)); }

  openBinaryReader(path,options,context) {
    return this.file(path,context,async()=>{
      const machine=this.getMachine();
      const fd=(await machine.request(op.open,[path,options?.noFollow?'1':'0'],undefined,{signal:context?.abortSignal})).status;
      let closed=false;
      const read=async(offset,length,context)=>this.file(path,context,async()=>{
        if(closed)throw new Error('文件句柄已关闭。');
        const chunks=[];
        let received=0;
        while(received<length) {
          const size=Math.min(65536,length-received);
          const {data}=await machine.request(op.read,[fd,offset+received,size],undefined,{signal:context?.abortSignal});
          chunks.push(data);received+=data.length;
          if(data.length<size)break;
        }
        const data=new Uint8Array(received);let at=0;
        for(const chunk of chunks){data.set(chunk,at);at+=chunk.length;}
        return data;
      });
      return {
        info:context=>this.file(path,context,async()=>{
          const info=metadata((await machine.request(op.fstat,[fd],undefined,{signal:context?.abortSignal})).data,path)[0];
          return {...info,path,name:path.split('/').at(-1)};
        }),
        read,
        scanLines:({startLine,endLine},context)=>this.file(path,context,async()=>{
          const scanner=new LineScanner(startLine,endLine);
          for(let offset=0;;) {
            const data=getOrThrow(await read(offset,65536,context));
            scanner.push(data);offset+=data.length;
            if(data.length<65536)break;
          }
          return scanner.finish();
        }),
        close:async()=>{if(closed)return;closed=true;if(!machine.dead)await machine.request(op.close,[fd]);},
      };
    });
  }

  readBinaryFile(path,context) {
    return this.file(path,context,async()=>{
      const reader=getOrThrow(await this.openBinaryReader(path,undefined,context));
      try {
        const info=getOrThrow(await reader.info(context));
        return getOrThrow(await reader.read(0,info.size,context));
      } finally { await reader.close(); }
    });
  }
  async readTextFile(path,context) {
    const result=await this.readBinaryFile(path,context);
    return result.ok?ok(decode(result.value)):result;
  }
  writeFile(path,content,context) { return this.write(path,content,false,context); }
  appendFile(path,content,context) { return this.write(path,content,true,context); }
  write(path,content,append,context) {
    return this.file(path,context,async()=>{
      const data=typeof content==='string'?encoder.encode(content):content;
      const machine=this.getMachine();
      let offset=0;
      do {
        const chunk=data.subarray(offset,offset+65536);
        await machine.request(op.write,[path,append||offset>0?'1':'0'],chunk,{signal:context?.abortSignal});
        offset+=chunk.length;
      } while(offset<data.length);
    });
  }
  createDir(path,options,context) {
    return this.file(path,context,async()=>{
      const target=absolute(path,this.cwd);
      const paths=options?.recursive?target.split('/').slice(1).map((_,index)=>'/'+target.split('/').slice(1,index+2).join('/')):[target];
      for(const directory of paths) {
        if(options?.recursive && getOrThrow(await this.exists(directory,context))) {
          if(getOrThrow(await this.fileInfo(directory,context)).kind!=='directory')throw new FileError('not_directory','路径不是目录。',directory);
          continue;
        }
        await this.getMachine().request(op.mkdir,[directory],undefined,{signal:context?.abortSignal});
      }
    });
  }
  renameFile(from,to,context) { return this.file(from,context,async()=>{await this.getMachine().request(op.rename,[from,to],undefined,{signal:context?.abortSignal});}); }
  truncateFile(path,size,context) { return this.file(path,context,async()=>{await this.getMachine().request(op.truncate,[path,size],undefined,{signal:context?.abortSignal});}); }
  flushFile(path,context) { return this.file(path,context,async()=>{await this.getMachine().request(op.flush,[path],undefined,{signal:context?.abortSignal});}); }
  async createTempFile(options,context) {
    const path=`/tmp/${options?.prefix||'pi-'}${crypto.randomUUID()}${options?.suffix||''}`;
    const result=await this.writeFile(path,'',context);
    return result.ok?ok(path):result;
  }
  async createTempDir(prefix,context) {
    const path=`/tmp/${prefix||'pi-'}${crypto.randomUUID()}`;
    const result=await this.createDir(path,undefined,context);
    return result.ok?ok(path):result;
  }
  remove(path,options,context) {
    return this.file(path,context,async()=>{
      const info=await this.fileInfo(path,context);
      if(!info.ok && options?.force && info.error.code==='not_found')return;
      const entry=getOrThrow(info);
      if(entry.kind==='directory' && options?.recursive) for(const child of getOrThrow(await this.listDir(path,context)))getOrThrow(await this.remove(child.path,options,context));
      await this.getMachine().request(op.remove,[path],undefined,{signal:context?.abortSignal});
    });
  }
  async watch() { return err(new FileError('not_supported','Linux 环境暂不提供文件监视。')); }
  async openTextLineReader() { return err(new FileError('not_supported','请使用 openBinaryReader。')); }
  async readTextLines() { return err(new FileError('not_supported','请使用 openBinaryReader。')); }
  async openDirReader() { return err(new FileError('not_supported','请使用 listDir。')); }

  async exec(command,options={},context) {
    try {
      context?.abortSignal?.throwIfAborted();
      const env=Object.entries(options.env||{}).map(([key,value])=>`${key}=${value}`);
      const args=[options.cwd||this.cwd,options.inheritEnv===false?'0':'1',env.length,options.spill?.afterBytes||0,options.spill?.afterLines||0,
        ...env,...(typeof command==='string'?['/bin/sh','-c',command]:command)];
      const result=await this.getMachine().request(op.exec,args,undefined,{
        signal:context?.abortSignal,timeout:options.timeout,
        onOutput:(text,stream)=>options.onOutput?.(text,context,{stream}),
      });
      const spillPath=decode(result.data)||undefined;
      if(result.cancelled) return err(Object.assign(new ExecutionError(result.cancelled,result.cancelled==='timeout'?'命令超时。':'命令已停止。'),{spillPath}));
      return ok({exitCode:result.status,...(spillPath?{spillPath}:{})});
    } catch(error) {
      return err(new ExecutionError(context?.abortSignal?.aborted?'aborted':'unknown',error.message,error));
    }
  }
}

export function createLinuxEnvironments(site) {
  const environments=new Map();
  return {
    get:({conversationId})=>{
      if(!environments.has(conversationId))environments.set(conversationId,new LinuxEnv(`linux:${site}:${conversationId}`));
      return environments.get(conversationId);
    },
    delete:conversationId=>{environments.get(conversationId)?.dispose();environments.delete(conversationId);},
    dispose:()=>{for(const env of environments.values())env.dispose();environments.clear();},
  };
}
