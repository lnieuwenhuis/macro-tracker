import { upsertUserFromShooProfile, type DatabaseRuntime } from "../src";
import { createTestDatabase } from "../src/testing";

export async function setupSingleUserContext(): Promise<{
  runtime: DatabaseRuntime;
  userId: string;
}> {
  const runtime = await createTestDatabase();
  const user = await upsertUserFromShooProfile({
    pairwiseSub: "ps_test_user",
    email: "coach@example.com",
    displayName: "Coach",
  });
  return { runtime, userId: user.id };
}
