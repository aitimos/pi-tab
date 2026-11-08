// Durable conversation IDs are local to their source database.
export function conversationRef(ownerSite, conversationId) {
  if (typeof ownerSite !== 'string' || ownerSite !== ownerSite.toLowerCase() || !/^[a-z0-9.[\]:-]+$/.test(ownerSite) || new URL(`https://${ownerSite}`).hostname !== ownerSite || !Number.isSafeInteger(conversationId) || conversationId < 1) throw Error('INVALID_CONVERSATION_REF');
  return {ownerSite, conversationId};
}
export function refKey(ref) {
  const value = conversationRef(ref?.ownerSite, ref?.conversationId);
  return JSON.stringify([value.ownerSite, value.conversationId]);
}
export function parseRef(key) {
  const [ownerSite, conversationId] = JSON.parse(key);
  return conversationRef(ownerSite, conversationId);
}
export function serialQueue() {
  const queues = new Map();
  return (key, work) => {
    const next = (queues.get(key) || Promise.resolve()).catch(() => {}).then(work);
    queues.set(key, next);
    void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
    return next;
  };
}
