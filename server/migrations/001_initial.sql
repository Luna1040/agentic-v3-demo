CREATE TABLE characters (
  id text PRIMARY KEY, name text NOT NULL, subtitle text NOT NULL, description text NOT NULL,
  initial text NOT NULL, color text NOT NULL CHECK (color IN ('sage','blue','peach')), greeting text NOT NULL,
  sort_order integer NOT NULL UNIQUE
);
CREATE TABLE worlds (
  id uuid PRIMARY KEY, seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id text NOT NULL, title text NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(owner_id,id)
);
CREATE TABLE sessions (
  id uuid PRIMARY KEY, seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id text NOT NULL, world_id uuid NOT NULL, character_id text NOT NULL REFERENCES characters(id), title text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id),
  UNIQUE(owner_id,world_id,id), UNIQUE(owner_id,world_id,id,character_id)
);
CREATE TABLE turns (
  id uuid PRIMARY KEY, seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id text NOT NULL, world_id uuid NOT NULL, session_id uuid NOT NULL, character_id text NOT NULL,
  client_turn_id text NOT NULL, content_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('running','committed','failed','cancelled')),
  phase text NOT NULL CHECK(phase IN ('responding','settling')), base_revision integer NOT NULL CHECK(base_revision >= 0),
  input_json jsonb NOT NULL, runtime_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_draft text, attempt uuid NOT NULL, lease_expires_at timestamptz NOT NULL,
  error_code text, error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(owner_id,world_id,session_id,character_id) REFERENCES sessions(owner_id,world_id,id,character_id),
  UNIQUE(session_id,client_turn_id), UNIQUE(owner_id,world_id,session_id,id), UNIQUE(owner_id,world_id,id,character_id),
  CHECK(jsonb_typeof(input_json)='object' AND jsonb_typeof(runtime_metadata)='object' AND jsonb_typeof(usage)='object')
);
CREATE UNIQUE INDEX one_running_turn_per_world ON turns(world_id) WHERE status='running';
CREATE INDEX turns_history_idx ON turns(owner_id,session_id,seq DESC) WHERE status='committed';
CREATE TABLE messages (
  id uuid PRIMARY KEY, seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id text NOT NULL, world_id uuid NOT NULL, session_id uuid NOT NULL, turn_id uuid,
  role text NOT NULL CHECK(role IN ('user','assistant')), content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(owner_id,world_id,session_id) REFERENCES sessions(owner_id,world_id,id),
  FOREIGN KEY(owner_id,world_id,session_id,turn_id) REFERENCES turns(owner_id,world_id,session_id,id),
  CHECK(turn_id IS NOT NULL OR role='assistant'), UNIQUE(turn_id,role)
);
CREATE INDEX messages_session_idx ON messages(owner_id,session_id,seq DESC);
CREATE TABLE events (
  id uuid PRIMARY KEY, seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id text NOT NULL, world_id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('event','fact','relationship')), text text NOT NULL CHECK(length(text) BETWEEN 1 AND 1200),
  visibility text NOT NULL CHECK(visibility IN ('public','private')), character_id text NOT NULL,
  source_turn_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(owner_id,world_id,source_turn_id,character_id) REFERENCES turns(owner_id,world_id,id,character_id)
);
CREATE INDEX events_world_idx ON events(owner_id,world_id,seq DESC);
CREATE INDEX sessions_owner_idx ON sessions(owner_id,updated_at DESC,seq DESC);
CREATE INDEX worlds_owner_idx ON worlds(owner_id,seq DESC);
