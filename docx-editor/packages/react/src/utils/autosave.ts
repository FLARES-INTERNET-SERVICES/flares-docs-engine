/*
 * Copyright (c) 2026 Casual Office. All rights reserved.
 */

/**
 * Tab-local autosave for the docx editor. Single slot per origin — we
 * keep the most recent dirty snapshot so the user can recover from a
 * crash or accidental close. Anything more elaborate (versioned
 * history, cross-tab merge) is out of scope until we have a backend.
 *
 * IndexedDB is used over localStorage because docx buffers regularly
 * exceed the 5 MB localStorage budget; IDB stores the ArrayBuffer
 * directly via structured clone, no JSON round-trip required.
 *
 * Mirrors the sibling Casual Sheets autosave store
 * (`services/sheet/apps/web/src/autosave/store.ts`) — same single-slot
 * design, same DB / store / key convention. Pulled into its own DB
 * (`casual-docs`) so we don't have to lockstep version numbers with
 * the sheet repo.
 */

import { openDocsDb, STORE_AUTOSAVE as STORE } from './idb';

/**
 * The slot used when the host gives no document identity.
 *
 * Historically this was the ONLY key: one record per origin, whatever
 * document produced it. That is wrong in two directions — a draft of one
 * document is offered against another, and opening a second document
 * destroys the first one's safety net. Hosts that pass a `documentId` get a
 * slot of their own; `'current'` remains for single-document use so existing
 * behaviour is unchanged when no id is supplied.
 */
const DEFAULT_KEY = 'current';

/** Records are per document, so a rename must not create a second one. */
function keyFor(documentId?: string): string {
  return documentId && documentId !== '' ? `doc:${documentId}` : DEFAULT_KEY;
}

export interface AutosaveRecord {
  /** Document name at the time of save — used in the restore prompt. */
  name: string;
  /** The full `.docx` buffer the editor can `loadBuffer` straight from. */
  buffer: ArrayBuffer;
  /** Wall-clock ms at save time — for the restore prompt copy. */
  savedAt: number;
  /**
   * Stable identity of the document this belongs to, when the host supplies
   * one. Deliberately not the filename: renaming a document must not orphan
   * its recovery record, and two documents that happen to share a name must
   * not share one.
   */
  documentId?: string;
  /**
   * The durable revision the host had acknowledged when this was written.
   *
   * This is what makes a recovery record answerable. On reopening, a host
   * that has since durably stored a NEWER revision knows this copy is
   * already superseded — and offering to "restore" it would roll the
   * document backwards, which is the failure mode a recovery feature exists
   * to prevent.
   */
  durableRevision?: number;
}

const openDb = openDocsDb;

export async function readAutosave(documentId?: string): Promise<AutosaveRecord | null> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return null;
  try {
    const db = await openDb();
    return await new Promise<AutosaveRecord | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(keyFor(documentId));
      req.onsuccess = () => resolve((req.result as AutosaveRecord | undefined) ?? null);
      req.onerror = () => reject(req.error ?? new Error('read failed'));
    });
  } catch (err) {
    // Private-mode browsers + Safari ITP can throw on open. Restoring
    // gracefully fails to "no record" so the editor still mounts.
    if (typeof console !== 'undefined') {
      console.warn('[autosave] read failed; skipping restore', err);
    }
    return null;
  }
}

export async function writeAutosave(rec: AutosaveRecord): Promise<void> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec, keyFor(rec.documentId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('write failed'));
    });
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[autosave] write failed', err);
    }
  }
}

export async function clearAutosave(documentId?: string): Promise<void> {
  if (typeof window === 'undefined' || typeof indexedDB === 'undefined') return;
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(keyFor(documentId));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('clear failed'));
    });
  } catch (err) {
    if (typeof console !== 'undefined') {
      console.warn('[autosave] clear failed', err);
    }
  }
}

/**
 * One-time cleanup: remove the stale `docx-editor-autosave` key written by the
 * legacy `AutoSaveManager` (localStorage Document JSON). The active autosave
 * path uses IndexedDB; this key is never read by the current codebase and can
 * accumulate up to several MB of stale JSON. Safe to call on every mount —
 * removeItem is a no-op when the key is absent.
 */
export function clearLegacyLocalStorageAutosave(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem('docx-editor-autosave');
  } catch {
    // Private-mode or storage denied — no-op.
  }
}

/** "moments ago" / "12 min ago" / "3 hr ago" / "2 days ago". */
export function formatAgo(ms: number): string {
  if (ms < 60_000) return 'moments ago';
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
