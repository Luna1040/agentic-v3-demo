ALTER TABLE characters
  ADD COLUMN definition text NOT NULL DEFAULT '',
  ADD COLUMN thumbnail_url text,
  ADD COLUMN cover_url text,
  ADD COLUMN language text NOT NULL DEFAULT 'zh-CN',
  ADD COLUMN source_kind text NOT NULL DEFAULT 'sample' CHECK(source_kind IN ('sample','legacy')),
  ADD COLUMN source jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(source)='object');
UPDATE characters SET definition=description;

ALTER TABLE worlds ADD COLUMN scene jsonb NOT NULL DEFAULT '{"location":null,"presentCharacterIds":[]}'::jsonb;
UPDATE worlds AS w SET scene=jsonb_build_object('location',NULL,'presentCharacterIds',jsonb_build_array(s.character_id))
FROM (SELECT DISTINCT ON(world_id) world_id,character_id FROM sessions ORDER BY world_id,updated_at DESC,seq DESC) AS s
WHERE w.id=s.world_id;
ALTER TABLE worlds ADD CONSTRAINT worlds_scene_shape CHECK(
  jsonb_typeof(scene)='object'
  AND scene ? 'location' AND jsonb_typeof(scene->'location') IN ('null','string')
  AND (scene->>'location' IS NULL OR length(scene->>'location')<=120)
  AND scene ? 'presentCharacterIds' AND jsonb_typeof(scene->'presentCharacterIds')='array'
  AND jsonb_array_length(scene->'presentCharacterIds')<=6
);
ALTER TABLE turns ADD COLUMN runtime_checkpoint jsonb CHECK(runtime_checkpoint IS NULL OR jsonb_typeof(runtime_checkpoint)='object');
ALTER TABLE turns DROP CONSTRAINT turns_phase_check;
ALTER TABLE turns ADD CONSTRAINT turns_phase_check CHECK(phase IN ('planning','responding','settling'));

CREATE TABLE agent_calls (
  turn_id uuid NOT NULL, attempt uuid NOT NULL, id text NOT NULL,
  owner_id text NOT NULL, world_id uuid NOT NULL, session_id uuid NOT NULL,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  record jsonb NOT NULL CHECK(jsonb_typeof(record)='object' AND record ?& ARRAY['id','attemptId','agent','status']),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(turn_id,attempt,id),
  FOREIGN KEY(owner_id,world_id,session_id,turn_id) REFERENCES turns(owner_id,world_id,session_id,id),
  CHECK(record->>'id'=id AND record->>'attemptId'=attempt::text),
  CHECK(record->>'agent' IN ('main','actor','updater')),
  CHECK(record->>'status' IN ('running','completed','failed','cancelled','reused'))
);
CREATE INDEX agent_calls_owner_turn_idx ON agent_calls(owner_id,turn_id,seq);

CREATE TABLE agent_prompt_versions (
  agent_key text NOT NULL CHECK(agent_key IN ('main','actor','updater')),
  version integer NOT NULL CHECK(version>0),
  content text NOT NULL CHECK(length(btrim(content))>0 AND length(content)<=12000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(agent_key,version)
);
CREATE FUNCTION reject_agent_prompt_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Agent prompt versions are immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER agent_prompts_immutable BEFORE UPDATE OR DELETE ON agent_prompt_versions
FOR EACH ROW EXECUTE FUNCTION reject_agent_prompt_mutation();
