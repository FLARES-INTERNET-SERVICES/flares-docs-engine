import { createHash } from 'node:crypto';
import * as Y from 'yjs';

/**
 * What a room currently holds, in the form a host application stores.
 *
 * A host keeps its own durable copy of each document and needs to read the
 * room's state to make one. Whether the room holds anything worth keeping is
 * reported rather than decided here: the host alone knows what it already has.
 */
export type RoomStateReport =
  | { exists: false }
  | { exists: true; unchanged: true; fingerprint: string }
  | {
      exists: true;
      unchanged: false;
      fingerprint: string;
      state: string;
      vector: string;
      hasContent: boolean;
    };

/**
 * Does this node hold anything a person put there?
 *
 * The test is deliberately not `fragment.length > 0`: ySyncPlugin publishes the
 * editor's empty starting paragraph the moment a client binds to a room, so an
 * untouched room is not an empty fragment. Anything other than a paragraph (a
 * table, an image, a page break) counts, even with no text inside it.
 */
function holdsContent(node: Y.XmlElement | Y.XmlText | Y.XmlHook): boolean {
  if (node instanceof Y.XmlText) {
    return node.length > 0;
  }

  if (node instanceof Y.XmlElement && node.nodeName === 'paragraph') {
    return (node.toArray() as Array<Y.XmlElement | Y.XmlText | Y.XmlHook>).some(holdsContent);
  }

  return true;
}

/**
 * Report on an encoded room state.
 *
 * `known` is the fingerprint the host last stored. Answering "unchanged" without
 * the bytes is what makes it cheap to ask on every poll from an open editor.
 */
export function reportRoomState(update: Uint8Array | null, known?: string): RoomStateReport {
  if (update === null) {
    return { exists: false };
  }

  const fingerprint = createHash('sha256').update(update).digest('hex');

  if (known === fingerprint) {
    return { exists: true, unchanged: true, fingerprint };
  }

  // Read from a private copy: asking a live document for a fragment it does not
  // have yet would create one in it.
  const copy = new Y.Doc();

  try {
    Y.applyUpdate(copy, update);

    return {
      exists: true,
      unchanged: false,
      fingerprint,
      state: Buffer.from(update).toString('base64'),
      vector: Buffer.from(Y.encodeStateVector(copy)).toString('base64'),
      hasContent: docHoldsContent(copy),
    };
  } finally {
    copy.destroy();
  }
}

function docHoldsContent(doc: Y.Doc): boolean {
  // 'prosemirror' is the fragment ySyncPlugin binds to.
  return (doc.getXmlFragment('prosemirror').toArray() as Array<Y.XmlElement | Y.XmlText | Y.XmlHook>).some(holdsContent);
}

/** Does this encoded state hold anything a person put there? */
export function roomStateHoldsContent(update: Uint8Array): boolean {
  const copy = new Y.Doc();

  try {
    Y.applyUpdate(copy, update);

    return docHoldsContent(copy);
  } finally {
    copy.destroy();
  }
}
