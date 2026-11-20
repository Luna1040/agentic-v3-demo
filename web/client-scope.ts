const clients = new WeakMap<object, number>();
let nextId = 0;

/** Changing either identity boundary remounts all account-owned UI state. */
export function clientScopeKey(client: object, namespace: string): string {
  let id = clients.get(client);
  if (id === undefined) { id = ++nextId; clients.set(client, id); }
  return JSON.stringify([id, namespace]);
}
