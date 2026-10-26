-- Immutable migration snapshot. Active runtime prompts remain in agent_prompt_versions.
CREATE TABLE legacy_agent_catalog (
  key text PRIMARY KEY,
  name text NOT NULL,
  responsibility text NOT NULL,
  enabled boolean NOT NULL,
  current_version integer NOT NULL,
  prompt text NOT NULL,
  versions jsonb NOT NULL,
  source jsonb NOT NULL,
  checksum text NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
