import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, FlaskConical, LoaderCircle, Play, RotateCcw, Save, Square } from 'lucide-react';
import type { AgentKey, AgentPromptConfig, AgentTestResult, Session, WorldView } from '../shared/contracts';
import type { ApiClient } from './api';
import { CallTrace, Usage } from './CallTrace';
import { displayValue, testFailureSummary } from './trace-model';
import { sessionPresentation } from './session-presentation';
import { readPromptDrafts, writePromptDrafts } from './prompt-drafts';

import { agentLabels as labels, agentTestHelp } from './agent-labels';
import { AgentCatalog } from './AgentCatalog';
const PROMPT_LIMIT = 12000;
export function PromptStudio({ client, sessions, worlds, initialSessionId, draftNamespace, onBack }: { client: ApiClient; sessions: Session[]; worlds?: WorldView[]; initialSessionId: string | null; draftNamespace?: string; onBack: () => void }) {
  const [configs, setConfigs] = useState<AgentPromptConfig[]>([]);
  const [drafts, setDrafts] = useState<Partial<Record<AgentKey, string>>>(() => readPromptDrafts(draftNamespace));
  const [agent, setAgent] = useState<AgentKey>('main');
  const [sessionId, setSessionId] = useState(initialSessionId || sessions[0]?.id || '');
  const [userText, setUserText] = useState('');
  const [assistantText, setAssistantText] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<AgentTestResult | null>(null);
  const [testedInput, setTestedInput] = useState<{ agent: AgentKey; sessionId: string; prompt: string; userText: string; assistantText: string } | null>(null);
  const testController = useRef<AbortController | null>(null);
  const saveController = useRef<AbortController | null>(null);
  const config = configs.find(item => item.key === agent);
  function exportEnabledPrompts() {
    const bundle = { format: 'agentic-v3-runtime-prompts-v1', exportedAt: new Date().toISOString(), prompts: Object.fromEntries(configs.map(item => [item.key, { version: item.version, model: item.model, content: item.content }])) };
    const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = 'agentic-v3-enabled-prompts.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice('已导出六个 Agent 当前启用的 Prompt 与版本。未保存的草稿不包含在内。');
  }
  const draft = drafts[agent] ?? config?.content ?? '';
  const promptTooLong = draft.length > PROMPT_LIMIT;
  const testError = result ? testFailureSummary(result) : undefined;
  const changedInputs = testedInput ? [
    draft !== testedInput.prompt && 'Prompt 草稿',
    userText !== testedInput.userText && '测试用户消息',
    agent === 'updater' && assistantText !== testedInput.assistantText && '助手输出',
    sessionId !== testedInput.sessionId && '会话上下文',
    agent !== testedInput.agent && 'Agent',
  ].filter(Boolean) : [];
  useEffect(() => { writePromptDrafts(draftNamespace, drafts); }, [draftNamespace, drafts]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setLoadError('');
    void client.prompts({ signal: controller.signal }).then(response => {
      if (controller.signal.aborted) return;
      setConfigs(response.prompts);
      setDrafts(current => { const next = { ...current }; for (const item of response.prompts) if (next[item.key] === undefined) next[item.key] = item.content; return next; });
    }).catch(failure => { if (!controller.signal.aborted) setLoadError(failure instanceof Error ? failure.message : 'Prompt 配置无法读取。'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, reload]);
  useEffect(() => () => { testController.current?.abort(); saveController.current?.abort(); }, []);
  function stop() { testController.current?.abort(); testController.current = null; setRunning(false); setNotice('试跑已停止。没有写入聊天或世界。'); }
  function chooseAgent(key: AgentKey) { if (saving) return; stop(); setAgent(key); setResult(null); setError(''); setNotice(''); }
  async function save() {
    if (!config || !draft.trim() || promptTooLong || saving || running) return;
    const controller = new AbortController(); saveController.current = controller;
    setSaving(true); setError(''); setNotice('');
    try {
      const saved = await client.savePrompt(agent, { content: draft, expectedVersion: config.version }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setConfigs(current => current.map(item => item.key === saved.key ? saved : item));
      setDrafts(current => ({ ...current, [saved.key]: saved.content }));
      setNotice(`已启用 ${labels[saved.key]} 的 v${saved.version}，后续新调用使用此版本。`);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '保存失败。'); }
    finally { if (!controller.signal.aborted) setSaving(false); }
  }
  async function run() {
    if (!config || !sessionId || !userText.trim() || !draft.trim() || promptTooLong || (agent === 'updater' && !assistantText.trim()) || saving || running) return;
    const controller = new AbortController(); testController.current = controller;
    setRunning(true); setResult(null); setError(''); setNotice('');
    setTestedInput({ agent, sessionId, prompt: draft, userText, assistantText });
    try {
      const response = await client.testAgent(agent, { sessionId, userText: userText.trim(), prompt: draft, ...(agent === 'updater' ? { assistantText: assistantText.trim() } : {}) }, { signal: controller.signal });
      if (!controller.signal.aborted && testController.current === controller) setResult(response);
    } catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '试跑失败。'); }
    finally { if (!controller.signal.aborted && testController.current === controller) setRunning(false); }
  }
  return <><header className="av-page-header"><div><span className="av-eyebrow">PROMPT DEVELOPMENT STUDIO</span><h2>调试当前接入的 Agent</h2><p>按服务端已接入目录调试：主线规划、整场演绎、世界更新、开场、世界动态与裁决。保存和试跑分别触发。</p></div><button className="av-icon-button" aria-label="返回聊天" onClick={onBack}><ArrowLeft size={19} /></button></header><div className="av-prompt-studio"><div className="av-prompt-draft-tools"><p className="av-dev-note">场景文风在 Actor 中编辑；感知范围、场景推进与世界归档由对应 Agent 配合处理。</p><button className="av-button" disabled={!configs.length} onClick={exportEnabledPrompts}><Download size={14} />导出已启用预设</button></div>
    <AgentCatalog client={client} available={configs.map(config => config.key)} onSelect={chooseAgent} />
    <nav className="av-agent-tabs" aria-label="选择 Agent">{configs.map(({ key, label }) => <button key={key} disabled={saving} className={key === agent ? 'is-active' : ''} onClick={() => chooseAgent(key)}>{label || labels[key]}</button>)}</nav>
    {loading ? <p className="av-loading-line"><LoaderCircle size={15} className="av-spin" />读取已启用的 Prompt…</p> : loadError ? <div className="av-form-error" role="alert">{loadError}<button className="av-button" onClick={() => setReload(value => value + 1)}>重新读取</button></div> : config ? <div className="av-prompt-columns">
      <section className="av-prompt-editor"><div className="av-panel-heading"><h3>{labels[agent]}</h3><span>已启用 v{config.version}</span></div><p className="av-dev-note">当前模型：{config.model}。此处编辑的是系统 Prompt；试跑不会自动保存。</p>{draft !== config.content && <div className="av-prompt-notice av-prompt-version-notice" role="status"><div><strong>当前草稿与已启用版本不同</strong><p>正式聊天使用 v{config.version}。编辑框里的浏览器草稿尚未发布，也不会自动覆盖启用版本。</p></div><button className="av-button" disabled={saving || running} onClick={() => { setDrafts(current => ({ ...current, [agent]: config.content })); setNotice(`当前已启用的 v${config.version} 已载入草稿，没有发布新版本。`); }}>载入当前启用版本</button></div>}<label className="av-field">Prompt 草稿<textarea className="av-prompt-text" maxLength={PROMPT_LIMIT} aria-describedby="av-prompt-length" aria-label={labels[agent] + ' Prompt 草稿'} value={draft} disabled={saving || running} onChange={event => setDrafts(current => ({ ...current, [agent]: event.target.value }))} spellCheck={false} /><small id="av-prompt-length">{draft.length.toLocaleString()} / {PROMPT_LIMIT.toLocaleString()} 字符 · {draft.length >= PROMPT_LIMIT ? '已达字符上限，请精简后再补充；超长内容不能保存或试跑。' : '最多 12000 字符，超长内容请先精简后粘贴。'}</small></label><div className="av-prompt-draft-tools"><button className="av-button" disabled={saving || running} onClick={() => { setDrafts(current => ({ ...current, [agent]: config.defaultContent })); setNotice('默认 Prompt 已载入草稿，尚未保存。'); }}><RotateCcw size={13} />构建默认内容载入草稿</button><select aria-label="载入历史版本到草稿" value="" disabled={saving || running} onChange={event => { const version = config.history.find(item => item.version === Number(event.target.value)); if (version) { setDrafts(current => ({ ...current, [agent]: version.content })); setNotice(`v${version.version} 已载入草稿，尚未保存。`); } }}><option value="">载入历史版本…</option>{config.history.slice(0, 10).map(item => <option key={item.version} value={item.version}>v{item.version} · {new Date(item.createdAt).toLocaleString('zh-CN')}</option>)}</select></div><div className="av-prompt-save"><span>{draft === config.content ? '草稿与启用版本一致' : '有尚未保存的修改'}</span><button className="av-button av-button-primary" disabled={saving || running || !draft.trim() || promptTooLong || draft === config.content} onClick={() => void save()}>{saving ? <LoaderCircle size={14} className="av-spin" /> : <Save size={14} />}保存并启用</button></div></section>
      <section className="av-agent-test"><div className="av-panel-heading"><h3><FlaskConical size={16} />独立试跑</h3><span>不会提交故事</span></div><p className="av-dev-note">{agentTestHelp[agent]}仅点击“试跑草稿”后执行；不会写入聊天消息或世界状态。</p><fieldset disabled={running || saving}><label className="av-field">会话上下文<select value={sessionId} onChange={event => { setSessionId(event.target.value); setResult(null); }}><option value="">请选择已有会话</option>{sessions.map(session => <option key={session.id} value={session.id}>{sessionPresentation(session, worlds).option}</option>)}</select></label><label className="av-field">{['opening', 'pulse', 'arbiter'].includes(agent) ? '测试意图或参数（可填 JSON）' : '测试用户消息'}<textarea value={userText} maxLength={8000} onChange={event => setUserText(event.target.value)} placeholder="写一条用于测试的消息" /></label>{agent === 'updater' && <label className="av-field">助手输出（WorldOps 必填）<textarea value={assistantText} maxLength={12000} onChange={event => setAssistantText(event.target.value)} placeholder="输入要交给世界更新 Agent 的角色回复" /></label>}</fieldset><div className="av-test-actions">{running ? <button className="av-button" onClick={stop}><Square size={13} />停止试跑</button> : <button className="av-button av-button-primary" disabled={saving || !sessionId || !draft.trim() || promptTooLong || !userText.trim() || (agent === 'updater' && !assistantText.trim())} onClick={() => void run()}><Play size={13} />试跑草稿</button>}{running && <span role="status"><LoaderCircle size={13} className="av-spin" />正在实际调用模型…</span>}</div>{!sessions.length && <p className="av-dev-note">先创建一段对话，再选择它作为测试上下文。</p>}</section>
    </div> : <p className="av-form-error">这个 Agent 尚未提供 Prompt 配置。</p>}
    {error && <div className="av-form-error" role="alert"><p>{error}</p><button className="av-button" disabled={saving || running} onClick={() => setReload(value => value + 1)}>重新读取启用版本（保留草稿）</button></div>}{notice && <p className="av-prompt-notice" role="status">{notice}</p>}
    {result && <section className="av-test-result"><div className="av-panel-heading"><h3>{testError ? '试跑失败' : '试跑结果'}</h3><span>{(result.durationMs / 1000).toFixed(2)}s · 未提交</span></div><Usage usage={result.usage} />{testError && <p className="av-form-error" role="alert">{testError}</p>}{changedInputs.length > 0 && <p className="av-prompt-notice" role="status">{changedInputs.join('、')}已改变。以下是上次输入的试跑结果，请重新试跑以验证当前输入。</p>}<details open><summary>实际输出</summary><pre>{displayValue(result.output)}</pre></details><h3>实际调用链</h3><CallTrace calls={result.calls} /></section>}
  </div></>;
}
