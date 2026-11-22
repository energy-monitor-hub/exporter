import { describe, expect, it, vi } from 'vitest';
import { getMqttCredentials, login, makeClientId } from '../src/auth/client.js';
import { EcoflowApiError, EcoflowAuthError } from '../src/auth/errors.js';
import { loadEcoflowEnv } from '../src/auth/env.js';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const LOGIN_OK = { code: '0', message: 'Success', data: { token: 'tok', user: { userId: '1234567890', name: 'x' } } };
const CERT_OK = {
  code: '0',
  message: 'Success',
  data: {
    url: 'mqtt-e.ecoflow.com',
    port: '8883',
    protocol: 'mqtts',
    certificateAccount: 'app-acc',
    certificatePassword: 'app-pass',
  },
};

describe('auth', () => {
  it('logs in, fetches certification and builds an app-style clientId', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(LOGIN_OK)).mockResolvedValueOnce(json(CERT_OK));
    const creds = await getMqttCredentials({ username: 'me@example.com', password: 'pässword', fetch: fetchMock });

    expect(creds).toMatchObject({
      host: 'mqtt-e.ecoflow.com',
      port: 8883,
      protocol: 'mqtts',
      username: 'app-acc',
      password: 'app-pass',
      userId: '1234567890',
    });
    expect(creds.clientId).toMatch(/^ANDROID_[0-9A-F-]{36}_1234567890$/);

    const [loginUrl, loginInit] = fetchMock.mock.calls[0]!;
    expect(loginUrl).toBe('https://api.ecoflow.com/auth/login');
    const body = JSON.parse(String(loginInit?.body)) as Record<string, string>;
    expect(body).toMatchObject({ email: 'me@example.com', scene: 'IOT_APP', userType: 'ECOFLOW' });
    expect(Buffer.from(body.password!, 'base64').toString('utf8')).toBe('pässword');

    const [certUrl, certInit] = fetchMock.mock.calls[1]!;
    expect(certUrl).toBe('https://api.ecoflow.com/iot-auth/app/certification?userId=1234567890');
    expect((certInit?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('honours a custom API host and strips a scheme from the broker url', async () => {
    const cert = { ...CERT_OK, data: { ...CERT_OK.data, url: 'mqtts://mqtt.ecoflow.com/' } };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(LOGIN_OK)).mockResolvedValueOnce(json(cert));
    const creds = await getMqttCredentials({ username: 'a', password: 'b', apiHost: 'api-e.ecoflow.com', fetch: fetchMock });
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api-e.ecoflow.com/auth/login');
    expect(creds.host).toBe('mqtt.ecoflow.com');
  });

  it('turns a login error code into EcoflowAuthError (not retryable)', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json({ code: '1004', message: 'Incorrect password' }));
    const err = await login({ username: 'a', password: 'b', fetch: fetchMock }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EcoflowAuthError);
    expect((err as EcoflowAuthError).code).toBe('1004');
  });

  it('keeps network and HTTP failures retryable', async () => {
    const down = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const e1 = await login({ username: 'a', password: 'b', fetch: down }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(EcoflowApiError);
    expect(e1).not.toBeInstanceOf(EcoflowAuthError);

    const http = vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 502 }));
    const e2 = await login({ username: 'a', password: 'b', fetch: http }).catch((e: unknown) => e);
    expect(e2).not.toBeInstanceOf(EcoflowAuthError);
    expect((e2 as Error).message).toContain('502');
  });

  it('reports missing fields in the certification reply', async () => {
    const bad = { code: '0', message: 'Success', data: { url: 'x', port: 8883 } };
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(json(LOGIN_OK)).mockResolvedValueOnce(json(bad));
    await expect(getMqttCredentials({ username: 'a', password: 'b', fetch: fetchMock })).rejects.toThrow(
      /certificateAccount/,
    );
  });

  it('makeClientId upper-cases the uuid', () => {
    expect(makeClientId('42', 'abcdef01-2345-4678-9abc-def012345678')).toBe(
      'ANDROID_ABCDEF01-2345-4678-9ABC-DEF012345678_42',
    );
  });

  it('loadEcoflowEnv names what is missing', () => {
    expect(() => loadEcoflowEnv({ ECOFLOW_USERNAME: 'a' })).toThrow('ECOFLOW_PASSWORD, DEVICE_SN');
    expect(loadEcoflowEnv({ ECOFLOW_USERNAME: 'a', ECOFLOW_PASSWORD: 'b', DEVICE_SN: ' SN1 ' })).toEqual({
      username: 'a',
      password: 'b',
      deviceSn: 'SN1',
    });
  });
});
