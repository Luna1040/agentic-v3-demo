import { Check, Copy } from 'lucide-react';
import type { Character, Message } from '../shared/contracts';
import { Avatar } from './Avatar';
import { messageText } from './message-text';

const time = (date: string) => new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(date));
export function ReadingText({ content }: { content: string }) {
  // Model output remains text nodes, including dialogue and simple emphasis.
  return <>{content.split(/\n\n+/).map((paragraph, index) => <p key={index}>{paragraph.split(/(“[^”]+”|「[^」]+」|\*[^*\n]+\*)/g).map((part, partIndex) => part.startsWith('*') && part.endsWith('*') ? <em key={partIndex}>{part.slice(1, -1)}</em> : /^[“「]/.test(part) ? <span className="av-dialogue" key={partIndex}>{part}</span> : part)}</p>)}</>;
}
export function MessageBubble({ message, character, currentPlayerName, streaming, onCopy }: { message: Message; character?: Character; currentPlayerName?: string | null; streaming?: boolean; onCopy: (text: string) => void }) {
  if (message.kind === 'operation') return null;
  const user = message.role === 'user';
  const text = messageText(message, character, currentPlayerName);
  return <article className={`av-message ${user ? 'is-user' : 'is-assistant'}`} data-message-id={message.id}>
    <Avatar character={character} user={user} />
    <div className="av-message-content">
      <div className="av-message-meta"><strong>{user ? message.playerName || '你' : message.characterName || character?.name || '角色'}</strong><time dateTime={message.createdAt}>{time(message.createdAt)}</time>{message.status === 'pending' && <span>发送中</span>}{message.status === 'failed' && <span>本轮待重试</span>}{message.status === 'cancelled' && <span>本轮已停止</span>}</div>
      <div className={'av-bubble ' + (streaming ? 'is-streaming' : '')}><ReadingText content={text} />{streaming && <span className="av-stream-caret" aria-hidden="true" />}</div>
      {!streaming && <div className="av-message-tools"><button onClick={() => onCopy(text)} aria-label="复制消息"><Copy size={12} /></button>{!user && <span><Check size={11} /> 已保存</span>}</div>}
    </div>
  </article>;
}
