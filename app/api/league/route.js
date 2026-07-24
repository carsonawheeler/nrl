import { getLeagueData } from '../../../lib/league';

export const dynamic = 'force-dynamic';

// JSON view of the DB-derived league bundle (TEAMS, PLAYERS, COACHES, MOVES,
// S1PICKS/S2PICKS, CHAMPS, RINGS, RESULTS, STATS). The page route bakes the same
// bundle into the DC document; this endpoint is handy for debugging/inspection.
export async function GET() {
  const data = await getLeagueData();
  return Response.json(data);
}
