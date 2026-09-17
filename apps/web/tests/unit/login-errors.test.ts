/** @vitest-environment node */
// UI-13: every sign-in failure code must produce a visible, safe message;
// unknown and inherited keys fall back instead of rendering nothing (or an object).
import { describe, expect, it } from "vitest";

import {
  LOGIN_ERROR_FALLBACK,
  getLoginErrorMessage,
} from "@/lib/login-errors";

describe("UI-13 login error messages", () => {
  it("maps the original four codes", () => {
    expect(getLoginErrorMessage("login_failed")).toContain("try again");
    expect(getLoginErrorMessage("missing_email")).toContain("email");
    expect(getLoginErrorMessage("invalid_token")).toContain("verified");
    expect(getLoginErrorMessage("session_expired")).toContain("sign in again");
  });

  it("maps actionable backend/route codes instead of returning to login silently", () => {
    for (const code of [
      "unauthorized",
      "forbidden",
      "invalid_origin",
      "missing_token",
      "bad_request",
      "not_found",
    ]) {
      const message = getLoginErrorMessage(code);
      expect(typeof message).toBe("string");
      expect(message!.length).toBeGreaterThan(0);
    }
    expect(getLoginErrorMessage("unauthorized")).toContain("authorized");
    expect(getLoginErrorMessage("invalid_origin")).toContain("this site");
  });

  it("falls back for unknown codes and inherited-key names without throwing", () => {
    expect(getLoginErrorMessage("some_future_code")).toBe(LOGIN_ERROR_FALLBACK);
    expect(getLoginErrorMessage("__proto__")).toBe(LOGIN_ERROR_FALLBACK);
    expect(getLoginErrorMessage("constructor")).toBe(LOGIN_ERROR_FALLBACK);
    expect(getLoginErrorMessage("toString")).toBe(LOGIN_ERROR_FALLBACK);
    expect(getLoginErrorMessage("hasOwnProperty")).toBe(LOGIN_ERROR_FALLBACK);
  });

  it("returns null only when there is no error", () => {
    expect(getLoginErrorMessage(undefined)).toBeNull();
    expect(getLoginErrorMessage("")).toBeNull();
  });

  it("never leaks raw upstream bodies", () => {
    const message = getLoginErrorMessage("upstream_error")!;
    expect(message).toBe(LOGIN_ERROR_FALLBACK);
    expect(message).not.toContain("{");
  });
});
