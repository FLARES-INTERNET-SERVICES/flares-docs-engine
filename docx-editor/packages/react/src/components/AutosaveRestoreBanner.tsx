/*
 * Copyright (c) 2026 Casual Office. All rights reserved.
 */

/**
 * Restore-prompt banner shown at editor mount when an autosave record
 * exists from the last session. Two actions:
 *
 *   - **Restore** — swap the editor's buffer for the saved snapshot.
 *   - **Discard** — drop the saved record.
 *
 * Two gates keep this from showing for noise:
 *   - **Age gate** — 24 h. Older snapshots are auto-discarded; if a
 *     user hasn't returned in a day the saved state is almost
 *     certainly stale.
 *   - **Same-doc gate** — if the editor already has unsaved changes on
 *     a different document name, the banner is suppressed to avoid
 *     clobbering current work.
 *
 * Self-dismisses after either action. Visual mirrors the existing
 * SuggestingModeBanner pattern so the editor's banner system stays
 * coherent.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { clearAutosave, formatAgo, readAutosave, type AutosaveRecord } from '../utils/autosave';

export interface AutosaveRestoreBannerProps {
  /** Called when the user clicks Restore — host swaps in the buffer. */
  onRestore: (buffer: ArrayBuffer, name: string) => void;
  /**
   * If `true`, the editor is currently dirty on a NEW document — we
   * suppress the banner so we don't clobber the user's typing.
   */
  suppress?: boolean;
  /**
   * Which document's recovery record to look for. Without it the banner
   * reads the shared single slot, and a draft of one document is offered
   * against another.
   */
  documentId?: string;
  /**
   * The revision the host has durably stored.
   *
   * A record written at or below this has already reached durable storage —
   * the work is safe, and offering to "restore" it would roll the document
   * back to an older copy of itself. That is the whole failure this gate
   * exists to prevent, and it is why a document that saved perfectly used to
   * greet its author with "restore unsaved changes?" on every reload.
   */
  durableRevision?: number;
}

const STALE_AFTER_MS = 24 * 60 * 60 * 1000; // 24 h

const ROOT_STYLE: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  padding: '6px 16px',
  // Themed via the info-state CSS variables so the banner reads as a
  // soft blue notification in light mode and a muted blue surface in
  // dark mode, instead of the previous hardcoded light-blue that sat
  // jarringly on a dark editor background.
  background: 'var(--doc-info-bg, #e8f0fe)',
  color: 'var(--doc-info-text, #1f2937)',
  borderBottom: '1px solid var(--doc-info-border, #aac6f7)',
  fontSize: 13,
  lineHeight: 1.4,
};

const MESSAGE_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
};

const STRONG_STYLE: CSSProperties = {
  fontWeight: 600,
  marginRight: 6,
};

const PRIMARY_BTN_STYLE: CSSProperties = {
  padding: '4px 14px',
  fontSize: 12,
  border: '1px solid var(--doc-primary, #1a73e8)',
  background: 'var(--doc-primary, #1a73e8)',
  color: 'white',
  borderRadius: 4,
  cursor: 'pointer',
  fontWeight: 500,
  flexShrink: 0,
};

const SECONDARY_BTN_STYLE: CSSProperties = {
  padding: '4px 10px',
  fontSize: 12,
  border: '1px solid var(--doc-border, #d1d5db)',
  background: 'transparent',
  color: 'var(--doc-text-on-surface, #1f2937)',
  borderRadius: 4,
  cursor: 'pointer',
  fontWeight: 500,
  flexShrink: 0,
};

export function AutosaveRestoreBanner({
  onRestore,
  suppress,
  documentId,
  durableRevision,
}: AutosaveRestoreBannerProps) {
  const [rec, setRec] = useState<AutosaveRecord | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const r = await readAutosave(documentId);
      if (cancelled) return;
      if (!r) {
        setRec(null);
        return;
      }
      // Age gate — drop stale snapshots silently.
      if (Date.now() - r.savedAt > STALE_AFTER_MS) {
        await clearAutosave(documentId);
        setRec(null);
        return;
      }
      // Identity gate. A record from a different document must never be
      // offered against this one, however recent it is -- restoring it would
      // replace the open document with an unrelated one.
      if (documentId !== undefined && r.documentId !== undefined && r.documentId !== documentId) {
        setRec(null);
        return;
      }
      // Durability gate. The host has this revision safely stored, so there is
      // nothing to recover: silently drop it rather than asking a user to
      // adjudicate between two copies of work that is not at risk.
      if (
        durableRevision !== undefined &&
        r.durableRevision !== undefined &&
        r.durableRevision <= durableRevision
      ) {
        await clearAutosave(documentId);
        setRec(null);
        return;
      }
      setRec(r);
    })();
    return () => {
      cancelled = true;
    };
    // Read on mount only — the banner is a "boot-time prompt", not a
    // live subscription. Re-reading every render would race with
    // discard/restore actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId]);

  if (!rec || dismissed || suppress) return null;

  return (
    <div role="status" aria-live="polite" data-testid="autosave-banner" style={ROOT_STYLE}>
      <div style={MESSAGE_STYLE}>
        <span style={STRONG_STYLE}>Unsaved changes</span>
        <span>
          from <em>{rec.name}</em> ({formatAgo(Date.now() - rec.savedAt)}) — restore them?
        </span>
      </div>
      <button
        type="button"
        style={PRIMARY_BTN_STYLE}
        data-testid="autosave-restore"
        onClick={async () => {
          onRestore(rec.buffer, rec.name);
          await clearAutosave(documentId);
          setDismissed(true);
        }}
      >
        Restore
      </button>
      <button
        type="button"
        style={SECONDARY_BTN_STYLE}
        data-testid="autosave-discard"
        onClick={async () => {
          await clearAutosave(documentId);
          setDismissed(true);
        }}
      >
        Discard
      </button>
    </div>
  );
}

export default AutosaveRestoreBanner;
