import { createHash } from 'node:crypto';

export interface AuthoredCastMember {
  key: string; name: string; description: string; personality: string;
  narrativeName?: string; aliases?: string[]; initial?: string;
  color?: 'sage'|'blue'|'peach'; presentAtStart?: boolean;
}
export interface AuthoredCast { version: 1; sharedBackground: string; members: AuthoredCastMember[] }
const text=(value:unknown,max:number,empty=false):value is string=>typeof value==='string' && (empty||!!value.trim()) && value.length<=max && !/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);

/** Import-time authoring metadata, never inferred from the title or dialogue. */
export function authoredCast(source:unknown):AuthoredCast|undefined {
  const raw=(source as {cast?:unknown}|null)?.cast;
  if(raw===undefined)return undefined;
  const cast=raw as AuthoredCast;
  if(!cast||cast.version!==1||!text(cast.sharedBackground,12000,true)||!Array.isArray(cast.members)||cast.members.length<2||cast.members.length>6
    ||cast.members.some(member=>!member||!text(member.key,64)||!/^[a-zA-Z0-9_-]+$/u.test(member.key)||!text(member.name,80)||!text(member.description,12000,true)||!text(member.personality,20000,true)
      ||member.narrativeName!==undefined&&!text(member.narrativeName,80)||member.initial!==undefined&&!text(member.initial,8)
      ||member.color!==undefined&&!['sage','blue','peach'].includes(member.color)||member.presentAtStart!==undefined&&typeof member.presentAtStart!=='boolean'
      ||member.aliases!==undefined&&(!Array.isArray(member.aliases)||member.aliases.length>12||member.aliases.some(alias=>!text(alias,80))))
    ||new Set(cast.members.map(member=>member.key)).size!==cast.members.length||new Set(cast.members.map(member=>member.name)).size!==cast.members.length||cast.members[0].presentAtStart===false)
    throw new Error('Invalid authored cast metadata; expected 2–6 distinct people and a present primary member.');
  return structuredClone(cast);
}

/** The primary identity retains the old root ID so archived references stay valid. */
export function castMemberId(rootId:string,key:string,index:number):string {
  return index===0?rootId:`cast:${createHash('sha256').update(rootId+'\0'+key).digest('hex').slice(0,32)}`;
}
export function castProfiles(card:Record<string,any>) {
  const cast=authoredCast(card.source);
  return cast?.members.map((member,index)=>({
    id:castMemberId(card.id,member.key,index),name:member.name,description:member.description,
    definition:[cast.sharedBackground,member.personality].filter(Boolean).join('\n\n'),
    greeting:index===0?card.greeting:'',initial:member.initial??Array.from(member.name)[0],color:member.color??card.color,
    source:{narrativeName:member.narrativeName??member.name,narrativeAliases:member.aliases??[],castKey:member.key},
    presentAtStart:member.presentAtStart!==false,
  }));
}

export function authoredMemorySummary(state:Record<string,any>,individualSummary=''):string {
  const shared=state.authoredSharedMemory as {summary?:string;sourceTurnIds?:string[]}|undefined;
  // Exact source IDs remain in the stored record/UI. Repeating them in the
  // model summary consumes its bounded memory window without adding knowledge.
  const summary=shared?.summary?`【拆分时的共同公开记录；后续状态以实体和个人摘要为准】${shared.summary}`:'';
  return [summary,individualSummary].filter(Boolean).join('\n\n');
}
