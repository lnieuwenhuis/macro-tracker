// Error codes that can land on /login?error=...: the Shoo verify route
// forwards backend codes (unauthorized, forbidden, ...) alongside its own
// (invalid_origin, missing_token, login_failed). Every code must produce a
// safe message; raw upstream bodies are never displayed.
const LOGIN_ERROR_MESSAGES: Record<string, string> = {
  login_failed: "Sign-in did not complete. Please try again.",
  missing_email: "Google did not provide an email address for this account.",
  invalid_token: "The Shoo token could not be verified.",
  session_expired: "Your local session expired. Please sign in again.",
  unauthorized: "Sign-in was not authorized. Please try again.",
  forbidden:
    "This account is not allowed to sign in. Contact support if this seems wrong.",
  invalid_origin: "Sign-in must be completed from this site. Please try again.",
  missing_token: "Sign-in did not return a credential. Please try again.",
  bad_request: "The sign-in request was invalid. Please try again.",
  not_found: "Your account was not found. Please try signing in again.",
};

export const LOGIN_ERROR_FALLBACK =
  "Sign-in did not complete. Please try again.";

export function getLoginErrorMessage(code: string | null | undefined) {
  if (!code) {
    return null;
  }

  // Own-property check so inherited keys such as __proto__ cannot select
  // Object.prototype members (which would render "[object Object]").
  if (!Object.prototype.hasOwnProperty.call(LOGIN_ERROR_MESSAGES, code)) {
    return LOGIN_ERROR_FALLBACK;
  }

  return LOGIN_ERROR_MESSAGES[code];
}
