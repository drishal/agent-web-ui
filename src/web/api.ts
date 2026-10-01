export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: init.body === undefined ? {} : { "content-type": "application/json" },
      body: init.body === undefined ? null : JSON.stringify(init.body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network", "Cannot reach the server");
  }
  if (!res.ok) {
    let data: { error?: string; code?: string } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // non-JSON error body
    }
    if (res.status === 401) for (const l of unauthorizedListeners) l();
    throw new ApiError(res.status, data.code ?? `http_${res.status}`, data.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
