import { useEffect, useRef, useState } from 'react';
import type { TurnTrace } from '../shared/contracts';
import type { ApiClient } from './api';

export interface TraceHints { settlementStatus?: string; directorStatus?: string }

/** Only the evidence that can change between polls: turn state, call identity and completion. */
function traceSignature(trace: TurnTrace): string {
  return [trace.status, ...trace.calls.map(call => [call.id, call.status, call.completedAt ?? ''].join(':'))].join('|');
}

function stillRunning(trace: TurnTrace, hints: TraceHints): boolean {
  return trace.status === 'running'
    || hints.settlementStatus === 'pending' || hints.settlementStatus === 'running'
    || hints.directorStatus === 'pending' || hints.directorStatus === 'running';
}

/**
 * Read one turn's recorded Agent calls and keep polling while the turn or its background work is running.
 * A poll that returns unchanged evidence does not re-render the callers.
 */
export function useTurnTrace(client: ApiClient, turnId: string, hints: TraceHints = {}) {
  const [trace, setTrace] = useState<TurnTrace | null>(null);
  const [error, setError] = useState('');
  const [retryKey, setRetryKey] = useState(0);
  const signature = useRef('');
  const loaded = useRef('');
  const { settlementStatus, directorStatus } = hints;
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    if (loaded.current !== turnId) { loaded.current = turnId; signature.current = ''; setTrace(null); }
    setError('');
    async function read() {
      try {
        const result = await client.trace(turnId, { signal: controller.signal });
        if (controller.signal.aborted) return;
        const next = traceSignature(result);
        if (next !== signature.current) { signature.current = next; setTrace(result); }
        if (stillRunning(result, { settlementStatus, directorStatus })) timer = setTimeout(() => void read(), 2000);
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '调用记录暂时无法读取。');
      }
    }
    if (turnId) void read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [client, turnId, retryKey, settlementStatus, directorStatus]);
  return { trace, error, retry: () => setRetryKey(value => value + 1) };
}
