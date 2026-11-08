export class StorageInUse extends Error {
  constructor() { super('这段历史正在另一标签页使用，请返回原页或稍后重试。'); this.code = 'STORAGE_IN_USE_RETRY'; }
}

// The timer bounds acquisition only. The lock stays held until close finishes.
export function acquireStorage(locks, name, open, {ifAvailable = false, timeout = 1500} = {}) {
  if (!locks) return Promise.reject(Object.assign(Error('浏览器不支持历史独占锁，请使用扩展，或显式新建独立对话。'), {code:'STORAGE_LOCK_UNAVAILABLE'}));
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    const timer = ifAvailable ? null : setTimeout(() => controller.abort(new StorageInUse()), timeout);
    let release;
    const held = new Promise(done => { release = done; });
    const request = locks.request(`pi-tab:${name}`, ifAvailable ? {ifAvailable:true} : {signal:controller.signal}, async lock => {
      clearTimeout(timer);
      if (!lock) { resolve(null); return; }
      const value = await open(name);
      resolve({value, release, done:request});
      await held;
    });
    void request.catch(error => { clearTimeout(timer); reject(controller.signal.aborted ? controller.signal.reason : error); });
  });
}
