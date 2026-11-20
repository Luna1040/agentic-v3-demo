import type { WorldView } from '../shared/contracts';
import { EntityCard } from './WorldArchive';
import { storyTimeLabel } from './time-model';

export const inspectionTabs = [['overview', '总览'], ['npc', '人物'], ['location', '地点'], ['item', '物品'], ['quest', '约定与任务'], ['memory', '记忆']] as const;
export type InspectionTab = typeof inspectionTabs[number][0];
export function WorldInspection({ world, tab }: { world: WorldView; tab: InspectionTab }) {
  const entities = world.entities || [];
  if (tab === 'overview') return <section className="av-episode av-inspector-section"><h3>当前场景</h3><p>地点：{entities.find(entity => entity.id === world.scene?.location)?.name || world.scene?.location || '尚未确认'}</p><p>{storyTimeLabel(world.storyTime)}</p>{world.scene?.situation && <p>{world.scene.situation}</p>}<p>已结识 {entities.filter(entity => entity.kind === 'npc').length} 位人物 · 发现 {entities.filter(entity => entity.kind === 'location').length} 处地点</p></section>;
  if (tab === 'memory') return <p>这里保留已确认的故事记忆，可以停用不希望在后续对话中使用的记录。</p>;
  return <div className="av-entity-grid">{entities.filter(entity => entity.kind === tab).map(entity => <EntityCard key={entity.id} entity={entity} entities={entities} templates={[]} />)}{!entities.some(entity => entity.kind === tab) && <p>故事中还没有此类记录。</p>}</div>;
}
