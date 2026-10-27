import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/** Folder with SQL migrations. Overridable for bundled builds (DOJO_MIGRATIONS_DIR). */
export function migrationsFolder(): string {
  if (process.env.DOJO_MIGRATIONS_DIR) return process.env.DOJO_MIGRATIONS_DIR;
  return resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');
}

export async function runMigrations(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(sql), { migrationsFolder: migrationsFolder() });
  } finally {
    await sql.end({ timeout: 5 });
  }
}
