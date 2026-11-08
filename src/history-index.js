import {conversationRef, refKey, serialQueue} from './conversation-ref.js';

const result = request => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});
const complete = tx => new Promise((resolve, reject) => {
  tx.oncomplete = resolve;
  tx.onabort = tx.onerror = () => reject(tx.error || Error('HISTORY_INDEX_UNAVAILABLE'));
});

export class HistoryIndex {
  constructor({factory = globalThis.indexedDB, locks = globalThis.navigator?.locks, readSource, activeSource} = {}) {
    Object.assign(this, {factory, locks, readSource, activeSource});
    this.serial = serialQueue();
    this.sourceErrors = [];
    this.scanComplete = false;
  }
  async open() {
    if (this.database) return this.database;
    if(this.opening)return this.opening;
    this.opening=(async()=>{
      const request = this.factory.open('pi-tab-history-index', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('rows', {keyPath:'key'}).createIndex('owner', 'ref.ownerSite');
      const db = await result(request);
      db.onversionchange = () => { db.close(); if(this.database===db)this.database = null; };
      return this.database = db;
    })().finally(()=>{this.opening=null;});
    return this.opening;
  }
  async reset() {
    const info=(await this.factory.databases()).find(db=>db.name==='pi-tab-history-index');
    if(info&&info.version!==1)throw Error('HISTORY_INDEX_VERSION');
    if(this.opening)await this.opening;
    this.database?.close();this.database=null;
    await result(this.factory.deleteDatabase('pi-tab-history-index'));
    this.scanComplete=false;
  }

  async replace(ownerSite, chats) {
    const prepared=chats.map(chat=>{const ref=conversationRef(ownerSite,chat.id);return {key:refKey(ref),version:1,ref,title:String(chat.title||'新对话')};});
    const db = await this.open(), tx = db.transaction('rows', 'readwrite'), done = complete(tx), store = tx.objectStore('rows');
    const cursor = store.index('owner').openCursor(IDBKeyRange.only(ownerSite));
    cursor.onsuccess = () => {
      const item = cursor.result;
      if (item) { item.delete(); item.continue(); return; }
      try { for (const row of prepared)store.put(row); }
      catch {tx.abort();}
    };
    await done;
  }
  reconcile(ownerSite) {
    return this.serial(ownerSite, async () => {
      const active = await this.activeSource(ownerSite);
      if (active) return this.replace(ownerSite, await active.listChats());
      if (!this.locks) throw Error('HISTORY_LOCK_UNAVAILABLE');
      return this.locks.request(`pi-tab:pi-tab-site-${ownerSite}`, {ifAvailable:true}, async lock => {
        if (!lock) throw Error('HISTORY_SOURCE_BUSY');
        await this.replace(ownerSite, await this.readSource(ownerSite));
      });
    });
  }
  async rebuild({signal} = {}) {
    this.scanComplete = false;
    this.sourceErrors = [];
    const databases = await this.factory.databases();
    const sources = databases.filter(item => item.name?.startsWith('pi-tab-site-')).map(item => item.name.slice(12)).sort();
    for (const owner of sources) {
      signal?.throwIfAborted();
      try { conversationRef(owner, 1); await this.reconcile(owner); }
      catch (error) { this.sourceErrors.push({ownerSite:owner, code:error.name === 'VersionError' ? 'HISTORY_SOURCE_VERSION' : error.message}); }
    }
    // Confirm disappearance against a fresh snapshot before discarding a partition.
    const existing = new Set((await this.factory.databases()).map(item => item.name));
    const db = await this.open(), tx = db.transaction('rows'), rows = await result(tx.objectStore('rows').getAll());
    for (const owner of new Set(rows.map(row => row.ref.ownerSite))) if (!existing.has(`pi-tab-site-${owner}`)) await this.serial(owner, () => this.replace(owner, []));
    this.scanComplete = true;
  }
  async list({cursor, limit = 50} = {}) {
    limit = Math.min(100, Math.max(1, Number(limit) || 50));
    const db = await this.open(), tx = db.transaction('rows');
    const rows = await new Promise((resolve, reject) => {
      const values = [], request = tx.objectStore('rows').openCursor(cursor ? IDBKeyRange.lowerBound(cursor, true) : null);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const item = request.result;
        if (!item || values.length > limit) { resolve(values); return; }
        values.push(item.value); item.continue();
      };
    });
    return {rows:rows.slice(0, limit), nextCursor:rows.length > limit ? rows[limit - 1].key : null, scanComplete:this.scanComplete, sourceErrors:this.sourceErrors};
  }
}
