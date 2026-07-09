export {
  assertSafeDestructiveTestDatabaseUrl,
  resolveDestructiveTestDatabaseUrl,
} from "./test-database-safety";

export async function createTestDatabase() {
  const { createMigratedTestDatabase } = await import("./migration");
  return createMigratedTestDatabase();
}

export async function migrateTestDatabase(connectionString: string) {
  const { migrateDatabaseUrl } = await import("./migration");
  return migrateDatabaseUrl(connectionString);
}
