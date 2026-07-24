export const dynamic = 'force-dynamic';

export async function GET() {
  const hasDb = Boolean(process.env.DATABASE_URL);
  return Response.json({ ok: true, database_connected: hasDb });
}
