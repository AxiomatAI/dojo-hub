import { runMigrations } from './migrate-lib';

const url = process.env.DATABASE_URL;
if (!url) throw new Error('DATABASE_URL is required');
await runMigrations(url);
console.log('migrations applied');
