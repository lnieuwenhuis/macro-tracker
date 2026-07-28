import { canAccessAdmin, ensureDateString } from "@macro-tracker/db";

import { requireOnboardedAppUser } from "./auth";

export type DateSearchParams = {
  date?: string;
};

export async function loadOnboardedDateParam<TSearchParams extends DateSearchParams>(
  searchParams: Promise<TSearchParams>,
) {
  const user = await requireOnboardedAppUser();
  const params = await searchParams;
  const selectedDate = ensureDateString(params.date);

  return {
    params,
    user,
    sessionUser: {
      userId: user.id,
      email: user.email,
    },
    selectedDate,
  };
}

export async function loadOnboardedPageContext<TSearchParams extends DateSearchParams>(
  searchParams: Promise<TSearchParams>,
) {
  const { params, user, sessionUser, selectedDate } =
    await loadOnboardedDateParam(searchParams);

  return {
    params,
    sessionUser,
    selectedDate,
    userEmail: user.email,
    canAccessAdmin: canAccessAdmin(user.role),
  };
}
