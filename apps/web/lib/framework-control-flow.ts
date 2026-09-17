// Next.js throws NEXT_REDIRECT / NEXT_NOT_FOUND errors through awaited server
// actions to drive framework control flow. Mutation handlers must rethrow them
// instead of turning a pending sign-in/logout or not-found transition into a
// local error message; any other rejection is a real transport failure.
// See node_modules/next/dist/docs/01-app/03-api-reference/04-functions/unstable_rethrow.md.
export function isFrameworkControlFlowError(error: unknown) {
  return (
    error instanceof Error &&
    typeof (error as Error & { digest?: unknown }).digest === "string" &&
    ((error as Error & { digest: string }).digest.startsWith("NEXT_REDIRECT") ||
      (error as Error & { digest: string }).digest.startsWith("NEXT_NOT_FOUND"))
  );
}
