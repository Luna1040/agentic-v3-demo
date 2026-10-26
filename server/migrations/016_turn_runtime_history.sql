-- Configuration changes may restart only a failed turn with no model result.
-- Keep its old attempt/configuration separately from actual model-call telemetry.
ALTER TABLE turns ADD COLUMN runtime_history jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(runtime_history)='array');
