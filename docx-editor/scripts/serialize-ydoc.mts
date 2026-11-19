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
import { prosemirrorToYXmlFragment, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { schema, fromProseDoc, toProseDoc } from '@eigenpal/docx-core/prosemirror';
import { repackDocx, createDocx, parseDocx, injectReplyRangeMarkers, injectTCReplyRangeMarkers } from '@eigenpal/docx-core/headless';
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

type JsonNode = { type: string; attrs?: Record<string, unknown>; content?: JsonNode[] };

/**
 * Give every paragraph the id the editor would.
 *
 * The editor gives one to any paragraph without, as soon as it opens a document. In a
 * room that is a change to the document, made by whoever happens to open it first:
 * nothing anyone wrote, and it would still have to be saved as a new version.
 */
function withParagraphIds(node: JsonNode, seen = new Set<string>()): JsonNode {
  if (node.type === 'paragraph') {
    const existing = node.attrs?.paraId;

    if (typeof existing === 'string' && existing !== '' && !seen.has(existing)) {
      seen.add(existing);
    } else {
      let id: string;
      do {
        // Word's rule: eight hex digits, below 0x80000000.
        id = Math.floor(Math.random() * 0x7fffffff + 1).toString(16).toUpperCase().padStart(8, '0');
      } while (seen.has(id));
      seen.add(id);
      node.attrs = { ...node.attrs, paraId: id };
    }
  }

  node.content?.forEach((child) => withParagraphIds(child, seen));

  return node;
}

/**
 * .docx -> Yjs update: a room's first state, when all there is to go on is a file.
 *
 * Done here rather than by whichever browser arrives first, because that browser may
 * belong to a viewer, whose updates the server refuses, or may never finish.
 * The same conversion the editor does when it seeds a room itself.
 */
export async function docxToYDocState(docx: Uint8Array): Promise<Uint8Array> {
  const parsed = await parseDocx(docx);
  const pmDoc = schema.nodeFromJSON(withParagraphIds(toProseDoc(parsed, { styles: parsed.package.styles }).toJSON()));
  const ydoc = new Y.Doc();

  try {
    prosemirrorToYXmlFragment(pmDoc, ydoc.getXmlFragment('prosemirror'));
    const comments = ydoc.getMap('comments');
    for (const comment of parsed.package.document.comments ?? []) {
      comments.set(String(comment.id), comment);
    }
    ydoc.getMap('meta').set('commentsInitialized', true);

    return Y.encodeStateAsUpdate(ydoc);
  } finally {
    ydoc.destroy();
  }
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
    const comments = ydoc.getMap('comments');
    // Old rooms may have no comment map at all: preserve their base comments.
    // The marker distinguishes that legacy case from intentionally deleting all.
    if (comments.size || ydoc.getMap('meta').get('commentsInitialized') === true) {
      document.package.document.comments = Array.from(comments.values()) as NonNullable<typeof document.package.document.comments>;
    }
    const savedComments = document.package.document.comments ?? [];
    injectReplyRangeMarkers(document.package.document.content, savedComments);
    injectTCReplyRangeMarkers(document.package.document.content, savedComments);

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
