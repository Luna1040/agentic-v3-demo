-- Story chronology is separate from UTC record timestamps. Old stories stay unknown.
ALTER TABLE worlds ADD COLUMN story_time jsonb CHECK(story_time IS NULL OR jsonb_typeof(story_time)='object');
ALTER TABLE worlds ADD COLUMN story_elapsed_ms bigint NOT NULL DEFAULT 0 CHECK(story_elapsed_ms>=0);
ALTER TABLE turns ADD COLUMN story_time jsonb CHECK(story_time IS NULL OR jsonb_typeof(story_time)='object');
ALTER TABLE turns ADD COLUMN episode_entity_ids text[] NOT NULL DEFAULT '{}';
CREATE INDEX turns_episode_entities_idx ON turns USING gin(episode_entity_ids) WHERE status='committed';
ALTER TABLE world_entities ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
CREATE TABLE world_entity_knowledge (
  owner_id text NOT NULL, world_id uuid NOT NULL, character_id text NOT NULL, entity_id text NOT NULL,
  version integer NOT NULL CHECK(version>0), snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(), source_turn_id uuid,
  PRIMARY KEY(world_id,character_id,entity_id),
  FOREIGN KEY(owner_id,world_id,entity_id) REFERENCES world_entities(owner_id,world_id,id),
  FOREIGN KEY(owner_id,world_id,character_id) REFERENCES world_entities(owner_id,world_id,id),
  FOREIGN KEY(owner_id,world_id,source_turn_id) REFERENCES turns(owner_id,world_id,id)
);
CREATE INDEX world_entity_knowledge_actor_idx ON world_entity_knowledge(owner_id,world_id,character_id);
-- Preserve existing declared knowledge at the migration boundary; infer no lost history.
INSERT INTO world_entity_knowledge(owner_id,world_id,character_id,entity_id,version,snapshot,observed_at,source_turn_id)
SELECT e.owner_id,e.world_id,n.id,e.id,e.version,to_jsonb(e),e.updated_at,e.source_turn_id
FROM world_entities e JOIN world_entities n ON n.owner_id=e.owner_id AND n.world_id=e.world_id AND n.kind='npc'
AND (n.id=ANY(e.known_by_character_ids) OR (e.kind='npc' AND e.id=n.id));
