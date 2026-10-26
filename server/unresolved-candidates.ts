/** Failed extraction commands remain candidates, never facts or automatic replay.
 * A model's deliberate defer is ordinary undecided RP, not a storage failure. */
export const unresolvedCandidateTypes=['memory','discovery','item','commitment','movement','source_gap'] as const;
const types=new Set<string>(unresolvedCandidateTypes);
export function unresolvedCandidates(value:unknown):Array<Record<string,any>> {
  return Array.isArray(value)?value.filter(candidate=>candidate && typeof candidate==='object' && candidate.command && (types.has(candidate.command.type)||candidate.command.type==='defer'&&candidate.command.evidenceKind==='actual_action')):[];
}
export function candidateRecoveryCharacters(row:{candidate_commands?:unknown;character_id:string;episode_participant_ids:string[];activities:Array<{characterId:string}>}):string[] {
  const allowed=new Set([...row.episode_participant_ids,...row.activities.map(activity=>activity.characterId)]);
  const result=new Set<string>();
  for(const candidate of unresolvedCandidates(row.candidate_commands)) {
    const command=candidate.command;
    const recipients=Array.isArray(candidate.recoveryCharacterIds)?candidate.recoveryCharacterIds
      : command.type==='memory'&&typeof command.characterId==='string'?[command.characterId]:[row.character_id];
    for(const id of recipients)if(typeof id==='string'&&allowed.has(id)&&(command.type!=='memory'||id===command.characterId))result.add(id);
  }
  return [...result];
}
/** Static host SQL, never constructed from model content. */
export const unresolvedCandidatePredicate="(c.command->'command'->>'type' IN ('memory','discovery','item','commitment','movement','source_gap') OR (c.command->'command'->>'type'='defer' AND c.command->'command'->>'evidenceKind'='actual_action'))";
