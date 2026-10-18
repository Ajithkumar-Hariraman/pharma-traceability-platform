import { z } from 'zod';
export const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .email('Enter a valid email address'),
  password: z
    .string()
    .min(12, 'Use at least 12 characters')
    .max(128, 'Use at most 128 characters'),
});
export type Credentials = z.infer<typeof credentialsSchema>;
export type { AuthUser as User } from '@pharma/contracts';
import type { AuthUser as User } from '@pharma/contracts';
let accessToken: string | null = null;
let refreshing: Promise<void> | null = null;
async function request(path: string, body?: unknown, authenticated = false) {
  const response = await fetch(`/api/auth/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      ...(authenticated && accessToken
        ? { Authorization: `Bearer ${accessToken}` }
        : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await response.json()) as {
    message?: string;
    accessToken?: string;
  };
  if (!response.ok)
    throw Object.assign(
      new Error(data.message || 'Unable to complete your request'),
      { status: response.status },
    );
  return data;
}
export async function refreshSession() {
  if (!refreshing)
    refreshing = request('refresh', {})
      .then((data) => {
        accessToken = data.accessToken ?? null;
      })
      .finally(() => {
        refreshing = null;
      });
  return refreshing;
}
export async function currentUser(): Promise<User> {
  try {
    return (await request('me', undefined, true)) as unknown as User;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('status' in error) ||
      error.status !== 401
    )
      throw error;
    await refreshSession();
    return (await request('me', undefined, true)) as unknown as User;
  }
}
export async function login(credentials: Credentials) {
  const data = await request('login', credentials);
  accessToken = data.accessToken ?? null;
  return currentUser();
}
export async function register(credentials: Credentials) {
  await request('register', credentials);
}
export async function logout() {
  await request('logout', {});
  accessToken = null;
}

export async function authenticatedRequest<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const send = () =>
    fetch(`/api${path}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let response = await send();
  if (response.status === 401) {
    await refreshSession();
    response = await send();
  }
  const data = (await response.json()) as { message?: string };
  if (!response.ok)
    throw Object.assign(
      new Error(data.message || 'Unable to complete your request'),
      { status: response.status },
    );
  return data as T;
}
