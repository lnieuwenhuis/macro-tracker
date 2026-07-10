const backendUrl = (process.env.BACKEND_URL ?? "http://127.0.0.1:4000").replace(/\/$/, "");
const backendInternalSecret = process.env.BACKEND_INTERNAL_SECRET?.trim();

function fail(message: string): never {
  console.error(
    [
      "@macro-tracker/db tests require the Rust backend to be running before Vitest starts.",
      message,
      "Start the backend with the same DATABASE_URL used by these tests and set the matching BACKEND_INTERNAL_SECRET.",
      `Current BACKEND_URL: ${backendUrl}`,
    ].join("\n"),
  );
  process.exit(1);
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  if (!backendInternalSecret) {
    fail("BACKEND_INTERNAL_SECRET is not set for the DB test process.");
  }

  let health: Response;
  try {
    health = await fetchWithTimeout(`${backendUrl}/health`);
  } catch (error) {
    fail(
      `Could not reach the Rust backend health check: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!health.ok) {
    fail(`Rust backend health check failed with HTTP ${health.status}.`);
  }

  let rpc: Response;
  try {
    rpc = await fetchWithTimeout(`${backendUrl}/internal/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-backend-internal-secret": backendInternalSecret,
      },
      body: JSON.stringify({ op: "__db_test_preflight__", args: {} }),
    });
  } catch (error) {
    fail(
      `Could not reach the Rust backend internal RPC endpoint: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const body = await rpc.text().catch(() => "");
  if (rpc.status === 404 && body.includes("Unknown backend operation")) {
    return;
  }

  if (rpc.status === 401 || rpc.status === 403) {
    fail(
      "Rust backend rejected the internal RPC preflight. BACKEND_INTERNAL_SECRET does not match the running backend.",
    );
  }

  fail(
    `Rust backend internal RPC preflight returned unexpected HTTP ${rpc.status}${body ? `: ${body}` : ""}.`,
  );
}

await main();

export {};
