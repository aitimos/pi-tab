// Pi Durable accepts native text/image content for prompts and queued inputs.
export function normalizeUserContent(value, model) {
  if (typeof value === 'string') {
    if (!value.trim()) throw new TypeError('请输入消息内容。');
    return value;
  }
  if (!Array.isArray(value) || !value.length) throw new TypeError('消息内容不能为空。');
  return value.map(part => {
    if (part?.type === 'text' && typeof part.text === 'string') return {type:'text',text:part.text};
    if (part?.type !== 'image' || !['image/png','image/jpeg','image/webp','image/gif'].includes(part.mimeType) || typeof part.data !== 'string' || !part.data.length) throw new TypeError('附件格式不受支持。');
    if (!model.input.includes('image')) throw new Error('当前模型不支持图片，请切换支持图片的模型。');
    return {type:'image',mimeType:part.mimeType,data:part.data};
  });
}

export function userContentText(content) {
  return typeof content === 'string' ? content : content.find(part => part.type === 'text')?.text || '图片';
}

export function editUserContent(content, text) {
  if (typeof content === 'string') return text;
  const index = content.findIndex(part => part.type === 'text');
  return index < 0 ? [{type:'text',text},...content] : content.map((part,i) => i === index ? {type:'text',text} : part);
}
