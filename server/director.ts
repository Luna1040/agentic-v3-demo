import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { ServiceError, type ActorInput, type StoryRuntime } from './runtime.ts';
import type { StoryStore } from './store.ts';
import { isDeepStrictEqual } from 'node:util';
import { appendRuntimeAudit } from './runtime-audit.ts';
type Query = Pick<Pool | PoolClient, 'query'>;

type MainlineState = import('../shared/harness.ts').MainlinePlan;
function isMainline(value:any):value is MainlineState {
  return value?.planType==='mainline' && value.version===1 && Array.isArray(value.stages) && typeof value.id==='string';
}
async function elapsedTurns(q:Query,ownerId:string,worldId:string,plan:MainlineState):Promise<number> {
  return Number((await q.query(`SELECT count(*) AS n FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='committed'
    AND seq>(SELECT seq FROM turns WHERE owner_id=$1 AND world_id=$2 AND id=$3)`,[ownerId,worldId,plan.basedOnTurnId])).rows[0].n);
}
// A durable plan spans turns. The replaceable request is only a revision demand.
export async function requestDirection(q: Query, ownerId: string, worldId: string, turnId: string, reason?:string): Promise<void> {
  const row=(await q.query('SELECT plan,guard,status,requested_turn_id,attempt FROM world_directions WHERE owner_id=$1 AND world_id=$2',[ownerId,worldId])).rows[0];
  if(isMainline(row?.plan) && row.plan.status==='active') {
    const source=(await q.query('SELECT input_json FROM turns WHERE owner_id=$1 AND world_id=$2 AND id=$3',[ownerId,worldId,turnId])).rows[0]?.input_json;
    if(source && (row.guard?.focusId!==source.character.id || !isDeepStrictEqual(row.guard?.profile,source.playerProfile??null))) {
      reason='会话角色或玩家身份已改变，请根据新的互动对象修订主线。';
      await q.query("UPDATE world_directions SET plan=jsonb_set(plan,'{status}','\"abandoned\"'::jsonb) WHERE owner_id=$1 AND world_id=$2",[ownerId,worldId]);
    }
  }
  if(isMainline(row?.plan) && row.plan.status==='active' && row.status==='completed' && !reason) {
    const total=await elapsedTurns(q,ownerId,worldId,row.plan);
    const stage=row.plan.stages.find((stage:MainlineState['stages'][number])=>stage.id===row.plan.currentStageId);
    const stageTurns=await elapsedTurns(q,ownerId,worldId,{...row.plan,basedOnTurnId:row.guard?.stageStartTurnId??row.plan.basedOnTurnId});
    if(total<Math.min(10,row.plan.targetTurns) && stageTurns<(stage?.budgetTurns??10))return;
    reason='当前阶段或主线节奏预算已到，请依据实际进展调整，用户主动深入互动时延长，不得把计划当作已完成事实。';
  }
  await q.query(`INSERT INTO world_directions(owner_id,world_id,requested_turn_id) VALUES($1,$2,$3)
    ON CONFLICT(owner_id,world_id) DO UPDATE SET requested_turn_id=$3,
    status=CASE WHEN world_directions.status='running' THEN 'running' ELSE 'pending' END,
    attempts=0,due_at=clock_timestamp()+interval '3 seconds',
    plan=CASE WHEN world_directions.plan->>'planType'='mainline' THEN world_directions.plan ELSE NULL END,updated_at=clock_timestamp()`,[ownerId,worldId,turnId]);
  if(reason)await q.query(`UPDATE world_directions SET plan=jsonb_set(plan,'{revisionReason}',to_jsonb($3::text)) WHERE owner_id=$1 AND world_id=$2 AND plan IS NOT NULL`,[ownerId,worldId,reason]);
  if(row?.requested_turn_id&&row.requested_turn_id!==turnId&&['running','pending'].includes(row.status))await appendRuntimeAudit(q,{ownerId,worldId,turnId:row.requested_turn_id,attemptId:row.attempt??undefined,kind:'director_superseded',data:{lane:'director',reason:'newer_direction_request',supersededByTurnId:turnId,previousStatus:row.status}});
  await appendRuntimeAudit(q,{ownerId,worldId,turnId,kind:'director_requested',data:{lane:'director',reason:reason??'continue_story',previousTurnId:row?.requested_turn_id??null}});
}
export async function pauseDirectionForTurn(q:Query,ownerId:string,worldId:string):Promise<void> {
  // Fence an in-flight revision before freezing the next dialogue context. A
  // late Main cannot replace the plan that this turn's evidence refers to.
  const row=(await q.query('SELECT attempt,status,requested_turn_id FROM world_directions WHERE owner_id=$1 AND world_id=$2 FOR UPDATE',[ownerId,worldId])).rows[0];
  // Lock pending too: otherwise a worker could claim it while the new turn is
  // still uncommitted and invisible to its NOT EXISTS(running turn) check.
  if(!row || row.status!=='running')return;
  await q.query("UPDATE world_directions SET status='pending',attempt=NULL,lease_expires_at=NULL,updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2",[ownerId,worldId]);
  await q.query(`UPDATE agent_calls SET record=record || jsonb_build_object('status','cancelled','error',jsonb_build_object('code','DIRECTOR_SUPERSEDED','message','新的对话已开始，旧规划结果已失效。'))
    WHERE owner_id=$1 AND world_id=$2 AND attempt=$3 AND record->>'status'='running'`,[ownerId,worldId,row.attempt]);
  await appendRuntimeAudit(q,{ownerId,worldId,turnId:row.requested_turn_id,attemptId:row.attempt??undefined,kind:'director_superseded',data:{lane:'director',reason:'new_foreground_turn'}});
}
export async function invalidateDirection(q:Query,ownerId:string,worldId:string,reason:string):Promise<void> {
  // A manual edit may keep the same source turn ID. Fence the attempt as well as
  // abandoning the plan, otherwise its late result could restore the old route.
  const previous=(await q.query('SELECT requested_turn_id,attempt FROM world_directions WHERE owner_id=$1 AND world_id=$2',[ownerId,worldId])).rows[0];
  await q.query(`UPDATE agent_calls c SET record=record || jsonb_build_object('status','cancelled','error',jsonb_build_object('code','DIRECTOR_SUPERSEDED','message','场景已调整，旧规划已失效。'))
    WHERE owner_id=$1 AND world_id=$2 AND record->>'status'='running'
    AND attempt IN (SELECT attempt FROM world_directions WHERE owner_id=$1 AND world_id=$2)`,[ownerId,worldId]);
  const invalidated=await q.query("UPDATE world_directions SET plan=CASE WHEN plan->>'planType'='mainline' THEN jsonb_set(plan,'{status}','\"abandoned\"'::jsonb) ELSE NULL END,status='pending',attempt=NULL,lease_expires_at=NULL WHERE owner_id=$1 AND world_id=$2",[ownerId,worldId]);
  if(!invalidated.rowCount)return;
  await appendRuntimeAudit(q,{ownerId,worldId,turnId:previous?.requested_turn_id,attemptId:previous?.attempt??undefined,kind:'director_superseded',data:{lane:'director',reason}});
  const latest=(await q.query("SELECT id FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='committed' ORDER BY seq DESC LIMIT 1",[ownerId,worldId])).rows[0];
  if(latest)await requestDirection(q,ownerId,worldId,latest.id,reason);
}
function guard(input:ActorInput): unknown {
  const scene=input.scene;
  return {revision:input.world.revision,focusId:input.character.id,scene:scene?{location:scene.location,situation:scene.situation??null,presentCharacterIds:scene.presentCharacterIds,mode:scene.mode??null,playerPresent:scene.playerPresent??null}:null,
    profile:input.playerProfile??null};
}
export async function readPreparedDirection(q:Query,ownerId:string,input:ActorInput):Promise<unknown|undefined> {
  const {rows}=await q.query(`SELECT d.plan,d.guard,d.claimed_turn_id,
    (SELECT id FROM turns WHERE owner_id=$1 AND world_id=$2 AND status='committed' ORDER BY seq DESC LIMIT 1) AS latest
    FROM world_directions d WHERE owner_id=$1 AND world_id=$2 AND plan IS NOT NULL`,[ownerId,input.world.id]);
  const row=rows[0];
  if(isMainline(row?.plan)) {
    const current=guard(input) as any;
    if(row.plan.status!=='active' || row.guard?.focusId!==current.focusId || !isDeepStrictEqual(row.guard?.profile,current.profile))return undefined;
    return {...row.plan,elapsedTurns:await elapsedTurns(q,ownerId,input.world.id,row.plan)};
  }
  // Read-only adapter for an old queued next-scene plan. New execution emits mainlines.
  return row && row.claimed_turn_id===row.latest && isDeepStrictEqual(row.guard,guard(input)) ? row.plan : undefined;
}
export async function applyStoryProgress(q:Query,ownerId:string,worldId:string,turnId:string,progress:any):Promise<void> {
  if(!progress)return;
  const row=(await q.query('SELECT plan FROM world_directions WHERE owner_id=$1 AND world_id=$2 FOR UPDATE',[ownerId,worldId])).rows[0];
  if(!isMainline(row?.plan)||row.plan.status!=='active'||progress.planId!==row.plan.id||progress.stageId!==row.plan.currentStageId)return;
  const plan:MainlineState=structuredClone(row.plan);
  if(progress.decision==='continue')return;
  if(progress.decision==='redirect')plan.status='abandoned';
  else if(progress.decision==='complete') { plan.status='completed'; for(const stage of plan.stages)stage.status='completed'; }
  else if(progress.decision==='advance') {
    const index=plan.stages.findIndex(stage=>stage.id===plan.currentStageId); if(index<0)return;
    plan.stages[index].status='completed';
    const next=plan.stages[index+1];if(next){next.status='active';plan.currentStageId=next.id;}else plan.status='completed';
  } else return;
  await q.query("UPDATE world_directions SET plan=$3,guard=COALESCE(guard,'{}'::jsonb) || jsonb_build_object('stageStartTurnId',$4::text),updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2",[ownerId,worldId,plan,turnId]);
  if(plan.status!=='active')await requestDirection(q,ownerId,worldId,turnId,progress.reason||'主线已结束或用户选择了新方向。');
}

/** Optional advice. Stale completion is discarded, never applied as a world event. */
export class DirectorWorker {
  private stopped=false; private timer?:ReturnType<typeof setTimeout>; private busy?:Promise<void>; private controller?:AbortController;
  constructor(private store:StoryStore,private resolveRuntime:()=>Promise<StoryRuntime>) {}
  start(){this.schedule();}
  private schedule(){if(this.stopped)return;this.timer=setTimeout(()=>{this.busy=this.step().catch(()=>{}).finally(()=>{this.busy=undefined;this.schedule();});},1000);this.timer.unref();}
  private async step(){
    const runtime=await this.resolveRuntime(); if(this.stopped||!runtime.planNextScene)return;
    const q=await this.store.pool.connect(); let row:any;
    try{
      await q.query('BEGIN');
      row=(await q.query(`SELECT d.* FROM world_directions d WHERE
        (d.status='pending' OR d.status='running' AND d.lease_expires_at<=clock_timestamp()) AND d.due_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM turns t WHERE t.world_id=d.world_id AND t.status='running' AND t.lease_expires_at>clock_timestamp())
        AND NOT EXISTS(SELECT 1 FROM world_settlements j WHERE j.world_id=d.world_id AND j.status<>'completed')
        ORDER BY d.due_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
      if(row){row.attempt=randomUUID();await q.query("UPDATE world_directions SET status='running',attempt=$3,claimed_turn_id=requested_turn_id,lease_expires_at=clock_timestamp()+interval '120 seconds',attempts=attempts+1 WHERE owner_id=$1 AND world_id=$2",[row.owner_id,row.world_id,row.attempt]);
        await appendRuntimeAudit(q,{ownerId:row.owner_id,worldId:row.world_id,turnId:row.requested_turn_id,attemptId:row.attempt,kind:'director_claimed',data:{lane:'director',attemptNumber:row.attempts+1}});
      }
      await q.query('COMMIT');
    }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
    if(!row)return;
    const controller=new AbortController();this.controller=controller;
    const timeout=setTimeout(()=>controller.abort(new ServiceError('DIRECTOR_TIMEOUT','后台剧情建议超时。')),90000);timeout.unref();
    try{
      if(this.stopped)throw new ServiceError('DIRECTOR_INTERRUPTED','服务停止。');
      const source=await this.store.storedTurn(row.owner_id,row.requested_turn_id);
      const input=await this.store.previewInput(row.owner_id,source.sessionId,'');
      input.turnId=source.id;
      if(row.plan?.planType==='mainline') input.preparedScenePlan=row.plan; else delete input.preparedScenePlan;
      if(input.contextPack)input.contextPack.dialogue.beforeTurnId=source.id;
      for(const packet of Object.values(input.worldContext?.actorInputs??{})){
        packet.turnId=source.id;
        if(packet.contextPack)packet.contextPack.dialogue.beforeTurnId=source.id;
      }
      const prepared=await this.store.pool.query('UPDATE world_directions SET input_json=$3,guard=$4 WHERE owner_id=$1 AND world_id=$2 AND attempt=$5',[row.owner_id,row.world_id,input,guard(input),row.attempt]);
      if(prepared.rowCount!==1)return;
      const task=runtime.planNextScene(input,{signal:controller.signal,attemptId:row.attempt,onCall:async record=>{
        controller.signal.throwIfAborted();
        const serialized=JSON.stringify(record,(key,value)=>/^(authorization|api[-_]?key|access[-_]?token|password|secret)$/i.test(key)?'[REDACTED]':value);
        if(serialized.length>80000)throw new ServiceError('TRACE_INVALID','后台导演记录过长。');
        const saved=await this.store.pool.query(`INSERT INTO agent_calls(turn_id,attempt,id,owner_id,world_id,session_id,record)
          SELECT $1,$2,$3,$4,$5,$6,$7 WHERE EXISTS(SELECT 1 FROM world_directions WHERE owner_id=$4 AND world_id=$5 AND attempt=$2 AND status='running')
          ON CONFLICT(turn_id,attempt,id) DO UPDATE SET record=EXCLUDED.record,updated_at=clock_timestamp() WHERE agent_calls.record->>'status'='running' RETURNING id`,[source.id,row.attempt,record.id,row.owner_id,row.world_id,source.sessionId,serialized]);
        if(!saved.rowCount&&record.status!=='running')await appendRuntimeAudit(this.store.pool,{ownerId:row.owner_id,worldId:row.world_id,turnId:row.requested_turn_id,attemptId:row.attempt,kind:'director_superseded',data:{lane:'director',applied:false,reason:'attempt_fenced_call_returned',callId:record.id,callReceipt:JSON.parse(serialized)}});
      }});
      let abort!:()=>void;
      const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(controller.signal.reason);controller.signal.addEventListener('abort',abort,{once:true});});
      let result;try{result=await Promise.race([task,cancelled]);}finally{controller.signal.removeEventListener('abort',abort);}
      controller.signal.throwIfAborted();
      // New player input invalidates this request immediately (including while a
      // next turn is generating). Its eventual completion cannot restore old advice.
      await this.auditTransaction(async q=>{
      const completed=await q.query(`UPDATE world_directions SET
        status=CASE WHEN requested_turn_id=$4 THEN 'completed' ELSE 'pending' END,
        plan=CASE WHEN requested_turn_id=$4 THEN $5::jsonb ELSE plan END,lease_expires_at=NULL,error_code=NULL,updated_at=clock_timestamp()
        WHERE owner_id=$1 AND world_id=$2 AND attempt=$3 RETURNING status,requested_turn_id`,[row.owner_id,row.world_id,row.attempt,row.requested_turn_id,result.plan]);
      if(completed.rowCount){
        const calls=(await q.query('SELECT id FROM agent_calls WHERE owner_id=$1 AND world_id=$2 AND attempt=$3 ORDER BY seq',[row.owner_id,row.world_id,row.attempt])).rows;
        await appendRuntimeAudit(q,{ownerId:row.owner_id,worldId:row.world_id,turnId:row.requested_turn_id,attemptId:row.attempt,kind:completed.rows[0].status==='completed'?'director_completed':'director_superseded',data:{lane:'director',applied:completed.rows[0].status==='completed',plan:result.plan,callIds:calls.map(call=>call.id),newerTurnId:completed.rows[0].requested_turn_id}});
      }else await appendRuntimeAudit(q,{ownerId:row.owner_id,worldId:row.world_id,turnId:row.requested_turn_id,attemptId:row.attempt,kind:'director_superseded',data:{lane:'director',applied:false,reason:'attempt_fenced',plan:result.plan}});
      });
    }catch(error){
      await this.store.pool.query(`UPDATE agent_calls SET record=record || jsonb_build_object('status','failed','completedAt',clock_timestamp(),'error',jsonb_build_object('code','DIRECTOR_INTERRUPTED','message','后台建议未完成，不影响已保存对话。')),updated_at=clock_timestamp() WHERE attempt=$1 AND owner_id=$2 AND record->>'status'='running'`,[row.attempt,row.owner_id]).catch(()=>{});
      await this.auditTransaction(async q=>{
        const failed=await q.query(`UPDATE world_directions SET status=CASE WHEN requested_turn_id<>$4 OR $5 THEN 'pending' ELSE 'failed' END,
          lease_expires_at=NULL,error_code=$6,updated_at=clock_timestamp() WHERE owner_id=$1 AND world_id=$2 AND attempt=$3 RETURNING status`,[row.owner_id,row.world_id,row.attempt,row.requested_turn_id,this.stopped,error instanceof ServiceError?error.code:'DIRECTOR_FAILED']);
        if(failed.rowCount)await appendRuntimeAudit(q,{ownerId:row.owner_id,worldId:row.world_id,turnId:row.requested_turn_id,attemptId:row.attempt,kind:'director_failed',data:{lane:'director',code:error instanceof ServiceError?error.code:'DIRECTOR_FAILED',disposition:failed.rows[0].status}});
      }).catch(()=>{});
    }finally{clearTimeout(timeout);if(this.controller===controller)this.controller=undefined;}
  }
  private async auditTransaction(work:(q:Query)=>Promise<void>){
    const q=await this.store.pool.connect();
    try{await q.query('BEGIN');await work(q);await q.query('COMMIT');}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  }
  async shutdown(){this.stopped=true;clearTimeout(this.timer);this.controller?.abort(new ServiceError('DIRECTOR_INTERRUPTED','服务停止。'));await Promise.race([this.busy,new Promise(r=>{const t=setTimeout(r,2000);t.unref();})]);}
}
