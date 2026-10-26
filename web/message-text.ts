import type { Character, Message } from '../shared/contracts';
import { resolveRoleplayTemplate } from '../shared/roleplay-template';

/** Display-only expansion. Keep authored text and model evidence unchanged. */
export function messageText(message: Message, character?: Character, currentPlayerName?: string | null): string {
  if (message.role !== 'assistant') return message.content;
  // Authored welcomes are templates; completed dialogue retains its original identity.
  const playerName = message.turnId === null && currentPlayerName !== undefined ? currentPlayerName : message.playerName;
  const names = { char: message.characterName || character?.name || '角色', user: playerName || '玩家' };
  // One pass: names containing $ or template-like text are literal values.
  return resolveRoleplayTemplate(message.content, names);
}
