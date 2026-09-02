import {
  completeOnboardingSetup,
  createAdminBarcodeProduct,
  createTemplate,
  ensureUserRoleForTesting,
  getAdminAuditEventById,
  getAdminUserDetail,
  getAdminBarcodeProductById,
  getAdminUserHealthSummary,
  listAdminAuditEvents,
  listAdminBarcodeProducts,
  listAdminBarcodeReviewQueue,
  listAdminUsers,
  lookupBarcodeFoodProduct,
  searchFoodProducts,
  setUserRole,
  softDeleteAdminBarcodeProduct,
  restoreAdminBarcodeProduct,
  updateAdminBarcodeProduct,
  upsertUserFromShooProfile,
  type DatabaseRuntime,
} from "../src";
import { foodProducts } from "../src/schema";
import { createTestDatabase } from "../src/testing";
import { eq, sql } from "drizzle-orm";
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
    );
    const admin = await upsertUserFromShooProfile(
      {
        pairwiseSub: "ps_admin",
        email: "admin@example.com",
        displayName: "Admin",
      },
    );
    const user = await upsertUserFromShooProfile(
      {
        pairwiseSub: "ps_user",
        email: "user@example.com",
        displayName: "User",
      },
    );

    ownerId = owner.id;
    adminId = admin.id;
    userId = user.id;

    await ensureUserRoleForTesting(ownerId, "owner");
    await ensureUserRoleForTesting(adminId, "admin");
  });

  afterEach(async () => {
    await runtime.close();
  });

  it("changes roles, prevents demoting the last owner, and records an audit event", async () => {
    const promoted = await setUserRole(ownerId, userId, "admin");
    expect(promoted.role).toBe("admin");

    await expect(
      setUserRole(ownerId, ownerId, "user"),
    ).rejects.toThrow("last owner");

    const audit = await listAdminAuditEvents(
      ownerId,
      {
        targetType: "user",
        targetId: userId,
        pageSize: 10,
      },
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
      ownerId,
      {
        role: "admin",
        pageSize: 25,
      },
    );

    expect(adminUsers.items.map((item) => item.email)).toEqual([
      "admin@example.com",
    ]);
  });

  it("summarizes user health segments and filters linked user lists", async () => {
    await completeOnboardingSetup(
      userId,
      {
        preferredWeightUnit: "kg",
        goals: {
          caloriesKcal: null,
          proteinG: null,
          carbsG: null,
          fatG: null,
        },
        goalWeightKg: null,
        currentWeight: null,
        starterTemplate: null,
      },
    );
    await runtime.db.execute(sql`update users set last_login_at = now() - interval '40 days' where id = ${adminId}`);

    for (let index = 0; index < 5; index += 1) {
      await createAdminBarcodeProduct(
        adminId,
        {
          barcode: `99000000004${index}`,
          name: `Admin Submitted Food ${index}`,
          brands: "Macro Lab",
          proteinG: 10,
          carbsG: 20,
          fatG: 5,
          caloriesKcal: 165,
          servingSizeG: 100,
        },
      );
    }

    const health = await getAdminUserHealthSummary(ownerId);
    const counts = new Map(
      health.segments.map((segment) => [segment.id, segment.count]),
    );

    expect(counts.get("onboarded_no_logs")).toBe(1);
    expect(counts.get("no_goals")).toBe(3);
    expect(counts.get("inactive7")).toBe(1);
    expect(counts.get("inactive30")).toBe(1);
    expect(counts.get("no_weight_entries")).toBe(3);
    expect(counts.get("heavy_barcode_submitters")).toBe(1);

    await expect(
      listAdminUsers(ownerId, { health: "onboarded_no_logs", pageSize: 25 }),
    ).resolves.toMatchObject({
      items: [{ email: "user@example.com" }],
    });
    await expect(
      listAdminUsers(ownerId, { health: "heavy_barcode_submitters", pageSize: 25 }),
    ).resolves.toMatchObject({
      items: [{ email: "admin@example.com" }],
    });
    await expect(
      listAdminUsers(ownerId, { activity: "inactive30", pageSize: 25 }),
    ).resolves.toMatchObject({
      items: [{ email: "admin@example.com" }],
    });
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
    );

    expect(await lookupBarcodeFoodProduct("9900000000001")).toMatchObject({
      name: "Admin Peanut Butter",
      submittedByUserId: adminId,
    });
    expect(
      await searchFoodProducts(userId, "Admin Peanut Butter"),
    ).toMatchObject([
      {
        barcode: "9900000000001",
        name: "Admin Peanut Butter",
        source: "barcode",
      },
    ]);

    const updated = await updateAdminBarcodeProduct(
      adminId,
      created.id,
      {
        barcode: "9900000000002",
        name: "Admin Peanut Butter Deluxe",
        brands: "Macro Lab",
        proteinG: 26,
        carbsG: 17,
        fatG: 49,
        caloriesKcal: 615,
        servingSizeG: 15,
      },
    );

    expect(updated.name).toBe("Admin Peanut Butter Deluxe");
    expect(await lookupBarcodeFoodProduct("9900000000001")).toBeNull();
    expect(await lookupBarcodeFoodProduct("9900000000002")).toMatchObject({
      name: "Admin Peanut Butter Deluxe",
    });
    expect(await searchFoodProducts(userId, "Deluxe")).toMatchObject([
      {
        barcode: "9900000000002",
        name: "Admin Peanut Butter Deluxe",
        proteinPer100: 26,
        carbsPer100: 17,
        fatPer100: 49,
        caloriesPer100: 615,
      },
    ]);
    expect(
      (await searchFoodProducts(userId, "Admin Peanut Butter")).map(
        (product) => product.barcode,
      ),
    ).toEqual(["9900000000002"]);

    const deleted = await softDeleteAdminBarcodeProduct(
      adminId,
      created.id,
    );
    expect(deleted.deletedAt).toBeTruthy();
    expect(await lookupBarcodeFoodProduct("9900000000001")).toBeNull();
    expect(await lookupBarcodeFoodProduct("9900000000002")).toBeNull();
    expect(await searchFoodProducts(userId, "Deluxe")).toEqual([]);

    const deletedOnly = await listAdminBarcodeProducts(
      adminId,
      {
        status: "deleted",
        pageSize: 25,
      },
    );
    expect(deletedOnly.items.map((item) => item.id)).toContain(created.id);

    const restored = await restoreAdminBarcodeProduct(
      adminId,
      created.id,
    );
    expect(restored.deletedAt).toBeNull();
    expect(await lookupBarcodeFoodProduct("9900000000002")).toMatchObject({
      name: "Admin Peanut Butter Deluxe",
    });
    expect(await searchFoodProducts(userId, "Deluxe")).toMatchObject([
      {
        barcode: "9900000000002",
        name: "Admin Peanut Butter Deluxe",
      },
    ]);

    const detail = await getAdminBarcodeProductById(adminId, created.id);
    expect(detail?.deletedAt).toBeNull();

    const audit = await listAdminAuditEvents(
      ownerId,
      {
        targetType: "food_product",
        targetId: created.id,
        pageSize: 10,
      },
    );
    expect(audit.items.map((item) => item.action)).toEqual([
      "barcode.restored",
      "barcode.deleted",
      "barcode.updated",
      "barcode.created",
    ]);

    const updateEvent = audit.items.find(
      (item) => item.action === "barcode.updated",
    );
    const auditDetail = await getAdminAuditEventById(ownerId, updateEvent!.id);
    expect(auditDetail?.details).toMatchObject({
      before: {
        name: "Admin Peanut Butter",
      },
      after: {
        name: "Admin Peanut Butter Deluxe",
      },
    });
  });

  it("builds barcode review queue reasons", async () => {
    const lowConfidence = await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000501",
        name: "Review Queue Duplicate",
        brands: "Macro Lab",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 165,
        servingSizeG: 100,
      },
    );
    await runtime.db
      .update(foodProducts)
      .set({
        sourceConfidence: "0.60",
        servingWeightG: null,
        updatedAt: new Date(),
      })
      .where(eq(foodProducts.id, lowConfidence.id));

    const duplicateName = await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000502",
        name: "Review Queue Duplicate",
        brands: "Macro Lab",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 165,
        servingSizeG: 100,
      },
    );
    const deleted = await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000503",
        name: "Recently Deleted Food",
        brands: "Macro Lab",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 165,
        servingSizeG: 100,
      },
    );
    await softDeleteAdminBarcodeProduct(adminId, deleted.id);
    const restored = await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000504",
        name: "Recently Restored Food",
        brands: "Macro Lab",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 165,
        servingSizeG: 100,
      },
    );
    await softDeleteAdminBarcodeProduct(adminId, restored.id);
    await restoreAdminBarcodeProduct(adminId, restored.id);
    await updateAdminBarcodeProduct(
      adminId,
      restored.id,
      {
        barcode: "9900000000504",
        name: "Recently Restored Food Updated",
        brands: "Macro Lab",
        proteinG: 11,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 169,
        servingSizeG: 100,
      },
    );
    const frequent = await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000505",
        name: "Frequently Revised Food",
        brands: "Macro Lab",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 165,
        servingSizeG: 100,
      },
    );
    await updateAdminBarcodeProduct(
      adminId,
      frequent.id,
      {
        barcode: "9900000000505",
        name: "Frequently Revised Food V2",
        brands: "Macro Lab",
        proteinG: 11,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 169,
        servingSizeG: 100,
      },
    );
    await updateAdminBarcodeProduct(
      adminId,
      frequent.id,
      {
        barcode: "9900000000505",
        name: "Frequently Revised Food V3",
        brands: "Macro Lab",
        proteinG: 12,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 173,
        servingSizeG: 100,
      },
    );

    const queue = await listAdminBarcodeReviewQueue(
      adminId,
      {
        pageSize: 25,
      },
    );
    const byId = new Map(queue.items.map((item) => [item.id, item]));

    expect(byId.get(lowConfidence.id)?.reviewReasons).toEqual(
      expect.arrayContaining([
        "low_confidence",
        "missing_serving_size",
        "duplicate_name",
      ]),
    );
    expect(byId.get(duplicateName.id)?.reviewReasons).toContain("duplicate_name");
    expect(byId.get(deleted.id)?.reviewReasons).toContain("recently_deleted");
    expect(byId.get(restored.id)?.reviewReasons).toContain("recently_restored");
    expect(byId.get(restored.id)?.latestAuditAction).toBe("barcode.updated");
    expect(byId.get(frequent.id)?.reviewReasons).toContain("frequent_revisions");
  });

  it("prevents restoring a deleted barcode when an active replacement uses the same barcode", async () => {
    const deletedOriginal = await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000099",
        name: "Original Barcode Food",
        brands: "Macro Lab",
        proteinG: 12,
        carbsG: 20,
        fatG: 4,
        caloriesKcal: 164,
        servingSizeG: 100,
      },
    );
    await softDeleteAdminBarcodeProduct(adminId, deletedOriginal.id);
    await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000099",
        name: "Replacement Barcode Food",
        brands: "Macro Lab",
        proteinG: 14,
        carbsG: 18,
        fatG: 5,
        caloriesKcal: 173,
        servingSizeG: 100,
      },
    );

    await expect(
      restoreAdminBarcodeProduct(adminId, deletedOriginal.id),
    ).rejects.toThrow("That barcode already exists.");

    const stillDeleted = await getAdminBarcodeProductById(
      adminId,
      deletedOriginal.id,
    );
    expect(stillDeleted?.deletedAt).toBeTruthy();
    expect(await lookupBarcodeFoodProduct("9900000000099")).toMatchObject({
      name: "Replacement Barcode Food",
    });
  });

  it("prevents duplicate active barcode creates and updates", async () => {
    await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000101",
        name: "Original Duplicate Guard Food",
        brands: "Macro Lab",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 165,
        servingSizeG: 100,
      },
    );

    await expect(
      createAdminBarcodeProduct(
        adminId,
        {
          barcode: "9900000000101",
          name: "Duplicate Guard Food",
          brands: "Macro Lab",
          proteinG: 12,
          carbsG: 19,
          fatG: 6,
          caloriesKcal: 178,
          servingSizeG: 100,
        },
      ),
    ).rejects.toThrow("That barcode already exists.");

    const other = await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000102",
        name: "Other Duplicate Guard Food",
        brands: "Macro Lab",
        proteinG: 14,
        carbsG: 18,
        fatG: 4,
        caloriesKcal: 164,
        servingSizeG: 100,
      },
    );

    await expect(
      updateAdminBarcodeProduct(
        adminId,
        other.id,
        {
          barcode: "9900000000101",
          name: "Other Duplicate Guard Food",
          brands: "Macro Lab",
          proteinG: 14,
          carbsG: 18,
          fatG: 4,
          caloriesKcal: 164,
          servingSizeG: 100,
        },
      ),
    ).rejects.toThrow("That barcode already exists.");

    expect(await getAdminBarcodeProductById(adminId, other.id)).toMatchObject({
      barcode: "9900000000102",
    });
  });

  it("enforces active global barcode uniqueness at the database level", async () => {
    await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000201",
        name: "Indexed Barcode Food",
        brands: "Macro Lab",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 165,
        servingSizeG: 100,
      },
    );

    await expect(
      runtime.db.execute(sql.raw(`
        INSERT INTO "food_products" (
          "id",
          "owner_user_id",
          "scope",
          "source",
          "barcode",
          "name",
          "brand",
          "default_serving_quantity",
          "default_serving_unit",
          "protein_per_100",
          "carbs_per_100",
          "fat_per_100",
          "calories_per_100",
          "serving_weight_g"
        )
        VALUES (
          '11111111-2222-4333-8444-555555555555',
          NULL,
          'global',
          'barcode',
          '9900000000201',
          'Duplicate Indexed Barcode Food',
          'Macro Lab',
          '1.00',
          'serving',
          10.00,
          20.00,
          5.00,
          165,
          '100.00'
        )
      `)),
    ).rejects.toThrow();

    await expect(
      runtime.db.execute(sql.raw(`
        INSERT INTO "food_products" (
          "id",
          "owner_user_id",
          "scope",
          "source",
          "barcode",
          "name",
          "brand",
          "default_serving_quantity",
          "default_serving_unit",
          "protein_per_100",
          "carbs_per_100",
          "fat_per_100",
          "calories_per_100",
          "serving_weight_g",
          "deleted_at"
        )
        VALUES (
          '11111111-2222-4333-8444-555555555556',
          NULL,
          'global',
          'barcode',
          '9900000000201',
          'Deleted Indexed Barcode Food',
          'Macro Lab',
          '1.00',
          'serving',
          10.00,
          20.00,
          5.00,
          165,
          '100.00',
          now()
        )
      `)),
    ).resolves.toBeTruthy();
  });

  it("finds active barcode duplicates when a newer deleted duplicate also exists", async () => {
    const active = await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000301",
        name: "Active Masking Guard Food",
        brands: "Macro Lab",
        proteinG: 10,
        carbsG: 20,
        fatG: 5,
        caloriesKcal: 165,
        servingSizeG: 100,
      },
    );

    await runtime.db.execute(sql.raw(`
      INSERT INTO "food_products" (
        "id",
        "owner_user_id",
        "scope",
        "source",
        "barcode",
        "name",
        "brand",
        "default_serving_quantity",
        "default_serving_unit",
        "protein_per_100",
        "carbs_per_100",
        "fat_per_100",
        "calories_per_100",
        "serving_weight_g",
        "updated_at",
        "deleted_at"
      )
      VALUES (
        '11111111-2222-4333-8444-555555555557',
        NULL,
        'global',
        'barcode',
        '9900000000301',
        'Deleted Masking Guard Food',
        'Macro Lab',
        '1.00',
        'serving',
        10.00,
        20.00,
        5.00,
        165,
        '100.00',
        '2999-01-01 00:00:00+00',
        '2999-01-01 00:00:00+00'
      )
    `));

    const other = await createAdminBarcodeProduct(
      adminId,
      {
        barcode: "9900000000302",
        name: "Other Masking Guard Food",
        brands: "Macro Lab",
        proteinG: 14,
        carbsG: 18,
        fatG: 4,
        caloriesKcal: 164,
        servingSizeG: 100,
      },
    );

    await expect(
      updateAdminBarcodeProduct(
        adminId,
        other.id,
        {
          barcode: "9900000000301",
          name: "Other Masking Guard Food",
          brands: "Macro Lab",
          proteinG: 14,
          carbsG: 18,
          fatG: 4,
          caloriesKcal: 164,
          servingSizeG: 100,
        },
      ),
    ).rejects.toThrow("That barcode already exists.");

    expect(await lookupBarcodeFoodProduct("9900000000301")).toMatchObject({
      id: active.id,
      name: "Active Masking Guard Food",
    });
    expect(await getAdminBarcodeProductById(adminId, other.id)).toMatchObject({
      barcode: "9900000000302",
    });
  });

  it("loads item macros for recent templates in admin user detail", async () => {
    await createTemplate(
      userId,
      {
        type: "day",
        label: "Two item day",
        items: [
          {
            label: "Breakfast",
            proteinG: 20,
            carbsG: 40,
            fatG: 8,
            caloriesKcal: 312,
          },
          {
            label: "Lunch",
            proteinG: 30,
            carbsG: 50,
            fatG: 12,
            caloriesKcal: 428,
          },
        ],
      },
    );

    const detail = await getAdminUserDetail(adminId, userId);
    const template = detail?.recentTemplates.find(
      (item) => item.label === "Two item day",
    );

    expect(template?.items).toHaveLength(2);
    expect(
      template?.items.reduce(
        (sum, item) => sum + item.caloriesKcal,
        0,
      ),
    ).toBe(740);
  });
});
