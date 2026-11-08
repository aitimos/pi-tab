import {refKey, serialQueue} from './conversation-ref.js';

export class Continuations {
  constructor({validateTarget, busy, exists, emit, epoch = crypto.randomUUID()}) {
    Object.assign(this, {validateTarget, busy, exists, emit, epoch});
    this.rows = new Map(); this.serial = serialQueue();
  }
  row(ref) {
    const key = refKey(ref);
    if (!this.rows.has(key)) this.rows.set(key, {ref, seq:0, pending:0, inFlight:0, requests:new Map()});
    return this.rows.get(key);
  }
  version(ref) { return {epoch:this.epoch, seq:this.row(ref).seq}; }
  async state(ref) {
    const row = this.row(ref), target = row.target;
    return {ref, version:this.version(ref), busy:Boolean(row.pending || row.inFlight || row.stopping || await this.busy(ref)),
      target:target ? {tabId:target.tabId, origin:target.origin, url:new URL(target.url).origin + new URL(target.url).pathname} : null};
  }
  async bind(ref, expected, viewId, target) {
    return this.serial(ref.ownerSite, async () => {
      await this.exists(ref); await this.validateTarget(target);
      const row = this.row(ref);
      if (expected?.epoch !== this.epoch || expected.seq !== row.seq) throw Error('BINDING_CONFLICT');
      if ((await this.state(ref)).busy || row.pending || row.inFlight || row.stopping) throw Error('CONVERSATION_BUSY');
      if(expected.seq!==row.seq)throw Error('BINDING_CONFLICT');
      row.seq++; row.target = structuredClone(target); row.viewId = viewId; row.lease = crypto.randomUUID();
      this.emit(ref, {type:'binding_changed',holderViewId:viewId});
      return {...await this.state(ref), leaseToken:row.lease};
    });
  }
  assertLease(row, {target, viewId, leaseToken}) {
    if (!row.target || row.lease !== leaseToken || row.viewId !== viewId || JSON.stringify(row.target) !== JSON.stringify(target)) throw Error('CONTINUE_HERE_REQUIRED');
  }
  async submit(ref, authorization, requestId, work, {queue = false} = {}) {
    let task;
    await this.serial(ref.ownerSite, async () => {
      await this.exists(ref);
      const row = this.row(ref);
      this.assertLease(row, authorization);
      if (row.stopping) throw Error('CONVERSATION_STOPPING');
      await this.validateTarget(row.target);
      if (!requestId) throw Error('RECONNECT_REVIEW_HISTORY');
      if (row.requests.has(requestId)) { task = row.requests.get(requestId); return; }
      if (!queue && (await this.state(ref)).busy) throw Error('CONVERSATION_BUSY');
      this.assertLease(row,authorization);
      if(row.stopping)throw Error('CONVERSATION_STOPPING');
      row.pending++;
      task = Promise.resolve().then(work).finally(() => { row.pending--; });
      row.requests.set(requestId, task);
      // Keep a bounded retry window without evicting pending submissions.
      void task.finally(() => {
        if (row.requests.size > 100) row.requests.delete(row.requests.keys().next().value);
      }).catch(() => {});
    });
    return task;
  }
  async stop(ref, work) {
    let task;
    await this.serial(ref.ownerSite, async () => {
      await this.exists(ref);
      const row = this.row(ref);
      if (row.stopping) { task = row.stopping; return; }
      row.stopping = Promise.resolve().then(work).then(async value => {
        await Promise.allSettled([...row.requests.values()]);
        if (row.inFlight || await this.busy(ref)) throw Error('CONVERSATION_NOT_DRAINED');
        return value;
      }).finally(() => { row.stopping = null; });
      task = row.stopping;
    });
    return task;
  }
  async tool(ref, work) {
    const row = this.row(ref);
    if (!row.target) throw Error('CONTINUE_HERE_REQUIRED');
    const target = structuredClone(row.target);
    row.inFlight++;
    try { await this.validateTarget(target); return await work(target); }
    finally { row.inFlight--; }
  }
  inherit(from, to) {
    const parent = this.row(from), child = this.row(to);
    if (parent.target) { child.target = structuredClone(parent.target); child.seq++; }
  }
  invalidate(tabId, documentId) {
    for (const row of this.rows.values()) if (row.target?.tabId === tabId && (!documentId || row.target.documentId === documentId)) {
      row.target = null; row.lease = null; row.seq++;
      this.emit(row.ref, {type:'target_invalidated'});
    }
  }
  forget(ref) { this.rows.delete(refKey(ref)); }
}
