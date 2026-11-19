type Comment = { id: number; parentId?: unknown };
export type CommentActivity = { id: string; kind: 'comment' | 'reply' };

/** Only local additions, never imports, remote updates, edits or resolves. */
export function addedComments(next: Comment[], previous: Comment[], sharedIds: Set<string>): CommentActivity[] {
  const known = new Set(previous.map((c) => String(c.id)));
  return next.filter((c) => !known.has(String(c.id)) && !sharedIds.has(String(c.id)))
    .map((c) => ({ id: String(c.id), kind: c.parentId != null ? 'reply' : 'comment' }));
}

export class CommentActivityOutbox {
  private pending = new Map<string, CommentActivity>();
  constructor(private storage: Pick<Storage, 'getItem' | 'setItem'> | undefined, private key: string) {
    try {
      const saved = JSON.parse(storage?.getItem(key) || '[]');
      if (Array.isArray(saved)) for (const event of saved) {
        if (/^[0-9]{1,16}$/.test(event?.id) && ['comment', 'reply'].includes(event?.kind)) this.pending.set(event.id, event);
      }
    } catch { /* Storage is optional; the current tab still retries. */ }
  }
  add(events: CommentActivity[]) { for (const event of events) this.pending.set(event.id, event); this.save(); }
  acknowledge(id: string) { this.pending.delete(id); this.save(); }
  events() { return [...this.pending.values()]; }
  private save() { try { this.storage?.setItem(this.key, JSON.stringify(this.events())); } catch { /* Keep memory queue. */ } }
}
