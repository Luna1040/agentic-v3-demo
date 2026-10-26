import type { AgentKey } from '../shared/contracts';
export const agentLabels: Record<AgentKey, string> = { main: 'Main · 主线规划', actor: 'Actor · 场景演绎', updater: 'WorldOps · 世界更新', opening: 'Opening · 开场导演', pulse: 'Pulse · 世界动态', arbiter: 'Arbiter · 冲突裁决' };
export const agentTestHelp: Record<AgentKey, string> = {
  main: '给出用户消息，只试跑覆盖数轮的主线规划；建议不会作为已发生的事实保存。',
  actor: '给出用户消息，一次生成当前场景的完整回复，正文可包含必要人物的行动与台词。',
  updater: '给出玩家消息与助手输出，检查 WorldOps 提出的候选变化。',
  opening: '描述开场情境，使用所选会话的实际世界与场景测试开场导演。',
  pulse: '描述希望检查的离线行动，使用会话世界快照测试世界动态。',
  arbiter: '描述需要裁决的冲突；也可以粘贴 JSON 参数原文检查候选处理。',
};
