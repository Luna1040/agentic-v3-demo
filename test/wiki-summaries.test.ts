import test from 'node:test';
import assert from 'node:assert/strict';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {WikiSummaries} from '../web/WikiSummaries';
import type {WorldView} from '../shared/contracts';
test('sourced Wiki output is visible as derived character prose and retains its source turn',()=>{
 const world:WorldView={id:'w',title:'世界',revision:1,createdAt:'2026-11-05',events:[],entities:[{id:'a',kind:'npc',name:'林晚',description:'',state:{},knownByCharacterIds:['a'],sourceTurnId:'seed',createdAt:'2026-11-05',updatedAt:'2026-11-05'}],wikiSummaries:[{characterId:'a',text:'林晚来到便利店。',sourceTurnId:'source-turn-12345678',updatedAt:'2026-11-05'}]};
 const html=renderToStaticMarkup(createElement(WikiSummaries,{world}));assert(html.includes('林晚来到便利店'));assert(html.includes('12345678'));assert(html.includes('不替代原始记录'));assert.equal(renderToStaticMarkup(createElement(WikiSummaries,{world:{...world,wikiSummaries:[]}})),'');
});
