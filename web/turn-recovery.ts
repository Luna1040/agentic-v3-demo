import type { TurnView } from '../shared/contracts';
import type { ApiClient } from './api';

function wait(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, 600);
    if (signal.aborted) { aborted(); return; }
    signal.addEventListener('abort', aborted, { once: true });
  });
}
/** Recovery has no mutation capability: a failed opening can never restart the model here. */
export async function readPersistedTurn(client: Pick<ApiClient, 'turn'>, turnId: string, signal: AbortSignal, onTurn: (turn: TurnView) => void, options: { maxReads?: number; wait?: (signal: AbortSignal) => Promise<void> } = {}): Promise<TurnView | null> {
  let last: TurnView | null = null;
  const reads = options.maxReads ?? 80;
  for (let index = 0; index < reads; index++) {
    signal.throwIfAborted();
    last = await client.turn(turnId, { signal });
    signal.throwIfAborted();
    onTurn(last);
    if (last.status !== 'running') break;
    if (index + 1 < reads) await (options.wait ?? wait)(signal);
  }
  return last;
}
