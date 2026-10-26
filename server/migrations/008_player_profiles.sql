CREATE TABLE player_profiles (
  owner_id text NOT NULL, id uuid NOT NULL, name text NOT NULL CHECK(length(name) BETWEEN 1 AND 80),
  persona text NOT NULL DEFAULT '' CHECK(length(persona)<=3000),
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(owner_id,id)
);
-- World-owned snapshot: template edits/deletion never rewrite an existing story.
ALTER TABLE worlds ADD COLUMN player_profile jsonb CHECK(player_profile IS NULL OR jsonb_typeof(player_profile)='object');
