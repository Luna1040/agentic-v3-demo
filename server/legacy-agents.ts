import type { AgentKey } from '../shared/contracts.ts';
import type { Pool } from 'pg';

const map: Record<string, { executionKeys: AgentKey[]; implementation: string }> = {
  phase1_actor: { executionKeys: ['actor'], implementation: '早期单角色演出由独立 Character Actor 接替；原 Prompt 留档。' },
  scene_conductor: { executionKeys: ['main'], implementation: '真实模型规划场景、生成本世界新 NPC，并调用 run_scene。' },
  character_actor: { executionKeys: ['actor'], implementation: '每位登场 NPC 单独调用 Actor，只读取自己的授权上下文。' },
  opening_director: { executionKeys: ['opening'], implementation: '新场景动态开场，与正式回合共享幂等提交和多人演出。' },
  teacher_worldops: { executionKeys: ['updater'], implementation: '维护事件、人物、地点、物品和任务候选；宿主验证后原子提交。' },
  knowledge_audit: { executionKeys: ['actor', 'arbiter'], implementation: '知识隔离由宿主组装上下文落实；角色遵守知识边界，明确冲突交由 Arbiter。原独立审查 Prompt 留档。' },
  user_agency_audit: { executionKeys: ['actor', 'arbiter'], implementation: 'Actor 保留用户选择，高风险裁决交由 Arbiter；原独立审查 Prompt 留档。' },
  wiki_summarizer: { executionKeys: ['updater'], implementation: '世界档案直接展示已提交实体和有来源的互动，暂不额外调用模型生成攻略文章。' },
  world_arbiter: { executionKeys: ['arbiter'], implementation: '明确冲突或高风险候选触发真实裁决调用。' },
  quest_keeper: { executionKeys: ['updater', 'pulse'], implementation: '任务状态归 WorldOps，返场结算读取已知任务；不提前写入未来结果。' },
  world_pulse_planner: { executionKeys: ['pulse'], implementation: '用户返场时按真实间隔有界结算，暂停或间隔不足不调用模型。' },
  location_generator: { executionKeys: ['main', 'opening', 'updater'], implementation: '场景规划提出地点，最终提交后进入本世界档案。' },
  encounter_resolver: { executionKeys: ['main', 'actor', 'arbiter'], implementation: '场景安排、独立演出与冲突裁决共同承接遭遇；没有独立随机战斗引擎。' },
  delivery_formatter: { executionKeys: [], implementation: '改为确定性的多角色消息渲染、流式展示和持久化，无额外模型调用。' },
  auto_reply: { executionKeys: ['pulse'], implementation: '归并为用户返场时的离线结算与待参与邀请；不在后台自动发消息或持续消耗 token。' },
  world_orchestrator: { executionKeys: ['main', 'opening', 'pulse'], implementation: 'Harness 调度回合，宿主负责租约、检查点、权限、时钟与事务提交。' },
};

export async function legacyAgentCatalog(pool: Pool) {
  const result = await pool.query('SELECT key,name,responsibility,enabled,current_version,prompt,versions,source FROM legacy_agent_catalog ORDER BY key');
  return result.rows.map(row => ({ key: row.key, name: row.name, responsibility: row.responsibility, enabled: row.enabled,
    currentVersion: row.current_version, prompt: row.prompt, versions: row.versions,
    configuration: { promptKey: row.source.definition.prompt_key ?? null, modelRouteId: row.source.definition.model_route_id ?? null,
      runtimeLimits: JSON.parse(row.source.definition.runtime_limits ?? '{}'),
      config: JSON.parse(row.source.definition.config ?? '{}') },
    ...(map[row.key] ?? { executionKeys: [], implementation: '历史定义留档；当前未连接执行路径。' }),
  }));
}
