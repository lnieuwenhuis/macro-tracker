import {
  INTERNAL_FOOD_PRODUCT_FIELDS,
  type BrowserFoodProduct,
  type FoodProduct,
} from "@macro-tracker/db";

/**
 * SEC-06: strips internal provenance (contributor ids, source metadata, correction links)
 * before a product row crosses the server-action or server-component boundary to the browser.
 */
export function toBrowserFoodProduct(product: FoodProduct): BrowserFoodProduct {
  const projected: BrowserFoodProduct & Partial<FoodProduct> = { ...product };
  for (const field of INTERNAL_FOOD_PRODUCT_FIELDS) {
    delete projected[field];
  }
  return projected;
}

export function toBrowserFoodProducts(
  products: FoodProduct[],
): BrowserFoodProduct[] {
  return products.map(toBrowserFoodProduct);
}
