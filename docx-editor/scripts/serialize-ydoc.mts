/**
 * Yjs update -> .docx, headless.
 *
 * This lives in the editor workspace, not in the collaboration server, for one
 * unglamorous reason: ProseMirror refuses to mix documents built by two copies
 * of prosemirror-model, and a linked package brings its own. Keeping the schema,
 * the Yjs bridge and the conversion in a single dependency tree is what makes
 * the conversion possible at all.
 *
 * The collaboration server imports this by absolute path, so Node resolves
 * these imports from HERE, against this one consistent tree.
 *
 * The conversion is the one the editor performs on save, in the same order:
 *
 *   Yjs update -> Y.Doc -> ProseMirror JSON -> fromProseDoc -> serializeDocx
 */
import * as Y from 'yjs';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { schema, fromProseDoc } from '@eigenpal/docx-core/prosemirror';
import { repackDocx, createDocx, parseDocx } from '@eigenpal/docx-core/headless';
import { assertTextSurvived, completePackage } from './complete-package.mts';

export interface SerializeRequest {
  /** A Yjs update, as raw bytes. */
  state: Uint8Array;
  /** Used for the document title; never a path. */
  name?: string;
  /**
   * The .docx this state was seeded from, if the caller has it. Passing it
   * preserves everything the editor never touches — styles, numbering,
   * footnotes — which a bare round trip would drop.
   */
  base?: Uint8Array;
}

export async function serializeYDocToDocx(request: SerializeRequest): Promise<Uint8Array> {
  const ydoc = new Y.Doc();

  try {
    Y.applyUpdate(ydoc, request.state);

    // 'prosemirror' is the fragment ySyncPlugin binds to. A different name
    // yields an empty document rather than an error, which is worse.
    const json = yXmlFragmentToProsemirrorJSON(ydoc.getXmlFragment('prosemirror'));

    // The schema builds the node. Importing Node separately is what pulls in a
    // second prosemirror-model and produces "multiple versions loaded".
    const pmDoc = schema.nodeFromJSON(json);

    // A base is worth having and not required. With one, the result keeps
    // everything the editor never touches -- styles, numbering, footnotes, the
    // parts of the package a bare round trip drops. Without one, the document
    // is built from scratch and those are the defaults.
    const base = request.base ? await parseDocx(request.base) : undefined;
    const document = fromProseDoc(pmDoc, base);

    // repackDocx writes the ZIP. serializeDocx (serializeDocument) produces the
    // document XML only -- a fragment of the package, not a file any word
    // processor will open.
    const packed = base
      ? await repackDocx(document)
      : await createDocx(document);

    const complete = await completePackage(new Uint8Array(packed), pmDoc);

    await assertTextSurvived(complete, pmDoc);

    return complete;
  } finally {
    // Per-request scratch. Left undestroyed, a serialize every few minutes per
    // open document is a slow leak.
    ydoc.destroy();
  }
}
