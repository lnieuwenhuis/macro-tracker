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
  // today is the browser's calendar day (not the Node/UTC day) so a cold load without ?date= is already correct.
  const today = await getRequestToday();
  const selectedDate = ensureDateString(params.date, today);

  return {
    params,
    user,
    sessionUser: {
      userId: user.id,
      email: user.email,
    },
    selectedDate,
    today,
  };
}

export async function loadOnboardedPageContext<TSearchParams extends DateSearchParams>(
  searchParams: Promise<TSearchParams>,
) {
  const { params, user, sessionUser, selectedDate, today } =
    await loadOnboardedDateParam(searchParams);

  return {
    params,
    sessionUser,
    selectedDate,
    today,
    userEmail: user.email,
    preferredWeightUnit: user.preferredWeightUnit,
    canAccessAdmin: canAccessAdmin(user.role),
  };
}
