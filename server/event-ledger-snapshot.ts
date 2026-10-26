import type { Pool,PoolClient } from 'pg';
export interface LedgerOverflow { openEvents:number; omittedOpenEvents:number }
/** Open occurrences retain their identity before recent closed history consumes
 * the bounded context. Overflow is explicit, never interpreted as completion. */
export async function loadEventLedgerSnapshot(q:Pick<Pool|PoolClient,'query'>,ownerId:string,worldId:string) {
  const rows=(await q.query(`SELECT record,count(*) FILTER (WHERE record->>'phase' IN ('planned','in_progress')) OVER() AS open_count
    FROM world_story_events WHERE owner_id=$1 AND world_id=$2
    ORDER BY CASE WHEN record->>'phase' IN ('planned','in_progress') THEN 0 ELSE 1 END,updated_at DESC,id LIMIT 100`,[ownerId,worldId])).rows;
  const openEvents=Number(rows[0]?.open_count??0);
  return {events:rows.map(row=>row.record),overflow:{openEvents,omittedOpenEvents:Math.max(0,openEvents-100)}};
}
