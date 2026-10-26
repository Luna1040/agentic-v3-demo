import { useEffect, useRef, useState } from 'react';
import { Download, LoaderCircle, Play, RotateCcw } from 'lucide-react';
import type { RuntimeAuditView } from '../shared/contracts';
import { ApiError, type ApiClient } from './api';
import { recordedTimeLabel } from './time-model';
import { auditBatches, auditEventLabels, auditFieldChanges, auditFieldSource, auditObject, auditRowChanges, auditTurnIds, auditValue, foregroundLabels, settlementLabels, type AuditEvent, type AuditFieldChange } from './runtime-audit-model';

function Source({ id }: { id?: string | null }) { return <code title={id || undefined}>{id ? '#' + id.slice(-8) : '来源未记录'}</code>; }
function Raw({ value, label = '原始审计数据' }: { value: unknown; label?: string }) { return <details><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>; }
function ChangeTable({ changes }: { changes: AuditFieldChange[] }) {
  return changes.length ? <div className="av-audit-table-wrap"><table className="av-audit-table"><thead><tr><th>字段</th><th>提交前</th><th>提交后</th></tr></thead><tbody>{changes.map(change => <tr key={change.path}><th>{change.path}</th><td>{auditValue(change.before)}</td><td>{auditValue(change.after)}</td></tr>)}</tbody></table></div> : <p>没有字段变化。</p>;
}
function CurrentFields({ view, value, kind, id = '', sourceTurnId }: { view: RuntimeAuditView; value: unknown; kind: 'entity' | 'event' | 'scene'; id?: string; sourceTurnId?: string }) {
  return <div className="av-audit-table-wrap"><table className="av-audit-table"><thead><tr><th>字段</th><th>当前值</th><th>依据</th></tr></thead><tbody>{auditFieldChanges(undefined, value).map(field => {
    const source = auditFieldSource(view, id, field.path, kind, {value:field.after});
    return <tr key={field.path}><th>{field.path}</th><td>{auditValue(field.after)}</td><td>{source ? <>本组内匹配提交 <Source id={source} /></> : <>无本组匹配字段变更{sourceTurnId&&<> · 记录来源 <Source id={sourceTurnId} /></>}</>}</td></tr>;
  })}</tbody></table></div>;
}
function AuditTimelineEvent({ event }: { event: AuditEvent }) {
  const members = auditTurnIds(event);
  const scene = auditObject(event.data.scene);
  const changes = [...auditRowChanges(event, 'entityChanges'), ...auditRowChanges(event, 'eventChanges')];
  return <article className="av-episode av-inspector-section" data-audit-kind={event.kind}>
    <h3>{auditEventLabels[event.kind] || event.kind} <small>{recordedTimeLabel(event.at)}</small></h3>
    <p>{event.data.lane === 'director' ? '主线规划' : event.data.lane === 'capture' ? '录制标记' : '世界归档'}{event.batchId && <> · 批次 <Source id={event.batchId} /></>}{event.attemptId && <> · 尝试 <Source id={event.attemptId} /></>}</p>
    {!!members.length && <p>来源轮次：{members.map(id => <span className="av-audit-source" key={id}><Source id={id} /></span>)}</p>}
    {event.kind === 'claimed' && <><p>实际同批整理 {members.length} 轮 · 最多共用一次提取请求，实际请求以调用记录为准。</p>{(event.data.reusedResult || event.data.reusedCheckpoint) ? <p>本次恢复了已有结果／检查点，不代表新发起一次提取。</p> : null}</>}
    {event.data.reason !== undefined && <p>原因：{auditValue(event.data.reason)}</p>}
    {event.kind === 'rebased' && <><p>旧结果未直接覆盖新状态；已按当前版本重新对齐。</p><Raw label="预期版本与实际版本" value={{expectedVersions:event.data.expectedVersions,actualVersions:event.data.actualVersions}} /></>}
    {event.kind === 'split' && <p>本次合批已拆分；后续领取记录才代表实际重新执行的批次。</p>}
    {event.kind === 'committed' && <>
      <p>世界版本 {auditValue(event.data.worldRevisionBefore)} → {auditValue(event.data.worldRevisionAfter)} · 待核对候选 {auditValue(event.data.unresolvedCommands)}</p>
      {scene.disposition !== undefined && <p>当前场景：{({applied:'应用到当前场景',historical:'仅保留历史，不回退当前场景',unchanged:'保持不变'} as Record<string,string>)[String(scene.disposition)] || String(scene.disposition)}</p>}
      {changes.map((row, index) => <details key={row.id + '-' + index}><summary>{String(row.after.name ?? row.before.name ?? row.id)} · {row.changes.length} 个字段变化</summary><ChangeTable changes={row.changes} /></details>)}
      {scene.disposition === 'applied' && <details><summary>场景提交前 → 后</summary><ChangeTable changes={auditFieldChanges(scene.before, scene.after)} /></details>}
      {!changes.length && <p>本次未修改人物、地点、物品或事项记录。</p>}
    </>}
    <Raw value={event} />
  </article>;
}

export function RuntimeAuditRecords({ view }: { view: RuntimeAuditView }) {
  const batches = auditBatches(view);
  const target = view.capture?.expectedTurns ?? 7;
  const count = Math.min(view.turns.length, target);
  const names = new Map(view.turns.map((turn, index) => [turn.id, `第 ${index + 1} 轮`]));
  return <div className="av-inspector-stack">
    <section className="av-episode av-inspector-section" role="status">
      <h3>{view.capture ? `本组已收到 ${count} / ${target} 轮` : '尚未开始新一组录制'}</h3>
      <p>{view.capture ? `录制开始于 ${recordedTimeLabel(view.capture.startedAt)}，只统计开始后的用户消息。` : '下方显示最近 7 轮；点击上方按钮后，记录接下来 7 轮。'}</p>
      <p>归档排队／处理中 {view.backlog.pendingTurns} 轮 · 失败 {view.backlog.failedTurns} 轮 · 待核对候选 {view.backlog.unresolvedCommands ?? 0} 条 · 当前世界版本 {view.worldRevision}</p>
      {view.capture && count === target && <p>{view.backlog.pendingTurns ? '7 轮已收齐，后台仍在处理。' : view.backlog.failedTurns ? '7 轮已收齐，存在归档失败，请查看时间线。' : '7 轮已收齐，归档队列已排空。'}{view.backlog.unresolvedCommands ? '仍有候选未应用，不能当作全部入库。' : ''}</p>}
      <p>前台回复与归档分开记账；归档失败不会删除已保存的回复。此页只读取日志，不调用模型。</p>
      {view.truncated && <p className="av-form-error">日志达到读取上限，当前显示不完整。请保留导出，并从录制标记重新核查。</p>}
    </section>
    <section className="av-episode av-inspector-section"><h3>每轮前台与后台</h3>
      {view.turns.length ? view.turns.map((turn, index) => <div className="av-audit-turn" key={turn.id}><strong>第 {index + 1} 轮 <Source id={turn.id} /></strong><p>{turn.userText || '（无用户正文）'}</p><p>前台：{foregroundLabels[turn.status] || turn.status} · 后台：{turn.settlementStatus ? settlementLabels[turn.settlementStatus] || turn.settlementStatus : '尚无归档任务'} · 尝试 {turn.attempts ?? 0} 次</p>{turn.batchId && <small>最近批次 <Source id={turn.batchId} /></small>}{turn.callIds?.length ? <Raw label="模型调用 ID（在 Agent 调用记录查看输入输出）" value={turn.callIds} /> : null}</div>) : <p>等待你的下一条消息。</p>}
    </section>
    <section className="av-episode av-inspector-section"><h3>真实归档批次 · {batches.length} 批</h3><p>每批最多 3 轮，最多共用一次提取请求，恢复时可能不发新请求；入库仍按原轮次依次处理。后台赶得上时会是单轮批次，不保证产生积压或合批。</p>
      {batches.length ? batches.map(batch => <p key={batch.id}>批次 <Source id={batch.id} />：{batch.turnIds.map(id => names.get(id) || '#' + id.slice(-8)).join(' ＋ ')}（{batch.turnIds.length} 轮，领取 {batch.attempts} 次）</p>) : <p>尚无实际领取记录，暂不能判断合批。</p>}
    </section>
    <section className="av-episode av-inspector-section"><h3>冲突与覆盖规则</h3><p>已采纳的变化按来源轮次更新对应字段；后文摘要没提到的旧人物、地点、物品和约定不会因此被删除。旧场景结果只记历史，不能把当前场景拉回去。</p><p>版本不符会重新对齐、等待或拆批，具体以时间线为准。未采纳候选不算事实。Main 的旧规划可被新请求替代，计划本身不算已完成剧情。</p></section>
    <section className="av-episode av-inspector-section"><h3>当前实际入库 · {view.world.entities?.length ?? 0} 项</h3><p>快照读取于 {recordedTimeLabel(view.world.capturedAt)} · 世界版本 {view.world.revision}。这是当前状态，会随后续聊天变化，并非第 7 轮结束时冻结的快照。</p><p>逐字段显示本组内最后一次变更且值仍匹配的提交；这不排除本组后又有互动。没有匹配变更的字段只展示记录来源，不能据此推断它由本组创建。</p>
      {view.world.scene&&<details><summary>当前场景</summary><CurrentFields view={view} value={view.world.scene} kind="scene"/></details>}
      {view.world.entities?.map(entity => <details key={entity.id}><summary>{entity.name} · {({npc:'人物',location:'地点',item:'物品',quest:'约定／任务'} as Record<string,string>)[entity.kind] || entity.kind}</summary><CurrentFields view={view} value={entity} kind="entity" id={entity.id} sourceTurnId={entity.sourceTurnId}/></details>)}
      {view.world.eventLedger?.map(event=><details key={event.id}><summary>事项 · {event.id}</summary><CurrentFields view={view} value={event} kind="event" id={event.id}/></details>)}
      <Raw label="完整当前状态（含场景和事项）" value={view.world} />
    </section>
    <div className="av-section-label"><span>真实处理时间线 · {view.events.length} 条</span></div>
    {view.events.length ? view.events.map(event => <AuditTimelineEvent key={event.id} event={event} />) : <p>暂无本组审计事件。</p>}
  </div>;
}

function exportAudit(worldId: string, view: RuntimeAuditView) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(view, null, 2)], {type:'application/json'}));
  const link = document.createElement('a'); link.href = url; link.download = `runtime-audit-${worldId}-${view.capture?.id || 'recent'}.json`; link.click();
  // Delay revocation until the browser has started reading the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function RuntimeAudit({ worldId, client }: { worldId: string; client: ApiClient }) {
  const [view, setView] = useState<RuntimeAuditView | null>(null);
  const [error, setError] = useState('');
  const [capturing, setCapturing] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const captureRequest = useRef<AbortController | null>(null);
  const readGeneration = useRef(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let allowed = true;
    async function poll() {
      const generation = readGeneration.current;
      try { const result = await client.runtimeAudit(worldId, {signal:controller.signal}); if (!controller.signal.aborted && generation === readGeneration.current && !captureRequest.current) {setView(result);setError('');} }
      catch (failure) { if (!controller.signal.aborted && generation === readGeneration.current && !captureRequest.current) {setError(failure instanceof Error ? failure.message : '读取审计记录失败。');if (failure instanceof ApiError && [401,403,404].includes(failure.status)) allowed = false;} }
      finally { if (!controller.signal.aborted && allowed) timer = setTimeout(() => void poll(), 1500); }
    }
    void poll();
    return () => {controller.abort();if(timer)clearTimeout(timer);};
  }, [client, worldId, refreshKey]);
  useEffect(() => () => captureRequest.current?.abort(), [worldId]);
  async function capture() {
    if (captureRequest.current) return;
    const controller = new AbortController(); captureRequest.current = controller; readGeneration.current++; setCapturing(true); setError('');
    try {const result = await client.captureRuntimeAudit(worldId,{expectedTurns:7},{signal:controller.signal});if(!controller.signal.aborted){setView(result);setRefreshKey(key=>key+1);}}
    catch(failure){if(!controller.signal.aborted)setError(failure instanceof Error?failure.message:'开始录制失败。');}
    finally{if(captureRequest.current===controller)captureRequest.current=null;if(!controller.signal.aborted)setCapturing(false);}
  }
  async function download() {
    if (!view || exporting) return;
    setExporting(true);setExportNotice('');
    try {
      const snapshot = await client.runtimeAudit(worldId, {captureId:view.capture?.id,includeCalls:true});
      exportAudit(worldId,snapshot);
      setExportNotice(snapshot.callsTruncated || snapshot.truncated ? '导出已下载，但日志或模型调用达到上限，文件内容不完整。' : `导出已下载，包含 ${snapshot.calls?.length ?? 0} 条实际模型调用输入／输出及本次读取的数据库状态。`);
    } catch(failure) {setExportNotice(failure instanceof Error?`导出失败：${failure.message}`:'导出失败，请重试。');}
    finally {setExporting(false);}
  }
  const collecting = !!view?.capture && view.turns.length < view.capture.expectedTurns;
  return <section aria-label="队列与入库审计"><div className="av-inspector-actions"><button className="av-button" onClick={()=>void capture()} disabled={capturing || collecting}>{capturing?<LoaderCircle size={13} className="av-spin"/>:<Play size={13}/>} {collecting?'正在录制接下来 7 轮':'开始录制接下来 7 轮'}</button><button className="av-button" onClick={()=>setRefreshKey(key=>key+1)}><RotateCcw size={13}/>重新读取</button><button className="av-button" disabled={!view || exporting} onClick={()=>void download()}>{exporting?<LoaderCircle size={13} className="av-spin"/>:<Download size={13}/>}导出 JSON（含调用）</button></div>
    <p className="av-dev-note">先开始录制，再关闭抽屉正常聊天；AI 回复完成就发下一条，共 7 条。之后回到这里查看。不必提醒角色记忆，也不必专门触发 NPC。</p>
    {error&&<p className="av-form-error" role="alert">{error} 已读取的记录保留，可重新读取。</p>}
    {exportNotice&&<p className="av-dev-note" role="status">{exportNotice}</p>}
    {view?<RuntimeAuditRecords view={view}/>:!error&&<p className="av-loading-line"><LoaderCircle size={14} className="av-spin"/>正在读取审计记录…</p>}
  </section>;
}
