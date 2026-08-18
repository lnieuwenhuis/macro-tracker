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
  // UI-02: `today` is returned as well so shells can be handed it as a prop
  // instead of each recomputing `getLocalDateString()` during render, which
  // resolves to the Node process zone (UTC) on the server and the browser zone
  // on hydration - a mismatch for every user at a non-zero UTC offset.
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
