-- Chat operation signals, frozen rewrite references, complete pre-state world
-- snapshots and non-destructive version archiving. Historical migrations are
-- immutable; every new column/table is additive and defaults to the old behaviour.

-- The request signal is frozen on the turn. `operation` keeps its historical
-- meaning ('chat' | 'opening'); chat_type is the independent operation signal.
ALTER TABLE turns
  ADD COLUMN chat_type text NOT NULL DEFAULT 'chat'
    CHECK (chat_type IN ('chat','continue','regenerate','edit_regenerate')),
  ADD COLUMN target_turn_id uuid,
  ADD COLUMN request_hash text,
  ADD COLUMN continuation jsonb CHECK (continuation IS NULL OR jsonb_typeof(continuation)='object'),
  ADD COLUMN rewrite_reference jsonb CHECK (rewrite_reference IS NULL OR jsonb_typeof(rewrite_reference)='object'),
  ADD COLUMN snapshot_id uuid,
  ADD COLUMN committed_revision integer CHECK (committed_revision IS NULL OR committed_revision >= 0),
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN superseded_by uuid;
CREATE INDEX turns_active_history_idx ON turns(owner_id,session_id,seq DESC)
  WHERE status='committed' AND archived_at IS NULL;
CREATE INDEX turns_world_active_idx ON turns(owner_id,world_id,seq DESC)
  WHERE status='committed' AND archived_at IS NULL;

-- Old versions stay auditable: messages are archived, never deleted. Every read
-- projection (session detail, pagination, history, episodes) filters them out.
ALTER TABLE messages ADD COLUMN archived_at timestamptz;
CREATE INDEX messages_session_active_idx ON messages(owner_id,session_id,seq DESC)
  WHERE archived_at IS NULL;

-- A rewrite removes an entity from the current world projection but keeps the row
-- so archived messages that reference it keep their foreign key and audit trail.
ALTER TABLE world_entities ADD COLUMN archived_at timestamptz;
CREATE INDEX world_entities_active_idx ON world_entities(owner_id,world_id)
  WHERE archived_at IS NULL;

-- Complete pre-state projection captured at every turn begin. `data` covers every
-- world-derived table plus scene/clock/plan cursors; see server/store.ts
-- (WORLD_SNAPSHOT_TABLES) for the authoritative list and restore semantics.
CREATE TABLE world_snapshots (
  id uuid PRIMARY KEY,
  seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id text NOT NULL,
  world_id uuid NOT NULL,
  session_id uuid NOT NULL,
  turn_id uuid,
  world_revision integer NOT NULL CHECK (world_revision >= 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id)
);
CREATE INDEX world_snapshots_turn_idx ON world_snapshots(owner_id,world_id,turn_id);

-- Fenced background settlement jobs are moved here instead of deleted. A late
-- worker write can no longer find its live row, so it fails closed, while the full
-- original job record (including results/checkpoints) stays auditable.
CREATE TABLE world_settlement_archive (
  owner_id text NOT NULL,
  world_id uuid NOT NULL,
  turn_id uuid NOT NULL,
  superseded_by_turn_id uuid,
  sealed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  record jsonb NOT NULL CHECK (jsonb_typeof(record)='object'),
  PRIMARY KEY(owner_id,world_id,turn_id)
);
