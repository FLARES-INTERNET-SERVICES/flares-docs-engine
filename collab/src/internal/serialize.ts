/**
 * Turn a Yjs document into a .docx, server side.
 *
 * The host application stores the collaborative state and owns the canonical
 * file; it needs the bytes to write a version, and it cannot produce them
 * itself -- the conversion lives in the editor's TypeScript, not in PHP or any
 * other host language.
 *
 * Doing it in the browser instead would mean trusting whatever bytes a client
 * uploads to become the canonical document. Doing it here keeps the file the
 * server's own work, derived from state the server already holds.
 *
 * The conversion is the same one the editor performs on save, in the same
 * order, using the same exported functions:
 *
 *   Yjs update -> Y.Doc -> ProseMirror JSON -> fromProseDoc -> serializeDocx
 *
 * Nothing here is Flares-specific: it takes a Yjs update and a filename and
 * returns a document.
 */
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { Node as PMNode } from 'prosemirror-model';
import { schema } from '@eigenpal/docx-core/prosemirror';
import { fromProseDoc } from '@eigenpal/docx-core/prosemirror';
import { serializeDocx, parseDocx } from '@eigenpal/docx-core/headless';

export interface SerializeRequest {
  /** A Yjs update, as raw bytes. */
  state: Uint8Array;
  /** Used for the document title; not a path. */
  name: string;
  /**
   * The document this state was seeded from, if the caller has it. Passing it
   * preserves everything the editor never touches -- styles, numbering,
   * footnotes, the parts of the package a round trip would otherwise drop.
   */
  base?: Uint8Array;
}

export async function serializeYDocToDocx(request: SerializeRequest): Promise<Uint8Array> {
  const ydoc = new Y.Doc();

  try {
    Y.applyUpdate(ydoc, request.state);

    // 'prosemirror' is the fragment ySyncPlugin binds to; a different name
    // yields an empty document rather than an error, which is worse.
    const fragment = ydoc.getXmlFragment('prosemirror');
    const json = yXmlFragmentToProsemirrorJSON(fragment);
    const pmDoc = PMNode.fromJSON(schema, json);

    const base = request.base ? await parseDocx(request.base) : undefined;
    const document = fromProseDoc(pmDoc, base);

    if (document.package?.document && request.name) {
      document.package.document.title = request.name;
    }

    return await serializeDocx(document);
  } finally {
    // The Y.Doc is per-request scratch. Left undestroyed, a serialize every few
    // minutes per open document is a slow leak.
    ydoc.destroy();
  }
}
