import {defineTool} from '@earendil-works/pi-durable';
import {createBashTool,createReadTool,createEditTool} from '@earendil-works/pi-durable/tools';
import {getOrThrow} from '@earendil-works/pi-durable/env';
import {Type} from 'typebox';
import picomatch from 'picomatch';

export function createLinuxTools() {
  const bash=createBashTool();
  return [
    {...bash,description:bash.description.replace('Execute a bash command','Execute a BusyBox /bin/sh command (not GNU Bash)')+' Files exist only in this conversation’s temporary Linux; cwd is /workspace for every call.'},
    createReadTool(),
    {...createEditTool(),prepareArguments:undefined},
    defineTool({
      name:'grep',
      description:'Search this conversation’s Linux files with BusyBox grep. Supports POSIX extended regex or literal matching, glob filtering, case folding and context lines. Returns paths and line numbers. Does not apply .gitignore or support ripgrep-specific syntax. Defaults to /workspace, 100 matches and 50 KiB of output. Directory symlinks are not traversed.',
      parameters:Type.Object({
        pattern:Type.String(),path:Type.Optional(Type.String()),glob:Type.Optional(Type.String()),
        ignoreCase:Type.Optional(Type.Boolean()),literal:Type.Optional(Type.Boolean()),
        context:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1})),
      }),
      outputLimits:{maxBytes:51200,maxLines:Number.MAX_SAFE_INTEGER,retain:'head'},
      async execute({pattern,path='.',glob,ignoreCase=false,literal=false,context:around=0,limit=100},api,context) {
        const env=api.env;
        const root=getOrThrow(await env.absolutePath(path,context));
        const info=getOrThrow(await env.fileInfo(root,context));
        // BusyBox only compiles regex on nonempty input. Validate once even
        // when all candidate files are empty or the glob selects no files.
        if(!literal) {
          let error='';
          const result=getOrThrow(await env.exec(['/bin/grep','-E','--',pattern,'/proc/version'],{onOutput:(text,_ctx,{stream})=>{if(stream==='stderr')error+=text;}},context));
          if(result.exitCode>1)throw new Error(error.trim()||'Invalid regular expression');
        }
        const matches=glob?picomatch(glob,{dot:true,windows:false,basename:!glob.includes('/')}):()=>true;
        const pending=[info];let count=0,shortened=false;
        while(pending.length && count<limit) {
          context.abortSignal?.throwIfAborted();
          const entry=pending.pop();
          if(entry.kind==='directory') {
            const children=getOrThrow(await env.listDir(entry.path,context));
            pending.push(...children.sort((a,b)=>a.path<b.path?1:a.path>b.path?-1:0));
            continue;
          }
          if(entry.kind!=='file' && entry.path!==root)continue;
          const relative=info.kind==='directory'?entry.path.slice(root.replace(/\/$/,'').length+1):entry.name;
          if(!matches(relative))continue;
          const argv=['/bin/grep','-n','-I',literal?'-F':'-E','-m',String(limit-count)];
          if(ignoreCase)argv.push('-i');
          if(around)argv.push('-C',String(around));
          argv.push('--',pattern,entry.path);
          let buffer='',stderr='';
          const line=text=>{
            const match=/^(\d+)([:-])(.*)$/.exec(text.replace(/\r$/,''));
            if(!match)return;
            if(match[2]===':')count++;
            const content=match[3].length>500?match[3].slice(0,500)+'…':match[3];
            shortened ||= match[3].length>500;
            const delimiter=match[2];
            api.output(`${relative}${delimiter}${match[1]}${delimiter} ${content}\n`);
          };
          const result=getOrThrow(await env.exec(argv,{onOutput:(text,_ctx,{stream})=>{
            if(stream==='stderr'){stderr+=text;return;}
            // Keep only the displayed prefix, even when a file has a huge line.
            let start=0,newline;
            while((newline=text.indexOf('\n',start))>=0) {
              buffer=(buffer+text.slice(start,newline)).slice(0,550);
              line(buffer);buffer='';start=newline+1;
            }
            buffer=(buffer+text.slice(start)).slice(0,550);
          }},context));
          if(buffer)line(buffer);
          if(result.exitCode>1)throw new Error(stderr.trim()||`grep exited with code ${result.exitCode}`);
        }
        if(!count)api.output('No matches found');
        const diagnostics=[];
        if(count>=limit)diagnostics.push({severity:'info',code:'match_limit',message:`达到 ${limit} 条匹配上限；可增大 limit 或缩小搜索范围。`});
        if(shortened)diagnostics.push({severity:'info',code:'line_limit',message:'长行只显示前 500 个字符；使用 read 查看全文。'});
        return {diagnostics};
      },
    }),
  ].map(tool=>({...tool,replay:'unsafe',executionMode:'sequential'}));
}
