import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("deduplicates auth in a real RSC render and authenticates each new request", async () => {
  const { stdout } = await promisify(execFile)(process.execPath, [
    "--conditions=react-server",
    "tests/fixtures/auth-render.mjs",
  ], { timeout: 15_000 });
  expect(stdout).toContain("next-request revocation/logout fresh");
});
