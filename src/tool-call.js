import {OutputBuffer} from '@earendil-works/chord/output';
import {validateToolArguments} from '@earendil-works/pi-ai/utils/validation';
import {createId} from './id.js';

/** Console calls use the same streaming/result contract as native Pi tools. */
export async function callTool(tool,args,api,context) {
  const validated=validateToolArguments(tool,{type:'toolCall',id:createId(),name:tool.name,arguments:tool.prepareArguments?.(args)??args});
  context.abortSignal?.throwIfAborted();
  const output=new OutputBuffer({maxBytes:51200,maxLines:2000,retain:'head',...tool.outputLimits});
  const diagnostics=[];
  let details,result;
  try {
    result=await tool.execute(validated,{
      ...api,
      output:(chunk,skipped)=>{output.push(chunk,skipped);api.output?.(chunk,skipped);},
      retainedOutput:()=>{const snapshot=output.snapshot();return {text:snapshot.text,truncated:snapshot.droppedBytes>0};},
      diagnostic:diagnostic=>diagnostics.push(diagnostic),
      details:async value=>{details=value;},
    },context);
  } catch(error) {
    result={isError:true,diagnostics:[{severity:'error',code:'tool_error',message:error.message||String(error)}]};
  }
  output.end();
  const snapshot=output.snapshot();
  if(result.output===undefined && snapshot.droppedBytes>0) diagnostics.push({severity:'info',code:'truncated',message:`输出已截断，省略 ${snapshot.droppedBytes} 字节。`});
  return {
    ...result,
    output:result.output??(snapshot.text?[{type:'text',text:snapshot.text}]:[]),
    ...(result.details===undefined && details!==undefined?{details}:{}),
    diagnostics:[...diagnostics,...(result.diagnostics??[])],
  };
}
