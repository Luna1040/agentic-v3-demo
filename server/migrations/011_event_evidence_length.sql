-- Events store the exact authorized user evidence, matching ActorInput's bound.
-- A long original message must not make asynchronous settlement fail repeatedly.
ALTER TABLE events DROP CONSTRAINT events_text_check;
ALTER TABLE events ADD CONSTRAINT events_text_check CHECK(length(text) BETWEEN 1 AND 8000);
