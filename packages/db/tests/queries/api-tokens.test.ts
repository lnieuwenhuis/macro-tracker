import {
  authenticateApiToken,
  createApiToken,
  listApiTokens,
  revokeApiToken,
  type DatabaseRuntime,
} from "../../src";
import { apiTokens } from "../../src/schema";
import { setupSingleUserContext } from "../helpers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("API token queries", () => {
  let runtime: DatabaseRuntime;
  let userId: string;

  beforeEach(async () => {
    ({ runtime, userId } = await setupSingleUserContext());
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("creates API tokens as one-time-visible secrets with stored hashes", async () => {
    const created = await createApiToken(
      userId,
      {
        name: "Mobile app",
        scopes: ["read:daily", "write:daily"],
      },
    );

    expect(created.token).toMatch(/^mtk_v1_/);
    const rawTokenSecretPrefix = created.token.slice("mtk_v1_".length, 19);
    expect(created.record).toMatchObject({
      userId,
      tokenPrefix: expect.stringMatching(/^mtk_v1_[a-f0-9]{12}$/),
      name: "Mobile app",
      scopes: ["read:daily", "write:daily"],
      lastUsedAt: null,
      revokedAt: null,
    });
    expect(created.record.tokenPrefix).not.toContain(rawTokenSecretPrefix);
    expect(created.record.expiresAt).toBeTruthy();

    const [stored] = await runtime.db.select().from(apiTokens);
    expect(stored?.tokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(stored?.tokenHash).not.toBe(created.token);
    expect(stored?.tokenPrefix).not.toContain(rawTokenSecretPrefix);

    const listed = await listApiTokens(userId);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.tokenPrefix).not.toContain(rawTokenSecretPrefix);
    expect(JSON.stringify(listed)).not.toContain(stored!.tokenHash);
    expect(JSON.stringify(listed)).not.toContain(created.token);
  });

  it("supports never-expiring API tokens explicitly", async () => {
    const created = await createApiToken(
      userId,
      {
        name: "No expiry",
        scopes: ["read:stats"],
        expiresAt: null,
      },
    );

    expect(created.record.expiresAt).toBeNull();
  });

  it("validates and dedupes API token scopes", async () => {
    await expect(
      createApiToken(userId, { name: "Empty", scopes: [] }),
    ).rejects.toThrow("API token must include at least one scope.");
    await expect(
      createApiToken(userId, { name: "Bad", scopes: ["read:daily", "admin:*"] }),
    ).rejects.toThrow("API token scope is invalid.");

    const created = await createApiToken(
      userId,
      {
        name: "Duplicates",
        scopes: ["read:daily", "write:daily", "read:daily"],
      },
    );

    expect(created.record.scopes).toEqual(["read:daily", "write:daily"]);
  });

  it("rejects invalid API token expiry strings with validation errors", async () => {
    await expect(
      createApiToken(
        userId,
        {
          name: "Bad expiry",
          scopes: ["read:daily"],
          expiresAt: "not-a-date",
        },
      ),
    ).rejects.toThrow("API token expiry is invalid.");
  });

  it("defaults API token expiry to about ninety days", async () => {
    const before = Date.now();
    const created = await createApiToken(
      userId,
      {
        name: "Default expiry",
        scopes: ["read:daily"],
      },
    );
    const after = Date.now();
    const expiresAt = new Date(created.record.expiresAt!).getTime();

    expect(expiresAt).toBeGreaterThanOrEqual(before + 89 * 24 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 91 * 24 * 60 * 60 * 1000);
  });

  it("authenticates valid API tokens and updates last-used time", async () => {
    const created = await createApiToken(
      userId,
      {
        name: "Reader",
        scopes: ["read:daily"],
      },
    );

    const result = await authenticateApiToken(created.token);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.token.userId).toBe(userId);
      expect(result.token.scopes).toEqual(["read:daily"]);
      expect(result.token.lastUsedAt).toBeTruthy();
    }

    const listed = await listApiTokens(userId);
    expect(listed[0]?.lastUsedAt).toBeTruthy();
  });

  it("throttles API token last-used updates within a short window", async () => {
    const created = await createApiToken(
      userId,
      {
        name: "Reader",
        scopes: ["read:daily"],
      },
    );

    const first = await authenticateApiToken(created.token);
    expect(first.ok).toBe(true);
    const firstLastUsedAt = first.ok ? first.token.lastUsedAt : null;
    expect(firstLastUsedAt).toBeTruthy();

    const second = await authenticateApiToken(created.token);
    expect(second.ok).toBe(true);
    expect(second.ok ? second.token.lastUsedAt : null).toEqual(firstLastUsedAt);
    const [storedAfterSecond] = await runtime.db.select().from(apiTokens);
    expect(new Date(storedAfterSecond!.lastUsedAt!).getTime()).toBe(
      new Date(firstLastUsedAt!).getTime(),
    );

    const staleLastUsedAt = new Date(Date.now() - 10 * 60 * 1000);
    await runtime.db
      .update(apiTokens)
      .set({ lastUsedAt: staleLastUsedAt })
      .where(eq(apiTokens.id, created.record.id));

    const stale = await authenticateApiToken(created.token);
    expect(stale.ok).toBe(true);
    expect(stale.ok ? new Date(stale.token.lastUsedAt!).getTime() : 0).toBeGreaterThan(
      staleLastUsedAt.getTime(),
    );
  });

  it("rejects malformed, unknown, expired, and revoked API tokens", async () => {
    await expect(authenticateApiToken(null)).resolves.toEqual({
      ok: false,
      reason: "missing",
    });
    await expect(authenticateApiToken("not-a-token")).resolves.toEqual({
      ok: false,
      reason: "malformed",
    });
    await expect(
      authenticateApiToken("mtk_v1_unknown"),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid",
    });

    const expired = await createApiToken(
      userId,
      {
        name: "Expired",
        scopes: ["read:daily"],
        expiresAt: new Date(Date.now() - 60_000),
      },
    );
    await expect(authenticateApiToken(expired.token)).resolves.toEqual({
      ok: false,
      reason: "expired",
    });
    await expect(listApiTokens(userId)).resolves.toContainEqual(
      expect.objectContaining({
        id: expired.record.id,
        lastUsedAt: null,
      }),
    );

    const active = await createApiToken(
      userId,
      {
        name: "Revoked",
        scopes: ["read:daily"],
      },
    );
    await expect(
      revokeApiToken(userId, active.record.id),
    ).resolves.toBe(true);
    await expect(authenticateApiToken(active.token)).resolves.toEqual({
      ok: false,
      reason: "revoked",
    });
    await expect(listApiTokens(userId)).resolves.toContainEqual(
      expect.objectContaining({
        id: active.record.id,
        lastUsedAt: null,
      }),
    );
  });
});
