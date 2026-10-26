import type { TurnEvent, TurnView, WorldView } from '../shared/contracts';
import { applyTurnEvent, initialConversation, recoverTurn, type ConversationState } from './conversation-state';

/** Single state owner for transport, persisted dialogue and background snapshots.
 * Background refreshes have no capability to replace messages or a running draft. */
export class ConversationController {
  private value: ConversationState = initialConversation;
  private readonly listeners = new Set<() => void>();
  get current() { return this.value; }
  readonly snapshot = () => this.value;
  readonly subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  readonly update = (change: (state: ConversationState) => ConversationState) => {
    const next = change(this.value);
    if (next === this.value) return;
    this.value = next;
    for (const listener of this.listeners) listener();
  };
  accept(event: TurnEvent) { this.update(state => applyTurnEvent(state, event)); }
  recover(turn: TurnView) { this.update(state => recoverTurn(state, turn)); }
  refreshWorld(world: WorldView) {
    this.update(state => !state.detail || state.detail.world.id !== world.id || world.revision < state.detail.world.revision
      ? state : {...state, detail: {...state.detail, world}});
  }
}
