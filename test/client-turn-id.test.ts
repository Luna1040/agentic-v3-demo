import assert from 'node:assert/strict';
import test from 'node:test';
import { attemptForSend, openingAttempt, type Attempt } from '../web/conversation-state';
import { createClientTurnId } from '../web/client-turn-id';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const realCrypto = globalThis.crypto;
const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');

/** Replace globalThis.crypto for the duration of one synchronous test. */
function withCrypto<T>(value: unknown, run: () => T): T {
  Object.defineProperty(globalThis, 'crypto', { value, configurable: true, writable: true });
  try { return run(); }
  finally { if (originalDescriptor) Object.defineProperty(globalThis, 'crypto', originalDescriptor); }
}

test('uses native crypto.randomUUID with the crypto object as its receiver', () => {
  let observedThis: unknown;
  const stub = {
    randomUUID(this: unknown) {
      observedThis = this;
      return 'native-id';
    },
    getRandomValues() {
      assert.fail('getRandomValues must not run while randomUUID is available');
    },
  };
  assert.equal(withCrypto(stub, () => createClientTurnId()), 'native-id');
  assert.equal(observedThis, stub);
});

test('falls back to crypto.getRandomValues when randomUUID is not exposed (insecure HTTP origin)', () => {
  const calls: string[] = [];
  const stub = {
    getRandomValues(array: Uint8Array) {
      calls.push('getRandomValues');
      array.fill(0xab);
      return array;
    },
  };
  const id = withCrypto(stub, () => createClientTurnId());
  assert.deepEqual(calls, ['getRandomValues']);
  assert.equal(id, 'abababab-abab-4bab-abab-abababababab');
  assert.match(id, UUID_V4);
});

test('randomUUID that exists but returns no usable value still falls back to getRandomValues', () => {
  const id = withCrypto({
    randomUUID: () => '',
    getRandomValues(array: Uint8Array) { array.fill(0xcd); return array; },
  }, () => createClientTurnId());
  assert.equal(id, 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd');
});

test('renders a distinct non-crypto id when crypto is missing entirely', () => {
  withCrypto(undefined, () => {
    const ids = new Set<string>();
    for (let index = 0; index < 20000; index++) {
      const id = createClientTurnId();
      assert.match(id, /^ctid-/);
      assert.ok(id.length <= 100, 'the server limits clientTurnId to 100 characters');
      ids.add(id);
    }
    assert.equal(ids.size, 20000);
    // Sending is still possible without any crypto API at all.
    const attempt = attemptForSend('  无 crypto 发送  ');
    assert.match(attempt.clientTurnId, /^ctid-/);
    assert.equal(attempt.content, '无 crypto 发送');
  });
});

test('a throwing randomUUID and getRandomValues still produce a usable id', () => {
  const randomUUIDOnly = withCrypto({
    randomUUID() { throw new TypeError('crypto.randomUUID is not a function'); },
    getRandomValues(array: Uint8Array) { realCrypto.getRandomValues(array); return array; },
  }, () => createClientTurnId());
  assert.match(randomUUIDOnly, UUID_V4);

  const bothBroken = withCrypto({
    randomUUID() { throw new TypeError('crypto.randomUUID is not a function'); },
    getRandomValues() { throw new Error('getRandomValues unavailable'); },
  }, () => createClientTurnId());
  assert.match(bothBroken, /^ctid-/);
  assert.ok(bothBroken.length <= 100);
});

test('generated ids stay unique in bulk on the fallback and the getRandomValues path', () => {
  const secure = withCrypto({
    getRandomValues(array: Uint8Array) { realCrypto.getRandomValues(array); return array; },
  }, () => Array.from({ length: 5000 }, () => createClientTurnId()));
  assert.equal(new Set(secure).size, secure.length);
  for (const id of secure) assert.match(id, UUID_V4);

  const insecure = withCrypto(undefined, () => Array.from({ length: 20000 }, () => createClientTurnId()));
  assert.equal(new Set(insecure).size, insecure.length);
});

test('retrying a failed send reuses its original clientTurnId and never mints a new one', () => {
  let minted = 0;
  withCrypto({
    randomUUID() { minted++; return `native-${minted}`; },
    getRandomValues() { assert.fail('randomUUID should be enough here'); },
  }, () => {
    const first = attemptForSend('  第一句  ');
    assert.equal(first.clientTurnId, 'native-1');
    assert.equal(first.content, '第一句');
    assert.equal(first.turnId, null);

    const failed: Attempt = { ...first, turnId: 'turn-1' };
    const retry = attemptForSend('重试不能换 key', failed);
    assert.equal(retry.clientTurnId, 'native-1');
    assert.equal(retry.content, '第一句');
    assert.equal(retry.turnId, 'turn-1');
    assert.equal(minted, 1);

    // The fixed opening id keeps backend idempotency (`opening:<sessionId>`) as well.
    const opening = openingAttempt('session-1');
    const openingRetry = attemptForSend('', opening);
    assert.equal(openingRetry.clientTurnId, 'opening:session-1');
    assert.equal(openingRetry.operation, 'opening');
    assert.equal(minted, 1);
  });
});
