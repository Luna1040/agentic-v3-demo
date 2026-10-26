import type { Observation } from '../shared/living-world.ts';

export const observationText = (value: Observation | undefined): string => Array.isArray(value) ? value.join('\n') : value ?? '';

/** Each selected source fragment remains separately auditable; never search the joined text. */
export function validObservation(value: unknown, source: string): value is Observation {
  if (typeof value === 'string') return value.length <= 8000 && (value === '' || source.includes(value));
  if (!Array.isArray(value) || value.length < 1 || value.length > 8 || value.some(part => typeof part !== 'string' || !part.trim())) return false;
  if (value.join('\n').length > 8000) return false;
  let cursor = 0;
  for (const part of value as string[]) {
    const index = source.indexOf(part, cursor);
    if (index < 0) return false;
    cursor = index + part.length;
  }
  return true;
}

/** Correlated to the existing events e / turns t aliases. No additional database object.
 * PostgreSQL independently verifies every fragment in source order, without overlap,
 * and binds the exact displayed event text to their canonical newline join.
 */
export const verifiedObservationSql = `(
  WITH RECURSIVE observation_source AS (
    SELECT CASE WHEN t.episode_observations IS NULL THEN to_jsonb(t.input_json->>'userText')
      ELSE t.episode_observations->e.character_id END AS value, t.input_json->>'userText' AS raw
  ), observation_parts AS (
    SELECT part.ordinality AS n, part.value #>> '{}' AS quote, jsonb_typeof(part.value)='string' AS valid_type, source.raw
    FROM observation_source source CROSS JOIN LATERAL jsonb_array_elements(
      CASE WHEN jsonb_typeof(source.value)='string' THEN jsonb_build_array(source.value)
        WHEN jsonb_typeof(source.value)='array' THEN CASE WHEN jsonb_array_length(source.value) BETWEEN 1 AND 8 THEN source.value ELSE '[]'::jsonb END
        ELSE '[]'::jsonb END
    ) WITH ORDINALITY AS part(value,ordinality)
  ), observation_matches(n,end_at,valid) AS (
    SELECT 0::bigint,0,true
    UNION ALL
    SELECT part.n,matched.end_at+found.position-1+char_length(part.quote),
      matched.valid AND part.valid_type AND char_length(btrim(part.quote))>0 AND found.position>0
    FROM observation_matches matched JOIN observation_parts part ON part.n=matched.n+1
    CROSS JOIN LATERAL (SELECT strpos(substr(part.raw,matched.end_at+1),part.quote) AS position) found
  )
  SELECT count(*) BETWEEN 1 AND 8
    AND char_length(string_agg(quote,E'\\n' ORDER BY n))<=8000
    AND string_agg(quote,E'\\n' ORDER BY n)=e.text
    AND COALESCE((SELECT valid FROM observation_matches ORDER BY n DESC LIMIT 1),false)
  FROM observation_parts
)`;
