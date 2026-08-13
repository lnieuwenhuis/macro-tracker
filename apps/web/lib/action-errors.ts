const GENERIC_ERROR = "Something went wrong.";
const UNAVAILABLE_ERROR =
  "Unable to save this change right now. Try again in a moment.";

/**
 * A message an action raised itself, already written for the user. Anything
 * else that reaches {@link toActionError} is treated as untrusted internals.
 */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ActionError";
  }
}

type BackendFailure = Error & { code?: string };

/**
 * Shape check rather than `instanceof`: the class identity does not survive
 * module mocking or a duplicated package instance, and falling through there
 * would leak raw backend text to the user.
 */
function backendErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || error.name !== "BackendError") {
    return undefined;
  }

  return (error as BackendFailure).code;
}

/**
 * Turns a thrown backend failure into copy that is safe to render.
 *
 * Maps on the backend's stable `error.code`, not on message text. The previous
 * implementations matched Drizzle-era strings (`"Failed query:"`, raw
 * constraint names) that the Rust port already masks, so every branch was dead
 * and the intended copy — "That barcode already exists." — never appeared.
 * Anything the backend classifies as internal or upstream is replaced outright:
 * those messages can carry operation names, serde offsets and upstream URLs.
 */
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
