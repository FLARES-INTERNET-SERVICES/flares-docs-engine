import { describe, expect, it } from 'bun:test';
import type { FlowBlock } from '@eigenpal/docx-core/layout-engine';
import { screenBlocks, screenGeometry } from './screenLayout';

describe('screen-only document layout', () => {
  it('puts paragraph-level floating pictures into normal text flow even when already narrow', () => {
    const source: FlowBlock = {
      kind: 'paragraph',
      id: 'float-paragraph',
      runs: [
        {
          kind: 'image',
          src: 'seal.png',
          width: 100,
          height: 80,
          displayMode: 'float',
          wrapType: 'none',
          position: { horizontal: { posOffset: 5000000 } },
          pmStart: 3,
          pmEnd: 4,
        },
      ],
    };
    const before = JSON.stringify(source);
    const result = screenBlocks([source], 256, 1056)[0];
    if (result.kind !== 'paragraph') throw new Error('Expected paragraph');
    expect(result.runs[0]).toMatchObject({
      width: 100,
      height: 80,
      position: undefined,
      displayMode: 'inline',
      wrapType: 'inline',
      cssFloat: 'none',
      pmStart: 3,
      pmEnd: 4,
    });
    expect(JSON.stringify(source)).toBe(before);
  });
  it('flows floating objects on screen without changing their print anchors', () => {
    const source: FlowBlock[] = [
      {
        kind: 'image',
        id: 'floating-picture',
        src: 'test.png',
        width: 600,
        height: 300,
        anchor: { isAnchored: true, offsetH: 700, offsetV: 50 },
        pmStart: 4,
        pmEnd: 5,
      },
      {
        kind: 'textBox',
        id: 'box',
        width: 500,
        height: 20,
        anchor: { offsetH: 600000, offsetV: 900000 },
        autoFit: 'noAutofit',
        content: [{ kind: 'paragraph', id: 'inside', runs: [] }],
      },
    ];
    const before = JSON.stringify(source);
    const result = screenBlocks(source, 256, 1056);
    expect(result[0]).toMatchObject({
      width: 216,
      height: 108,
      anchor: undefined,
      pmStart: 4,
      pmEnd: 5,
    });
    expect(result[1]).toMatchObject({
      width: 216,
      height: undefined,
      anchor: undefined,
      autoFit: 'spAutoFit',
    });
    expect(JSON.stringify(source)).toBe(before);
  });
  it('keeps readable content space at narrow widths', () => {
    for (const width of [288, 358, 736]) {
      const result = screenGeometry(width, 1056);
      expect(result.pageSize.w - result.margins.left - result.margins.right).toBe(width - 40);
      expect(result.columns).toBeUndefined();
    }
  });

  it('reflows section breaks without mutating their original print settings', () => {
    const section = Object.freeze({
      kind: 'sectionBreak' as const,
      id: 'section-1',
      pageSize: Object.freeze({ w: 1122, h: 794 }),
      margins: Object.freeze({ top: 96, bottom: 96, left: 96, right: 96 }),
      columns: Object.freeze({ count: 2, gap: 48 }),
      type: 'nextPage' as const,
    });
    const blocks: FlowBlock[] = [section];
    const before = JSON.stringify(blocks);
    const mobile = screenBlocks(blocks, 288, 1056);
    expect(mobile[0]).not.toBe(section);
    expect(mobile[0]).toMatchObject({ pageSize: { w: 288, h: 1056 }, type: 'nextPage' });
    expect(JSON.stringify(blocks)).toBe(before);
    expect(section.pageSize.w).toBe(1122);
  });

  it('leaves content and its position identifiers unchanged', () => {
    const pageBreak = Object.freeze({
      kind: 'pageBreak' as const,
      id: 'break-1',
      pmStart: 9,
      pmEnd: 10,
    });
    expect(screenBlocks([pageBreak], 288, 1056)[0]).toBe(pageBreak);
  });

  it('fits table columns without writing phone dimensions into the source', () => {
    const source: FlowBlock = {
      kind: 'table',
      id: 't',
      width: 9000,
      widthType: 'dxa',
      columnWidths: [200, 400],
      indent: 30,
      rows: [
        {
          id: 'r',
          heightRule: 'exact',
          height: 20,
          cells: [{ id: 'c', width: 600, widthValue: 9000, widthType: 'dxa', blocks: [] }],
        },
      ],
    };
    const original = JSON.stringify(source);
    const result = screenBlocks([source], 256, 1056)[0];
    expect(result.kind).toBe('table');
    if (result.kind !== 'table') throw new Error('Expected table');
    expect(result.columnWidths).toEqual([72, 144]);
    expect(result.rows[0].heightRule).toBe('auto');
    expect(result.rows[0].cells[0].width).toBeUndefined();
    expect(JSON.stringify(source)).toBe(original);
  });

  it('scales an oversized inline image proportionally without altering its source', () => {
    const source: FlowBlock = {
      kind: 'paragraph',
      id: 'p',
      runs: [{ kind: 'image', src: 'test.png', width: 600, height: 300, pmStart: 2, pmEnd: 3 }],
    };
    const result = screenBlocks([source], 256, 1056)[0];
    if (result.kind !== 'paragraph') throw new Error('Expected paragraph');
    expect(result.runs[0]).toMatchObject({ width: 216, height: 108, pmStart: 2, pmEnd: 3 });
    expect(source.runs[0]).toMatchObject({ width: 600, height: 300 });
  });

  it('fits nested table images to their cell, preserving print wrapping and source content', () => {
    const picture: FlowBlock = {
      kind: 'paragraph',
      id: 'picture',
      runs: [{ kind: 'image', src: 'test.png', width: 600, height: 300, pmStart: 12, pmEnd: 13 }],
    };
    const nested: FlowBlock = {
      kind: 'table',
      id: 'nested',
      columnWidths: [600],
      rows: [{ id: 'inner-row', cells: [{ id: 'inner-cell', blocks: [picture], noWrap: true }] }],
    };
    const outer: FlowBlock = {
      kind: 'table',
      id: 'outer',
      columnWidths: [100, 100, 100],
      rows: [
        {
          id: 'outer-row',
          cells: [
            { id: 'merged', colSpan: 2, blocks: [nested], noWrap: true },
            { id: 'last', blocks: [] },
          ],
        },
      ],
    };
    const before = JSON.stringify(outer);
    const result = screenBlocks([outer], 256, 1056)[0];
    if (result.kind !== 'table') throw new Error('Expected outer table');
    const cell = result.rows[0].cells[0];
    expect(cell.noWrap).toBe(false);
    expect(cell.colSpan).toBe(2);
    const table = cell.blocks[0];
    if (table.kind !== 'table') throw new Error('Expected nested table');
    expect(table.columnWidths).toEqual([130]);
    const paragraph = table.rows[0].cells[0].blocks[0];
    if (paragraph.kind !== 'paragraph') throw new Error('Expected picture paragraph');
    expect(paragraph.runs[0]).toMatchObject({ width: 116, height: 58, pmStart: 12, pmEnd: 13 });
    expect(JSON.stringify(outer)).toBe(before);
  });
});
