// Idempotency keys minted once per intent and reused until it settles, so a double-tap dedupes instead of duplicating.
export type ClientMutationIdStore = {
  take: (key: string) => string;
  settle: (key: string) => void;
};

function randomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // Fallback for older WebViews without crypto.randomUUID; a collision only costs a dropped duplicate.
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
