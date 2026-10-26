import { useMemo, useState } from 'react';
import { Activity, ChevronRight, LoaderCircle, PanelRightClose, RotateCcw } from 'lucide-react';
import type { Message, WorldView } from '../shared/contracts';
import type { ApiClient } from './api';
import { CallTrace } from './CallTrace';
import { agentLabels } from './agent-labels';
import { displayValue } from './trace-model';
import { useTurnTrace } from './use-turn-trace';

const traceStatusLabels = { running: '运行中', committed: '已提交', failed: '失败', cancelled: '已停止' } as const;
const settlementLabels = { pending: '排队中', running: '后台运行中', failed: '待重试（回复已保存）', completed: '已完成' } as const;
const directorLabels = { pending: '排队中', running: '后台准备中', completed: '已准备', failed: '准备失败（可以继续聊天）' } as const;

function turnLabel(messages: Message[], turnId: string): string {
  const message = messages.find(item => item.turnId === turnId && item.role === 'user');
  const text = message?.content.replace(/\s+/g, ' ').trim();
  return (text ? text.slice(0, 28) : '当前生成') + ' · ' + turnId.slice(0, 8);
}

/** Collapsed rail: the panel keeps a visible entry instead of hiding behind a header button. */
export function TracePanelHandle({ onExpand }: { onExpand: () => void }) {
  return <aside className="av-trace-panel is-collapsed"><button className="av-trace-handle" type="button" onClick={onExpand} title="展开 Agent 输入输出面板"><Activity size={15} /><span>Agent 调用</span><ChevronRight size={12} /></button></aside>;
}

/**
 * Always-visible Agent call panel. It follows the newest turn unless the reader pins an older one,
 * and renders each call's recorded input and output in full without another click.
 */
export function TracePanel({ client, messages, pendingTurnId, settlements, director, onCollapse, onDrawer }: {
  client: ApiClient; messages: Message[]; pendingTurnId?: string | null;
  settlements?: WorldView['settlements']; director?: WorldView['director'];
  onCollapse: () => void; onDrawer: () => void;
}) {
  const ids = useMemo(() => [...new Set([...(pendingTurnId ? [pendingTurnId] : []), ...[...messages].reverse().flatMap(message => message.turnId ? [message.turnId] : [])])], [messages, pendingTurnId]);
  const [pinned, setPinned] = useState<string | null>(null);
  const id = pinned && ids.includes(pinned) ? pinned : ids[0] || '';
  const settlement = settlements?.find(job => job.turnId === id);
  const selectedDirector = director?.turnId === id ? director : undefined;
  const { trace, error, retry } = useTurnTrace(client, id, { settlementStatus: settlement?.status, directorStatus: selectedDirector?.status });
  const agents = [...new Set(trace?.calls.map(call => call.agent) || [])];
  return <aside className="av-trace-panel" aria-label="Agent 输入输出">
    <header className="av-trace-panel-head">
      <div><span className="av-eyebrow">ACTUAL AGENT CALLS</span><h2>Agent 输入输出</h2></div>
      <div className="av-trace-panel-tools">
        <button type="button" title="在开发调用记录抽屉中打开" aria-label="在开发调用记录抽屉中打开" onClick={onDrawer}><Activity size={15} /></button>
        <button type="button" title="收起面板" aria-label="收起 Agent 输入输出面板" onClick={onCollapse}><PanelRightClose size={16} /></button>
      </div>
    </header>
    <div className="av-trace-panel-body">
      {!ids.length ? <p className="av-dev-note">发送第一条消息后，这里会实时显示每个 Agent 的实际输入与返回，无需再打开抽屉或展开折叠块。</p> : <>
        <div className="av-trace-panel-turn">
          <label className="av-field">对话轮次<select value={id} onChange={event => setPinned(event.target.value === ids[0] ? null : event.target.value)}>{ids.map(turnId => <option key={turnId} value={turnId}>{turnLabel(messages, turnId)}</option>)}</select></label>
          {pinned && <button type="button" className="av-trace-follow" onClick={() => setPinned(null)}>已固定在旧轮次 · 回到最新轮</button>}
        </div>
        <div className="av-trace-panel-status">
          {trace && <span className={'av-trace-chip is-' + trace.status}>本轮 {traceStatusLabels[trace.status]}</span>}
          {agents.map(agent => <span key={agent} className="av-trace-agent">{agentLabels[agent] || agent}</span>)}
          {settlement && <span className="av-trace-chip is-backstage">世界整理 {settlementLabels[settlement.status]}{settlement.attempts > 1 ? ` · 第 ${settlement.attempts} 次` : ''}</span>}
          {selectedDirector && <span className="av-trace-chip is-backstage">主线规划 {directorLabels[selectedDirector.status]}</span>}
        </div>
        {settlement?.error && <p className="av-trace-panel-error">{settlement.error.code} · {settlement.error.message}</p>}
        {error ? <div className="av-form-error" role="alert"><p>{error}</p><button className="av-button" onClick={retry}><RotateCcw size={13} />重新读取</button></div>
          : !trace ? <p className="av-loading-line"><LoaderCircle size={15} className="av-spin" />正在读取真实调用…</p>
            : <><CallTrace calls={trace.calls} expanded />{trace.metadata && <details className="av-trace-metadata"><summary>运行版本与配置</summary><pre>{displayValue(trace.metadata)}</pre></details>}</>}
        <p className="av-dev-note">展示实际调用、父子关系与输入输出。后台 Main 规划跨多轮的主线阶段，建议不等于已发生的世界事实。不包含模型隐藏思考。</p>
      </>}
    </div>
  </aside>;
}
