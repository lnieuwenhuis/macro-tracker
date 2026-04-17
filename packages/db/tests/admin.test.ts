import {
  createAdminBarcodeProduct,
  ensureUserRole,
  getAdminBarcodeProductById,
  listAdminAuditEvents,
  listAdminBarcodeProducts,
  listAdminUsers,
  lookupCustomBarcodeProduct,
  setUserRole,
  softDeleteAdminBarcodeProduct,
  restoreAdminBarcodeProduct,
  updateAdminBarcodeProduct,
  upsertUserFromShooProfile,
  type DatabaseRuntime,
} from "../src";
import { createTestDatabase } from "../src/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

describe("admin queries", () => {
  let runtime: DatabaseRuntime;
  let ownerId: string;
  let adminId: string;
  let userId: string;

  beforeEach(async () => {
    runtime = await createTestDatabase();

    const owner = await upsertUserFromShooProfile(
      {
        pairwiseSub: "ps_owner",
        email: "owner@example.com",
        displayName: "Owner",
      },
      runtime.db,
    );
    const admin = await upsertUserFromShooProfile(
      {
        pairwiseSub: "ps_admin",
        email: "admin@example.com",
        displayName: "Admin",
      },
      runtime.db,
    );
    const user = await upsertUserFromShooProfile(
      {
        pairwiseSub: "ps_user",
        email: "user@example.com",
        displayName: "User",
      },
      runtime.db,
    );

    ownerId = owner.id;
    adminId = admin.id;
    userId = user.id;

    await ensureUserRole(ownerId, "owner", runtime.db);
    await ensureUserRole(adminId, "admin", runtime.db);
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("changes roles, prevents demoting the last owner, and records an audit event", async () => {
    const promoted = await setUserRole(ownerId, userId, "admin", runtime.db);
    expect(promoted.role).toBe("admin");

    await expect(
      setUserRole(ownerId, ownerId, "user", runtime.db),
    ).rejects.toThrow("last owner");

    const audit = await listAdminAuditEvents(
      {
        targetType: "user",
        targetId: userId,
        pageSize: 10,
      },
      runtime.db,
    );

    expect(audit.items[0]?.action).toBe("user.role_changed");
    expect(audit.items[0]?.details).toMatchObject({
      fromRole: "user",
      toRole: "admin",
      targetEmail: "user@example.com",
    });
  });

  it("filters admin user listings by role", async () => {
    const adminUsers = await listAdminUsers(
      {
        role: "admin",
        pageSize: 25,
      },
      runtime.db,
    );

    expect(adminUsers.items.map((item) => item.email)).toEqual([
      "admin@example.com",
    ]);
  });

  it("creates, updates, soft-deletes, restores, and filters barcode records", async () => {
    const created = await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000001",
        name: "Admin Peanut Butter",
        brands: "Macro Lab",
        proteinG: 25,
        carbsG: 18,
        fatG: 50,
        caloriesKcal: 620,
        servingSizeG: 15,
      },
      runtime.db,
    );

    expect(await lookupCustomBarcodeProduct("9900000000001", runtime.db)).toMatchObject({
      name: "Admin Peanut Butter",
    });

    const updated = await updateAdminBarcodeProduct(
      adminId,
      created.id,
      {
        barcode: "9900000000001",
        name: "Admin Peanut Butter Deluxe",
        brands: "Macro Lab",
        proteinG: 26,
        carbsG: 17,
        fatG: 49,
        caloriesKcal: 615,
        servingSizeG: 15,
      },
      runtime.db,
    );

    expect(updated.name).toBe("Admin Peanut Butter Deluxe");

    const deleted = await softDeleteAdminBarcodeProduct(
      adminId,
      created.id,
      runtime.db,
    );
    expect(deleted.status).toBe("deleted");
    expect(await lookupCustomBarcodeProduct("9900000000001", runtime.db)).toBeNull();

    const deletedOnly = await listAdminBarcodeProducts(
      {
        status: "deleted",
        pageSize: 25,
      },
      runtime.db,
    );
    expect(deletedOnly.items.map((item) => item.id)).toContain(created.id);

    const restored = await restoreAdminBarcodeProduct(
      adminId,
      created.id,
      runtime.db,
    );
    expect(restored.status).toBe("active");
    expect(await lookupCustomBarcodeProduct("9900000000001", runtime.db)).toMatchObject({
      name: "Admin Peanut Butter Deluxe",
    });

    const detail = await getAdminBarcodeProductById(created.id, runtime.db);
    expect(detail?.deletedAt).toBeNull();

    const audit = await listAdminAuditEvents(
      {
        targetType: "barcode_product",
        targetId: created.id,
        pageSize: 10,
      },
      runtime.db,
    );
    expect(audit.items.map((item) => item.action)).toEqual([
      "barcode.restored",
      "barcode.deleted",
      "barcode.updated",
      "barcode.created",
    ]);
  });
});
