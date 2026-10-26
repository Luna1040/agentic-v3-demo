CREATE TABLE world_directions (
  owner_id text NOT NULL, world_id uuid NOT NULL,
  requested_turn_id uuid NOT NULL, claimed_turn_id uuid,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed')),
  attempt uuid, lease_expires_at timestamptz, due_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '3 seconds',
  plan jsonb, guard jsonb, input_json jsonb, attempts integer NOT NULL DEFAULT 0,
  error_code text, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,world_id),
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id),
  FOREIGN KEY(requested_turn_id) REFERENCES turns(id)
);
