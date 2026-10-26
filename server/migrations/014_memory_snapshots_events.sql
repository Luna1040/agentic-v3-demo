-- Separate immutable memory history and event identity from the current projection.
CREATE TABLE world_memory_snapshots (
 owner_id text NOT NULL, world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
 character_id text NOT NULL, source_turn_id uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
 through_seq bigint NOT NULL, summary text NOT NULL, provenance jsonb NOT NULL,
 PRIMARY KEY(world_id,character_id,source_turn_id)
);
CREATE INDEX memory_snapshot_edge ON world_memory_snapshots(owner_id,world_id,character_id,through_seq DESC);
INSERT INTO world_memory_snapshots(owner_id,world_id,character_id,source_turn_id,through_seq,summary,provenance)
SELECT DISTINCT ON (j.world_id,c.change->'entity'->>'id',t.id)
 j.owner_id,j.world_id,c.change->'entity'->>'id',t.id,t.seq,c.change->'entity'->'state'->>'arc',
 c.change->'arcSource' || jsonb_build_object('kind','character_view','status','source_verified','turnId',t.id)
FROM world_settlements j JOIN turns t ON t.id=j.turn_id
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(j.result->'entityChanges','[]')) WITH ORDINALITY c(change,n)
WHERE j.status='completed' AND t.status='committed'
 AND c.change->'entity'->>'kind'='npc' AND jsonb_typeof(c.change->'entity'->'state'->'arc')='string'
 AND length(trim(c.change->'entity'->'state'->>'arc'))>0
 AND c.change->'arcSource'->>'source' IN ('user','actor','pulse')
 AND length(trim(c.change->'arcSource'->>'quote'))>0
ORDER BY j.world_id,c.change->'entity'->>'id',t.id,c.n DESC;
CREATE TABLE world_story_events (
 owner_id text NOT NULL,world_id uuid NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
 id text NOT NULL,version integer NOT NULL CHECK(version>0),record jsonb NOT NULL,
 source_turn_id uuid NOT NULL REFERENCES turns(id),last_source_turn_id uuid NOT NULL REFERENCES turns(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(world_id,id)
);
CREATE INDEX story_events_recent ON world_story_events(owner_id,world_id,updated_at DESC);
