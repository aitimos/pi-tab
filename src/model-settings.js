// Provider identity also associates profiles created before an explicit provider
// record exists (for example the initial setup form).
export const providerIdentity = p => [p.nativeProvider || '',p.api,p.baseUrl,p.apiKey || ''].join('\n');
export function savedProviders(data) {
  return [...new Map([...data.profiles,...data.providers].map(p=>[providerIdentity(p),{
    id:p.providerId || p.id, api:p.api,baseUrl:p.baseUrl,apiKey:p.apiKey || '',providerName:p.providerName || '',
    headers:p.headers,proxyUrl:p.proxyUrl,proxyToken:p.proxyToken,nativeProvider:p.nativeProvider,
  }])).values()];
}
export function changeModels(current, change, busyIds = []) {
  const data=structuredClone(current), {action,id}=change;
  const isProvider=action.endsWith('provider');
  if(!['update-provider','delete-provider','update-model','delete-model'].includes(action))throw Error('未知设置操作。');
  const record=(isProvider?savedProviders(data):data.profiles).find(p=>p.id===id);
  if(!record)throw Error('配置不存在。');
  const related=p=>isProvider?(p.providerId===id || providerIdentity(p)===providerIdentity(record)):p.id===id;
  const affected=data.profiles.filter(related);
  if(affected.some(p=>busyIds.includes(p.id)))throw Error('此配置正在运行，请停止任务后再修改。');
  if(action.startsWith('delete')){
    if(!isProvider){const provider=savedProviders(data).find(p=>providerIdentity(p)===providerIdentity(record));if(provider&&!data.providers.some(p=>p.id===provider.id))data.providers.push(provider);}
    data.profiles=data.profiles.filter(p=>!related(p));
    data.removedProfiles=[...new Set([...(data.removedProfiles || []),...affected.map(p=>p.id)])];
    if(isProvider){data.providers=data.providers.filter(p=>p.id!==id);data.removedProviders=[...new Set([...(data.removedProviders || []),id])];}
    if(affected.some(p=>p.id===data.config?.profileId))data.config=null;
  }else if(isProvider){
    const values=change.values;
    const patch=record.nativeProvider?{providerName:values.providerName}:Object.fromEntries(['providerName','api','baseUrl','apiKey'].map(key=>[key,values[key] ?? record[key]]));
    if(!record.nativeProvider){
      const url=new URL(patch.baseUrl);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('请填写有效的接口地址。');
      patch.baseUrl=patch.baseUrl.replace(/\/+$/,'');
    }
    const connectionChanged=!record.nativeProvider && (patch.api!==record.api || patch.baseUrl!==record.baseUrl);
    if(connectionChanged && !Object.hasOwn(values,'apiKey'))patch.apiKey='';
    const update=p=>{
      const next={...p,...patch,providerId:id};
      if(connectionChanged)for(const key of ['headers','proxyUrl','proxyToken','modelInfo','compat'])delete next[key];
      return next;
    };
    data.providers=[...data.providers.filter(p=>p.id!==id),{...update(record),id}];
    data.profiles=data.profiles.map(p=>related(p)?update(p):p);
  }else{
    data.profiles=data.profiles.map(p=>p.id===id?{...change.values,id,profileId:id}:p);
  }
  if(data.config)data.config=data.profiles.find(p=>p.id===data.config.profileId) || null;
  return {data,affected:affected.map(p=>p.id)};
}
