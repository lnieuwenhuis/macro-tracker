export {
  assertSafeDestructiveTestDatabaseUrl,
  resolveDestructiveTestDatabaseUrl,
} from "./test-database-safety";

export async function createTestDatabase() {
  const { createMigratedTestDatabase } = await import("./migration");
  return createMigratedTestDatabase();
}
