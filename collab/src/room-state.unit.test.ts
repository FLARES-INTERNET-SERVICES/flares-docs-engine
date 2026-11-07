import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { reportRoomState } from './room-state.js';

function encode(build: (fragment: Y.XmlFragment, doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  doc.transact(() => build(doc.getXmlFragment('prosemirror'), doc));
  return Y.encodeStateAsUpdate(doc);
}

function paragraph(text?: string): Y.XmlElement {
  const element = new Y.XmlElement('paragraph');
  if (text !== undefined) {
    const node = new Y.XmlText();
    node.insert(0, text);
    element.insert(0, [node]);
  }
  return element;
}

test('a room with nothing stored says so, rather than reporting an empty document', () => {
  assert.deepEqual(reportRoomState(null), { exists: false });
});

test('a room with only the empty starting paragraph has no content', () => {
  const report = reportRoomState(encode((f) => f.insert(0, [paragraph()])));
  assert.equal(report.exists && !report.unchanged && report.hasContent, false);
});

test('a room with no fragment at all has no content', () => {
  const report = reportRoomState(encode(() => undefined));
  assert.equal(report.exists && !report.unchanged && report.hasContent, false);
});

test('text is content, and the state round-trips', () => {
  const update = encode((f) => f.insert(0, [paragraph('hello')]));
  const report = reportRoomState(update);
  assert.ok(report.exists && !report.unchanged);
  assert.equal(report.hasContent, true);

  const restored = new Y.Doc();
  Y.applyUpdate(restored, Buffer.from(report.state, 'base64'));
  assert.match(restored.getXmlFragment('prosemirror').toString(), /hello/);
});

test('text deleted back to nothing is no content, but keeps its history in the vector', () => {
  const doc = new Y.Doc();
  const element = paragraph('gone soon');
  doc.getXmlFragment('prosemirror').insert(0, [element]);
  const before = Y.encodeStateVector(doc);
  (element.get(0) as Y.XmlText).delete(0, 'gone soon'.length);

  const report = reportRoomState(Y.encodeStateAsUpdate(doc));
  assert.ok(report.exists && !report.unchanged);
  assert.equal(report.hasContent, false);
  assert.deepEqual([...Buffer.from(report.vector, 'base64')], [...before]);
});

test('a table with no text in it is still content', () => {
  const report = reportRoomState(encode((f) => f.insert(0, [new Y.XmlElement('table')])));
  assert.equal(report.exists && !report.unchanged && report.hasContent, true);
});

test('a known fingerprint is answered without the bytes', () => {
  const update = encode((f) => f.insert(0, [paragraph('same')]));
  const first = reportRoomState(update);
  assert.ok(first.exists);

  const second = reportRoomState(update, first.fingerprint);
  assert.deepEqual(second, { exists: true, unchanged: true, fingerprint: first.fingerprint });
});

test('a stale fingerprint gets the bytes', () => {
  const report = reportRoomState(encode((f) => f.insert(0, [paragraph('new')])), 'not-the-fingerprint');
  assert.ok(report.exists && !report.unchanged);
  assert.ok(report.state.length > 0);
});
