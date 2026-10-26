import test from 'node:test';
import assert from 'node:assert/strict';
import { ConversationController } from '../web/conversation-controller';
import { initialConversation } from '../web/conversation-state';

test('world refresh cannot erase a stream or committed reply; older/foreign world snapshots are ignored',()=>{
  const c=new ConversationController();
  const world={id:'w',revision:2,title:'世界',createdAt:'',events:[]};
  c.update(()=>({...initialConversation,loading:false,pending:{clientTurnId:'client',turnId:'t',content:'你好'},
    detail:{world,session:{id:'s',worldId:'w',characterId:'npc',title:'会话',createdAt:'',updatedAt:''},messages:[],hasMore:false,nextBefore:null}}));
  c.accept({type:'delta',turnId:'t',text:'米拉说：“你好。”',characterId:'npc'});
  c.refreshWorld({...world,revision:3,settlementBacklog:{pendingTurns:1,failedTurns:1,oldestPendingAt:null}});
  assert.equal(c.current.draft,'米拉说：“你好。”');assert.equal(c.current.pending?.turnId,'t');
  c.accept({type:'committed',turnId:'t',world,message:{id:'reply',sessionId:'s',turnId:'t',role:'assistant',content:'米拉说：“你好。”',createdAt:''}});
  assert.equal(c.current.detail?.world.revision,3);assert.equal(c.current.detail?.messages.length,1);
  c.refreshWorld({...world,id:'other',revision:99});c.refreshWorld({...world,revision:1});
  assert.equal(c.current.detail?.world.id,'w');assert.equal(c.current.detail?.world.revision,3);
  assert.equal(c.current.detail?.messages[0].content,'米拉说：“你好。”');assert.equal(c.current.pending,null);
});

test('persisted recovery ignores another session and preserves a completed single scene',()=>{
  const c=new ConversationController();const user={id:'u',sessionId:'s',turnId:'t',role:'user' as const,content:'你好',createdAt:''};
  c.update(()=>({...initialConversation,loading:false,pending:{clientTurnId:'client',turnId:'t',content:'你好'},detail:{world:{id:'w',revision:1,title:'世界',createdAt:'',events:[]},session:{id:'s',worldId:'w',characterId:'npc',title:'会话',createdAt:'',updatedAt:''},messages:[user],hasMore:false,nextBefore:null}}));
  const persisted={id:'t',sessionId:'other',worldId:'w',status:'committed' as const,phase:'responding' as const,userMessage:user,assistantMessage:{...user,id:'a',role:'assistant' as const,content:'完整场景'},createdAt:'',updatedAt:''};
  c.recover(persisted);assert.equal(c.current.pending?.turnId,'t');
  c.recover({...persisted,sessionId:'s'});assert.equal(c.current.pending,null);assert.equal(c.current.detail?.messages.length,2);
  c.recover({...persisted,sessionId:'s'});assert.equal(c.current.detail?.messages.length,2);
});
