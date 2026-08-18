/**
 * @vitest-environment jsdom
 *
 * TEST-02: `api-token-actions.test.ts` mocks `ApiSettingsClient` out
 * entirely (`ApiSettingsClient: () => null`), so the one surface where a raw
 * API token secret is shown -- exactly once -- had no coverage at any level.
 *
 * A second auditor read `components/api-settings-client.tsx` and found it
 * correct: the raw token only ever lives in `useActionState`'s `state.token`,
 * which is replaced (and so cleared) by the *next* `createApiTokenAction`
 * result -- success or failure -- and is never written to localStorage, a
 * URL, or a log. This test renders the real component against a real test
 * database and proves that guarantee holds at runtime: create -> reveal
 * once -> the secret is gone as soon as another action result lands, and
 * revoking the token (a real, DB-backed action) never brings it back.
 */
import { randomUUID } from "node:crypto";

import { getApiScopes, listApiTokens, upsertUserFromShooProfile } from "@macro-tracker/db";
import { resolveDestructiveTestDatabaseUrl } from "@macro-tracker/db/testing";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  userId: "",
  requireOnboardedSessionUser: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireOnboardedSessionUser: mocked.requireOnboardedSessionUser,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocked.revalidatePath,
}));

import { ApiSettingsClient } from "@/components/api-settings-client";

// `upsertUserFromShooProfile`/`listApiTokens`/etc. from `@macro-tracker/db`
// go over the backend RPC client (BACKEND_URL/BACKEND_INTERNAL_SECRET), not a
// local drizzle connection -- so no `DatabaseRuntime` is needed to call them.
// A raw `pg` pool (mirroring `tests/e2e/global-setup.ts`) is only needed here
// to truncate between tests. `@macro-tracker/db/testing`'s `createTestDatabase`
// is deliberately avoided: it resolves its migrations folder from
// `import.meta.url` via a dynamic `import()`, which Vite/Vitest resolve
// against the jsdom document location (not the filesystem) in this
// environment, and this file needs `jsdom` to render with Testing Library.
let pool: Pool;

beforeAll(() => {
  const connectionString = resolveDestructiveTestDatabaseUrl(process.env, {
    explicitEnvNames: ["TEST_DATABASE_URL"],
    purpose: "api-settings-client unit tests",
  });
  if (!connectionString) {
    throw new Error("TEST_DATABASE_URL is required for api-settings-client tests.");
  }
  pool = new Pool({ connectionString });
});

afterAll(async () => {
  await pool.end();
});

describe("ApiSettingsClient", () => {
  beforeEach(async () => {
    await pool.query(
      "TRUNCATE TABLE api_tokens, users RESTART IDENTITY CASCADE",
    );
    const testUserKey = randomUUID();
    const user = await upsertUserFromShooProfile({
      pairwiseSub: `api-settings-client-${testUserKey}`,
      email: `api-settings-client-${testUserKey}@example.com`,
    });
    mocked.userId = user.id;
    mocked.requireOnboardedSessionUser.mockResolvedValue({
      userId: user.id,
      email: user.email,
    });
    mocked.revalidatePath.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  async function createTokenThroughForm(name: string, previousSecret?: string) {
    fireEvent.change(screen.getByLabelText("Token name"), {
      target: { value: name },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));

    // Scoped to the "New token" reveal section: the token list below also
    // renders each token's (truncated) `tokenPrefix`, which matches the same
    // "mtk_v1_<hex>" shape and would otherwise make this query ambiguous.
    //
    // The reveal `<section>` itself does not unmount between two successful
    // creations (only its text content changes), so this must wait for the
    // *content* to update rather than just for the section to appear --
    // otherwise it can observe the still-present previous reveal.
    const secret = await waitFor(() => {
      const revealHeading = screen.getByText("New token");
      const revealSection = revealHeading.closest("section");
      if (!revealSection) {
        throw new Error("Expected a 'New token' reveal section.");
      }
      const secretParagraph = within(revealSection).getByText(/^mtk_v1_[0-9a-f]/);
      const value = secretParagraph.textContent;
      if (!value || value === previousSecret) {
        throw new Error("Still waiting for the new token secret to render.");
      }
      return value;
    });
    return secret;
  }

  it("reveals a newly created token exactly once and clears it once another action result lands", async () => {
    render(<ApiSettingsClient tokens={[]} scopes={getApiScopes()} />);

    const secretA = await createTokenThroughForm("Shortcut A");
    expect(secretA).toMatch(/^mtk_v1_/);
    expect(
      screen.getByText("Copy this now. It will not be shown again."),
    ).not.toBeNull();

    // Creating a second token replaces `state.token` -- the only place the
    // raw secret ever lives -- with the new result. The first secret must be
    // gone from the DOM, not just visually superseded.
    const secretB = await createTokenThroughForm("Shortcut B", secretA);
    expect(secretB).toMatch(/^mtk_v1_/);
    expect(secretB).not.toBe(secretA);
    expect(screen.queryByText(secretA)).toBeNull();
    // Only one "New token" reveal section is ever on screen at a time.
    expect(screen.getAllByText("New token")).toHaveLength(1);

    // A *failing* action result also clears the previously revealed secret,
    // since `state.token` is only ever set on a successful creation.
    fireEvent.change(screen.getByLabelText("Token name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText("API token name is required.");
    expect(screen.queryByText(secretB)).toBeNull();
    expect(screen.queryByText("New token")).toBeNull();

    // The raw secrets were never persisted anywhere the server can read back
    // -- the DB only ever has the hashed/prefixed record.
    const stored = await listApiTokens(mocked.userId);
    expect(stored).toHaveLength(2);
    for (const record of stored) {
      expect(JSON.stringify(record)).not.toContain(secretA);
      expect(JSON.stringify(record)).not.toContain(secretB);
    }
  });

  it("never sends the raw secret to the revoke action, and never re-displays it after revoking", async () => {
    render(<ApiSettingsClient tokens={[]} scopes={getApiScopes()} />);

    const secret = await createTokenThroughForm("Shortcut");
    const [createdRecord] = await listApiTokens(mocked.userId);
    expect(createdRecord?.revokedAt).toBeNull();

    // The revoke form only carries a hidden `tokenId` field -- confirm the
    // raw secret never appears anywhere outside the one-time reveal box, in
    // particular not inside the revoke form itself.
    const revokeForm = screen.getByRole("button", { name: "Revoke" }).closest("form");
    if (!revokeForm) {
      throw new Error("Expected a revoke form.");
    }
    expect(revokeForm.innerHTML).not.toContain(secret);

    // Double-tap confirm: first click arms the button, second submits.
    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const confirmButton = await screen.findByRole("button", {
      name: "Tap again to revoke",
    });
    fireEvent.click(confirmButton);

    await waitFor(async () => {
      const [revoked] = await listApiTokens(mocked.userId);
      expect(revoked?.revokedAt).toBeTruthy();
    });

    // Revoking runs through an entirely separate server action from the one
    // that revealed the secret (`useActionState(createApiTokenAction, ...)`)
    // and must not cause it to be shown again: the secret must still appear
    // exactly once (the original, untouched reveal), never duplicated into
    // the token list row (which only ever shows the truncated prefix).
    expect(screen.getAllByText(secret)).toHaveLength(1);
    const tokenArticle = screen.getByText("Shortcut").closest("article");
    if (!tokenArticle) {
      throw new Error("Expected a token list entry.");
    }
    expect(tokenArticle.textContent).not.toContain(secret);
  });
});
