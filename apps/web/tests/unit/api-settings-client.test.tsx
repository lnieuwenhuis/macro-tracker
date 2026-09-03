/**
 * @vitest-environment jsdom
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

// `createTestDatabase` is avoided here: it resolves migrations via
// `import.meta.url`, which Vitest resolves against the jsdom document
// location, not the filesystem, in this environment.
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

    // Scoped to the reveal section, since the token list below also renders
    // truncated prefixes matching the same shape; waits for the content to
    // change since the section itself persists across creations.
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

    // Creating a second token replaces `state.token` with the new result;
    // the first secret must be gone from the DOM, not just superseded.
    const secretB = await createTokenThroughForm("Shortcut B", secretA);
    expect(secretB).toMatch(/^mtk_v1_/);
    expect(secretB).not.toBe(secretA);
    expect(screen.queryByText(secretA)).toBeNull();
    expect(screen.getAllByText("New token")).toHaveLength(1);

    // `state.token` is only ever set on a successful creation, so a failing
    // action result also clears the previously revealed secret.
    fireEvent.change(screen.getByLabelText("Token name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create token" }));
    await screen.findByText("API token name is required.");
    expect(screen.queryByText(secretB)).toBeNull();
    expect(screen.queryByText("New token")).toBeNull();

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

    // The revoke form only carries a hidden `tokenId` field; confirm the raw
    // secret never leaks into it.
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

    // Revoking runs through a separate server action from the one that
    // revealed the secret and must not cause it to be shown again.
    expect(screen.getAllByText(secret)).toHaveLength(1);
    const tokenArticle = screen.getByText("Shortcut").closest("article");
    if (!tokenArticle) {
      throw new Error("Expected a token list entry.");
    }
    expect(tokenArticle.textContent).not.toContain(secret);
  });
});
