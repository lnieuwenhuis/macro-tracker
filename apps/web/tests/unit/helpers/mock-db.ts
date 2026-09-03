import { vi } from "vitest";

type DbRegistry = Record<string, unknown>;

// Unconfigured db exports become no-op vi.fn(); keys for other modules are dropped.
export async function mockDbModule(mocked: DbRegistry): Promise<DbRegistry> {
  const actual = await vi.importActual<DbRegistry>("@macro-tracker/db");
  return Object.fromEntries(Object.keys(actual).map((key) => [key, mocked[key] ?? vi.fn()]));
}
