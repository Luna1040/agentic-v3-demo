import type { ActorInput, WorldTurnResult } from './runtime.ts';
import type { Pool, PoolClient } from 'pg';
import { candidateRecoveryCharacters, unresolvedCandidatePredicate } from './unresolved-candidates.ts';
import { loadEventLedgerSnapshot,type LedgerOverflow } from './event-ledger-snapshot.ts';

type Row = Record<string, any>;
/** A request reads the world once. Per-character projection below performs no I/O. */
export interface ContextSnapshot {
  entities: Row[];
  knowledge: Map<string, Row[]>;
  pending: Row[];
  previous?: Row;
  turnSeqs: Map<string, number>;
  eventLedger: any[];
  eventLedgerOverflow?: LedgerOverflow;
}
export async function loadContextSnapshot(q: Pick<Pool | PoolClient, 'query'>, ownerId: string, worldId: string): Promise<ContextSnapshot> {
  const entities=(await q.query('SELECT * FROM world_entities WHERE owner_id=$1 AND world_id=$2 ORDER BY created_at,id',[ownerId,worldId])).rows;
  const knowledgeRows=(await q.query('SELECT character_id,snapshot,observed_at,source_turn_id FROM world_entity_knowledge WHERE owner_id=$1 AND world_id=$2 ORDER BY entity_id',[ownerId,worldId])).rows;
  const pendingRows=(await q.query(`SELECT t.id,t.seq,t.character_id,t.episode_participant_ids,t.activities,j.status,j.result->'deferredCommands' AS candidate_commands FROM turns t JOIN world_settlements j ON j.turn_id=t.id
    WHERE t.owner_id=$1 AND t.world_id=$2 AND t.status='committed' AND (j.status<>'completed' OR EXISTS(
      SELECT 1 FROM jsonb_array_elements(COALESCE(j.result->'deferredCommands','[]'::jsonb)) c(command) WHERE ${unresolvedCandidatePredicate}
    )) ORDER BY t.seq`,[ownerId,worldId])).rows;
  const pending=pendingRows.map(row=>{const {candidate_commands,...scope}=row;return {...scope,unresolvedCharacterIds:candidateRecoveryCharacters(row as any)};});
  const previous=(await q.query("SELECT updated_at,episode_scene,episode_participant_ids FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='committed' ORDER BY seq DESC LIMIT 1",[ownerId,worldId])).rows[0];
  const ids=entities.flatMap(row=>typeof row.state?.arcProvenance?.turnId==='string' ? [row.state.arcProvenance.turnId] : []).filter(id=>/^[a-f0-9-]{36}$/i.test(id));
  const sequences=ids.length?(await q.query('SELECT id,seq FROM turns WHERE owner_id=$1 AND world_id=$2 AND id=ANY($3::uuid[])',[ownerId,worldId,ids])).rows:[];
  const knowledge=new Map<string,Row[]>();
  for(const row of knowledgeRows) knowledge.set(row.character_id,[...(knowledge.get(row.character_id)??[]),row]);
  const ledger=await loadEventLedgerSnapshot(q,ownerId,worldId);
  return {entities,knowledge,pending,previous,eventLedger:ledger.events,eventLedgerOverflow:ledger.overflow,turnSeqs:new Map(sequences.map(row=>[row.id,Number(row.seq)]))};
}
/** Identity sightings never grant access to another character's private persona. */
export function knownEntityRows(snapshot: ContextSnapshot, characterId: string): Array<{row:Row;observedAt?:string;sourceTurnId?:string}> {
  const known=(snapshot.knowledge.get(characterId)??[]).flatMap(entry=>{
    const historical=entry.snapshot;
    const identity=snapshot.entities.find(current=>current.id===historical.id&&current.kind==='npc'&&current.state?.authoredCastKey);
    // Authored identity corrections do not make stale private state current.
    const row=identity?{...historical,name:identity.name,description:identity.description,state:{...historical.state,narrativeName:identity.state.narrativeName,narrativeAliases:identity.state.narrativeAliases}}:historical;
    const authorized=Array.isArray(row.known_by_character_ids)&&row.known_by_character_ids.includes(characterId);
    if(!authorized&&row.kind!=='npc')return [];
    return [{row:authorized?row:{...row,description:'',state:{initial:row.state?.initial,color:row.state?.color},known_by_character_ids:[characterId]},observedAt:entry.observed_at,sourceTurnId:entry.source_turn_id}];
  });
  const own=snapshot.entities.find(row=>row.id===characterId&&row.kind==='npc');
  return own?[...known.filter(entry=>entry.row.id!==characterId),{row:{...own,known_by_character_ids:[...new Set([...(own.known_by_character_ids??[]),characterId])]}}]:known;
}

export interface TurnEvidence { turnId:string; throughSeq:number; input:ActorInput; dialogue:WorldTurnResult }
export interface MemorySnapshot { characterId:string; throughSeq:number; sourceTurnId:string; summary:string; provenance:unknown }
export async function loadMemorySnapshot(q:Pick<Pool | PoolClient,'query'>,ownerId:string,worldId:string,characterId:string,beforeSeq:number|string):Promise<MemorySnapshot|undefined> {
  const row=(await q.query(`SELECT * FROM world_memory_snapshots WHERE owner_id=$1 AND world_id=$2 AND character_id=$3 AND through_seq<$4
    ORDER BY through_seq DESC LIMIT 1`,[ownerId,worldId,characterId,beforeSeq])).rows[0];
  return row ? {characterId,throughSeq:Number(row.through_seq),sourceTurnId:row.source_turn_id,summary:row.summary,provenance:row.provenance} : undefined;
}
export interface CommitContext { worldRevision:number; entityVersions:Record<string,number> }

/** Unrelated entities are deliberately absent from the optimistic write guard. */
export function dependencyVersions(input:{character?:{id:string};scene?:{presentCharacterIds:string[]};worldContext?:{entityHeadVersions?:Record<string,number>;actorInputs?:Record<string,any>}}):Record<string,number> {
  const versions={...(input.worldContext?.entityHeadVersions??{})};
  const participants=new Set([input.character?.id,...(input.scene?.presentCharacterIds??[])]);
  for(const [id,actor] of Object.entries(input.worldContext?.actorInputs??{}))if(participants.has(id))Object.assign(versions,dependencyVersions(actor));
  return versions;
}
export function dependenciesMatch(expected:Record<string,number>,actual:Record<string,number>):boolean {
  return Object.entries(expected).every(([id,version])=>actual[id]===version);
}
