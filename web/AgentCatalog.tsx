import { useEffect, useState } from 'react';
import { Archive, ArrowUpRight, LoaderCircle, RotateCcw } from 'lucide-react';
import type { AgentKey } from '../shared/contracts';
import type { ApiClient, LegacyAgentCatalogEntry } from './api';
import { agentLabels } from './agent-labels';
import { displayValue } from './trace-model';

export function AgentCatalog({ client, available, onSelect }: { client: ApiClient; available: AgentKey[]; onSelect: (key: AgentKey) => void }) {
  const [entries, setEntries] = useState<LegacyAgentCatalogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    void client.agentCatalog({ signal: controller.signal }).then(result => { if (!controller.signal.aborted) setEntries(result.agents); }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '原版配置目录无法读取。'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [client, revision]);
  return <details className="av-agent-catalog"><summary><Archive size={16} /><strong>原版 16 项职责与配置</strong><span>{loading ? '正在读取' : entries.length ? `已导入 ${entries.length} 项` : '待导入'}</span></summary><div className="av-agent-catalog-body"><p>保留原版职责、Prompt 和版本供核对。以下归档只读；关联按钮指向当前实际执行的 Agent，不表示原版职责都会独立调用模型。</p>{loading && <p className="av-loading-line"><LoaderCircle size={13} className="av-spin" />正在读取持久化配置…</p>}{error && <div className="av-form-error" role="alert">{error}<button className="av-button" onClick={() => setRevision(value => value + 1)}><RotateCcw size={13} />重新读取目录</button></div>}{!loading && !entries.length && !error && <p className="av-dev-note">原版配置尚未导入。这里不会生成占位 Agent 或虚构版本。</p>}<div className="av-legacy-agent-grid">{entries.map(entry => <details key={entry.key} className="av-legacy-agent"><summary><strong>{entry.name}</strong><small>{entry.key} · 原配置 {entry.enabled ? '启用' : '停用'}</small></summary><div><p>{entry.responsibility}</p><p className="av-agent-mapping">当前实现：{entry.implementation}</p><div className="av-agent-links">{entry.executionKeys.map(key => <button className="av-button" key={key} disabled={!available.includes(key)} onClick={() => onSelect(key)}><ArrowUpRight size={12} />调试 {agentLabels[key] || key}</button>)}</div>{entry.configuration && <details><summary>原版运行配置</summary><pre>{displayValue(entry.configuration)}</pre></details>}<details><summary>原版启用 Prompt（Agent 配置 {entry.currentVersion === null ? '版本未记录' : `v${entry.currentVersion}`}）</summary><pre>{entry.prompt || '原配置没有 Prompt 文本。'}</pre></details>{entry.versions.length > 0 && <details><summary>归档 Prompt 版本 · {entry.versions.length} 个</summary>{entry.versions.map((version, index) => <details key={`${version.version}-${index}`}><summary>v{version.version} · {version.status} · {version.createdAt ? new Date(version.createdAt).toLocaleString('zh-CN') : '日期未记录'}</summary><pre>{version.prompt}</pre></details>)}</details>}</div></details>)}</div></div></details>;
}
