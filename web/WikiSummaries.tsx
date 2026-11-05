import type {WorldView} from '../shared/contracts';
import {ReadingText} from './ChatMessage';

/** A sourced projection, deliberately separate from committed entity facts. */
export function WikiSummaries({world}:{world:WorldView}){
  if(!world.wikiSummaries?.length)return null;
  return <section className="av-entity-arc" aria-label="世界档案摘要"><h3>世界档案摘要</h3><p>根据已保存互动整理的记述，可能包含人物视角，不替代原始记录。</p>{world.wikiSummaries.map(summary=><article key={summary.characterId}><h4>{world.entities?.find(e=>e.id===summary.characterId)?.name??'人物记述'}</h4><ReadingText content={summary.text}/><small>来源回合 #{summary.sourceTurnId.slice(-8)}</small></article>)}</section>;
}
