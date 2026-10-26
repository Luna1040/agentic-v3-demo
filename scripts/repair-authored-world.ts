import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {loadLocalEnvironment,databaseSettings} from '../server/config.ts';
import {createPool} from '../server/database.ts';
import {StoryStore} from '../server/store.ts';
import {authoredCast} from '../server/authored-cast.ts';
import {loadRuntime} from '../server/load-runtime.ts';

// Explicit operator repair from reviewed author metadata and literal evidence.
// Stop the service and back up the database before running; no model is called.
const file=process.argv[2];if(!file)throw Error('Provide a reviewed repair JSON file.');
const spec=JSON.parse(readFileSync(file,'utf8'));
const cast=authoredCast({cast:spec.cast});if(!cast)throw Error('Missing cast.');
loadLocalEnvironment();
const pool=createPool(databaseSettings().migrationConnectionString(),{max:2});
const store=new StoryStore(pool,{livingWorld:true});
try {
  const initial=await store.getWorld(spec.ownerId,spec.worldId);
  if(initial.revision!==spec.expectedRevision)throw Error('World changed; review the repair again.');
  const card=(await pool.query('SELECT root_character_id FROM worlds WHERE owner_id=$1 AND id=$2',[spec.ownerId,spec.worldId])).rows[0];
  await pool.query("UPDATE characters SET source=source || jsonb_build_object('cast',$2::jsonb) WHERE id=$1",[card.root_character_id,JSON.stringify(cast)]);
  let world=await store.repairAuthoredCast(spec.ownerId,spec.worldId,initial.revision,spec.sharedMemory);
  const q=await pool.connect();
  try {
    await q.query('BEGIN');
    const locked=(await q.query('SELECT revision FROM worlds WHERE owner_id=$1 AND id=$2 FOR UPDATE',[spec.ownerId,spec.worldId])).rows[0];
    if(locked.revision!==world.revision)throw Error('World changed during repair.');
    // A reviewed joint scene may disclose selected existing public entities to
    // the newly separated people. Never broadcast every old/private entity.
    for(const entityId of spec.sharedEntityIds??[]) {
      const shared=(await q.query('SELECT id,source_turn_id FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND id=$3',[spec.ownerId,spec.worldId,entityId])).rows[0];
      if(!shared||!spec.sharedMemory?.sourceTurnIds.includes(shared.source_turn_id))throw Error('Shared entity lacks reviewed joint-scene evidence.');
      const people=world.entities!.filter(e=>e.kind==='npc'&&world.scene!.presentCharacterIds.includes(e.id)).map(e=>e.id);
      await q.query('UPDATE world_entities SET known_by_character_ids=ARRAY(SELECT DISTINCT unnest(known_by_character_ids || $4::text[])) WHERE owner_id=$1 AND world_id=$2 AND id=$3',[spec.ownerId,spec.worldId,entityId,people]);
      await q.query(`INSERT INTO world_entity_knowledge(owner_id,world_id,character_id,entity_id,version,snapshot,observed_at,source_turn_id)
        SELECT e.owner_id,e.world_id,n.id,e.id,e.version,to_jsonb(e),clock_timestamp(),e.source_turn_id FROM world_entities e
        JOIN world_entities n ON n.world_id=e.world_id AND n.id=ANY($4::text[]) WHERE e.owner_id=$1 AND e.world_id=$2 AND e.id=$3
        ON CONFLICT(world_id,character_id,entity_id) DO UPDATE SET snapshot=EXCLUDED.snapshot,version=EXCLUDED.version,observed_at=EXCLUDED.observed_at,source_turn_id=EXCLUDED.source_turn_id`,[spec.ownerId,spec.worldId,entityId,people]);
    }
    for(const intent of spec.itemIntents??[]) {
      if(typeof intent.name!=='string'||!intent.name.trim()||intent.name.length>120||typeof intent.summary!=='string'||intent.summary.length>400||typeof intent.quote!=='string'||!intent.quote.trim())throw Error('Invalid reviewed item intent.');
      const source=(await q.query("SELECT id,input_json,episode_participant_ids FROM turns WHERE owner_id=$1 AND world_id=$2 AND id=$3 AND status='committed'",[spec.ownerId,spec.worldId,intent.sourceTurnId])).rows[0];
      if(!source||!source.input_json.userText.includes(intent.quote)||!intent.quote.includes(intent.name))throw Error('Intent is not supported by literal player evidence.');
      const exists=(await q.query("SELECT id FROM world_entities WHERE owner_id=$1 AND world_id=$2 AND kind='item' AND name=$3",[spec.ownerId,spec.worldId,intent.name])).rowCount;
      if(exists)continue;
      const hex=createHash('sha256').update(spec.worldId+'\0'+intent.sourceTurnId+'\0'+intent.name).digest('hex');
      const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-5${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`;
      const witnesses=world.entities!.filter(e=>e.kind==='npc'&&world.scene!.presentCharacterIds.includes(e.id)).map(e=>e.id);
      const state={status:'待执行',pendingIntent:{phase:'planned',summary:intent.summary},repairEvidence:{source:'user',turnId:source.id,quote:intent.quote,method:'reviewed_backfill'}};
      await q.query("INSERT INTO world_entities(owner_id,world_id,id,kind,name,description,state,known_by_character_ids,source_turn_id) VALUES($1,$2,$3,'item',$4,$5,$6,$7,$8)",[spec.ownerId,spec.worldId,id,intent.name,intent.summary,state,witnesses,source.id]);
      const record={id:'evt_'+hex.slice(0,32),kind:'item',subjectId:'$player',summary:intent.summary,phase:'planned',sourceTurnId:source.id,lastSourceTurnId:source.id,evidenceIds:['reviewed:user:'+source.id],entityId:id,version:1};
      await q.query('INSERT INTO world_story_events(owner_id,world_id,id,version,record,source_turn_id,last_source_turn_id) VALUES($1,$2,$3,1,$4,$5,$5)',[spec.ownerId,spec.worldId,record.id,record,source.id]);
      await q.query(`INSERT INTO world_entity_knowledge(owner_id,world_id,character_id,entity_id,version,snapshot,observed_at,source_turn_id)
        SELECT e.owner_id,e.world_id,n.id,e.id,e.version,to_jsonb(e),clock_timestamp(),$4 FROM world_entities e
        JOIN world_entities n ON n.world_id=e.world_id AND n.id=ANY($5::text[])
        WHERE e.owner_id=$1 AND e.world_id=$2 AND e.id=$3`,[spec.ownerId,spec.worldId,id,source.id,witnesses]);
    }
    await q.query('UPDATE worlds SET revision=revision+1 WHERE owner_id=$1 AND id=$2',[spec.ownerId,spec.worldId]);
    await q.query('COMMIT');
  }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  world=await store.getWorld(spec.ownerId,spec.worldId);
  if(spec.expectedUpdaterPrompt!==undefined) {
    const current=(await store.getPrompts()).find(p=>p.key==='updater');
    if(!current||current.version!==spec.expectedUpdaterVersion||current.content!==spec.expectedUpdaterPrompt)throw Error('Updater prompt changed; preserve the edit and review separately.');
    const runtime=await loadRuntime();
    if(runtime.prompts!.updater!==current.content)await store.savePrompt('updater',runtime.prompts!.updater,current.version);
  }
  console.log(JSON.stringify({worldId:world.id,revision:world.revision,npcs:world.entities!.filter(e=>e.kind==='npc').map(e=>({id:e.id,name:e.name})),items:world.entities!.filter(e=>e.kind==='item').map(e=>({name:e.name,state:e.state}))}));
}finally{await store.close();}
