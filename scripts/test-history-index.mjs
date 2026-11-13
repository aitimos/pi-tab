import {chromium} from 'playwright';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {resolve,join} from 'node:path';
const output=resolve(process.env.PI_TAB_EVIDENCE||'../evidence');await mkdir(output,{recursive:true});
const runtime=await readFile('dist/pi-console.js','utf8');
const compiled=await build({stdin:{contents:"export {HistoryIndex} from './src/history-index.js';",resolveDir:process.cwd()},bundle:true,format:'iife',globalName:'HistoryTest',write:false});
const code=compiled.outputFiles[0].text;
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<title>History index verification</title><script>globalThis.__piTabDeferredInstall=true;</script><script>'+runtime+'</script><script>'+code+'</script>');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({headless:true,executablePath:process.env.PI_TAB_TEST_CHROME||chromium.executablePath()}),page=await browser.newPage();
try{
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const evidence=await page.evaluate(async()=>{
    const check=(condition,message)=>{if(!condition)throw Error(message);};
    const pi=PiConsolePlugin.install({storageName:'pi-tab-site-cold.example',globalName:'source',deferResume:true,log:false});
    await pi.ready;const chats=await pi.listChats();await pi.dispose();
    const directory=await PiConsolePlugin.readSourceDirectory('cold.example');check(directory.length===chats.length,'real cold directory missing');
    const factory=indexedDB;
    const future=factory.open('pi-tab-site-future.example',2);await new Promise((r,j)=>{future.onsuccess=r;future.onerror=j;});future.result.close();
    let versionRejected=false;try{await PiConsolePlugin.readSourceDirectory('future.example');}catch(error){versionRejected=error.message==='HISTORY_SOURCE_VERSION';}check(versionRejected,'future source accepted');
    const before=(await factory.databases()).length;
    let missingRejected=false;try{await PiConsolePlugin.readSourceDirectory('missing.example');}catch{missingRejected=true;}check(missingRejected,'missing source accepted');check((await factory.databases()).length===before,'missing source created');
    const race=factory.open('pi-tab-site-race.example',1);await new Promise((r,j)=>{race.onsuccess=r;race.onerror=j;});race.result.close();
    const deletingFactory={databases:async()=>{const snapshot=await factory.databases();await new Promise((r,j)=>{const deletion=factory.deleteDatabase('pi-tab-site-race.example');deletion.onsuccess=r;deletion.onerror=j;});return snapshot;},open:(...args)=>factory.open(...args)};
    let raceRejected=false;try{await PiConsolePlugin.readSourceDirectory('race.example',deletingFactory);}catch{raceRejected=true;}
    check(raceRejected,'source deletion race accepted');check(!(await factory.databases()).some(db=>db.name==='pi-tab-site-race.example'),'deleted source recreated');
    const index=new HistoryTest.HistoryIndex({readSource:site=>PiConsolePlugin.readSourceDirectory(site),activeSource:async()=>null});
    await index.rebuild();let listed=await index.list();check(listed.rows.length===directory.length,'index source mismatch');check(listed.sourceErrors.some(error=>error.ownerSite==='future.example'),'future source error absent');
    await index.replace('other.example',[{id:directory[0].id,title:'collision'}]);listed=await index.list();check(listed.rows.length===directory.length+1,'numeric identity collision');
    await index.replace('cold.example',[]);listed=await index.list();check(listed.rows.every(row=>row.ref.ownerSite!=='cold.example'),'partition delete failed');
    const original=index.database.transaction.bind(index.database);
    index.database.transaction=(...args)=>{const tx=original(...args);if(args[1]==='readwrite')tx.objectStore('rows').put=()=>{throw new DOMException('quota fixture','QuotaExceededError');};return tx;};
    let quotaRejected=false;try{await index.replace('other.example',[{id:2,title:'must not partially save'}]);}catch{quotaRejected=true;}
    index.database.transaction=original;check(quotaRejected,'quota failure accepted');
    check((await index.list()).rows.some(row=>row.ref.ownerSite==='other.example'&&row.ref.conversationId===directory[0].id),'failed transaction lost previous partition');
    await index.reset();
    const sources=Array.from({length:100},(_,i)=>({name:`pi-tab-site-source-${i}.example`,version:1}));
    const fakeFactory={databases:async()=>sources,open:(...args)=>factory.open(...args),deleteDatabase:name=>factory.deleteDatabase(name)};
    let active=0,peak=0;
    const large=new HistoryTest.HistoryIndex({factory:fakeFactory,activeSource:async()=>null,readSource:async site=>{active++;peak=Math.max(peak,active);await Promise.resolve();active--;return Array.from({length:100},(_,i)=>({id:i+1,title:`Task ${site} ${i}`}));}});
    const started=performance.now();await large.rebuild();const duration=performance.now()-started;
    let rows=[],cursor=null;do{const next=await large.list({cursor,limit:100});rows.push(...next.rows);cursor=next.nextCursor;}while(cursor);
    check(rows.length===10000,'large directory pagination missing rows');check(peak===1,'source readers not serial');check(rows.every(row=>Object.keys(row).sort().join(',')==='key,ref,title,version'),'index stored extra data');
    const controller=new AbortController();controller.abort();let cancelled=false;try{await large.rebuild({signal:controller.signal});}catch{cancelled=true;}check(cancelled,'scan cancellation ignored');
    await large.reset();
    return {realColdRows:directory.length,versionRejected,missingRejected,raceRejected,quotaRejected,large:{sources:100,rows:rows.length,durationMs:duration,peakReaders:peak},cancelled};
  });
  assert.equal(evidence.large.rows,10000);await writeFile(join(output,'history-index.json'),JSON.stringify(evidence,null,2));console.log(JSON.stringify(evidence));
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
