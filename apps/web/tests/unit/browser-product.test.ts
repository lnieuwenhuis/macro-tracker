import type { FoodProduct } from "@macro-tracker/db";
import { INTERNAL_FOOD_PRODUCT_FIELDS } from "@macro-tracker/db";
import { describe, expect, it } from "vitest";

import { toBrowserFoodProduct, toBrowserFoodProducts } from "@/lib/browser-product";

const fullProduct: FoodProduct = {
  id: "product-1",
  ownerUserId: null,
  scope: "global",
  source: "barcode",
  barcode: "1234567890123",
  name: "Shared yogurt",
  brand: "Brand",
  defaultServingQuantity: 1,
  defaultServingUnit: "serving",
  servingWeightG: 150,
  servingVolumeMl: null,
  proteinPer100: 10,
  carbsPer100: 4,
  fatPer100: 0.5,
  caloriesPer100: 61,
  submittedByUserId: "contributor-uuid",
  deletedByUserId: null,
  sourceProvider: "community",
  sourceConfidence: 0.9,
  sourceMetadata: { servingSizeG: null },
  correctedFromProductId: "original-uuid",
  createdAt: "2026-06-20T00:00:00.000Z",
  updatedAt: "2026-06-20T00:00:00.000Z",
  deletedAt: null,
};

describe("toBrowserFoodProduct", () => {
  it("omits internal provenance while keeping nutrition and source labels", () => {
    const projected = toBrowserFoodProduct(fullProduct);

    for (const field of INTERNAL_FOOD_PRODUCT_FIELDS) {
      expect(projected).not.toHaveProperty(field);
    }
    expect(projected).toMatchObject({
      id: "product-1",
      scope: "global",
      source: "barcode",
      barcode: "1234567890123",
      name: "Shared yogurt",
      brand: "Brand",
      proteinPer100: 10,
      caloriesPer100: 61,
      servingWeightG: 150,
    });
  });

  it("does not mutate the server-side product", () => {
    const copy = structuredClone(fullProduct);
    toBrowserFoodProduct(copy);
    expect(copy).toEqual(fullProduct);
  });

  it("projects arrays element-wise", () => {
    const projected = toBrowserFoodProducts([fullProduct]);
    expect(projected).toHaveLength(1);
    expect(projected[0]).not.toHaveProperty("sourceMetadata");
  });
});
