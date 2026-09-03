import { describe, expect, it } from "vitest";

import { ActionError, toActionError } from "@/lib/action-errors";

function backendError(code: string, message: string) {
  const error = new Error(message);
  error.name = "BackendError";
  (error as Error & { code?: string }).code = code;
  return error;
}

describe("toActionError", () => {
  it("returns the raised message for an ActionError", () => {
    expect(toActionError(new ActionError("Please pick a name."))).toBe("Please pick a name.");
  });

  it.each(["conflict", "bad_request", "not_found", "forbidden", "unauthorized"])(
    "passes through the backend message for %s",
    (code) => {
      expect(toActionError(backendError(code, "That barcode already exists."))).toBe(
        "That barcode already exists.",
      );
    },
  );

  it("replaces internal/upstream backend errors with a generic retry message", () => {
    expect(toActionError(backendError("internal", "serde offset 12 at upstream.example"))).toBe(
      "Unable to save this change right now. Try again in a moment.",
    );
  });

  it("falls back to generic copy when a BackendError-named error carries no code", () => {
    const error = new Error("Failed query: raw constraint text");
    error.name = "BackendError";

    expect(toActionError(error)).toBe("Something went wrong.");
  });

  it("treats a TimeoutError as a retryable failure", () => {
    const error = new Error("timed out");
    error.name = "TimeoutError";

    expect(toActionError(error)).toBe("Unable to save this change right now. Try again in a moment.");
  });

  it("falls back to a generic message for anything else", () => {
    expect(toActionError("nope")).toBe("Something went wrong.");
  });
});
