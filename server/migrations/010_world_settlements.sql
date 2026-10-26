CREATE TABLE world_settlements (
  id uuid PRIMARY KEY, seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id text NOT NULL, world_id uuid NOT NULL, turn_id uuid NOT NULL UNIQUE,
  session_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','failed','completed')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0), attempt uuid,
  lease_expires_at timestamptz, next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  dialogue jsonb NOT NULL, input_json jsonb, checkpoint jsonb, result jsonb,
  runtime_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  head_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_code text, error_message text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(owner_id,world_id,session_id,turn_id) REFERENCES turns(owner_id,world_id,session_id,id),
  CHECK(jsonb_typeof(dialogue)='object')
);
CREATE INDEX world_settlements_queue ON world_settlements(world_id,seq) WHERE status <> 'completed';
CREATE INDEX world_settlements_due ON world_settlements(next_attempt_at,seq) WHERE status IN ('pending','running');
