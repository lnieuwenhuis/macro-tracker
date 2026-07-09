import {
  createApiToken,
  listApiTokens,
  setDatabaseRuntimeForTesting,
  upsertUserFromShooProfile,
  type ApiTokenRecord,
  type DatabaseRuntime,
} from "@macro-tracker/db";
import { createTestDatabase } from "@macro-tracker/db/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  userId: "",
  requireOnboardedSessionUser: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  requireOnboardedSessionUser: mocked.requireOnboardedSessionUser,
}));

vi.mock("@/components/api-settings-client", async (importOriginal) => ({
  ...((await importOriginal()) as object),
  ApiSettingsClient: () => null,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocked.revalidatePath,
}));

import {
  createApiTokenAction,
  revokeApiTokenAction,
} from "@/lib/api-token-actions";
import {
  API_TOKEN_PRESETS,
  getVisibleApiTokens,
} from "@/components/api-settings-client";
import ApiSettingsPage from "@/app/settings/api/page";

describe("API token settings actions", () => {
  let runtime: DatabaseRuntime;

  async function withBackendUrl<T>(url: string, operation: () => Promise<T>) {
    const previous = process.env.BACKEND_URL;
    process.env.BACKEND_URL = url;
    try {
      return await operation();
    } finally {
      if (previous === undefined) {
        delete process.env.BACKEND_URL;
      } else {
        process.env.BACKEND_URL = previous;
      }
    }
  }

  beforeEach(async () => {
    runtime = await createTestDatabase();
    setDatabaseRuntimeForTesting(runtime);
    const user = await upsertUserFromShooProfile(
      {
        pairwiseSub: "settings-api-user",
        email: "settings-api@example.com",
      },
      runtime.db,
    );
    mocked.userId = user.id;
    mocked.requireOnboardedSessionUser.mockResolvedValue({
      userId: user.id,
      email: user.email,
    });
    mocked.revalidatePath.mockClear();
  });

  afterEach(async () => {
    setDatabaseRuntimeForTesting();
    await runtime.close();
    vi.clearAllMocks();
  });

  it("creates a one-time-visible token and revokes it for the session user", async () => {
    const formData = new FormData();
    formData.set("name", "Shortcut");
    formData.set("expires", "never");
    formData.append("scopes", "read:daily");
    formData.append("scopes", "write:daily");

    const created = await createApiTokenAction({}, formData);

    expect(created.ok).toBe(true);
    if (!created.token || !created.record) {
      throw new Error("Expected API token creation to succeed.");
    }
    expect(created.token).toMatch(/^mtk_v1_/);
    const rawTokenSecretPrefix = created.token.slice("mtk_v1_".length, 19);
    expect(created.record).toMatchObject({
      userId: mocked.userId,
      name: "Shortcut",
      tokenPrefix: expect.stringMatching(/^mtk_v1_[a-f0-9]{12}$/),
      scopes: ["read:daily", "write:daily"],
      expiresAt: null,
    });
    expect(created.record.tokenPrefix).not.toContain(rawTokenSecretPrefix);
    expect(mocked.revalidatePath).toHaveBeenCalledWith("/settings/api");

    const listed = await listApiTokens(mocked.userId, runtime.db);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.tokenPrefix).not.toContain(rawTokenSecretPrefix);
    expect(JSON.stringify(listed)).not.toContain(created.token);

    const revokeData = new FormData();
    revokeData.set("tokenId", listed[0]!.id);
    await revokeApiTokenAction(revokeData);

    const [revoked] = await listApiTokens(mocked.userId, runtime.db);
    expect(revoked?.revokedAt).toBeTruthy();
  });

  it("creates 90-day tokens through the settings action", async () => {
    const formData = new FormData();
    formData.set("name", "Shortcut");
    formData.set("expires", "90");
    formData.append("scopes", "read:daily");
    const beforeCreate = Date.now();

    const created = await createApiTokenAction({}, formData);

    expect(created.ok).toBe(true);
    if (!created.record?.expiresAt) {
      throw new Error("Expected API token creation to return an expiry.");
    }
    const expiresAt = new Date(created.record.expiresAt).getTime();
    const ninetyDaysFromBeforeCreate = beforeCreate + 90 * 24 * 60 * 60 * 1000;
    expect(expiresAt).toBeGreaterThanOrEqual(ninetyDaysFromBeforeCreate);
    expect(expiresAt).toBeLessThan(ninetyDaysFromBeforeCreate + 60_000);
    expect(expiresAt).toBeLessThan(beforeCreate + 365 * 24 * 60 * 60 * 1000);
  });

  it("requires completed onboarding before listing API tokens", async () => {
    mocked.requireOnboardedSessionUser.mockRejectedValue(new Error("redirect:/onboarding"));

    await expect(ApiSettingsPage()).rejects.toThrow("redirect:/onboarding");
  });

  it("requires completed onboarding before creating API tokens", async () => {
    mocked.requireOnboardedSessionUser.mockRejectedValue(new Error("redirect:/onboarding"));
    const formData = new FormData();
    formData.set("name", "Shortcut");
    formData.set("expires", "never");
    formData.append("scopes", "read:daily");

    await expect(createApiTokenAction({}, formData)).rejects.toThrow("redirect:/onboarding");
    await expect(listApiTokens(mocked.userId, runtime.db)).resolves.toHaveLength(0);
    expect(mocked.revalidatePath).not.toHaveBeenCalled();
  });

  it("requires completed onboarding before revoking API tokens", async () => {
    const created = await createApiToken(
      mocked.userId,
      {
        name: "Shortcut",
        scopes: ["read:daily"],
      },
      runtime.db,
    );
    mocked.requireOnboardedSessionUser.mockRejectedValue(new Error("redirect:/onboarding"));
    const formData = new FormData();
    formData.set("tokenId", created.record.id);

    await expect(revokeApiTokenAction(formData)).rejects.toThrow("redirect:/onboarding");
    await expect(listApiTokens(mocked.userId, runtime.db)).resolves.toContainEqual(
      expect.objectContaining({ id: created.record.id, revokedAt: null }),
    );
    expect(mocked.revalidatePath).not.toHaveBeenCalled();
  });

  it("returns validation errors for expected API token input failures", async () => {
    const formData = new FormData();
    formData.set("name", "   ");
    formData.set("expires", "never");
    formData.append("scopes", "read:daily");

    await expect(createApiTokenAction({}, formData)).resolves.toEqual({
      ok: false,
      error: "API token name is required.",
    });
  });

  it("rejects invalid API token expiry values without creating a token", async () => {
    const formData = new FormData();
    formData.set("name", "Shortcut");
    formData.set("expires", "forever");
    formData.append("scopes", "read:daily");

    await expect(createApiTokenAction({}, formData)).resolves.toEqual({
      ok: false,
      error: "API token expiry is invalid.",
    });
    await expect(listApiTokens(mocked.userId, runtime.db)).resolves.toHaveLength(0);
    expect(mocked.revalidatePath).not.toHaveBeenCalled();
  });

  it("hides unexpected API token creation failures from the client", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const formData = new FormData();
    formData.set("name", "Shortcut");
    formData.set("expires", "never");
    formData.append("scopes", "read:daily");

    const created = await withBackendUrl("http://127.0.0.1:9", () =>
      createApiTokenAction({}, formData),
    );

    expect(created).toEqual({
      ok: false,
      error: "Unable to create API token.",
    });
    expect(consoleError).toHaveBeenCalledWith("Unexpected API token creation error", expect.any(Error));
    consoleError.mockRestore();
  });

  it("prefers revalidated server token rows over stale newly-created client state", async () => {
    const staleRecord = {
      id: "token-id",
      userId: mocked.userId,
      name: "Shortcut",
      tokenPrefix: "mtk_v1_stale",
      scopes: ["read:daily"],
      createdAt: "2026-01-01T00:00:00.000Z",
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    } satisfies ApiTokenRecord;
    const serverRecord = {
      ...staleRecord,
      tokenPrefix: "mtk_v1_fresh",
      revokedAt: "2026-01-02T00:00:00.000Z",
    };

    expect(getVisibleApiTokens([serverRecord], staleRecord)).toEqual([serverRecord]);
  });

  it("defines API token presets with expected expiry and scopes", () => {
    const readOnly = API_TOKEN_PRESETS.find(
      (preset) => preset.id === "read_only_dashboard",
    );
    const shortcut = API_TOKEN_PRESETS.find(
      (preset) => preset.id === "shortcut_logger",
    );
    const full = API_TOKEN_PRESETS.find(
      (preset) => preset.id === "full_automation",
    );

    expect(readOnly).toMatchObject({
      name: "Read-only dashboard",
      expires: "90",
    });
    expect(readOnly?.scopes.every((scope) => scope.startsWith("read:"))).toBe(true);
    expect(shortcut?.scopes).toEqual(
      expect.arrayContaining(["read:daily", "write:daily", "read:foods"]),
    );
    expect(full).toMatchObject({
      name: "Full automation",
      expires: "never",
    });
    expect(full?.scopes).toEqual(
      expect.arrayContaining(["write:foods", "write:templates", "write:goals"]),
    );
  });
});
