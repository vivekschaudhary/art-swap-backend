// Runs pending migrations, then exits. Used by the compose `migrate` service and the release step (§12).
import { loadEnv } from "../config/env.js";
import { createPool } from "./client.js";
import { migrate } from "./migrate.js";

const env = loadEnv();
const pool = createPool(env.DATABASE_URL);
try {
  const applied = await migrate(pool, (name) => process.stdout.write(`applied ${name}\n`));
  process.stdout.write(applied.length === 0 ? "no pending migrations\n" : `done: ${applied.length} applied\n`);
  await pool.end();
  process.exit(0);
} catch (err) {
  process.stderr.write(`migration failed: ${(err as Error).message}\n`);
  await pool.end();
  process.exit(1);
}
