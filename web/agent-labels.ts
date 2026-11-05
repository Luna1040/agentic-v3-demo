import type { AgentKey } from '../shared/contracts';
import type { AgentCallRecord } from '../shared/contracts';
export function callAgentLabel(call:AgentCallRecord):string { return call.delegateKey ? oldAgentLabels[call.delegateKey] ?? call.delegateKey : agentLabels[call.agent] ?? call.agent; }
export const oldAgentLabels:Record<string,string>={phase1_actor:'Phase1 Actor · 早期演员',scene_conductor:'Scene Conductor · 场景导演',character_actor:'Character Actor · 角色演员',opening_director:'Opening Director · 开场导演',teacher_worldops:'Teacher WorldOps · 记忆与物品',knowledge_audit:'Knowledge Audit · 知情审查',user_agency_audit:'User Agency Audit · 自主权审查',wiki_summarizer:'Wiki Summarizer · 档案摘要',world_arbiter:'World Arbiter · 冲突裁决',quest_keeper:'Quest Keeper · 任务约定',world_pulse_planner:'World Pulse Planner · 离线规划',location_generator:'Location Generator · 地点维护',encounter_resolver:'Encounter Resolver · 遭遇人物',delivery_formatter:'Delivery Formatter · 交付检查',auto_reply:'Auto Reply · 返场邀请',world_orchestrator:'Main · World Orchestrator',scene_locator:'Scene Locator · 当前定位'};
export const agentLabels: Record<AgentKey, string> = { main: 'Main · 主线规划', actor: 'Actor · 场景演绎', updater: 'WorldOps · 世界更新', opening: 'Opening · 开场导演', pulse: 'Pulse · 世界动态', arbiter: 'Arbiter · 冲突裁决' };
export const agentTestHelp: Record<AgentKey, string> = {
  main: '按当前运行方式试跑 Main 及其实际选中的子 Agent；只检查输入输出，不提交聊天或世界变化。',
  actor: '给出用户消息，一次生成当前场景的完整回复，正文可包含必要人物的行动与台词。',
  updater: '给出玩家消息与助手输出，检查 WorldOps 提出的候选变化。',
  opening: '描述开场情境，使用所选会话的实际世界与场景测试开场导演。',
  pulse: '描述希望检查的离线行动，使用会话世界快照测试世界动态。',
  arbiter: '描述需要裁决的冲突；也可以粘贴 JSON 参数原文检查候选处理。',
};
