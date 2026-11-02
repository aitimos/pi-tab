const encoder=new TextEncoder();
const help=`curl (Pi Tab fetch adapter)
Usage: curl [options] URL
  -X, --request METHOD       HTTP method
  -H, --header 'Name: value' Request header (repeatable)
  -d, --data DATA            POST data; @file or @- reads Linux file/stdin
      --data-raw DATA        POST literal data, including leading @
      --data-binary DATA     POST bytes; @file or @- reads Linux file/stdin
      --json DATA            JSON body with JSON Content-Type and Accept
  -I, --head                 HEAD request
  -i, --include              Include response headers
  -o, --output FILE          Save response in Linux (default stdout; - means stdout)
  -L, --location             Follow redirects using fetch
  -f, --fail                 Exit 22 for HTTP 400+ without response body
      --fail-with-body      Exit 22 for HTTP 400+, keep response body
  -s, --silent              Suppress errors (no progress meter is provided)
  -S, --show-error          Show errors even with -s
  -m, --max-time SECONDS     Maximum request duration
  -u, --user USER:PASSWORD   HTTP Basic authentication
      --url URL             Request URL (one URL per command)
  -h, --help; -V, --version
HTTP(S) only. Browser fetch controls TLS, restricted headers and decompression.
No proxy, -k, cookie jar, environment proxy settings, or native curl compatibility.
Browser cookies are omitted. Redirect responses require -L because fetch hides
their headers/status in manual mode. Uploads are buffered; downloads are streamed.
`;

export function parseCurl(argv) {
  const options={headers:new Headers(),data:[],include:false,head:false,location:false,silent:false,showError:false};
  const values=new Map(Object.entries({X:'method',request:'method',H:'header',header:'header',d:'data',data:'data','data-raw':'data-raw','data-binary':'data-binary',json:'json',o:'output',output:'output',m:'timeout','max-time':'timeout',u:'user',user:'user',url:'url'}));
  const flags=new Map(Object.entries({I:'head',head:'head',i:'include',include:'include',L:'location',location:'location',f:'fail',fail:'fail','fail-with-body':'failWithBody',s:'silent',silent:'silent',S:'showError','show-error':'showError',h:'help',help:'help',V:'version',version:'version'}));
  const urls=[];
  let positional=false;
  for(let i=0;i<argv.length;i++) {
    const arg=argv[i];
    if(positional || !arg.startsWith('-') || arg==='-') { urls.push(arg);continue; }
    if(arg==='--') { positional=true;continue; }
    const long=arg.startsWith('--');
    const equal=long?arg.indexOf('='):-1;
    const names=long?[arg.slice(2,equal<0?undefined:equal)]:[...arg.slice(1)];
    for(let j=0;j<names.length;j++) {
      const name=names[j];
      if(flags.has(name)) {
        if(equal>=0)throw new Error(`option --${name} does not take a value`);
        options[flags.get(name)]=true;continue;
      }
      if(!values.has(name))throw new Error(`unsupported option: ${long?'--':'-'}${name}; use curl --help`);
      const value=equal>=0?arg.slice(equal+1):!long&&j+1<names.length?names.slice(j+1).join(''):argv[++i];
      if(value===undefined)throw new Error(`option ${name} requires a value`);
      const key=values.get(name);
      if(key==='header') {
        const at=value.indexOf(':');
        if(at<1)throw new Error('headers must use Name: value');
        const header=value.slice(0,at).trim();
        // Fetch silently drops these. Report the unsupported behavior instead.
        if(/^(cookie2?|host|content-length|connection|transfer-encoding|origin|referer|accept-encoding|accept-charset|user-agent|date|dnt|expect|keep-alive|te|trailer|upgrade|permissions-policy|set-cookie|access-control-request-.*|proxy-.*|sec-.*)$/i.test(header))throw new Error(`fetch controls the ${header} header`);
        options.headers.append(header,value.slice(at+1).trim());
      } else if(['data','data-raw','data-binary','json'].includes(key))options.data.push({kind:key,value});
      else if(key==='url')urls.push(value);
      else options[key]=value;
      break;
    }
  }
  if(options.help || options.version)return options;
  if(urls.length!==1)throw new Error('exactly one HTTP(S) URL is required');
  options.url=new URL(urls[0]);
  if(!['http:','https:'].includes(options.url.protocol))throw new Error('only HTTP(S) URLs are supported');
  if(options.url.username || options.url.password)throw new Error('use -u for Basic authentication');
  if(options.timeout!==undefined) {
    options.timeout=Number(options.timeout);
    if(!Number.isFinite(options.timeout) || options.timeout<0 || options.timeout>2147483)throw new Error('invalid --max-time');
  }
  if(options.head && options.data.length)throw new Error('HEAD and request data cannot be combined');
  if(options.method!==undefined && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(options.method))throw new Error('invalid HTTP method');
  if(options.fail && options.failWithBody)throw new Error('--fail and --fail-with-body cannot be combined');
  return options;
}

export async function runCurl(call, fetchRequest=fetch) {
  let options, timer, outputFd, reader, timeout=false, exitCode=2;
  const controller=new AbortController();
  call.ioSignal=controller.signal;
  const abort=()=>controller.abort(call.signal.reason);
  call.signal.addEventListener('abort',abort,{once:true});
  try {
    call.signal.throwIfAborted();
    options=parseCurl(call.argv);
    if(options.help || options.version) {
      await call.stdout(encoder.encode(options.help?help:'curl Pi Tab fetch adapter (HTTP/HTTPS, not libcurl)\n'));
      return {exitCode:0};
    }
    if(options.timeout>0)timer=setTimeout(()=>{timeout=true;controller.abort(new Error('request timed out'));},options.timeout*1000);
    const body=[];
    let json=false;
    for(const [index,{kind,value}] of options.data.entries()) {
      if(index && kind!=='json')body.push(encoder.encode('&'));
      json ||= kind==='json';
      if(kind!=='data-raw' && value.startsWith('@')) {
        exitCode=26;
        const stream=value==='@-'?call.stdin:call.readFile(value.slice(1));
        for await(const bytes of stream) {
          controller.signal.throwIfAborted();
          body.push(kind==='data'?bytes.filter(byte=>byte!==10&&byte!==13&&byte!==0):bytes);
        }
      } else body.push(encoder.encode(value));
    }
    if(options.data.length && !options.headers.has('content-type'))options.headers.set('content-type',json?'application/json':'application/x-www-form-urlencoded');
    if(json && !options.headers.has('accept'))options.headers.set('accept','application/json');
    if(options.user!==undefined) {
      if(!options.user.includes(':'))throw new Error('-u requires USER:PASSWORD (interactive prompts are unavailable)');
      options.headers.set('authorization','Basic '+btoa(Array.from(encoder.encode(options.user),byte=>String.fromCharCode(byte)).join('')));
    }
    exitCode=7;
    const response=await fetchRequest(options.url.href,{
      method:options.method || (options.head?'HEAD':options.data.length?'POST':'GET'),
      headers:options.headers,body:options.data.length?new Blob(body):undefined,
      signal:controller.signal,credentials:'omit',redirect:options.location?'follow':'manual',cache:'no-store',
    });
    if(response.type==='opaqueredirect') {exitCode=47;throw new Error('fetch hides redirect responses; use -L to follow the redirect');}
    if(options.fail && response.status>=400) {exitCode=22;throw new Error(`HTTP ${response.status}`);}
    exitCode=23;
    if(options.output!==undefined && options.output!=='-')outputFd=await call.open(options.output,true);
    const output=bytes=>outputFd===undefined?call.stdout(bytes):call.write(outputFd,bytes);
    if(options.include || options.head) {
      // Fetch does not expose the wire protocol version or raw header ordering.
      const headers=`HTTP ${response.status}${response.statusText?' '+response.statusText:''}\r\n${[...response.headers].map(([key,value])=>`${key}: ${value}\r\n`).join('')}\r\n`;
      await output(encoder.encode(headers));
    }
    if(!options.head && response.body) {
      reader=response.body.getReader();
      while(true) {
        exitCode=56;
        const chunk=await reader.read();
        if(chunk.done)break;
        exitCode=23;
        await output(chunk.value);
      }
    }
    if(options.failWithBody && response.status>=400) {exitCode=22;throw new Error(`HTTP ${response.status}`);}
    return {exitCode:0};
  } catch(error) {
    call.ioSignal=undefined;
    if(call.signal.aborted)return {exitCode:130};
    if(timeout)exitCode=28;
    if(!options?.silent || options.showError)await call.stderr(encoder.encode(`curl: (${exitCode}) ${error.message}\n`));
    return {exitCode};
  } finally {
    call.ioSignal=undefined;
    clearTimeout(timer);
    controller.abort();
    call.signal.removeEventListener('abort',abort);
    if(reader)await reader.cancel().catch(()=>{});
    if(outputFd!==undefined && !call.signal.aborted)await call.io(4,outputFd);
  }
}
