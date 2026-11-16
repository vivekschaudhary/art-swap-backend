// Runs pending migrations, then exits. Reads only DATABASE_URL, so CI and the migrate workflow
// need just that secret. Used by .github/workflows/migrate.yml and the local compose migrate service.
import { createPool } from "./client.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  process.stderr.write("DATABASE_URL is not set\n");
  process.exit(1);
}

const pool = createPool(databaseUrl);

/** Waits for the database to accept connections, since a fresh database can take a moment. */
async function waitForDatabase(attempts = 30): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await pool.query("select 1");
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      process.stdout.write(`waiting for database (attempt ${i}): ${(err as Error).message}\n`);
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
}

try {
  await waitForDatabase();
  const applied = await migrate(pool, (name) => process.stdout.write(`applied ${name}\n`));
  process.stdout.write(applied.length === 0 ? "no pending migrations\n" : `done: ${applied.length} applied\n`);
  await pool.end();
  process.exit(0);
} catch (err) {
  process.stderr.write(`migration failed: ${(err as Error).message}\n`);
  await pool.end();
  process.exit(1);
}
