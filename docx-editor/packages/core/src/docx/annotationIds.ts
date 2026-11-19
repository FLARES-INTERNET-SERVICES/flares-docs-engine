import type { Document } from '../types/document';

const MAX_WORD_ID = 0x7ffffffe;
type RecordValue = Record<string, unknown>;

function isPlain(value: unknown): value is RecordValue {
  return (
    value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype
  );
}

function isAnnotation(value: RecordValue): boolean {
  return (
    typeof value.id === 'number' &&
    (typeof value.author === 'string' ||
      value.type === 'commentRangeStart' ||
      value.type === 'commentRangeEnd')
  );
}

/**
 * Collaboration IDs can exceed Word's signed integer range. Remap only at the
 * export boundary, including anchors, replies and tracked-change metadata.
 * Never mutate the live document, and reserve existing IDs before allocating.
 */
export function normalizeAnnotationIds(doc: Document): Document {
  const used = new Set<number>();
  const oversized = new Set<number>();
  const scan = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(scan);
      return;
    }
    if (value instanceof Map) {
      value.forEach(scan);
      return;
    }
    if (!isPlain(value)) return;
    if (isAnnotation(value)) {
      const id = value.id as number;
      if (!Number.isSafeInteger(id) || id < 0) throw new Error('Invalid annotation ID');
      if (id > MAX_WORD_ID) oversized.add(id);
      else used.add(id);
      if (typeof value.parentId === 'number') {
        if (!Number.isSafeInteger(value.parentId) || value.parentId < 0)
          throw new Error('Invalid parent annotation ID');
        if (value.parentId > MAX_WORD_ID) oversized.add(value.parentId);
        else used.add(value.parentId);
      }
    }
    Object.values(value).forEach(scan);
  };
  scan(doc.package);
  if (oversized.size === 0) return doc;
  const ids = new Map<number, number>();
  let next = 1;
  for (const id of [...oversized].sort((a, b) => a - b)) {
    while (used.has(next)) next++;
    if (next > MAX_WORD_ID) throw new Error('Word annotation ID space exhausted');
    ids.set(id, next);
    used.add(next++);
  }
  const copy = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(copy);
    if (value instanceof Map) return new Map([...value].map(([key, item]) => [key, copy(item)]));
    if (!isPlain(value)) return value;
    const result = Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, copy(item)])
    );
    if (isAnnotation(value)) {
      result.id = ids.get(value.id as number) ?? value.id;
      if (typeof value.parentId === 'number')
        result.parentId = ids.get(value.parentId) ?? value.parentId;
    }
    return result;
  };
  return { ...doc, package: copy(doc.package) as Document['package'] };
}
