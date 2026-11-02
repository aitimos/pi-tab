import {linux} from '../linux/vendor/linux.js';
import {LinuxCommand} from './linux-command.js';
import {runCurl} from './linux-curl.js';

export const operations = Object.freeze({exec:1,open:2,read:3,close:4,stat:5,fstat:6,write:7,mkdir:8,list:9,remove:10,realpath:11,rename:12,truncate:13,flush:14});
const encoder = new TextEncoder();
let assets;

/** One Linux kernel, RAM filesystem and process tree. No page or Pi dependencies. */
export class LinuxMachine {
  constructor({assetUrl = name => chrome.runtime.getURL(`linux/${name}`),site,conversationId} = {}) {
    this.assetUrl = assetUrl;
    this.identity={site,conversationId};
    this.commands=new Map();
    this.mailbox = new SharedArrayBuffer(1024 * 1024 + 8);
    this.control = new Int32Array(this.mailbox, 0, 2);
    this.input = new Uint8Array(this.mailbox, 8);
    this.sequence = 0;
    this.queue = Promise.resolve();
    this.dead = false;
  }

  async start() {
    if (this.dead) throw new Error('Linux 已关闭，临时文件已丢失。');
    if (!this.starting) this.starting = (async () => {
      if (!crossOriginIsolated) throw new Error('Linux 需要扩展启用跨源隔离。');
      const logs = [];
      assets ??= (async () => {
        const responses = await Promise.all(['vmlinux.wasm','initramfs.cpio.gz'].map(name => fetch(this.assetUrl(name))));
        for (const response of responses) if (!response.ok) throw new Error(`Linux 资源加载失败：${response.status}`);
        const [kernel, initrd] = await Promise.all(responses.map(response => response.arrayBuffer()));
        return {kernel:await WebAssembly.compile(kernel), initrd};
      })().catch(error => { assets=undefined; throw error; });
      const {kernel,initrd} = await assets;
      if (this.dead) throw new Error('Linux 已关闭。');
      const ready = new Promise((resolve,reject) => { this.readyResolve=resolve; this.readyReject=reject; });
      const timer = setTimeout(() => this.dispose(new Error(`Linux 启动超时。\n${logs.join('\n')}`)), 30000);
      this.os = await linux(this.assetUrl('linux-worker.js'), 'wasm32_nommu', kernel,
        'maxcpus=3 nohz_full=0,2-63 rcu_nocbs=0,2-63 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc',
        initrd, text => { logs.push(text); if(logs.length>30) logs.shift(); },
        text => { logs.push(text); if(logs.length>30) logs.shift(); }, this.mailbox,
        message => this.receive(message), error => this.dispose(new Error(`${error.message}\nLinux 已停止，临时文件已丢失；下次调用会重新启动。`)),
        (message,worker)=>this.command(message,worker));
      try { await ready; } finally { clearTimeout(timer); }
    })().catch(error => { this.dispose(error); throw error; });
    await this.starting;
  }

  command(message,worker) {
    if(message.kind==='start') {
      const call=new LinuxCommand(message,this.identity);
      this.commands.set(worker,call);
      if(call.group===this.cancelledGroup)call.close();
      void runCurl(call).then(({exitCode})=>call.io(6,exitCode)).catch(()=>{
        // The process may have been killed (including SIGPIPE from `head`).
        if(!call.signal.aborted)void call.io(6,2).catch(()=>{});
      });
    } else if(message.kind==='reply')this.commands.get(worker)?.receive(message);
    else if(message.kind==='closed') {
      this.commands.get(worker)?.close();
      this.commands.delete(worker);
    }
  }

  receive({id,kind,data,status}) {
    if (kind===0) { this.readyResolve(); return; }
    const pending=this.pending;
    if (!pending || id!==pending.id) return;
    if(kind===6) {
      pending.group=status;
      if(this.cancelledGroup===status)this.cancelledGroup=undefined;
      if(pending.cancelled)pending.cancel(pending.cancelled);
      return;
    }
    if (kind===1 || kind===2) {
      const text=pending.decoders[kind-1].decode(data,{stream:true});
      if(text) {
        try { pending.onOutput?.(text,kind===1?'stdout':'stderr'); }
        catch(error) { pending.outputError=error;Atomics.store(this.control,1,id); }
      }
      return;
    }
    if (kind===5) { pending.chunks.push(data); return; }
    this.pending=null;
    for (let i=0;i<2;i++) {
      const text=pending.decoders[i].decode();
      if(text) {
        try { pending.onOutput?.(text,i===0?'stdout':'stderr'); }
        catch(error) { pending.outputError=error; }
      }
    }
    pending.chunks.push(data);
    const output=new Uint8Array(pending.chunks.reduce((size,chunk)=>size+chunk.length,0));
    let position=0;
    for(const chunk of pending.chunks) { output.set(chunk,position); position+=chunk.length; }
    if(pending.outputError) pending.reject(pending.outputError);
    else if(kind===4) pending.reject(Object.assign(new Error(new TextDecoder().decode(output)),{errno:status}));
    else pending.resolve({status,data:output,cancelled:pending.cancelled});
  }

  request(operation, args=[], data=new Uint8Array(), {signal,timeout,onOutput}={}) {
    const strings=args.map(value=>String(value));
    if(strings.length>4096 || strings.some(value=>value.includes('\0'))) return Promise.reject(new Error('Linux 参数包含 NUL 或参数过多。'));
    const parameters=encoder.encode(strings.length?strings.join('\0')+'\0':'');
    if(16+parameters.length+data.length>this.input.length) return Promise.reject(new Error('Linux 请求超过 1 MiB。'));
    const run=this.queue.then(async()=>{
      signal?.throwIfAborted();
      await this.start();
      signal?.throwIfAborted();
      if(this.dead) throw new Error('Linux 已关闭，临时文件已丢失。');
      const id=++this.sequence;
      let abort, timer;
      try {
        return await new Promise((resolve,reject)=>{
          const pending={id,resolve,reject,onOutput,chunks:[],decoders:[new TextDecoder(),new TextDecoder()]};
          this.pending=pending;
          const cancel=reason=>{
            pending.cancelled=reason; Atomics.store(this.control,1,id);
            if(pending.group!==undefined) {
              this.cancelledGroup=pending.group;
              for(const call of this.commands.values())if(call.group===pending.group)call.close();
            }
          };
          pending.cancel=cancel;
          abort=()=>cancel('aborted');
          signal?.addEventListener('abort',abort,{once:true});
          if(timeout!==undefined) timer=setTimeout(()=>cancel('timeout'),timeout*1000);
          const header=new DataView(this.input.buffer,8,16);
          [id,operation,strings.length,data.length].forEach((value,index)=>header.setUint32(index*4,value,true));
          this.input.set(parameters,16);
          this.input.set(data,16+parameters.length);
          Atomics.store(this.control,0,16+parameters.length+data.length);
        });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort',abort);
      }
    });
    this.queue=run.catch(()=>{});
    return run;
  }

  dispose(error=new Error('Linux 已关闭，临时文件已丢失。')) {
    if(this.dead) return;
    this.dead=true;
    for(const call of this.commands.values())call.close();
    this.commands.clear();
    this.os?.dispose();
    this.readyReject?.(error);
    this.pending?.reject(error);
    this.pending=null;
  }
}
