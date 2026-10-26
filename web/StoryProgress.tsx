import type { WorldView } from '../shared/contracts';

const phases: Record<string,string> = {planned:'计划中',in_progress:'进行中',completed:'已完成',cancelled:'已取消'};
/** Owner archive only. Plans and unaccepted candidates are visibly distinct from facts. */
export function StoryProgress({world}:{world:WorldView}) {
  const plan=world.mainlinePlan;
  return <div className="av-episode-list av-story-progress">
    {plan && <details className="av-episode" open><summary><strong>{plan.status==='active'?'当前主线':plan.status==='completed'?'已结束主线':'已放弃路线'} · {plan.goal}</strong><span>{plan.elapsedTurns ?? 0} / {plan.targetTurns} 轮参考节奏</span></summary>
      <div className="av-episode-body"><p>这是可随选择调整的计划，尚未发生的阶段不会算作经历。</p>
        <ol>{plan.stages.map(stage=><li key={stage.id}><strong>{stage.status==='completed'?'已推进':plan.status!=='active'?'未执行':stage.status==='active'?'当前':'后续'} · {stage.goal}</strong><p>{stage.completionCondition}</p></li>)}</ol>
        {plan.revisionReason && <p>调整原因：{plan.revisionReason}</p>}
        <small>依据轮次 #{plan.basedOnTurnId.slice(-8)} · 当前阶段 {plan.currentStageId}</small>
      </div></details>}
    {(world.eventLedger??[]).map(event=><details className="av-episode" key={event.id}><summary><strong>{event.summary}</strong><span>{phases[event.phase] ?? event.phase}</span></summary>
      <div className="av-episode-body"><p>人物：{event.subjectId==='$player' ? world.playerProfile?.name || '玩家' : world.entities?.find(entity=>entity.id===event.subjectId)?.name ?? event.subjectId}</p><p>同一事项持续更新，共关联 {event.evidenceIds.length} 条来源。</p><small>事项 {event.id} · 最近来源 {event.lastSourceTurnId}</small></div></details>)}
    {!!world.deferredCommands?.length && <details className="av-episode"><summary>未采纳的归档记录 · {world.deferredCommands.length} 项</summary><div className="av-episode-body"><p>这些候选在当时未被采纳，保留原始对话与处理原因。后续回合可能已补全；这里不代表当前仍缺少这些信息。</p>{world.deferredCommands.map((item,index)=><p key={`${item.sourceTurnId}:${item.id}:${index}`}>{item.reason}</p>)}</div></details>}
    {!plan&&!world.eventLedger?.length&&!world.deferredCommands?.length&&<p className="av-dev-note">还没有整理完成的主线或事项。</p>}
  </div>;
}
