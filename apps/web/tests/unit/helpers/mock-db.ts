import { vi } from "vitest";

type DbRegistry = Record<string, unknown>;

// Every real @macro-tracker/db export gets `mocked`'s same-named value, or a
// no-op vi.fn(); unmatched `mocked` keys (mocks for other modules) are dropped.
export async function mockDbModule(mocked: DbRegistry): Promise<DbRegistry> {
  const actual = await vi.importActual<DbRegistry>("@macro-tracker/db");
  return Object.fromEntries(Object.keys(actual).map((key) => [key, mocked[key] ?? vi.fn()]));
}
