export function createLazyCollectionLoader<T>(loadCollection: () => Promise<T>) {
  let cached: T | undefined;
  let inFlight: Promise<T> | null = null;

  return {
    async load() {
      if (cached !== undefined) {
        return cached;
      }
      if (inFlight) {
        return inFlight;
      }

      inFlight = loadCollection()
        .then((value) => {
          cached = value;
          return value;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}
