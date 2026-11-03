import { useEffect, useRef } from 'react';
import { Check, Copy, PenLine, RefreshCw, Sparkles } from 'lucide-react';
import type { Character, Message } from '../shared/contracts';
import { Avatar } from './Avatar';
import { messageText } from './message-text';
import { operationKindOf, operationLabel, operationStatusText } from './chat-operations.ts';

const time = (date: string) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(date));

/** Player-facing affordances for the latest turn; only the owning message receives them. */
export interface MessageActions {
  busy: boolean;
  canContinue?: boolean;
  canRegenerate?: boolean;
  canEdit?: boolean;
  editing?: boolean;
  editDraft?: string;
  editError?: string | null;
  onContinue?(): void;
  onRegenerate?(): void;
  onEditStart?(): void;
  onEditCancel?(): void;
  onEditInput?(text: string): void;
  onEditSave?(): void;
}

export function ReadingText({ content }: { content: string }) {
  // Model output remains text nodes, including dialogue and simple emphasis.
  return <>{content.split(/\n\n+/).map((paragraph, index) => <p key={index}>{paragraph.split(/(“[^”]+”|「[^」]+」|\*[^*\n]+\*)/g).map((part, partIndex) => part.startsWith('*') && part.endsWith('*') ? <em key={partIndex}>{part.slice(1, -1)}</em> : /^[“「]/.test(part) ? <span className="av-dialogue" key={partIndex}>{part}</span> : part)}</p>)}</>;
}

/**
 * An operation signal is not something the player said. It renders as a system status line
 * (继续演出 / 重新生成), never as a player bubble; unknown internal markers (the opening) stay hidden.
 */
export function OperationLine({ message }: { message: Message }) {
  const label = operationLabel(message);
  if (!label) return null;
  return <div className={'av-operation-line ' + (message.status ? 'is-' + message.status : 'is-committed')} role="status" data-operation-kind={operationKindOf(message)}>
    <Sparkles size={11} aria-hidden="true" />
    <span>{label}</span>
    <small>{operationStatusText(message.status)}</small>
  </div>;
}

function EditForm({ actions }: { actions: MessageActions }) {
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { area.current?.focus(); area.current?.setSelectionRange(area.current.value.length, area.current.value.length); }, []);
  const draft = actions.editDraft ?? '';
  return <div className="av-inline-edit">
    <textarea ref={area} value={draft} maxLength={8000} aria-label="编辑这条消息" onChange={event => actions.onEditInput?.(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); actions.onEditCancel?.(); } }} />
    <div className="av-inline-edit-actions">
      <small>{draft.trim().length}/8000</small>
      {actions.editError && <small className="is-error">{actions.editError}</small>}
      <button type="button" className="av-inline-cancel" disabled={actions.busy} onClick={() => actions.onEditCancel?.()}>取消</button>
      <button type="button" className="av-inline-save" disabled={actions.busy || !draft.trim()} onClick={() => actions.onEditSave?.()}>保存并重写</button>
    </div>
  </div>;
}

export function MessageBubble({ message, character, currentPlayerName, streaming, onCopy, actions }: { message: Message; character?: Character; currentPlayerName?: string | null; streaming?: boolean; onCopy: (text: string) => void; actions?: MessageActions }) {
  if (message.kind === 'operation') return <OperationLine message={message} />;
  const user = message.role === 'user';
  const text = messageText(message, character, currentPlayerName);
  const editing = Boolean(user && actions?.editing);
  return <article className={`av-message ${user ? 'is-user' : 'is-assistant'}${editing ? ' is-editing' : ''}`} data-message-id={message.id}>
    <Avatar character={character} user={user} />
    <div className="av-message-content">
      <div className="av-message-meta"><strong>{user ? message.playerName || '你' : message.characterName || character?.name || '角色'}</strong><time dateTime={message.createdAt}>{time(message.createdAt)}</time>{message.status === 'pending' && <span>发送中</span>}{message.status === 'failed' && <span>本轮待重试</span>}{message.status === 'cancelled' && <span>本轮已停止</span>}</div>
      {editing ? <EditForm actions={actions!} /> : <div className={'av-bubble ' + (streaming ? 'is-streaming' : '')}><ReadingText content={text} />{streaming && <span className="av-stream-caret" aria-hidden="true" />}</div>}
      {!streaming && !editing && <div className="av-message-tools"><button onClick={() => onCopy(text)} aria-label="复制消息"><Copy size={12} /></button>{!user && <span><Check size={11} /> 已保存</span>}</div>}
      {!streaming && !editing && actions && (user
        ? actions.canEdit && <div className="av-message-actions is-user"><button type="button" disabled={actions.busy} title={actions.busy ? '正在生成，完成后再编辑' : '编辑这条消息并从该处重写'} onClick={() => actions.onEditStart?.()}><PenLine size={12} />编辑并重写</button></div>
        : (actions.canContinue || actions.canRegenerate) && <div className="av-message-actions">
          {actions.canContinue && <button type="button" disabled={actions.busy} title="从最新回复末尾继续推进一幕" onClick={() => actions.onContinue?.()}><Sparkles size={12} />继续</button>}
          {actions.canRegenerate && <button type="button" disabled={actions.busy} title="基于原消息重新回应，不延续当前回复" onClick={() => actions.onRegenerate?.()}><RefreshCw size={12} />重写</button>}
        </div>)}
    </div>
  </article>;
}
