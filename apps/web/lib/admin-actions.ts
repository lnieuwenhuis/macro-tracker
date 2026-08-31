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

import { ActionError, toActionError } from "./action-errors";
import { requireAdminUser, requireOwnerUser } from "./auth";

function getRequiredText(formData: FormData, key: string) {
  const value = formData.get(key);

  if (typeof value !== "string" || !value.trim()) {
    throw new ActionError(`${key} is required.`);
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
    throw new ActionError(`${key} must be a non-negative number.`);
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
    throw new ActionError(`${key} must be a non-negative number.`);
  }

  return value;
}

function getBarcodeProductInput(formData: FormData) {
  return {
    barcode: getRequiredText(formData, "barcode"),
    name: getRequiredText(formData, "name"),
    brands: getOptionalText(formData, "brands"),
    proteinG: getNumber(formData, "proteinG"),
    carbsG: getNumber(formData, "carbsG"),
    fatG: getNumber(formData, "fatG"),
    caloriesKcal: Math.round(getNumber(formData, "caloriesKcal")),
    servingSizeG: getNullableNumber(formData, "servingSizeG"),
  };
}

async function redirectAfterAdminAction(input: {
  successDestination: string;
  errorDestination: (error: unknown) => string;
  action: () => Promise<string | void>;
}) {
  let destination = input.successDestination;

  try {
    destination = (await input.action()) ?? destination;
  } catch (error) {
    destination = input.errorDestination(error);
  }

  redirect(destination);
}

/**
 * Not an open redirect today — every destination starts with a literal
 * `/admin/` — but the ids come straight off `formData`, so they are encoded
 * rather than trusted to be UUID-shaped. A real id is unchanged by this.
 */
function encodePathSegment(value: string) {
  return encodeURIComponent(value);
}

function revalidateAdminPaths(detailPath?: string) {
  revalidatePath("/admin");
  revalidatePath("/admin/barcodes");
  if (detailPath) {
    revalidatePath(detailPath);
  }
}

export async function changeUserRoleAction(formData: FormData) {
  const owner = await requireOwnerUser();
  const userId = getRequiredText(formData, "userId");
  const role = getRequiredText(formData, "role") as AdminRole;

  await redirectAfterAdminAction({
    successDestination: `/admin/users/${encodePathSegment(userId)}?saved=role`,
    errorDestination: (error) =>
      `/admin/users/${encodePathSegment(userId)}?error=${encodeURIComponent(toActionError(error))}`,
    action: async () => {
      await setUserRole(owner.id, userId, role);
      revalidatePath("/admin");
      revalidatePath("/admin/users");
      revalidatePath(`/admin/users/${userId}`);
    },
  });
}

export async function createAdminBarcodeProductAction(formData: FormData) {
  const admin = await requireAdminUser();

  await redirectAfterAdminAction({
    successDestination: "/admin/barcodes?saved=created",
    errorDestination: (error) =>
      `/admin/barcodes?error=${encodeURIComponent(toActionError(error))}`,
    action: async () => {
      const product = await createAdminBarcodeProduct(
        admin.id,
        getBarcodeProductInput(formData),
      );
      revalidateAdminPaths();
      return `/admin/barcodes/${encodePathSegment(product.id)}?saved=created`;
    },
  });
}

export async function updateAdminBarcodeProductAction(formData: FormData) {
  const admin = await requireAdminUser();
  const id = getRequiredText(formData, "id");

  await redirectAfterAdminAction({
    successDestination: `/admin/barcodes/${encodePathSegment(id)}?saved=updated`,
    errorDestination: (error) =>
      `/admin/barcodes/${encodePathSegment(id)}?error=${encodeURIComponent(toActionError(error))}`,
    action: async () => {
      await updateAdminBarcodeProduct(admin.id, id, getBarcodeProductInput(formData));
      revalidateAdminPaths(`/admin/barcodes/${id}`);
    },
  });
}

export async function softDeleteAdminBarcodeProductAction(formData: FormData) {
  const admin = await requireAdminUser();
  const id = getRequiredText(formData, "id");

  await redirectAfterAdminAction({
    successDestination: `/admin/barcodes/${encodePathSegment(id)}?saved=deleted`,
    errorDestination: (error) =>
      `/admin/barcodes/${encodePathSegment(id)}?error=${encodeURIComponent(toActionError(error))}`,
    action: async () => {
      await softDeleteAdminBarcodeProduct(admin.id, id);
      revalidateAdminPaths(`/admin/barcodes/${id}`);
    },
  });
}

export async function restoreAdminBarcodeProductAction(formData: FormData) {
  const admin = await requireAdminUser();
  const id = getRequiredText(formData, "id");

  await redirectAfterAdminAction({
    successDestination: `/admin/barcodes/${encodePathSegment(id)}?saved=restored`,
    errorDestination: (error) =>
      `/admin/barcodes/${encodePathSegment(id)}?error=${encodeURIComponent(toActionError(error))}`,
    action: async () => {
      await restoreAdminBarcodeProduct(admin.id, id);
      revalidateAdminPaths(`/admin/barcodes/${id}`);
    },
  });
}
