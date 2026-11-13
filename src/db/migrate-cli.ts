// Runs pending migrations, then exits. Used by the compose `migrate` service and the release step (§12).
import { loadEnv } from "../config/env.js";
import { createPool } from "./client.js";
import { migrate } from "./migrate.js";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);

/** Waits for the database to accept connections. A healthy container doesn't guarantee this on first boot. */
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
