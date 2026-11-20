export class ApiError extends Error {
  constructor(message: string, public code = 'REQUEST_FAILED', public status = 0) { super(message); this.name = 'ApiError'; }
}
export interface RequestOptions { signal?: AbortSignal }
export interface ApiClientOptions {
  storageNamespace?: string;
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  getHeaders?: () => HeadersInit | Promise<HeadersInit>;
}
export function createApiTransport({ baseUrl = "/api", fetch: fetchImpl = globalThis.fetch.bind(globalThis), getHeaders }: ApiClientOptions = {}) {
  const base = baseUrl.replace(/\/$/, '');
  async function request(path: string, { signal }: RequestOptions = {}, method = 'GET', body?: unknown, stream = false) {
    const headers = new Headers(await getHeaders?.());
    headers.set('Accept', stream ? 'text/event-stream' : 'application/json');
    if (body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetchImpl(base + path, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new ApiError(data.error?.message || data.message || `请求失败 (${response.status})`, data.error?.code, response.status);
    }
    return response;
  }
  async function json<T>(path: string, options?: RequestOptions, method?: string, body?: unknown): Promise<T> {
    return (await request(path, options, method, body)).json();
  }
  return { request, json };
}
