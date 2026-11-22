import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { EcoflowApiError, EcoflowAuthError } from './errors.js';
import { certificationDataSchema, envelopeSchema, loginDataSchema } from './schemas.js';

/**
 * Private (mobile app) API: email + password -> token -> MQTT credentials.
 * Checked against foxthefox/ioBroker.ecoflow-mqtt (lib/ecoflow_utils.js, getEcoFlowMqttCredits)
 * and tolwi/hassio-ecoflow-cloud (api/private_api.py) on 2026-11-21.
 */

/** `api.ecoflow.com` is what ioBroker uses; hassio offers `api-e.ecoflow.com` (EU) and `api-a.ecoflow.com`. */
export const DEFAULT_API_HOST = 'api.ecoflow.com';

export interface AuthOptions {
  username: string;
  password: string;
  apiHost?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface MqttCredentials {
  /** Broker host, e.g. `mqtt-e.ecoflow.com`. */
  host: string;
  port: number;
  /** As reported by the API, usually `mqtts`. We always connect over TLS. */
  protocol: string;
  username: string;
  password: string;
  userId: string;
  clientId: string;
}

const APP_HEADERS = {
  lang: 'en_US',
  platform: 'android',
  'content-type': 'application/json',
  'user-agent': 'okhttp/3.14.9',
} as const;

/** `ANDROID_<UUID>_<userId>`: the broker only authorises client ids in the app's format. */
export function makeClientId(userId: string, uuid: string = randomUUID()): string {
  return `ANDROID_${uuid.toUpperCase()}_${userId}`;
}

async function callApi<S extends z.ZodType>(
  url: string,
  init: RequestInit,
  schema: S,
  opts: AuthOptions,
  what: string,
): Promise<{ data: z.infer<S>; code?: string }> {
  const doFetch = opts.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  } catch (err) {
    throw new EcoflowApiError(`${what}: request failed: ${(err as Error).message}`, undefined, { cause: err });
  }
  if (!res.ok) {
    throw new EcoflowApiError(`${what}: HTTP ${res.status} ${res.statusText}`);
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (err) {
    throw new EcoflowApiError(`${what}: response is not JSON`, undefined, { cause: err });
  }
  const env = envelopeSchema.safeParse(body);
  if (!env.success) {
    throw new EcoflowApiError(`${what}: unexpected response shape`);
  }
  const code = env.data.code === undefined ? undefined : String(env.data.code);
  if (env.data.message.toLowerCase() !== 'success') {
    throw new EcoflowApiError(`${what}: ${env.data.message}`, code);
  }
  const data = schema.safeParse(env.data.data);
  if (!data.success) {
    const fields = data.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new EcoflowApiError(`${what}: missing or invalid fields: ${fields}`, code);
  }
  return code === undefined ? { data: data.data } : { data: data.data, code };
}

export interface LoginResult {
  token: string;
  userId: string;
}

export async function login(opts: AuthOptions): Promise<LoginResult> {
  const host = opts.apiHost ?? DEFAULT_API_HOST;
  try {
    const { data } = await callApi(
      `https://${host}/auth/login`,
      {
        method: 'POST',
        headers: APP_HEADERS,
        body: JSON.stringify({
          email: opts.username,
          password: Buffer.from(opts.password, 'utf8').toString('base64'),
          scene: 'IOT_APP',
          userType: 'ECOFLOW',
          os: 'android',
        }),
      },
      loginDataSchema,
      opts,
      'login',
    );
    return { token: data.token, userId: data.user.userId };
  } catch (err) {
    // An error code from /auth/login means the credentials were rejected;
    // transport and parse failures carry no code and stay retryable.
    if (err instanceof EcoflowApiError && err.code !== undefined) {
      throw new EcoflowAuthError(err.message, err.code);
    }
    throw err;
  }
}

export async function fetchCertification(
  session: LoginResult,
  opts: AuthOptions,
): Promise<Omit<MqttCredentials, 'clientId' | 'userId'>> {
  const host = opts.apiHost ?? DEFAULT_API_HOST;
  const url = `https://${host}/iot-auth/app/certification?userId=${encodeURIComponent(session.userId)}`;
  const { data } = await callApi(
    url,
    { method: 'GET', headers: { ...APP_HEADERS, authorization: `Bearer ${session.token}` } },
    certificationDataSchema,
    opts,
    'certification',
  );
  return {
    host: stripScheme(data.url),
    port: data.port,
    protocol: data.protocol ?? 'mqtts',
    username: data.certificateAccount,
    password: data.certificatePassword,
  };
}

/** Login, then ask for MQTT credentials. A fresh clientId every call. */
export async function getMqttCredentials(opts: AuthOptions): Promise<MqttCredentials> {
  const session = await login(opts);
  const cert = await fetchCertification(session, opts);
  return { ...cert, userId: session.userId, clientId: makeClientId(session.userId) };
}

function stripScheme(url: string): string {
  return url.replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
}
