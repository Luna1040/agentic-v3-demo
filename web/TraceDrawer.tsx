import { useState } from 'react';
import { LoaderCircle, RotateCcw } from 'lucide-react';
import type { Message, WorldView } from '../shared/contracts';
import type { ApiClient } from './api';
import { CallTrace } from './CallTrace';
import { Drawer } from './Drawer';
import { displayValue } from './trace-model';
import { useTurnTrace } from './use-turn-trace';

export function TraceDrawer({ client, messages, pendingTurnId, settlements, director, onClose }: { client: ApiClient; messages: Message[]; pendingTurnId?: string | null; settlements?: WorldView['settlements']; director?: WorldView['director']; onClose: () => void }) {
  const ids = [...new Set([...(pendingTurnId ? [pendingTurnId] : []), ...[...messages].reverse().flatMap(message => message.turnId ? [message.turnId] : [])])];
  const [chosen, setChosen] = useState('');
  const id = chosen && ids.includes(chosen) ? chosen : ids[0] || '';
  const settlement = settlements?.find(job => job.turnId === id);
  const selectedDirector = director?.turnId === id ? director : undefined;
  const { trace, error, retry } = useTurnTrace(client, id, { settlementStatus: settlement?.status, directorStatus: selectedDirector?.status });
  return <Drawer title="开发调用记录" eyebrow="ACTUAL AGENT CALLS" onClose={onClose} wide><p className="av-dev-note">展示实际调用、父子关系与输入输出。后台 Main 规划跨多轮的主线阶段，建议不等于已发生的世界事实。不包含模型隐藏思考。</p>{ids.length > 0 && <label className="av-field">对话轮次<select value={id} onChange={event => setChosen(event.target.value)}>{ids.map(turnId => { const user = messages.find(message => message.turnId === turnId && message.role === 'user'); return <option key={turnId} value={turnId}>{user?.content.slice(0, 42) || '当前生成'} · {turnId.slice(0, 8)}</option>; })}</select></label>}{error ? <div className="av-form-error" role="alert"><p>{error}</p><button className="av-button" onClick={retry}><RotateCcw size={13} />重新读取</button></div> : id && !trace ? <p className="av-loading-line"><LoaderCircle size={15} className="av-spin" />正在读取真实调用…</p> : trace ? <><div className="av-trace-status">本轮：{{ running: '运行中', committed: '已提交', failed: '失败', cancelled: '已停止' }[trace.status]}</div><div className="av-trace-status">{settlement && <>世界整理：{{ pending: '排队中', running: '后台运行中', failed: '待重试（回复已保存）', completed: '已完成' }[settlement.status]}{settlement.error && <small> · {settlement.error.message}</small>}</>}</div>{selectedDirector && <div className="av-trace-status">主线规划：{{ pending: '排队中', running: '后台准备中', completed: '已准备', failed: '准备失败（可以继续聊天）' }[selectedDirector.status]}{selectedDirector.errorCode && <small> · {selectedDirector.errorCode}</small>}</div>}<CallTrace calls={trace.calls} />{trace.metadata && <details className="av-trace-metadata"><summary>运行版本与配置</summary><pre>{displayValue(trace.metadata)}</pre></details>}</> : <p className="av-dev-note">发送第一条消息后，这里会出现对应的调用记录。</p>}</Drawer>;
}
