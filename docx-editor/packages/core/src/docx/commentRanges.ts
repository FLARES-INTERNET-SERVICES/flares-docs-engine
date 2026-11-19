import type { BlockContent, Comment, ParagraphContent } from '../types/content';

function unanchoredReplies(content: BlockContent[], comments: Comment[]): Comment[] {
  const anchored = new Set<number>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype)
      return;
    const item = value as Record<string, unknown>;
    if (item.type === 'commentRangeStart' && typeof item.id === 'number') anchored.add(item.id);
    Object.values(item).forEach(visit);
  };
  visit(content);
  return comments.filter((c) => c.parentId != null && !anchored.has(c.id));
}

export function injectReplyRangeMarkers(content: BlockContent[], comments: Comment[]): void {
  const replies = unanchoredReplies(content, comments);
  if (replies.length === 0) return;

  // Build parentId → reply IDs map
  const replyIdsByParent = new Map<number, number[]>();
  for (const r of replies) {
    const arr = replyIdsByParent.get(r.parentId!);
    if (arr) arr.push(r.id);
    else replyIdsByParent.set(r.parentId!, [r.id]);
  }

  // Walk document content and find parent commentRangeStart/End locations
  function walkBlocks(blocks: BlockContent[]): void {
    for (const block of blocks) {
      if (block.type === 'paragraph') {
        // Skip paragraphs without any comment range markers
        if (
          !block.content.some((i) => i.type === 'commentRangeStart' || i.type === 'commentRangeEnd')
        )
          continue;
        const newItems: ParagraphContent[] = [];
        for (const item of block.content) {
          if (item.type === 'commentRangeStart') {
            newItems.push(item);
            // Add reply range starts right after parent's start
            const replyIds = replyIdsByParent.get(item.id);
            if (replyIds) {
              for (const rid of replyIds) {
                newItems.push({ type: 'commentRangeStart', id: rid });
              }
            }
          } else if (item.type === 'commentRangeEnd') {
            // Parent's rangeEnd first, then reply rangeEnds (parallel, not nested)
            newItems.push(item);
            const replyIds = replyIdsByParent.get(item.id);
            if (replyIds) {
              for (const rid of replyIds) {
                newItems.push({ type: 'commentRangeEnd', id: rid });
              }
            }
          } else {
            newItems.push(item);
          }
        }
        block.content = newItems;
      } else if (block.type === 'table') {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            walkBlocks(cell.content);
          }
        }
      }
    }
  }

  walkBlocks(content);
}

/**
 * Inject commentRangeStart/End for comments that reply to tracked changes.
 * TC replies' parents are insertion/deletion nodes (not comments), so
 * injectReplyRangeMarkers can't find them. This function finds the TC
 * content nodes and wraps them with comment range markers.
 */
export function injectTCReplyRangeMarkers(content: BlockContent[], comments: Comment[]): void {
  // Find replies whose parentId is a tracked change (not a real comment)
  // Real comment parents were handled by injectReplyRangeMarkers first.
  // Older clients could reuse a revision ID for a reply, so a comment-map
  // entry alone cannot prove that the parent is a comment rather than a change.
  const tcReplies = unanchoredReplies(content, comments);
  if (tcReplies.length === 0) return;

  // Build revisionId → reply comment IDs
  const replyIdsByRevision = new Map<number, number[]>();
  for (const r of tcReplies) {
    const arr = replyIdsByRevision.get(r.parentId!);
    if (arr) arr.push(r.id);
    else replyIdsByRevision.set(r.parentId!, [r.id]);
  }

  function walkBlocks(blocks: BlockContent[]): void {
    for (const block of blocks) {
      if (block.type === 'paragraph') {
        // Check if any insertion/deletion in this paragraph matches a TC reply
        const hasTC = block.content.some(
          (item) =>
            (item.type === 'insertion' || item.type === 'deletion') &&
            replyIdsByRevision.has(item.info.id)
        );
        if (!hasTC) continue;

        const newItems: ParagraphContent[] = [];
        const items = block.content;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (
            (item.type === 'insertion' || item.type === 'deletion') &&
            replyIdsByRevision.has(item.info.id)
          ) {
            const replyIds = replyIdsByRevision.get(item.info.id)!;
            // Add commentRangeStart BEFORE the TC content
            for (const rid of replyIds) {
              newItems.push({ type: 'commentRangeStart', id: rid });
            }
            newItems.push(item);
            // Check if the next item is the other half of a replacement pair
            // (adjacent del+ins with same author+date). If so, include it inside
            // the comment range so we don't break del-ins adjacency.
            const next = items[i + 1];
            if (
              next &&
              (next.type === 'insertion' || next.type === 'deletion') &&
              next.type !== item.type &&
              next.info.author === item.info.author &&
              next.info.date === item.info.date
            ) {
              newItems.push(next);
              i++; // skip the paired item
            }
            // Add commentRangeEnd AFTER both TC items
            for (const rid of replyIds) {
              newItems.push({ type: 'commentRangeEnd', id: rid });
            }
          } else {
            newItems.push(item);
          }
        }
        block.content = newItems;
      } else if (block.type === 'table') {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            walkBlocks(cell.content);
          }
        }
      }
    }
  }

  walkBlocks(content);
}
