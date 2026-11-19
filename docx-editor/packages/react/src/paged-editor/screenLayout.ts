import type { FlowBlock, PageMargins, ParagraphBlock } from '@eigenpal/docx-core/layout-engine';

/** Screen-only geometry. Never write these values into the document or PM state. */
export function screenGeometry(width: number, height: number) {
  return {
    pageSize: { w: Math.max(240, width), h: height },
    margins: {
      top: 24,
      bottom: 24,
      left: 20,
      right: 20,
      header: 8,
      footer: 8,
    } satisfies PageMargins,
    columns: undefined,
  };
}

/** Explicit section breaks must use the same screen geometry as the body. */
export function screenBlocks(blocks: FlowBlock[], width: number, height: number): FlowBlock[] {
  return fitBlocks(blocks, Math.max(1, width - 40), width, height);
}

function fitBlocks(
  blocks: FlowBlock[],
  available: number,
  width: number,
  height: number
): FlowBlock[] {
  return blocks.map((block) => {
    if (block.kind === 'sectionBreak') return { ...block, ...screenGeometry(width, height) };
    if (block.kind === 'image') {
      const scale = block.width > available ? available / block.width : 1;
      return {
        ...block,
        anchor: undefined,
        width: block.width * scale,
        height: block.height * scale,
      };
    }
    if (block.kind === 'textBox') {
      const boxWidth = Math.min(block.width, available);
      const innerWidth = Math.max(
        1,
        boxWidth - (block.margins?.left ?? 7) - (block.margins?.right ?? 7)
      );
      return {
        ...block,
        width: boxWidth,
        height: undefined,
        anchor: undefined,
        autoFit: 'spAutoFit',
        content: fitBlocks(block.content, innerWidth, width, height) as ParagraphBlock[],
      };
    }
    if (block.kind === 'paragraph')
      return {
        ...block,
        runs: block.runs.map((run) => {
          if (run.kind !== 'image') return run;
          const scale = run.width > available ? available / run.width : 1;
          return {
            ...run,
            width: run.width * scale,
            height: run.height * scale,
            position: undefined,
            wrapType: 'inline',
            displayMode: 'inline',
            cssFloat: 'none',
            distTop: 0,
            distBottom: 0,
            distLeft: 0,
            distRight: 0,
          };
        }),
      };
    if (block.kind === 'table') {
      const total = block.columnWidths?.reduce((sum, value) => sum + value, 0) ?? 0;
      const columns = block.columnWidths?.map((value) =>
        total > 0 ? (value * available) / total : value
      );
      const count = block.rows.reduce(
        (maximum, row) =>
          Math.max(
            maximum,
            row.cells.reduce((sum, cell) => sum + (cell.colSpan ?? 1), 0)
          ),
        1
      );
      return {
        ...block,
        width: 5000,
        widthType: 'pct',
        columnWidths: columns,
        indent: 0,
        floating: undefined,
        rows: block.rows.map((row) => {
          let column = 0;
          return {
            ...row,
            heightRule: 'auto',
            cells: row.cells.map((cell) => {
              const span = cell.colSpan ?? 1;
              const cellWidth = columns?.length
                ? columns.slice(column, column + span).reduce((sum, value) => sum + value, 0)
                : (available * span) / count;
              column += span;
              const contentWidth = Math.max(
                1,
                cellWidth - (cell.padding?.left ?? 7) - (cell.padding?.right ?? 7)
              );
              return {
                ...cell,
                width: undefined,
                widthValue: undefined,
                widthType: 'auto',
                noWrap: false,
                blocks: fitBlocks(cell.blocks, contentWidth, width, height),
              };
            }),
          };
        }),
      };
    }
    return block;
  });
}
