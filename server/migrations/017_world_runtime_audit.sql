CREATE TABLE world_runtime_audit (
 id uuid PRIMARY KEY,
 seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
 owner_id text NOT NULL,
 world_id uuid NOT NULL,
 source_turn_id uuid REFERENCES turns(id),
 batch_id uuid,
 attempt uuid,
 kind text NOT NULL CHECK(length(kind) BETWEEN 1 AND 80),
 data jsonb NOT NULL CHECK(jsonb_typeof(data)='object' AND octet_length(data::text)<=2097152),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(owner_id,world_id) REFERENCES worlds(owner_id,id)
);
CREATE INDEX runtime_audit_world_timeline ON world_runtime_audit(owner_id,world_id,seq);
CREATE INDEX runtime_audit_turn_timeline ON world_runtime_audit(owner_id,world_id,source_turn_id,seq);
CREATE FUNCTION reject_runtime_audit_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'world_runtime_audit is append-only' USING ERRCODE='42501';
END;
$$;
CREATE TRIGGER runtime_audit_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON world_runtime_audit
 FOR EACH STATEMENT EXECUTE FUNCTION reject_runtime_audit_change();
