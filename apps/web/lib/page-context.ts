import { canAccessAdmin, ensureDateString } from "@macro-tracker/db";

import { requireOnboardedAppUser } from "./auth";
import { getRequestToday } from "./server-timezone";

export type DateSearchParams = {
  date?: string;
};

export async function loadOnboardedDateParam<TSearchParams extends DateSearchParams>(
  searchParams: Promise<TSearchParams>,
) {
  const user = await requireOnboardedAppUser();
  const params = await searchParams;
  // Fall back to the browser's calendar day, not the Node process day, so a
  // cold load without `?date=` already renders the day the user is in.
  const selectedDate = ensureDateString(params.date, await getRequestToday());

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
    preferredWeightUnit: user.preferredWeightUnit,
    canAccessAdmin: canAccessAdmin(user.role),
  };
}
