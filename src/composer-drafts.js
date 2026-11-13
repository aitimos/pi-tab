const copy = ({text = '', attachments = []} = {}) => ({text, attachments:[...attachments]});
const hasContent = draft => draft.text !== '' || draft.attachments.length > 0;

// One store per window; editing, in-flight submissions and retained drafts have
// separate ownership within each conversation. Nothing here submits a message.
export class ComposerDrafts {
  #conversations = new Map();
  #nextId = 0;
  #row(ref) {
    if (!this.#conversations.has(ref)) this.#conversations.set(ref, {current:copy(), pending:new Map(), retained:[]});
    return this.#conversations.get(ref);
  }
  save(ref, draft) { this.#row(ref).current = copy(draft); }
  current(ref) { return copy(this.#row(ref).current); }
  begin(ref, draft) {
    const row = this.#row(ref), id = ++this.#nextId;
    row.pending.set(id, copy(draft));
    row.current = copy();
    return {ref, id};
  }
  reject({ref, id}) {
    const row = this.#row(ref), draft = row.pending.get(id);
    if (!draft) return;
    row.pending.delete(id);
    if (hasContent(row.current)) row.retained.push({id, draft});
    else row.current = draft;
  }
  finish({ref, id}) { this.#row(ref).pending.delete(id); }
  retained(ref) { return this.#row(ref).retained.map(({id, draft}) => ({id, ...copy(draft)})); }
  restore(ref, id) {
    const row = this.#row(ref), index = row.retained.findIndex(item => item.id === id);
    if (index < 0) return false;
    const [{draft}] = row.retained.splice(index, 1);
    if (hasContent(row.current)) row.retained.push({id:++this.#nextId, draft:row.current});
    row.current = draft;
    return true;
  }
}
