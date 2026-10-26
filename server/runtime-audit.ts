import { randomUUID } from 'node:crypto';
import type { Pool,PoolClient } from 'pg';
import type { RuntimeAuditView,WorldView } from '../shared/contracts.ts';
import { ServiceError } from './runtime.ts';
type Query=Pick<Pool|PoolClient,'query'>;
const iso=(value:string|Date)=>new Date(value).toISOString();
const uuid=(value:string)=>/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu.test(value);
/** Transactional observation only. Never store model reasoning or credentials;
 * raw dialogue and model input/output retain their existing trace ownership. */
export async function appendRuntimeAudit(q:Query,input:{ownerId:string;worldId:string;turnId?:string;batchId?:string;attemptId?:string;kind:string;data:Record<string,unknown>;id?:string}):Promise<string>{
 const id=input.id??randomUUID();
 const serialized=JSON.stringify(input.data,(key,value)=>/^(authorization|api[-_]?key|access[-_]?token|password|secret|reasoning|thinking|chainOfThought|hiddenThoughts)$/iu.test(key)?'[REDACTED]':typeof value==='string'?value.replace(/\bsk-[a-zA-Z0-9_-]{16,}\b/gu,'[REDACTED]'):value);
 if(Buffer.byteLength(serialized,'utf8')>2090000)throw new ServiceError('AUDIT_TOO_LARGE','执行审计超过保存上限；正文已保留。',422);
 await q.query(`INSERT INTO world_runtime_audit(id,owner_id,world_id,source_turn_id,batch_id,attempt,kind,data)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,input.ownerId,input.worldId,input.turnId??null,input.batchId??null,input.attemptId??null,input.kind,serialized]);
 return id;
}
export function auditEntity(row:Record<string,any>|undefined):Record<string,unknown>|null{
 if(!row)return null;
 const state={...row.state};for(const key of ['definition','greeting','initial','color'])delete state[key];
 return {id:row.id,kind:row.kind,name:row.name,version:row.version??1,description:row.description,state,sourceTurnId:row.source_turn_id??row.sourceTurnId??'seed'};
}
export async function readRuntimeAudit(q:Query,ownerId:string,world:WorldView,captureId?:string,includeCalls=false):Promise<RuntimeAuditView>{
 if(captureId!==undefined&&!uuid(captureId))throw new ServiceError('INPUT_INVALID','观测批次编号无效。',422);
 const captureRow=(await q.query(`SELECT * FROM world_runtime_audit WHERE owner_id=$1 AND world_id=$2 AND kind='capture_started'
  ${captureId?'AND id=$3':''} ORDER BY seq DESC LIMIT 1`,captureId?[ownerId,world.id,captureId]:[ownerId,world.id])).rows[0];
 if(captureId&&!captureRow)throw new ServiceError('CAPTURE_NOT_FOUND','观测批次不存在。',404);
 const capture=captureRow?{id:captureRow.id,startedAt:iso(captureRow.created_at),afterSeq:Number(captureRow.data.afterSeq),expectedTurns:Number(captureRow.data.expectedTurns)}:null;
 const rows=(await q.query(`SELECT t.id,t.seq,t.status,t.created_at,t.updated_at,t.input_json->>'userText' AS user_text,j.status AS settlement_status,j.attempts,j.batch_id,
   ARRAY(SELECT c.id FROM agent_calls c WHERE c.owner_id=t.owner_id AND c.world_id=t.world_id AND (c.turn_id=t.id OR c.record->'batchedTurnIds' @> jsonb_build_array(t.id::text)) ORDER BY c.seq) AS call_ids
  FROM turns t LEFT JOIN world_settlements j ON j.turn_id=t.id WHERE t.owner_id=$1 AND t.world_id=$2 AND t.operation='chat' ${capture?'AND t.seq>$3':''}
  ORDER BY t.seq ${capture?'ASC':'DESC'} LIMIT ${capture?capture.expectedTurns:7}`,capture?[ownerId,world.id,capture.afterSeq]:[ownerId,world.id])).rows;
 if(!capture)rows.reverse();
 const ids=rows.map(row=>row.id);
 const events=(await q.query(`SELECT * FROM world_runtime_audit WHERE owner_id=$1 AND world_id=$2 AND
   (source_turn_id=ANY($3::uuid[]) OR id=$4::uuid OR ($5::timestamptz IS NOT NULL AND created_at>=$5 AND kind='director_superseded' AND created_at<=COALESCE((SELECT max(updated_at) FROM turns WHERE id=ANY($3::uuid[])),clock_timestamp())))
   ORDER BY seq LIMIT 2001`,[ownerId,world.id,ids,capture?.id??null,capture?.startedAt??null])).rows;
 const calls=includeCalls?(await q.query(`SELECT turn_id,record FROM agent_calls WHERE owner_id=$1 AND world_id=$2 AND
  (turn_id=ANY($3::uuid[]) OR EXISTS(SELECT 1 FROM unnest($3::uuid[]) target(id) WHERE record->'batchedTurnIds' @> jsonb_build_array(target.id::text))) ORDER BY seq LIMIT 501`,[ownerId,world.id,ids])).rows:undefined;
 const capturedAt=iso((await q.query('SELECT clock_timestamp() AS now')).rows[0].now);
 return {capture,turns:rows.map(row=>({id:row.id,seq:Number(row.seq),userText:row.user_text??'',status:row.status,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),...(row.settlement_status?{settlementStatus:row.settlement_status,attempts:row.attempts}:{}),...(row.batch_id?{batchId:row.batch_id}:{}),callIds:row.call_ids})),
  events:events.slice(0,2000).map(row=>({id:row.id,kind:row.kind,at:iso(row.created_at),...(row.source_turn_id?{turnId:row.source_turn_id}:{}),...(row.batch_id?{batchId:row.batch_id}:{}),...(row.attempt?{attemptId:row.attempt}:{}),data:row.data})),
  backlog:{pendingTurns:world.settlementBacklog?.pendingTurns??0,failedTurns:world.settlementBacklog?.failedTurns??0,unresolvedCommands:world.settlementBacklog?.unresolvedCommands??0},worldRevision:world.revision,
  world:{id:world.id,title:world.title,revision:world.revision,capturedAt,scene:world.scene,entities:world.entities,eventLedger:world.eventLedger},truncated:events.length>2000,
  ...(calls?{calls:calls.slice(0,500).map(row=>({turnId:row.turn_id,record:row.record})),callsTruncated:calls.length>500}:{})};
}
