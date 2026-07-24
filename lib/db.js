import { neon } from '@neondatabase/serverless';

// Pooled connection for app read queries (Vercel injects DATABASE_URL).
export const sql = neon(process.env.DATABASE_URL);
