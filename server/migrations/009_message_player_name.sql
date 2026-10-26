-- Names belong to the message's identity snapshot, not the currently selected persona.
ALTER TABLE messages ADD COLUMN player_name text;
UPDATE messages m SET player_name=t.input_json->'playerProfile'->>'name'
FROM turns t WHERE m.turn_id=t.id AND m.owner_id=t.owner_id;
-- Original welcomes have no turn. Prefer the earliest session snapshot for old stories.
UPDATE messages m SET player_name=CASE
 WHEN EXISTS(SELECT 1 FROM turns t WHERE t.session_id=m.session_id AND t.owner_id=m.owner_id)
 THEN (SELECT t.input_json->'playerProfile'->>'name' FROM turns t WHERE t.session_id=m.session_id AND t.owner_id=m.owner_id ORDER BY t.seq LIMIT 1)
 ELSE w.player_profile->>'name' END
FROM worlds w WHERE m.turn_id IS NULL AND m.world_id=w.id AND m.owner_id=w.owner_id;
