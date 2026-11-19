import { describe, expect, test } from 'bun:test';
import * as Y from 'yjs';
import { createAnnotationIdAllocator } from './annotationIds';
import { commentsFromMap, writeCommentsToMap } from './commentSync';

describe('collaborative annotation allocation', () => {
  test('disconnected peers retain both replies when they exchange updates', () => {
    const a = new Y.Doc();
    const b = new Y.Doc();
    const allocateA = createAnnotationIdAllocator(() => a.clientID);
    const allocateB = createAnnotationIdAllocator(() => b.clientID);
    const idA = allocateA();
    const idB = allocateB();
    expect(idA).not.toBe(idB);
    writeCommentsToMap(a.getMap('comments'), [{ id: idA, author: 'A', parentId: 1, content: [] }]);
    writeCommentsToMap(b.getMap('comments'), [{ id: idB, author: 'B', parentId: 1, content: [] }]);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
    expect(
      commentsFromMap(a.getMap('comments'))
        .map((c) => c.author)
        .sort()
    ).toEqual(['A', 'B']);
    expect(
      commentsFromMap(b.getMap('comments'))
        .map((c) => c.author)
        .sort()
    ).toEqual(['A', 'B']);
    a.destroy();
    b.destroy();
  });

  test('skips imported IDs and keeps integers exact at the largest client ID', () => {
    const base = 0xffffffff * 2 ** 20;
    const allocate = createAnnotationIdAllocator(
      () => 0xffffffff,
      (id) => id === base + 1
    );
    expect(allocate()).toBe(base + 2);
    expect(Number.isSafeInteger(allocate())).toBe(true);
  });

  test('follows client-ID changes and never resets a previously used lane', () => {
    let client = 7;
    const allocate = createAnnotationIdAllocator(() => client);
    const first = allocate();
    client = 8;
    expect(allocate()).toBe(8 * 2 ** 20 + 1);
    client = 7;
    expect(allocate()).toBe(first + 1);
  });
});
