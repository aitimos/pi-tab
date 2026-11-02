// One bounded IO request at a time for a Linux proxy process. This channel is
// independent of LinuxMachine.request: the shell may be waiting for this process.
export class LinuxCommand {
  constructor({mailbox,data,argc,group}, {site,conversationId} = {}) {
    const fields=new TextDecoder().decode(data).split('\0');
    if(!(mailbox instanceof SharedArrayBuffer) || mailbox.byteLength!==65552 || !Number.isInteger(argc) || argc<1 || !Number.isInteger(group) || group<1 || fields.length<argc+2 || fields.pop()!=='')throw new Error('Invalid Linux command packet');
    this.cwd=fields[0];
    this.argv=fields.slice(2,argc+1);
    this.env=Object.fromEntries(fields.slice(argc+1).map(value=>{const at=value.indexOf('=');return [value.slice(0,at),value.slice(at+1)];}));
    this.site=site;
    this.conversationId=conversationId;
    this.group=group;
    this.control=new Int32Array(mailbox,0,4);
    this.data=new Uint8Array(mailbox,16);
    this.controller=new AbortController();
    this.signal=this.controller.signal;
    this.queue=Promise.resolve();
  }
  receive({status,data}) {
    const pending=this.pending;
    if(!pending)return;
    this.pending=null;
    if(status<0 && status!==-11)pending.reject(new Error(`Linux IO failed (errno ${-status})`));
    else pending.resolve({status,data});
  }
  close() {
    this.controller.abort(new Error('Linux command stopped'));
    this.pending?.reject(this.signal.reason);
    this.pending=null;
  }
  io(operation,fd=0,data=new Uint8Array()) {
    const result=this.queue.then(()=>{
      this.signal.throwIfAborted();
      this.ioSignal?.throwIfAborted();
      return new Promise((resolve,reject)=>{
        this.pending={resolve,reject};
        this.data.set(data);
        this.control[1]=operation;this.control[2]=fd;this.control[3]=data.length;
        Atomics.store(this.control,0,1);
      });
    });
    this.queue=result.catch(()=>{});
    return result;
  }
  async *read(fd) {
    while(true) {
      const {data,status}=await this.io(1,fd);
      if(status===-11) { await new Promise(resolve=>setTimeout(resolve,10));continue; }
      if(!data.length)return;
      yield data;
    }
  }
  async *readFile(path) {
    const fd=await this.open(path,false);
    try { yield* this.read(fd); } finally { if(!this.signal.aborted)await this.io(4,fd); }
  }
  async open(path,write) {
    const data=new TextEncoder().encode(path+'\0');
    if(path.includes('\0') || data.length>65536)throw new Error('Invalid Linux path');
    return (await this.io(write?5:3,0,data)).status;
  }
  async write(fd,data) {
    for(let at=0;at<data.length;) {
      const {status}=await this.io(2,fd,data.subarray(at,at+65536));
      if(status===-11) { await new Promise(resolve=>setTimeout(resolve,10));continue; }
      if(!status)throw new Error('Linux write made no progress');
      at+=status;
    }
  }
  get stdin() { return this.read(0); }
  stdout=bytes=>this.write(1,bytes);
  stderr=bytes=>this.write(2,bytes);
}
