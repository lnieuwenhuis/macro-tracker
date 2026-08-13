/**
 * Idempotency keys for meal-entry creates.
 *
 * The backend already has the unique index and the `ON CONFLICT DO NOTHING`
 * for `client_mutation_id`, but nothing was sending one — so a mobile
 * double-tap, or a retry after a slow-but-successful save, wrote two identical
 * entries.
 *
 * An id is minted once per *intent* (identified by `key`) and reused until the
 * intent settles, which is what makes the repeat attempt dedupe rather than
 * duplicate.
 */
export type ClientMutationIdStore = {
  take: (key: string) => string;
  settle: (key: string) => void;
};

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // Older WebViews without `crypto.randomUUID`. Collisions here only cost a
  // dropped duplicate, and the value is scoped to one user's row.
  return `mt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function createClientMutationIdStore(): ClientMutationIdStore {
  const ids = new Map<string, string>();

  return {
    take(key) {
      const existing = ids.get(key);
      if (existing) {
        return existing;
      }

      const id = randomId();
      ids.set(key, id);
      return id;
    },
    settle(key) {
      ids.delete(key);
    },
  };
}
