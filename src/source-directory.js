import {IndexedDbStorage} from '@earendil-works/pi-durable/storage/indexeddb';
import {BACKGROUND_CONTEXT as ctx} from '@earendil-works/chord/context';

export async function readSourceDirectory(ownerSite, factory = indexedDB) {
  const name = `pi-tab-site-${ownerSite}`;
  const existing = (await factory.databases()).find(item => item.name === name);
  if (!existing) throw Error('HISTORY_SOURCE_MISSING');
  if (existing.version !== 1) throw Error('HISTORY_SOURCE_VERSION');
  const storage = await IndexedDbStorage.open(name, {indexedDB:{open(dbName, version) {
    const request = factory.open(dbName, version);
    // Register before the public adapter's listener. Never create/upgrade a source.
    request.addEventListener('upgradeneeded', event => { request.transaction.abort(); event.stopImmediatePropagation(); });
    return request;
  }}});
  try {
    const record = await storage.findDocument({kind:'pi-tab.state', scope:{kind:'session'}}, 'current', ctx);
    if (!record) return [];
    const document = await storage.document(record.id, 'current', ctx);
    if (document?.version !== 1) throw Error('HISTORY_SOURCE_VERSION');
    return (document?.value?.chats || []).map(({id, title}) => ({id, title}));
  } finally { await storage.close(ctx); }
}

export async function inspectRuntime(pi) { return pi.harness.inspect(ctx); }
export async function stopColdRuntime(pi) {
  const before = await inspectRuntime(pi);
  if (before.scheduling !== 'paused') throw Error('RECOVERY_NOT_PAUSED');
  for (const item of before.submissions) if (item.status === 'queued') await pi.harness.abortSubmission(item.id, ctx);
  for (const item of before.tasks) await pi.harness.abortTask(item.record.id, ctx);
  // waitForIdle excludes background tasks in Pi 1.4.0.
  pi.harness.resume();
  await Promise.all(before.tasks.map(item => pi.harness.waitForTask(item.record.id, ctx)));
  const after = await inspectRuntime(pi);
  if (after.tasks.length || after.submissions.length) throw Error('RECOVERY_NOT_DRAINED');
  return before.tasks.length;
}
