import { describe, expect, test } from 'bun:test';
import { addedComments, CommentActivityOutbox } from './commentActivity';

describe('comment activity', () => {
  test('announces local new comments and replies, including a reply to comment zero', () => {
    expect(addedComments([{ id: 1 }, { id: 2, parentId: 0 }], [], new Set())).toEqual([
      { id: '1', kind: 'comment' }, { id: '2', kind: 'reply' },
    ]);
  });
  test('does not reannounce existing, reopened or remotely received comments', () => {
    expect(addedComments([{ id: 1 }, { id: 2 }], [{ id: 1 }], new Set(['2']))).toEqual([]);
  });
  test('retries across reopening, deduplicates, and removes acknowledged events', () => {
    const data = new Map<string, string>();
    const storage = { getItem: (k: string) => data.get(k) || null, setItem: (k: string, v: string) => { data.set(k, v); } };
    const first = new CommentActivityOutbox(storage, 'room:actor');
    first.add([{ id: '3', kind: 'reply' }, { id: '3', kind: 'reply' }]);
    const reopened = new CommentActivityOutbox(storage, 'room:actor');
    expect(reopened.events()).toEqual([{ id: '3', kind: 'reply' }]);
    expect(new CommentActivityOutbox(storage, 'room:other-actor').events()).toEqual([]);
    reopened.acknowledge('3');
    expect(new CommentActivityOutbox(storage, 'room:actor').events()).toEqual([]);
  });
  test('storage failures leave in-memory delivery working', () => {
    const outbox = new CommentActivityOutbox({ getItem() { throw new Error(); }, setItem() { throw new Error(); } }, 'room');
    outbox.add([{ id: '4', kind: 'comment' }]);
    expect(outbox.events()).toHaveLength(1);
    outbox.acknowledge('4');
    expect(outbox.events()).toHaveLength(0);
  });
});
