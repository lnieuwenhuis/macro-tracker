"use server";

import {
  createAdminBarcodeProduct,
  restoreAdminBarcodeProduct,
  setUserRole,
  softDeleteAdminBarcodeProduct,
  updateAdminBarcodeProduct,
  type AdminRole,
} from "@macro-tracker/db";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireAdminUser, requireOwnerUser } from "./auth";

function getRequiredText(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${key} is required.`);
  }

  return value.trim();
}

function getOptionalText(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function getNumber(formData: FormData, key: string) {
  const raw = getRequiredText(formData, key);
  const value = Number(raw);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number.`);
  }

  return value;
}

function getNullableNumber(formData: FormData, key: string) {
  const raw = getOptionalText(formData, key);

  if (!raw) {
    return null;
  }

  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${key} must be a non-negative number.`);
  }

  return value;
}

function toActionError(error: unknown) {
  if (!(error instanceof Error)) {
    return "Something went wrong.";
  }

  if (error.message.includes("barcode_products_barcode_key")) {
    return "That barcode already exists.";
  }

  if (error.message.includes("users_email_key")) {
    return "That email address is already in use.";
  }

  if (error.message.includes("Failed query:")) {
    return "Unable to save this change right now.";
  }

  return error.message;
}

export async function changeUserRoleAction(formData: FormData) {
  const owner = await requireOwnerUser();
  const userId = getRequiredText(formData, "userId");
  const role = getRequiredText(formData, "role") as AdminRole;
  let destination = `/admin/users/${userId}?saved=role`;

  try {
    await setUserRole(owner.id, userId, role);
    revalidatePath("/admin");
    revalidatePath("/admin/users");
    revalidatePath(`/admin/users/${userId}`);
  } catch (error) {
    destination = `/admin/users/${userId}?error=${encodeURIComponent(toActionError(error))}`;
  }

  redirect(destination);
}

export async function createAdminBarcodeProductAction(formData: FormData) {
  const admin = await requireAdminUser();
  let destination = "/admin/barcodes?saved=created";

  try {
    const product = await createAdminBarcodeProduct(admin.id, {
      barcode: getRequiredText(formData, "barcode"),
      name: getRequiredText(formData, "name"),
      brands: getOptionalText(formData, "brands"),
      proteinG: getNumber(formData, "proteinG"),
      carbsG: getNumber(formData, "carbsG"),
      fatG: getNumber(formData, "fatG"),
      caloriesKcal: Math.round(getNumber(formData, "caloriesKcal")),
      servingSizeG: getNullableNumber(formData, "servingSizeG"),
    });

    revalidatePath("/admin");
    revalidatePath("/admin/barcodes");
    destination = `/admin/barcodes/${product.id}?saved=created`;
  } catch (error) {
    destination = `/admin/barcodes?error=${encodeURIComponent(toActionError(error))}`;
  }

  redirect(destination);
}

export async function updateAdminBarcodeProductAction(formData: FormData) {
  const admin = await requireAdminUser();
  const id = getRequiredText(formData, "id");
  let destination = `/admin/barcodes/${id}?saved=updated`;

  try {
    await updateAdminBarcodeProduct(admin.id, id, {
      barcode: getRequiredText(formData, "barcode"),
      name: getRequiredText(formData, "name"),
      brands: getOptionalText(formData, "brands"),
      proteinG: getNumber(formData, "proteinG"),
      carbsG: getNumber(formData, "carbsG"),
      fatG: getNumber(formData, "fatG"),
      caloriesKcal: Math.round(getNumber(formData, "caloriesKcal")),
      servingSizeG: getNullableNumber(formData, "servingSizeG"),
    });

    revalidatePath("/admin");
    revalidatePath("/admin/barcodes");
    revalidatePath(`/admin/barcodes/${id}`);
  } catch (error) {
    destination = `/admin/barcodes/${id}?error=${encodeURIComponent(toActionError(error))}`;
  }

  redirect(destination);
}

export async function softDeleteAdminBarcodeProductAction(formData: FormData) {
  const admin = await requireAdminUser();
  const id = getRequiredText(formData, "id");
  let destination = `/admin/barcodes/${id}?saved=deleted`;

  try {
    await softDeleteAdminBarcodeProduct(admin.id, id);
    revalidatePath("/admin");
    revalidatePath("/admin/barcodes");
    revalidatePath(`/admin/barcodes/${id}`);
  } catch (error) {
    destination = `/admin/barcodes/${id}?error=${encodeURIComponent(toActionError(error))}`;
  }

  redirect(destination);
}

export async function restoreAdminBarcodeProductAction(formData: FormData) {
  const admin = await requireAdminUser();
  const id = getRequiredText(formData, "id");
  let destination = `/admin/barcodes/${id}?saved=restored`;

  try {
    await restoreAdminBarcodeProduct(admin.id, id);
    revalidatePath("/admin");
    revalidatePath("/admin/barcodes");
    revalidatePath(`/admin/barcodes/${id}`);
  } catch (error) {
    destination = `/admin/barcodes/${id}?error=${encodeURIComponent(toActionError(error))}`;
  }

  redirect(destination);
}
