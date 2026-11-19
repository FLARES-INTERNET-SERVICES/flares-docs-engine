/*
 * Copyright (c) 2026 Casual Office. All rights reserved.
 */

import { describe, test, expect } from 'bun:test';
import * as Y from 'yjs';
import type { Comment } from '@eigenpal/docx-core/types/content';
import { commentsFromMap, writeCommentsToMap, observeComments } from './commentSync';

function comment(id: number, text: string, extra: Partial<Comment> = {}): Comment {
  return {
    id,
    author: 'A',
    content: [{ type: 'paragraph', content: [{ type: 'run', content: [{ type: 'text', text }] }] }],
    ...extra,
  };
}

const sync = (from: Y.Doc, to: Y.Doc) => Y.applyUpdate(to, Y.encodeStateAsUpdate(from));

describe('commentSync (collab transport)', () => {
  test('a stale rendered snapshot preserves remote additions and edits', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('comments');
    const rendered = [comment(1, 'original')];
    writeCommentsToMap(map, rendered);
    writeCommentsToMap(map, [
      comment(1, 'remote edit'),
      comment(2, 'remote reply', { parentId: 1 }),
    ]);
    writeCommentsToMap(map, [...rendered, comment(3, 'local reply', { parentId: 1 })], rendered);
    expect(commentsFromMap(map)).toEqual([
      comment(1, 'remote edit'),
      comment(2, 'remote reply', { parentId: 1 }),
      comment(3, 'local reply', { parentId: 1 }),
    ]);
    doc.destroy();
  });

  test('unchanged stale comments do not resurrect remotely deleted comments', () => {
    const doc = new Y.Doc();
    const map = doc.getMap('comments');
    const rendered = [comment(1, 'deleted remotely'), comment(2, 'kept')];
    writeCommentsToMap(map, rendered);
    map.delete('1');
    writeCommentsToMap(map, [...rendered, comment(3, 'new')], rendered);
    expect(commentsFromMap(map).map((c) => c.id)).toEqual([2, 3]);
    // Explicit local removals still apply without deleting unseen remote additions.
    writeCommentsToMap(map, [], [comment(2, 'kept')]);
    expect(commentsFromMap(map).map((c) => c.id)).toEqual([3]);
    doc.destroy();
  });

  test('add, reply, resolve, delete all propagate to a peer', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    const mapA = docA.getMap('comments');
    const mapB = docB.getMap('comments');

    let latestB: Comment[] = [];
    const unsub = observeComments(mapB, (c) => (latestB = c));

    // A adds a comment
    writeCommentsToMap(mapA, [comment(1, 'first comment')]);
    sync(docA, docB);
    expect(latestB.map((c) => c.id)).toEqual([1]);
    expect(latestB[0].content[0].content[0]).toMatchObject({ type: 'run' });

    // A adds a reply (separate comment with parentId)
    writeCommentsToMap(mapA, [comment(1, 'first comment'), comment(2, 'a reply', { parentId: 1 })]);
    sync(docA, docB);
    expect(latestB.map((c) => c.id)).toEqual([1, 2]);
    expect(latestB.find((c) => c.id === 2)?.parentId).toBe(1);

    // A resolves the thread
    writeCommentsToMap(mapA, [
      comment(1, 'first comment', { done: true }),
      comment(2, 'a reply', { parentId: 1 }),
    ]);
    sync(docA, docB);
    expect(latestB.find((c) => c.id === 1)?.done).toBe(true);

    // A deletes the reply
    writeCommentsToMap(mapA, [comment(1, 'first comment', { done: true })]);
    sync(docA, docB);
    expect(latestB.map((c) => c.id)).toEqual([1]);

    unsub();
    docA.destroy();
    docB.destroy();
  });

  test('concurrent adds from two peers merge (different keys)', () => {
    const docA = new Y.Doc();
    const docB = new Y.Doc();
    // each peer adds its own comment independently, then they exchange state
    writeCommentsToMap(docA.getMap('comments'), [comment(1, 'from A')]);
    writeCommentsToMap(docB.getMap('comments'), [comment(2, 'from B')]);
    sync(docA, docB);
    sync(docB, docA);
    expect(commentsFromMap(docA.getMap('comments')).map((c) => c.id)).toEqual([1, 2]);
    expect(commentsFromMap(docB.getMap('comments')).map((c) => c.id)).toEqual([1, 2]);
    docA.destroy();
    docB.destroy();
  });
});
