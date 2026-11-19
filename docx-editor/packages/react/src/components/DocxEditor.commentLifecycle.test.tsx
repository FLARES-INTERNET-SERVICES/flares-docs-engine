import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
import { test, expect, mock, afterAll } from 'bun:test';
import React from 'react';
import type { Comment } from '@eigenpal/docx-core/types/content';
import { render, cleanup } from '@testing-library/react';
import { createEmptyDocument } from '@eigenpal/docx-core/utils/createDocument';
const actualPagedEditor = { ...(await import('../paged-editor/PagedEditor')) };
// Mock layout only; keep geometry exports usable by the rest of the suite.
mock.module('../paged-editor/PagedEditor', () => ({
  ...actualPagedEditor,
  PagedEditor: React.forwardRef(() => null),
}));
const { DocxEditor } = await import('./DocxEditor');
afterAll(() => {
  mock.module('../paged-editor/PagedEditor', () => actualPagedEditor);
});

test('opening a saved DOCX cannot replace externally controlled live comments', async () => {
  const doc = createEmptyDocument();
  const live = [{ id: 4000000000001, author: 'A', content: [] }];
  doc.package.document.comments = [{ id: 1, author: 'A', content: [] }];
  const changed = mock((_comments: Comment[]) => {});
  try {
    render(
      <DocxEditor document={doc} externalContent comments={live} onCommentsChange={changed} />
    );
    expect(changed).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

test('a seed cannot resurrect comments while the controlled collection is empty', () => {
  const doc = createEmptyDocument();
  doc.package.document.comments = [{ id: 1, author: 'A', content: [] }];
  const changed = mock((_comments: Comment[]) => {});
  try {
    render(<DocxEditor document={doc} externalContent comments={[]} onCommentsChange={changed} />);
    expect(changed).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

test('standalone documents still import their saved comments', () => {
  const doc = createEmptyDocument();
  const saved = [{ id: 1, author: 'A', content: [] }];
  doc.package.document.comments = saved;
  const changed = mock((_comments: Comment[]) => {});
  try {
    render(<DocxEditor document={doc} onCommentsChange={changed} />);
    expect(
      changed.mock.calls.some((args) => JSON.stringify(args[0]) === JSON.stringify(saved))
    ).toBe(true);
  } finally {
    cleanup();
  }
});

test('loading another document leaves controlled comments with their owner', () => {
  const live = [{ id: 4000000000001, author: 'A', content: [] }];
  const changed = mock((_comments: Comment[]) => {});
  try {
    const view = render(
      <DocxEditor document={createEmptyDocument()} comments={live} onCommentsChange={changed} />
    );
    view.rerender(
      <DocxEditor document={createEmptyDocument()} comments={live} onCommentsChange={changed} />
    );
    expect(changed).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});
