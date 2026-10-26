-- A durable model-stage receipt is business evidence; trace completion is telemetry.
ALTER TABLE world_settlements ADD COLUMN offline_receipt jsonb;
