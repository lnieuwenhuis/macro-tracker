"use server";

import {
  createApiToken,
  getApiScopes,
  revokeApiToken,
  type ApiTokenRecord,
} from "@macro-tracker/db";
import { revalidatePath } from "next/cache";

import { requireOnboardedSessionUser } from "./auth";

const CREATE_API_TOKEN_VALIDATION_MESSAGES = new Set([
  "API token name is required.",
  "At least one API scope is required.",
  "API token expiry is invalid.",
]);

function getCreateApiTokenError(caught: unknown) {
  if (!(caught instanceof Error)) {
    console.error("Unexpected API token creation error", caught);
    return "Unable to create API token.";
  }

  if (
    CREATE_API_TOKEN_VALIDATION_MESSAGES.has(caught.message) ||
    caught.message.startsWith("API scope is invalid: ")
  ) {
    return caught.message;
  }

  console.error("Unexpected API token creation error", caught);
  return "Unable to create API token.";
}

export type CreateApiTokenActionState = {
  ok?: boolean;
  error?: string;
  token?: string;
  record?: ApiTokenRecord;
};

function getStringValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

function getSelectedScopes(formData: FormData) {
  return formData
    .getAll("scopes")
    .filter((value): value is string => typeof value === "string");
}

export async function createApiTokenAction(
  _previousState: CreateApiTokenActionState,
  formData: FormData,
): Promise<CreateApiTokenActionState> {
  const sessionUser = await requireOnboardedSessionUser();
  const name = getStringValue(formData, "name");
  const scopes = getSelectedScopes(formData);
  const expires = getStringValue(formData, "expires");

  if (expires !== "90" && expires !== "never") {
    return {
      ok: false,
      error: "API token expiry is invalid.",
    };
  }

  try {
    const created = await createApiToken(sessionUser.userId, {
      name,
      scopes,
      expiresAt: expires === "never" ? null : undefined,
    });
    revalidatePath("/settings/api");
    return {
      ok: true,
      token: created.token,
      record: created.record,
    };
  } catch (caught) {
    return {
      ok: false,
      error: getCreateApiTokenError(caught),
    };
  }
}

export async function revokeApiTokenAction(formData: FormData) {
  const sessionUser = await requireOnboardedSessionUser();
  const tokenId = getStringValue(formData, "tokenId");

  if (!tokenId) {
    return;
  }

  await revokeApiToken(sessionUser.userId, tokenId);
  revalidatePath("/settings/api");
}

export async function getApiTokenScopesForSettings() {
  return getApiScopes();
}
