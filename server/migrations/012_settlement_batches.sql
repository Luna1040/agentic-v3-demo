ALTER TABLE world_settlements ADD COLUMN batch_id uuid, ADD COLUMN offline_result jsonb, ADD COLUMN batch_disabled boolean NOT NULL DEFAULT false;
CREATE INDEX world_settlements_batch ON world_settlements(batch_id) WHERE batch_id IS NOT NULL;
