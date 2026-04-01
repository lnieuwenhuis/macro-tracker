import { closeDatabase } from "./client";
import { migrateCurrentDatabase } from "./migration";

async function main() {
  await migrateCurrentDatabase();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDatabase();
  });
