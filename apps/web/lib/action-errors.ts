const GENERIC_ERROR = "Something went wrong.";
const UNAVAILABLE_ERROR =
  "Unable to save this change right now. Try again in a moment.";

/** A message an action raised itself, already written for the user; anything else is treated as untrusted internals. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

type BackendFailure = Error & { code?: string };

// Shape check rather than instanceof: class identity doesn't survive module mocking and would leak raw backend text.
function backendErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "BackendError") {
    return undefined;
  }

  return (error as BackendFailure).code;
}

// Maps on the backend's stable error.code, not message text: internal/upstream messages can leak serde offsets.
export function toActionError(error: unknown) {
  if (error instanceof Error && error.name === "ActionError") {
    return error.message;
  }

  const code = backendErrorCode(error);

  if (code !== undefined) {
    switch (code) {
      // Curated, user-facing messages the backend owns.
      case "conflict":
      case "bad_request":
      case "not_found":
      case "forbidden":
      case "unauthorized":
        return (error as Error).message;
      default:
        return UNAVAILABLE_ERROR;
    }
  }

  if (error instanceof Error && error.name === "TimeoutError") {
    return UNAVAILABLE_ERROR;
  }

  return GENERIC_ERROR;
}
