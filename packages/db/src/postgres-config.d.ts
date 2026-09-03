export function isPgliteConnectionString(connectionString: string): boolean;

export function isLocalDatabaseHost(hostname: string): boolean;

export function readPositiveIntegerEnv(name: string, fallback: number): number;

export function getSslConfig(
  connectionString: string,
  env?: Record<string, string | undefined>,
): false | { rejectUnauthorized: boolean };

export type PostgresConnectionConfigOverrides = Partial<{
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  allowExitOnIdle: boolean;
}>;

export function getPostgresConnectionConfig(
  connectionString: string,
  overrides?: PostgresConnectionConfigOverrides,
): {
  connectionString: string;
  ssl: false | { rejectUnauthorized: boolean };
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
  allowExitOnIdle: boolean;
};
