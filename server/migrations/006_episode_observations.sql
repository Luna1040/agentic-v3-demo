-- Preserve the owner's full transcript while recording exactly what each NPC perceived.
-- NULL denotes an old transcript with no perception partition; never infer new access from it.
ALTER TABLE turns ADD COLUMN episode_observations jsonb
  CHECK (episode_observations IS NULL OR jsonb_typeof(episode_observations)='object');
