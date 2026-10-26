ALTER TABLE events
  ADD COLUMN evidence jsonb,
  ADD COLUMN status text NOT NULL DEFAULT 'unverified' CHECK(status IN ('active','unverified','retracted'));
ALTER TABLE events DROP CONSTRAINT events_text_check;
ALTER TABLE events ADD CONSTRAINT events_text_check CHECK(length(text) BETWEEN 1 AND 8000);
ALTER TABLE events ADD CONSTRAINT events_evidence_shape CHECK(
  evidence IS NULL OR (jsonb_typeof(evidence)='object'
    AND evidence=jsonb_build_object('source','user','turnId',source_turn_id::text))
);
ALTER TABLE events ADD CONSTRAINT events_active_evidence CHECK(status<>'active' OR evidence IS NOT NULL);
CREATE UNIQUE INDEX events_one_verified_per_turn ON events(source_turn_id) WHERE evidence IS NOT NULL;
CREATE INDEX events_active_world_idx ON events(owner_id,world_id,seq DESC) WHERE status='active';
