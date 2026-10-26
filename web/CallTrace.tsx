import { Activity, ChevronRight, Clock3 } from 'lucide-react';
import type { AgentCallRecord, ModelUsage } from '../shared/contracts';
import { agentLabels } from './agent-labels';
import { actorRecallSummary } from './time-model';
import { callCharacterLabel, callForest, displayValue, type CallNode } from './trace-model';

const statusLabels = { running: '运行中', completed: '完成', failed: '失败', cancelled: '已停止', reused: '复用已保存结果' };
export function Usage({ usage }: { usage?: ModelUsage }) {
  return <span className="av-usage">输入 {usage?.inputTokens ?? '未返回'} · 输出 {usage?.outputTokens ?? '未返回'} · 总计 {usage?.totalTokens ?? '未返回'} tokens</span>;
}

/** Folded view keeps the drawer compact; the inline panel renders the same evidence without another click. */
function CallInputOutput({ call, expanded }: { call: AgentCallRecord; expanded: boolean }) {
  if (expanded) return <div className="av-call-io">
    <span className="av-call-io-label">实际输入</span>
    <pre className="av-call-io-block">{displayValue(call.input)}</pre>
    <span className="av-call-io-label">实际返回</span>
    <pre className="av-call-io-block">{displayValue(call.output)}</pre>
  </div>;
  return <>
    <details><summary><ChevronRight size={12} />实际输入</summary><pre>{displayValue(call.input)}</pre></details>
    <details><summary><ChevronRight size={12} />实际返回</summary><pre>{displayValue(call.output)}</pre></details>
  </>;
}

function CallBranch({ node, expanded }: { node: CallNode; expanded: boolean }) {
  const { call } = node;
  const characterLabel = callCharacterLabel(call);
  const recall = call.agent === 'actor' ? actorRecallSummary(call.input) : undefined;
  const duration = call.completedAt ? Math.max(0, new Date(call.completedAt).getTime() - new Date(call.startedAt).getTime()) : null;
  return <div className="av-call-branch"><article className={'av-call is-' + call.status}><div className="av-call-heading"><strong><Activity size={13} />{agentLabels[call.agent] || call.agent}{characterLabel && <small className="av-call-character">{characterLabel}</small>}</strong><span>{statusLabels[call.status]}</span></div><div className="av-call-model"><span>{call.model || '未记录模型'}</span><span><Clock3 size={10} />{duration === null ? call.status === 'running' ? '进行中' : '未记录时长' : `${(duration / 1000).toFixed(2)}s`}</span></div><Usage usage={call.usage} />{recall && <details className="av-recall-summary"><summary>实际记忆输入：{recall.count} 段 · {recall.sessions} 个会话 · {recall.related} 段相关旧经历</summary><p>{recall.time}</p><p className="av-dev-note">这里是本次实际传入的经历，不代表模型一定正确使用。完整原文见实际输入。</p>{recall.records.map((record, index) => <div key={`${record.turnId}-${index}`}><strong>{record.reason} · #{record.turnId.slice(-8)}</strong><p>{record.time}{record.matches.length ? ` · 匹配：${record.matches.join("、")}` : ""}</p></div>)}</details>}{call.sourceCallId && <small className="av-source-call">复用调用：{call.sourceCallId}</small>}{call.error && <p className="av-form-error">{call.error.code} · {call.error.message}</p>}<CallInputOutput call={call} expanded={expanded} /></article>{node.children.length > 0 && <div className="av-call-children">{node.children.map(child => <CallBranch key={child.call.id} node={child} expanded={expanded} />)}</div>}</div>;
}
export function CallTrace({ calls, expanded = false }: { calls: AgentCallRecord[]; expanded?: boolean }) {
  const attempts = [...new Set(calls.map(call => call.attemptId))];
  if (!calls.length) return <div className="av-trace-empty"><Activity size={25} /><p>这一轮尚无调用记录。</p><small>执行可能尚未开始，或服务端未保存调用记录；不会根据消息补造。</small></div>;
  return <div className="av-call-list">{attempts.map((attempt, index) => <section key={attempt} className="av-call-attempt"><h3>第 {index + 1} 次执行 <span>{attempt.slice(0, 8)}</span></h3>{callForest(calls.filter(call => call.attemptId === attempt)).map(node => <CallBranch key={node.call.id} node={node} expanded={expanded} />)}</section>)}</div>;
}
