// Browser storage is origin-scoped; tab/session IDs never participate in this key.
export class SiteSettings {
  constructor(storage, key) { this.storage = storage; this.key = key; }
  read() {
    return JSON.parse(this.storage.getItem(this.key)) ?? { config:null, profiles:[], providers:[], preferences:{} };
  }
  update(change) {
    const data = this.read();
    change(data);
    this.storage.setItem(this.key, JSON.stringify(data));
    return data;
  }
  initialize(previous) {
    if (this.storage.getItem(this.key) !== null) return;
    const {config=null, profiles=[], providers=[], preferences={}} = previous ?? {};
    this.storage.setItem(this.key, JSON.stringify({config, profiles, providers, preferences}));
  }
}
