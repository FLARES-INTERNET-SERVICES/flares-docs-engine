/**
 * The file has to stand on its own in Word, not just contain the words.
 *
 * Run from this directory:
 *   ../../collab/node_modules/.bin/tsx --test serialize-ydoc.test.mts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment } from 'y-prosemirror';
import { schema } from '@eigenpal/docx-core/prosemirror';
import { docxToYDocState, serializeYDocToDocx } from './serialize-ydoc.mts';
import { createAnnotationIdAllocator } from '../packages/react/src/collab/annotationIds.ts';

const { nodes, marks } = schema;
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function stateOf(...blocks: unknown[]): Uint8Array {
  const doc = new Y.Doc();
  prosemirrorToYXmlFragment(nodes.doc.create(null, blocks as never) as never, doc.getXmlFragment('prosemirror'));

  return Y.encodeStateAsUpdate(doc);
}

const paragraph = (attrs: Record<string, unknown> | null, text?: string) =>
  nodes.paragraph.create(attrs, text ? schema.text(text) : undefined);

const report = () => [
  paragraph({ styleId: 'Title' }, 'A Title'),
  nodes.paragraph.create(null, [schema.text('Some '), schema.text('bold', [marks.bold.create()]), schema.text(' words')]),
  paragraph({ numPr: { numId: 1, ilvl: 0 }, listIsBullet: true }, 'A bullet'),
  paragraph({ numPr: { numId: 2, ilvl: 0 }, listIsBullet: false, listNumFmt: 'decimal' }, 'A number'),
];

/** The smallest package Word opens, as Flares creates them. */
async function blankBase(extra: Record<string, string> = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="word/document.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"/></Relationships>',
  );
  zip.file(
    'word/_rels/document.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>',
  );
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`,
  );
  for (const [path, contents] of Object.entries(extra)) zip.file(path, contents);

  return zip.generateAsync({ type: 'uint8array' });
}

const part = async (docx: Uint8Array, path: string) => JSZip.loadAsync(docx).then((z) => z.file(path)?.async('string'));

test('concurrent wide-ID replies survive a real DOCX export with Word-range IDs', async () => {
  const a = new Y.Doc();
  const b = new Y.Doc();
  const parentId = 2 ** 40;
  const make = (id: number, text: string, parentId?: number) => ({ id, author: 'Reviewer', parentId,
    content: [{ type: 'paragraph', content: [{ type: 'run', content: [{ type: 'text', text }] }] }],
  });
  Y.applyUpdate(a, stateOf(nodes.paragraph.create(null,
    schema.text('Concurrent review', [marks.comment.create({ commentId: parentId })]))));
  a.getMap('comments').set(String(parentId), make(parentId, 'Shared parent'));
  a.getMap('meta').set('commentsInitialized', true);
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  const idA = createAnnotationIdAllocator(() => a.clientID, id => a.getMap('comments').has(String(id)))();
  const idB = createAnnotationIdAllocator(() => b.clientID, id => b.getMap('comments').has(String(id)))();
  assert.notEqual(idA, idB);
  a.getMap('comments').set(String(idA), make(idA, 'Concurrent reply A', parentId));
  b.getMap('comments').set(String(idB), make(idB, 'Concurrent reply B', parentId));
  Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
  Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
  assert.equal(a.getMap('comments').size, 3);
  const originalState = Y.encodeStateAsUpdate(a);
  for (const base of [undefined, await blankBase()]) {
    const saved = await serializeYDocToDocx({ state: originalState, base });
    const xml = (await part(saved, 'word/comments.xml'))!;
    assert.match(xml, /Concurrent reply A/); assert.match(xml, /Concurrent reply B/);
    const ids = [...xml.matchAll(/w:id="(\d+)"/g)].map(m => Number(m[1]));
    assert.equal(new Set(ids).size, 3);
    assert.ok(ids.every(id => id >= 0 && id <= 0x7ffffffe));
    const body = (await part(saved, 'word/document.xml'))!;
    const anchor = Number(body.match(/commentRangeStart w:id="(\d+)"/)?.[1]);
    assert.ok(ids.includes(anchor));
    for (const id of ids) assert.ok(body.includes(`<w:commentReference w:id="${id}"`), 'each reply has a document anchor');
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, await docxToYDocState(saved));
    const comments = [...recovered.getMap('comments').values()] as { parentId?: number }[];
    assert.equal(comments.filter(c => c.parentId === anchor).length, 2);
    recovered.destroy();
  }
  assert.deepEqual(Y.encodeStateAsUpdate(a), originalState, 'export must not change live collaboration IDs');
  a.destroy(); b.destroy();
});

test('a reply to a tracked change has an anchor in the saved document', async () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stateOf(nodes.paragraph.create(null, schema.text('Suggested text', [
    marks.insertion.create({ revisionId: 7, author: 'Reviewer', date: '2026-11-19T00:00:00Z' }),
  ]))));
  const id = 2 ** 45;
  doc.getMap('comments').set(String(id), { id, parentId: 7, author: 'Other reviewer', content: [
    { type: 'paragraph', content: [{ type: 'run', content: [{ type: 'text', text: 'Review this suggestion' }] }] },
  ] });
  const saved = await serializeYDocToDocx({ state: Y.encodeStateAsUpdate(doc) });
  const comments = (await part(saved, 'word/comments.xml'))!;
  const exportedId = comments.match(/w:id="(\d+)"/)?.[1];
  assert.ok(exportedId);
  assert.match(comments, /Review this suggestion/);
  const body = (await part(saved, 'word/document.xml'))!;
  assert.ok(body.includes(`<w:commentRangeStart w:id="${exportedId}"`));
  assert.ok(body.includes(`<w:commentReference w:id="${exportedId}"`));
  assert.ok(body.includes('<w:ins w:id="7"'));
  doc.destroy();
});

test('shared comments and replies survive export and recovery, including deleting all comments', async () => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, stateOf(nodes.paragraph.create(null,
    schema.text('Annotated document', [marks.comment.create({ commentId: 1 })]))));
  const comments = doc.getMap('comments');
  const make = (id: number, text: string, parentId?: number) => ({
    id, author: 'Synthetic reviewer', parentId,
    content: [{ type: 'paragraph', content: [{ type: 'run', content: [{ type: 'text', text }] }] }],
  });
  comments.set('1', make(1, 'Original thread'));
  comments.set('2', make(2, 'Reply survives recovery', 1));
  doc.getMap('meta').set('commentsInitialized', true);
  for (const base of [undefined, await blankBase()]) {
    const saved = await serializeYDocToDocx({ state: Y.encodeStateAsUpdate(doc), base });
    assert.match((await part(saved, 'word/comments.xml')) ?? '', /Reply survives recovery/);
    assert.match((await part(saved, 'word/document.xml')) ?? '', /commentRangeStart w:id="1"/);
    assert.match((await part(saved, 'word/_rels/document.xml.rels')) ?? '', /relationships\/comments"/);
    const legacy = await serializeYDocToDocx({ state: stateOf(paragraph(null, 'Legacy room')), base: saved });
    assert.match((await part(legacy, 'word/comments.xml')) ?? '', /Reply survives recovery/);
    const recovered = new Y.Doc();
    Y.applyUpdate(recovered, await docxToYDocState(saved));
    assert.equal(recovered.getMap('comments').size, 2);
    assert.equal((recovered.getMap('comments').get('2') as { parentId: number }).parentId, 1);
    recovered.getMap('comments').clear();
    const deleted = await serializeYDocToDocx({ state: Y.encodeStateAsUpdate(recovered), base: saved });
    assert.doesNotMatch((await part(deleted, 'word/comments.xml')) ?? '', /Original thread|Reply survives recovery/);
    recovered.destroy();
  }
  doc.destroy();
});

for (const [label, base] of [['no base', () => Promise.resolve(undefined)], ['a blank base', () => blankBase()]] as const) {
  test(`with ${label}, every list and style the body uses is defined`, async () => {
    const docx = await serializeYDocToDocx({ state: stateOf(...report()), name: 'a.docx', base: await base() });

    const body = await part(docx, 'word/document.xml');
    assert.match(body!, /<w:pStyle w:val="Title"\/>/);
    assert.match(body!, /<w:b\/>[\s\S]*>bold</);
    assert.match(body!, /<w:numId w:val="1"\/>/);
    assert.match(body!, /<w:numId w:val="2"\/>/);

    const numbering = await part(docx, 'word/numbering.xml');
    assert.match(numbering!, /<w:num w:numId="1"><w:abstractNumId w:val="0"\/>/);
    assert.match(numbering!, /<w:num w:numId="2"><w:abstractNumId w:val="1"\/>/);
    assert.ok(numbering!.indexOf('<w:abstractNum ') < numbering!.indexOf('<w:num '), 'the schema requires this order');
    assert.match(numbering!, /w:abstractNumId="0">[\s\S]*?<w:numFmt w:val="bullet"\/>/);
    assert.match(numbering!, /w:abstractNumId="1">[\s\S]*?<w:numFmt w:val="decimal"\/>/);

    assert.match((await part(docx, 'word/styles.xml'))!, /w:styleId="Title"/);

    const types = await part(docx, '[Content_Types].xml');
    assert.match(types!, /PartName="\/word\/numbering\.xml"/);
    assert.match(types!, /PartName="\/word\/styles\.xml"/);

    const rels = await part(docx, 'word/_rels/document.xml.rels');
    assert.match(rels!, /relationships\/numbering" Target="numbering\.xml"/);
    assert.match(rels!, /relationships\/styles" Target="styles\.xml"/);
    const ids = [...rels!.matchAll(/\bId="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(ids).size, ids.length, 'relationship ids are unique');
  });
}

test('a file\'s own definitions are left alone, and only what is missing is added', async () => {
  const theirs = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}><w:abstractNum w:abstractNumId="5"><w:lvl w:ilvl="0"><w:numFmt w:val="upperRoman"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="5"/></w:num></w:numbering>`;
  const docx = await serializeYDocToDocx({
    state: stateOf(...report()),
    name: 'a.docx',
    base: await blankBase({
      'word/numbering.xml': theirs,
      'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:sz w:val="99"/></w:rPr></w:style></w:styles>`,
    }),
  });

  const numbering = await part(docx, 'word/numbering.xml');
  assert.match(numbering!, /upperRoman/, 'their list definition survives');
  assert.match(numbering!, /<w:num w:numId="1"><w:abstractNumId w:val="5"\/>/, 'and still answers to its number');
  assert.match(numbering!, /<w:num w:numId="2"><w:abstractNumId w:val="6"\/>/, 'the missing one gets a free id');
  assert.ok(numbering!.lastIndexOf('<w:abstractNum ') < numbering!.indexOf('<w:num '), 'order holds when merging');

  const styles = await part(docx, 'word/styles.xml');
  assert.match(styles!, /<w:sz w:val="99"\/>/, 'their Title is kept');
  assert.equal(styles!.match(/w:styleId="Title"/g)?.length, 1, 'and not defined twice');
});

test('plain text in a file with no styles opens in the font it was written in', async () => {
  const docx = await serializeYDocToDocx({ state: stateOf(paragraph(null, 'Plain')), name: 'a.docx', base: await blankBase() });

  const styles = await part(docx, 'word/styles.xml');
  assert.match(styles!, /<w:rFonts w:ascii="Arial"/);
  assert.match(styles!, /<w:sz w:val="22"\/>/);
  assert.match((await part(docx, '[Content_Types].xml'))!, /PartName="\/word\/styles\.xml"/);
});

test('a file\'s own defaults are not replaced', async () => {
  const docx = await serializeYDocToDocx({
    state: stateOf(paragraph(null, 'Plain')),
    name: 'a.docx',
    base: await blankBase({
      'word/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Georgia"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`,
    }),
  });

  const styles = await part(docx, 'word/styles.xml');
  assert.match(styles!, /Georgia/);
  assert.doesNotMatch(styles!, /Arial/);
});

test('an empty document needs no definitions and adds none', async () => {
  const docx = await serializeYDocToDocx({ state: stateOf(paragraph(null)), name: 'a.docx', base: await blankBase() });

  assert.equal(await part(docx, 'word/numbering.xml'), undefined);
  assert.equal(await part(docx, 'word/styles.xml'), undefined);
  assert.doesNotMatch((await part(docx, 'word/document.xml'))!, /<w:t[ >]/);
});

test('text survives a repeated save on its own output', async () => {
  const first = await serializeYDocToDocx({ state: stateOf(...report()), name: 'a.docx', base: await blankBase() });
  const second = await serializeYDocToDocx({ state: stateOf(...report()), name: 'a.docx', base: first });

  const numbering = await part(second, 'word/numbering.xml');
  assert.equal(numbering!.match(/<w:num /g)?.length, 2, 'definitions do not accumulate');
  assert.match((await part(second, 'word/document.xml'))!, />A bullet</);
});

const fragmentText = (state: Uint8Array) => {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return doc.getXmlFragment('prosemirror').toString().replace(/<[^>]*>/g, '');
};

test('a file becomes a room holding what it says', async () => {
  const docx = await serializeYDocToDocx({ state: stateOf(...report()), name: 'a.docx', base: await blankBase() });

  const text = fragmentText(await docxToYDocState(docx));

  assert.match(text, /A Title/);
  assert.match(text, /A bullet/);
  assert.equal(text.split('A Title').length - 1, 1, 'once');
});

test('and that room saves back to a file saying the same thing', async () => {
  const original = await serializeYDocToDocx({ state: stateOf(...report()), name: 'a.docx', base: await blankBase() });

  const again = await serializeYDocToDocx({ state: await docxToYDocState(original), name: 'a.docx', base: original });

  const words = (xml: string) => [...xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
  assert.equal(words((await part(again, 'word/document.xml'))!), words((await part(original, 'word/document.xml'))!));
});

test('a blank file becomes a room with one empty paragraph in it', async () => {
  const state = await docxToYDocState(await blankBase());

  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  assert.equal(doc.getXmlFragment('prosemirror').length, 1);
  assert.equal(fragmentText(state), '');
});

test('the first person to open it has nothing to add to it', async () => {
  const docx = await serializeYDocToDocx({ state: stateOf(...report()), name: 'a.docx', base: await blankBase() });
  const doc = new Y.Doc();
  Y.applyUpdate(doc, await docxToYDocState(docx));

  const ids = (doc.getXmlFragment('prosemirror').toArray() as Y.XmlElement[]).map((p) => p.getAttribute('paraId'));

  assert.ok(ids.length >= 4);
  assert.ok(ids.every((id) => /^[0-9A-F]{8}$/.test(String(id))), ids.join());
  assert.equal(new Set(ids).size, ids.length, 'each its own');
});

test('something that is not a Word file is refused, not turned into an empty room', async () => {
  await assert.rejects(docxToYDocState(new TextEncoder().encode('not a word document')));
});
