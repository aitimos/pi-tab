import {Lexer} from 'marked';

// Parse Markdown with Marked; build only the formatting elements we support.
// Raw HTML stays text, so replies cannot inject scripts, controls, or page styles.
export function renderMarkdown(text) {
  const fragment=document.createDocumentFragment();
  const decoder=document.createElement('textarea');
  const decode=text=>text.replace(/&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/gi,entity=>{decoder.innerHTML=entity;return decoder.value;});
  function append(parent,tokens) {
    for(const token of tokens) {
      let node;
      switch(token.type) {
        case 'space': continue;
        case 'checkbox': parent.append(token.checked?'☑ ':'☐ ');continue;
        case 'heading': node=document.createElement(`h${token.depth}`);break;
        case 'paragraph': node=document.createElement('p');break;
        case 'strong': node=document.createElement('strong');break;
        case 'em': node=document.createElement('em');break;
        case 'del': node=document.createElement('del');break;
        case 'blockquote': node=document.createElement('blockquote');break;
        case 'br': node=document.createElement('br');break;
        case 'hr': node=document.createElement('hr');break;
        case 'code': {
          node=document.createElement('pre');
          const code=document.createElement('code');code.textContent=token.text;node.append(code);break;
        }
        case 'codespan': node=document.createElement('code');node.textContent=token.text;break;
        case 'list':
          node=document.createElement(token.ordered?'ol':'ul');
          if(token.ordered)node.start=token.start;
          for(const item of token.items){const li=document.createElement('li');append(li,item.tokens);node.append(li);}break;
        case 'table': {
          node=document.createElement('table');
          const head=document.createElement('thead'),body=document.createElement('tbody');
          for(const [index,cells] of [token.header,...token.rows].entries()){
            const row=document.createElement('tr');
            cells.forEach((cell,i)=>{const element=document.createElement(index===0?'th':'td');if(token.align[i])element.style.textAlign=token.align[i];append(element,cell.tokens);row.append(element);});
            (index===0?head:body).append(row);
          }
          node.append(head,body);break;
        }
        case 'link': case 'image': {
          node=document.createElement('span');
          const href=decode(token.href).trim();
          // Keep explicit web/mail links; relative model-invented URLs stay text.
          if(/^(https?:\/\/|mailto:)/i.test(href)){
            node=document.createElement('a');node.href=href;node.target='_blank';node.rel='noopener noreferrer';
            if(token.title)node.title=decode(token.title);
          }
          if(token.type==='image')node.textContent=decode(token.text) || href;
          break;
        }
        case 'text':
          if(token.tokens){append(parent,token.tokens);continue;}
          parent.append(document.createTextNode(decode(token.text)));continue;
        default: parent.append(document.createTextNode(token.text ?? token.raw ?? ''));continue;
      }
      if(token.tokens && !['list','table'].includes(token.type))append(node,token.tokens);
      parent.append(node);
    }
  }
  append(fragment,Lexer.lex(text,{gfm:true,breaks:true}));
  return fragment;
}
