import { expect, test } from 'bun:test';
import type { BlockContent, Comment } from '../types/content';
import { injectReplyRangeMarkers, injectTCReplyRangeMarkers } from './commentRanges';

test('repeated export preparation does not duplicate reply anchors', () => {
  const blocks: BlockContent[] = [
    {
      type: 'paragraph',
      content: [
        { type: 'commentRangeStart', id: 1 },
        { type: 'run', content: [{ type: 'text', text: 'Original' }] },
        { type: 'commentRangeEnd', id: 1 },
        {
          type: 'insertion',
          info: { id: 7, author: 'Reviewer' },
          content: [{ type: 'run', content: [{ type: 'text', text: 'Suggested' }] }],
        },
      ],
    },
  ];
  const comments: Comment[] = [
    { id: 1, author: 'A', content: [] },
    { id: 2, author: 'B', content: [], parentId: 1 },
    { id: 3, author: 'B', content: [], parentId: 7 },
  ];
  injectReplyRangeMarkers(blocks, comments);
  injectTCReplyRangeMarkers(blocks, comments);
  const once = JSON.stringify(blocks);
  injectReplyRangeMarkers(blocks, comments);
  injectTCReplyRangeMarkers(blocks, comments);
  expect(JSON.stringify(blocks)).toBe(once);
  expect(once.match(/commentRangeStart/g)?.length).toBe(3);
  expect(once.match(/commentRangeEnd/g)?.length).toBe(3);
});

test('legacy replies sharing their revision parent ID still receive anchors', () => {
  const blocks: BlockContent[] = [
    {
      type: 'paragraph',
      content: [{ type: 'deletion', info: { id: 2, author: 'Reviewer' }, content: [] }],
    },
  ];
  const comments: Comment[] = [
    { id: 2, parentId: 2, author: 'A', content: [] },
    { id: 2 ** 40, parentId: 2, author: 'B', content: [] },
  ];
  injectReplyRangeMarkers(blocks, comments);
  injectTCReplyRangeMarkers(blocks, comments);
  expect(JSON.stringify(blocks).match(/commentRangeStart/g)?.length).toBe(2);
  expect(JSON.stringify(blocks).match(/commentRangeEnd/g)?.length).toBe(2);
});
