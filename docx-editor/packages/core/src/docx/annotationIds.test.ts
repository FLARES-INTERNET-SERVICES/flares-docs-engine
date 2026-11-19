import { expect, test } from 'bun:test';
import type { Document } from '../types/document';
import { normalizeAnnotationIds } from './annotationIds';

test('export maps wide IDs consistently without changing live IDs or existing Word IDs', () => {
  const wide = 2 ** 40;
  const doc = {
    package: {
      document: {
        comments: [
          { id: 1, author: 'Imported' },
          { id: wide, author: 'A' },
          { id: wide + 1, author: 'B', parentId: wide },
        ],
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'commentRangeStart', id: wide },
              { type: 'commentRangeEnd', id: wide },
              { type: 'insertion', info: { id: wide + 2, author: 'A' }, content: [] },
            ],
          },
        ],
      },
    },
    originalBuffer: new ArrayBuffer(4),
  } as unknown as Document;
  const original = JSON.stringify(doc);
  const exported = normalizeAnnotationIds(doc);
  expect(exported.package.document.comments?.map((c) => c.id)).toEqual([1, 2, 3]);
  expect(exported.package.document.comments?.[2].parentId).toBe(2);
  expect(exported.package.document.content).toEqual([
    {
      type: 'paragraph',
      content: [
        { type: 'commentRangeStart', id: 2 },
        { type: 'commentRangeEnd', id: 2 },
        { type: 'insertion', info: { id: 4, author: 'A' }, content: [] },
      ],
    },
  ]);
  expect(exported.originalBuffer).toBe(doc.originalBuffer);
  expect(JSON.stringify(doc)).toBe(original);
  expect(normalizeAnnotationIds(exported)).toBe(exported);
});
