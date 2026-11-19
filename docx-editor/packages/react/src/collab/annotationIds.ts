/**
 * Give each Yjs client a separate numeric lane. Yjs already requires unique
 * uint32 client IDs for concurrent writers. Twenty counter bits leave every
 * generated ID exactly representable by JavaScript (at most 2^52 - 1).
 * Read the client ID on each allocation because Yjs can change it on conflict.
 * Imported IDs must be checked by the caller through isUsed.
 */
const LANE_SIZE = 2 ** 20;

export function createAnnotationIdAllocator(
  getClientId: () => number,
  isUsed: (id: number) => boolean = () => false
): () => number {
  const counters = new Map<number, number>();
  return () => {
    const clientId = getClientId();
    if (!Number.isInteger(clientId) || clientId < 0 || clientId > 0xffffffff) {
      throw new Error('Invalid collaboration client ID');
    }
    let counter = counters.get(clientId) ?? 1;
    while (counter < LANE_SIZE) {
      const id = clientId * LANE_SIZE + counter++;
      counters.set(clientId, counter);
      if (!isUsed(id)) return id;
    }
    // Never wrap into another client's lane or silently reuse an ID.
    throw new Error('Annotation ID range exhausted; reconnect before adding more annotations');
  };
}
