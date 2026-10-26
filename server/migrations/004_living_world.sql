ALTER TABLE worlds
  ADD COLUMN root_character_id text,
  ADD COLUMN real_anchor_at timestamptz,
  ADD COLUMN clock_world_ms bigint NOT NULL DEFAULT 0 CHECK(clock_world_ms>=0),
  ADD COLUMN clock_active_ms bigint NOT NULL DEFAULT 0 CHECK(clock_active_ms>=0),
  ADD COLUMN clock_rate double precision NOT NULL DEFAULT 1 CHECK(clock_rate BETWEEN 0.1 AND 60),
  ADD COLUMN clock_mode text NOT NULL DEFAULT 'quiet' CHECK(clock_mode IN ('paused','quiet','active'));
UPDATE worlds w SET root_character_id=s.character_id FROM
  (SELECT DISTINCT ON(world_id) world_id,character_id FROM sessions ORDER BY world_id,seq) s WHERE s.world_id=w.id;
ALTER TABLE turns ADD CONSTRAINT turns_owner_world_id UNIQUE(owner_id,world_id,id);
CREATE TABLE world_entities (
  owner_id text NOT NULL, world_id uuid NOT NULL, id text NOT NULL,
  kind text NOT NULL CHECK(kind IN ('npc','location','item','quest','faction')),
  name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 120),
  description text NOT NULL CHECK(length(description)<=6000),
  state jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(state)='object'),
  known_by_character_ids text[] NOT NULL DEFAULT '{}', source_turn_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(world_id,id), UNIQUE(owner_id,world_id,id),
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id),
  FOREIGN KEY(owner_id,world_id,source_turn_id) REFERENCES turns(owner_id,world_id,id)
);
CREATE INDEX world_entities_known_idx ON world_entities(owner_id,world_id);
INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids)
SELECT DISTINCT s.owner_id,s.world_id,c.id,'npc',c.name,c.description,
  jsonb_build_object('definition',c.definition,'greeting',c.greeting,'initial',c.initial,'color',c.color,
    'origin','seed','rootCharacterId',w.root_character_id),ARRAY[c.id]
FROM sessions s JOIN characters c ON c.id=s.character_id JOIN worlds w ON w.id=s.world_id;
ALTER TABLE sessions
  ADD COLUMN scene jsonb CHECK(scene IS NULL OR jsonb_typeof(scene)='object'),
  ADD COLUMN dynamic_opening boolean NOT NULL DEFAULT false,
  DROP CONSTRAINT sessions_character_id_fkey,
  ADD CONSTRAINT sessions_world_character FOREIGN KEY(owner_id,world_id,character_id) REFERENCES world_entities(owner_id,world_id,id);
ALTER TABLE turns
  ADD COLUMN operation text NOT NULL DEFAULT 'chat' CHECK(operation IN ('chat','opening')),
  ADD COLUMN clock_snapshot jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(clock_snapshot)='object'),
  ADD COLUMN episode_scene jsonb,
  ADD COLUMN episode_participant_ids text[] NOT NULL DEFAULT '{}',
  ADD COLUMN activities jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(activities)='array');
UPDATE turns SET episode_scene=input_json->'scene',episode_participant_ids=ARRAY[character_id] WHERE status='committed';
ALTER TABLE messages
  DROP CONSTRAINT messages_turn_id_role_key,
  ADD COLUMN character_id text,
  ADD COLUMN character_name text,
  ADD COLUMN kind text NOT NULL DEFAULT 'dialogue' CHECK(kind IN ('dialogue','operation')),
  ADD CONSTRAINT messages_world_character FOREIGN KEY(owner_id,world_id,character_id) REFERENCES world_entities(owner_id,world_id,id);
UPDATE messages m SET character_id=s.character_id,character_name=e.name FROM sessions s JOIN world_entities e ON e.world_id=s.world_id AND e.id=s.character_id WHERE m.session_id=s.id AND m.role='assistant';
CREATE UNIQUE INDEX messages_one_user_per_turn ON messages(turn_id) WHERE role='user';
CREATE UNIQUE INDEX messages_one_actor_per_turn ON messages(turn_id,character_id) WHERE role='assistant';
CREATE INDEX turns_world_episodes_idx ON turns(owner_id,world_id,seq DESC) WHERE status='committed';
ALTER TABLE agent_prompt_versions DROP CONSTRAINT agent_prompt_versions_agent_key_check;
ALTER TABLE agent_prompt_versions ADD CONSTRAINT agent_prompt_versions_agent_key_check CHECK(agent_key IN ('main','actor','updater','opening','pulse','arbiter'));
DO $$ DECLARE found record; BEGIN
  FOR found IN SELECT conname FROM pg_constraint WHERE conrelid='agent_calls'::regclass AND contype='c' AND pg_get_constraintdef(oid) LIKE '%main%' LOOP
    EXECUTE format('ALTER TABLE agent_calls DROP CONSTRAINT %I',found.conname);
  END LOOP;
END $$;
ALTER TABLE agent_calls ADD CONSTRAINT agent_calls_agent_key_check CHECK(record->>'agent' IN ('main','actor','updater','opening','pulse','arbiter'));
