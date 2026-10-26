import type { SceneState } from './contracts.ts';
import type * as Harness from './harness.ts';
export type { StoryTime, TemporalContext, WorldEntity, WorldClock, SpeakerReply, Observation, EpisodeMemory, EntityChange, ActorLocation } from './harness.ts';
export type WorldEntityKind = Harness.WorldEntity['kind'];
export type WorldActivity = Harness.WorldActivity & {occurredAt?:string;sourceTurnId?:string};
export interface ArcSource { source: 'user' | 'actor' | 'pulse'; quote: string; characterId?: string }
export type ArcProvenanceDetail = { status: 'source_verified'; turnId: string } & ArcSource
  | { status: 'legacy_unverified'; turnId?: string };
export type ArcProvenance = { kind: 'character_view' } & ArcProvenanceDetail;
export interface CharacterView { kind: 'character_view'; summary: string; provenance: ArcProvenanceDetail }

export interface CreateSessionOptions { playerProfileId?:string|null;dynamicOpening?:boolean;scene?:SceneState;expectedRevision?:number }
