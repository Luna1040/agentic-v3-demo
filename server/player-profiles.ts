import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { PlayerProfile } from '../shared/contracts.ts';
import { ServiceError } from './runtime.ts';
type Query = Pool | PoolClient;
const view = (r: any): PlayerProfile => ({ id:r.id,name:r.name,persona:r.persona,version:r.version });
export async function profiles(q: Query, owner: string): Promise<PlayerProfile[]> {
  return (await q.query('SELECT * FROM player_profiles WHERE owner_id=$1 ORDER BY created_at,id',[owner])).rows.map(view);
}
export async function profile(q: Query, owner: string, id: unknown): Promise<PlayerProfile> {
  if(typeof id!=='string'||! /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id)) throw new ServiceError('PROFILE_INVALID','玩家身份无效。',422);
  const r=(await q.query('SELECT * FROM player_profiles WHERE owner_id=$1 AND id=$2',[owner,id])).rows[0];
  if(!r) throw new ServiceError('PROFILE_NOT_FOUND','玩家身份不存在。',404);
  return view(r);
}
export async function saveProfile(q: Query, owner: string, id: string|null, value: {name:string;persona:string;expectedVersion?:number}): Promise<PlayerProfile> {
  if(!value||typeof value.name!=='string'||!value.name.trim()||value.name.length>80||typeof value.persona!=='string'||value.persona.length>3000||[value.name,value.persona].some(text=>/[\u0000\uD800-\uDFFF]/u.test(text)))
    throw new ServiceError('PROFILE_INVALID','姓名需为 1–80 字，persona 最多 3000 字。',422);
  if(id!==null){
    await profile(q,owner,id);
    validateProfileVersion(value.expectedVersion);
    const r=(await q.query('UPDATE player_profiles SET name=$3,persona=$4,version=version+1,updated_at=clock_timestamp() WHERE owner_id=$1 AND id=$2 AND version=$5 RETURNING *',[owner,id,value.name.trim(),value.persona.trim(),value.expectedVersion])).rows[0];
    if(!r) throw new ServiceError('PROFILE_CHANGED','身份已被修改，请重新载入。',409);
    return view(r);
  }
  // Serialize the small library limit across simultaneous create requests.
  await q.query("SELECT pg_advisory_xact_lock(hashtextextended('player-profiles:' || $1,0))",[owner]);
  if((await profiles(q,owner)).length>=30) throw new ServiceError('PROFILE_LIMIT','最多保存 30 套玩家身份。',422);
  return view((await q.query('INSERT INTO player_profiles(owner_id,id,name,persona) VALUES($1,$2,$3,$4) RETURNING *',[owner,randomUUID(),value.name.trim(),value.persona.trim()])).rows[0]);
}

export function validateProfileVersion(value: unknown): asserts value is number {
  // The stored version is a PostgreSQL integer; reject values before SQL casts them.
  if(!Number.isSafeInteger(value)||Number(value)<1||Number(value)>2147483647)
    throw new ServiceError('PROFILE_INVALID','身份版本无效。',422);
}
