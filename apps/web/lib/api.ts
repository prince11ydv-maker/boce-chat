const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export class ApiRequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Thin fetch wrapper: always sends cookies (httpOnly session cookies),
// always throws a typed error with a user-safe message so pages never
// have to guess how to render a failure.
export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...init?.headers },
  });

  const body = await res.json().catch(() => null);

  if (!res.ok) {
    const err = body?.error ?? { code: "UNKNOWN", message: "Something went wrong." };
    throw new ApiRequestError(res.status, err.code, err.message);
  }

  return body as T;
}
