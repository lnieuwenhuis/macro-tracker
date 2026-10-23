import { vi } from "vitest";

type DbRegistry = Record<string, unknown>;

// Unconfigured db functions become no-op vi.fn(); non-function exports (constants) stay real so
// shared runtime values such as the internal-field list keep working under mocks.
export async function mockDbModule(mocked: DbRegistry): Promise<DbRegistry> {
  const actual = await vi.importActual<DbRegistry>("@macro-tracker/db");
  return Object.fromEntries(
    Object.keys(actual).map((key) => [
      key,
      mocked[key] ?? (typeof actual[key] === "function" ? vi.fn() : actual[key]),
    ]),
  );
}
