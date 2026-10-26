import test from 'node:test';
import assert from 'node:assert/strict';
import {playerDeparture} from '../shared/scene-transition.ts';
test('natural exits do not require Main to propose final presence',()=>{
  for(const raw of ['我从她让开的门边出去，朝教室走去。','我推门离开器材室，去冲澡。','我转身走出了房间。']) assert(playerDeparture(raw,[],'器材室'),raw);
  const raw='我拿起自己的水杯，朝更衣室走去，心里已经开始惦记热水和早餐。';
  assert(playerDeparture(raw,['目送你进了走廊，她低头看表。'],'田径场'));
  assert.equal(playerDeparture(raw,[],'田径场'),undefined,'heading alone is not arrival or departure');
});
test('intent, quoted speech, other-person movements and NPC inventions cannot remove the player',()=>{
  for(const raw of ['“我离开以后你怎么办？”','我没有离开器材室。','如果我离开房间呢？','我看她走出了门。','我打算离开。','我站在原地。']) assert.equal(playerDeparture(raw,['她目送你进了走廊。'],'器材室'),undefined,raw);
  assert.equal(playerDeparture('我离开器材室，又回到器材室。',[],'器材室'),undefined);
});
