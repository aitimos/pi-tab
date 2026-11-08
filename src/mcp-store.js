import {changeMcpConfig,McpConfigError,mcpVersion,planMcpImport,publicMcpPlan} from './mcp-config.js';

// Serializes writes within an owner. read/write adapters preserve the existing
// storage format; callbacks never make a durable save depend on network success.
export class McpConfigStore {
  constructor({read,write,onSaved=()=>{},guard=()=>{},release=()=>{},lock=fn=>fn()}){
    Object.assign(this,{read,write,onSaved,guard,release,lock});this.queue=Promise.resolve();
  }
  async snapshot(){
    const saved=await this.read(),config=saved.mcp??{mcpServers:{}},revision=saved.mcpRevision??0;
    return {config,revision,version:mcpVersion(config,revision)};
  }
  async preview(input,choices){
    const state=await this.snapshot();
    return publicMcpPlan(planMcpImport(state.config,input,choices),state.version);
  }
  change({operation,expectedVersion}){
    const task=()=>this.lock(async()=>{
      try{
        await this.guard();
        const state=await this.snapshot();
        if(expectedVersion!==undefined&&expectedVersion!==state.version)throw new McpConfigError('配置已变化，请重新加载或预览。');
        const {value,result}=changeMcpConfig(state.config,operation);
        if(JSON.stringify(value)===JSON.stringify(state.config))return {version:state.version,result,saved:false};
        const revision=state.revision+1;
        try{await this.write({mcp:value,mcpRevision:revision});}
        catch{throw new McpConfigError('保存失败，尚未写入任何条目。请检查存储空间后重试。');}
        const response={version:mcpVersion(value,revision),result,saved:true};
        try{await this.onSaved(value,revision);}
        catch{response.syncError='已保存，连接同步失败，请重新连接。';}
        return response;
      }finally{await this.release();}
    });
    const result=this.queue.then(task);this.queue=result.catch(()=>{});return result;
  }
}
