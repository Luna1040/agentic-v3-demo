import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresFixture, readPastDialogue } from './pg-helper.ts';

test('failed opening can restart after an upgrade while retaining the old turn and committed openings remain idempotent',async()=>{
 const f=await postgresFixture({livingWorld:true});
 try{
  const s=await f.store.createSession('alice','lin-wan',undefined,{dynamicOpening:true});
  const key=`opening:${s.session.id}`;
  const old=await f.store.beginTurn('alice',s.session.id,key,'开场',{version:1},{operation:'opening'});
  await f.store.finish(old,'failed','MAIN_AGENT_FAILED','原失败');
  const fresh=await f.store.beginTurn('alice',s.session.id,key,'开场',{version:2},{operation:'opening'});
  assert.notEqual(fresh.id,old.id);
  assert.equal((await f.store.getTurn('alice',old.id)).status,'failed');
  await assert.rejects(f.store.beginTurn('alice',s.session.id,key,'开场',{version:3},{operation:'opening'}),{code:'TURN_RUNNING'});
  await f.store.commit(fresh,'林晚点点头。',[],{observations:{'lin-wan':''}});
  const replay=await f.store.beginTurn('alice',s.session.id,key,'开场',{version:3},{operation:'opening'});
  assert.equal(replay.id,fresh.id);assert.equal(replay.status,'committed');
 }finally{await f.cleanup();}
});

for (const livingWorld of [false, true]) test(`only a fresh static world inserts the card greeting (livingWorld=${livingWorld})`, async () => {
  const fixture = await postgresFixture({ livingWorld });
  const { store } = fixture;
  try {
    const greeting = '初次见面，欢迎来到书店。';
    await fixture.migrationPool.query("UPDATE characters SET greeting=$1 WHERE id='lin-wan'", [greeting]);
    for (const dynamicOpening of [false, true]) {
      const profile = await store.savePlayerProfile('alice', null, { name: '原来的玩家', persona: '书店的访客' });
      const first = await store.createSession('alice', 'lin-wan', undefined, { dynamicOpening, playerProfileId: profile.id });
      assert.deepEqual(first.messages.map(message => message.content), dynamicOpening ? [] : [greeting]);
      assert.equal(first.session.dynamicOpening, dynamicOpening);
      if (!livingWorld && !dynamicOpening) {
        const initialInput = await store.previewInput('alice', first.session.id, '你好');
        assert.deepEqual(initialInput.history, [{ role: 'assistant', content: greeting }]);
        assert.equal(initialInput.character.greeting, greeting);
      }

      const userText = '我已经来过书店，今天继续聊。';
      const turn = await store.beginTurn('alice', first.session.id, 'original-chat', userText);
      await store.commit(turn, '林晚翻到上次看到的那页。', [{ kind: 'fact', text: userText, visibility: 'private', characterId: 'lin-wan', evidence: { source: 'user', turnId: turn.id } }], { observations: { 'lin-wan': userText } });
      const oldMessages = (await store.getSession('alice', first.session.id)).messages;
      assert.equal(oldMessages.find(message => message.role === 'user')?.playerName, profile.name);

      // Existing worlds must inherit the frozen snapshot, even after template edits/deletion.
      const updated = await store.savePlayerProfile('alice', profile.id, { name: '模板的新姓名', persona: '模板的新设定', expectedVersion: profile.version });
      await store.deletePlayerProfile('alice', updated.id, updated.version);
      for (const options of [{}, { dynamicOpening: false }, { dynamicOpening: true }]) {
        const before = await store.getWorld('alice', first.world.id);
        const continued = await store.createSession('alice', 'lin-wan', first.world.id, { ...options, expectedRevision: before.revision });
        assert.equal(continued.session.worldId, first.world.id);
        assert.equal(continued.session.dynamicOpening, options.dynamicOpening ?? false);
        assert.deepEqual(continued.messages, [], 'continuations must not replay the original card greeting');
        assert.deepEqual((await store.getSession('alice', continued.session.id)).messages, []);
        assert.deepEqual(continued.world.playerProfile, profile);
        const input = await store.previewInput('alice', continued.session.id, '继续上次的对话。');
        assert.deepEqual(input.history, [], 'an empty continuation must not synthesize greeting history');
        assert.equal(input.character.greeting, '');
        assert.deepEqual(input.playerProfile, profile);
        if (livingWorld || options.dynamicOpening) {
          assert.deepEqual(input.episodes,[]);
          assert((await readPastDialogue(store,'alice',continued.session.id,'lin-wan',[turn.id])).some(episode=>episode.turnId===turn.id && episode.userText===userText && episode.replies[0].text==='林晚翻到上次看到的那页。'));
          assert.equal(input.worldContext?.actorInputs['lin-wan'].character.greeting, '');
          assert.deepEqual(input.worldContext?.actorInputs['lin-wan'].history, []);
        } else {
          assert(input.world.events.some(event => event.evidence?.turnId === turn.id && event.text === userText));
        }
        assert.deepEqual((await store.getSession('alice', first.session.id)).messages, oldMessages, 'opening another session must not rewrite old messages or names');
      }
      const rows = await store.pool.query(`SELECT count(*)::int AS count FROM messages m WHERE owner_id=$1 AND world_id=$2 AND (turn_id IS NULL OR EXISTS(SELECT 1 FROM turns t WHERE t.id=m.turn_id AND t.status='committed'))`, ['alice', first.world.id]);
      assert.equal(rows.rows[0].count, oldMessages.length, 'only the original session may contribute existing messages');
    }
  } finally { await fixture.cleanup(); }
});


test('default creation persists the exact authored welcome and makes no turn or generated NPC', async () => {
 const f=await postgresFixture({livingWorld:true});
 try {
  const welcome='**林晚**推开书店的门。“欢迎，{{user}}。”';
  await f.migrationPool.query("UPDATE characters SET greeting=$1 WHERE id='lin-wan'",[welcome]);
  const detail=await f.store.createSession('alice','lin-wan');
  assert.equal(detail.session.dynamicOpening,false);
  assert.deepEqual(detail.messages.map(m=>m.content),[welcome]);
  assert.equal(detail.world.entities?.filter(e=>e.kind==='npc').length,1);
  assert.equal((await f.migrationPool.query('SELECT count(*)::int AS n FROM turns WHERE world_id=$1',[detail.world.id])).rows[0].n,0);
  const input=await f.store.previewInput('alice',detail.session.id,'你好');
  assert.equal(input.contextPack!.card.openingBackground,welcome.replace('{{user}}','玩家'));assert.equal(input.character.greeting,'');
  assert.equal(input.worldContext?.actorInputs['lin-wan'].contextPack!.card.openingBackground,welcome.replace('{{user}}','玩家'));
 } finally {await f.cleanup();}
});
