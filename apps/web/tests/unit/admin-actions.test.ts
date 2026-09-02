import { beforeEach, describe, expect, it, vi } from "vitest";

const mocked = vi.hoisted(() => ({
  createAdminBarcodeProduct: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
  requireAdminUser: vi.fn(),
  requireOwnerUser: vi.fn(),
}));

// Other admin-actions.ts db imports (restoreAdminBarcodeProduct, setUserRole,
// softDeleteAdminBarcodeProduct, updateAdminBarcodeProduct) are stubbed by
// mockDbModule's default; this file only configures/asserts on the create path.
vi.mock("@macro-tracker/db", async () => (await import("./helpers/mock-db")).mockDbModule(mocked));

vi.mock("@/lib/auth", () => ({
  requireAdminUser: mocked.requireAdminUser,
  requireOwnerUser: mocked.requireOwnerUser,
}));

vi.mock("next/cache", () => ({
  revalidatePath: mocked.revalidatePath,
}));

vi.mock("next/navigation", () => ({
  redirect: mocked.redirect,
}));

import { createAdminBarcodeProductAction } from "@/lib/admin-actions";

function buildBarcodeFormData() {
  const formData = new FormData();
  formData.set("barcode", "8712345000777");
  formData.set("name", "Macro Drink");
  formData.set("brands", "Macro Lab");
  formData.set("proteinG", "20");
  formData.set("carbsG", "8");
  formData.set("fatG", "2");
  formData.set("caloriesKcal", "130");
  formData.set("servingSizeG", "250");
  return formData;
}

describe("admin server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.requireAdminUser.mockResolvedValue({
      id: "admin-1",
      email: "admin@example.com",
      role: "admin",
    });
  });

  function backendError(code: string, message: string) {
    const error = new Error(message);
    error.name = "BackendError";
    return Object.assign(error, { code, status: 409 });
  }

  it("surfaces the backend duplicate-barcode conflict message", async () => {
    // The Rust backend masks the raw constraint name and returns a typed
    // conflict, so the mapping has to key off `error.code`.
    mocked.createAdminBarcodeProduct.mockRejectedValue(
      backendError("conflict", "That barcode already exists."),
    );

    await expect(createAdminBarcodeProductAction(buildBarcodeFormData())).rejects.toThrow(
      "redirect:/admin/barcodes?error=That%20barcode%20already%20exists.",
    );

    expect(mocked.redirect).toHaveBeenCalledWith(
      "/admin/barcodes?error=That%20barcode%20already%20exists.",
    );
    expect(mocked.revalidatePath).not.toHaveBeenCalled();
  });

  it("replaces internal backend failures with a generic message", async () => {
    mocked.createAdminBarcodeProduct.mockRejectedValue(
      backendError(
        "internal_error",
        "createAdminBarcodeProduct failed: serde error at line 3 column 18",
      ),
    );

    await expect(
      createAdminBarcodeProductAction(buildBarcodeFormData()),
    ).rejects.toThrow(/redirect:\/admin\/barcodes\?error=/);

    const [destination] = mocked.redirect.mock.calls.at(-1) ?? [];
    expect(destination).not.toContain("serde");
    expect(decodeURIComponent(String(destination))).toContain(
      "Unable to save this change right now.",
    );
  });
});
