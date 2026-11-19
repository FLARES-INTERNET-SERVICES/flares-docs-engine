/*
 * Copyright (c) 2026 Casual Office. All rights reserved.
 */

/**
 * Collab transport for comment threads. Comment highlight marks ride
 * ySyncPlugin (they're in the PM doc), but the thread content — author, text,
 * replies, resolved state — lives in React state and would NOT reach peers.
 * This bridges DocxEditor's controlled `comments` + `onCommentsChange` API to a
 * shared `comments` Y.Map keyed by comment id.
 *
 * Model: one Y.Map entry per Comment (replies are separate Comments with
 * `parentId`). Concurrency:
 *   - two peers adding different comments → different keys → merge cleanly.
 *   - two peers editing the SAME comment → last-write-wins on that key.
 * That's the right granularity for v1 (each thread/reply is independent).
 */
import type * as Y from 'yjs';
import type { Comment } from '@eigenpal/docx-core/types/content';

/** Rebuild the Comment[] from the shared map, ordered by id (creation order). */
export function commentsFromMap(map: Y.Map<unknown>): Comment[] {
  const out: Comment[] = [];
  map.forEach((value) => {
    if (value && typeof value === 'object') out.push(value as Comment);
  });
  out.sort((a, b) => a.id - b.id);
  return out;
}

/**
 * Apply changes relative to the snapshot the editor rendered. Remote changes
 * may already be in the map while React still displays that older snapshot;
 * unchanged local entries must not overwrite them or resurrect deleted entries.
 * Omitting previous retains full replacement semantics for seeding/imports.
 */
export function writeCommentsToMap(
  map: Y.Map<unknown>,
  comments: Comment[],
  previous?: Comment[]
): void {
  const doc = map.doc;
  const baseline = previous && new Map(previous.map((c) => [String(c.id), c]));
  const apply = () => {
    if (doc && doc.getMap('meta').get('commentsInitialized') !== true) {
      doc.getMap('meta').set('commentsInitialized', true);
    }
    const nextIds = new Set(comments.map((c) => String(c.id)));
    // Delete removed.
    for (const key of Array.from(baseline ? baseline.keys() : map.keys())) {
      if (!nextIds.has(key)) map.delete(key);
    }
    // Upsert changed (cheap deep-equal via JSON to avoid redundant churn).
    for (const c of comments) {
      const key = String(c.id);
      if (baseline?.has(key) && JSON.stringify(baseline.get(key)) === JSON.stringify(c)) continue;
      const existing = map.get(key);
      if (!existing || JSON.stringify(existing) !== JSON.stringify(c)) {
        map.set(key, c);
      }
    }
  };
  if (doc) doc.transact(apply);
  else apply();
}

/** Observe remote+local map changes; fire `cb` with the rebuilt Comment[]. */
export function observeComments(
  map: Y.Map<unknown>,
  cb: (comments: Comment[]) => void
): () => void {
  const handler = () => cb(commentsFromMap(map));
  map.observe(handler);
  return () => map.unobserve(handler);
}
