import { EventEmitter } from 'node:events';
import type { IClientOptions, MqttClient } from 'mqtt';
import { describe, expect, it, vi } from 'vitest';
import type { MqttCredentials } from '../src/auth/client.js';
import { EcoflowApiError, EcoflowAuthError } from '../src/auth/errors.js';
import { EcoflowMqtt, isAuthRefusal, type EcoflowMessage } from '../src/mqtt/client.js';

class FakeClient extends EventEmitter {
  subscribed: string[] = [];
  published: { topic: string; payload: Buffer }[] = [];
  ended = false;
  constructor(
    readonly url: string,
    readonly opts: IClientOptions,
  ) {
    super();
  }
  subscribe(topics: string[], _o: unknown, cb: (err: Error | null) => void): this {
    this.subscribed.push(...topics);
    cb(null);
    return this;
  }
  publish(topic: string, payload: Buffer, _o: unknown, cb?: (err?: Error) => void): this {
    this.published.push({ topic, payload });
    cb?.();
    return this;
  }
  end(_force?: boolean, _o?: unknown, cb?: () => void): this {
    this.ended = true;
    cb?.();
    return this;
  }
}

const creds = (n: number): MqttCredentials => ({
  host: 'mqtt-e.ecoflow.com',
  port: 8883,
  protocol: 'mqtts',
  username: `acc${n}`,
  password: `pass${n}`,
  userId: '42',
  clientId: `ANDROID_X${n}_42`,
});

const quiet = { info: () => {}, warn: () => {}, error: () => {} };

function setup(getCredentials: (n: number) => Promise<MqttCredentials>, extra: Partial<ConstructorParameters<typeof EcoflowMqtt>[0]> = {}) {
  const clients: FakeClient[] = [];
  let calls = 0;
  const sleep = vi.fn(async () => {});
  const mqtt = new EcoflowMqtt({
    auth: { username: 'u', password: 'p' },
    deviceSn: 'SN1',
    logger: quiet,
    getCredentials: () => getCredentials(++calls),
    connect: (url, opts) => {
      const c = new FakeClient(url, opts);
      clients.push(c);
      return c as unknown as MqttClient;
    },
    sleep,
    ...extra,
  });
  return { mqtt, clients, sleep, calls: () => calls };
}

const refused = (code: number) => Object.assign(new Error('Connection refused: Not authorized'), { code });

describe('EcoflowMqtt', () => {
  it('connects over TLS with the app credentials, subscribes and asks for quotas', async () => {
    const { mqtt, clients } = setup(async (n) => creds(n), { requestQuotasEveryMs: 300_000 });
    const connected = vi.fn();
    const messages: EcoflowMessage[] = [];
    mqtt.on('connected', connected);
    mqtt.on('message', (m) => messages.push(m));
    await mqtt.start();

    const c = clients[0]!;
    expect(c.url).toBe('mqtts://mqtt-e.ecoflow.com:8883');
    expect(c.opts).toMatchObject({ clientId: 'ANDROID_X1_42', username: 'acc1', password: 'pass1', rejectUnauthorized: true });

    c.emit('connect');
    expect(mqtt.isConnected).toBe(true);
    expect(connected).toHaveBeenCalledWith({ host: 'mqtt-e.ecoflow.com', port: 8883, userId: '42' });
    expect(c.subscribed).toEqual([
      '/app/device/property/SN1',
      '/app/42/SN1/thing/property/get_reply',
      '/app/42/SN1/thing/property/set_reply',
    ]);
    expect(c.published.map((p) => p.topic)).toEqual(['/app/42/SN1/thing/property/get']);

    c.emit('message', '/app/device/property/SN1', Buffer.from([1, 2]));
    expect(messages[0]).toMatchObject({ kind: 'property', payload: Buffer.from([1, 2]) });

    await mqtt.stop();
    expect(c.ended).toBe(true);
  });

  it('does not ask for quotas when disabled', async () => {
    const { mqtt, clients } = setup(async (n) => creds(n));
    await mqtt.start();
    clients[0]!.emit('connect');
    expect(clients[0]!.published).toEqual([]);
    await mqtt.stop();
  });

  it('logs in again with fresh credentials when the broker refuses them', async () => {
    const { mqtt, clients, calls } = setup(async (n) => creds(n));
    const disconnected = vi.fn();
    mqtt.on('disconnected', disconnected);
    await mqtt.start();
    clients[0]!.emit('connect');

    clients[0]!.emit('error', refused(5));
    await vi.waitFor(() => expect(clients).toHaveLength(2));

    expect(clients[0]!.ended).toBe(true);
    expect(disconnected).toHaveBeenCalledOnce();
    expect(calls()).toBe(2);
    expect(clients[1]!.opts).toMatchObject({ username: 'acc2', clientId: 'ANDROID_X2_42' });

    // Events from the dead client are ignored.
    const msgs = vi.fn();
    mqtt.on('message', msgs);
    clients[0]!.emit('message', '/app/device/property/SN1', Buffer.from([1]));
    expect(msgs).not.toHaveBeenCalled();
    await mqtt.stop();
  });

  it('leaves plain network errors to the mqtt.js reconnect loop', async () => {
    const { mqtt, clients } = setup(async (n) => creds(n));
    await mqtt.start();
    clients[0]!.emit('connect');
    clients[0]!.emit('error', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }));
    clients[0]!.emit('close');
    expect(mqtt.isConnected).toBe(false);
    expect(clients).toHaveLength(1);
    clients[0]!.emit('connect');
    expect(mqtt.isConnected).toBe(true);
    await mqtt.stop();
  });

  it('fails fast when the very first login is rejected', async () => {
    const { mqtt, clients } = setup(async () => {
      throw new EcoflowAuthError('login: Incorrect password', '1004');
    });
    await expect(mqtt.start()).rejects.toBeInstanceOf(EcoflowAuthError);
    expect(clients).toHaveLength(0);
  });

  it('retries the login with backoff while the internet is down', async () => {
    const { mqtt, clients, sleep } = setup(async (n) => {
      if (n < 3) throw new EcoflowApiError('login: request failed: fetch failed');
      return creds(n);
    });
    await mqtt.start();
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(clients).toHaveLength(1);
    await mqtt.stop();
  });

  it('recognises auth refusal codes', () => {
    expect(isAuthRefusal(refused(4))).toBe(true);
    expect(isAuthRefusal(refused(135))).toBe(true);
    expect(isAuthRefusal(refused(3))).toBe(false);
    expect(isAuthRefusal(new Error('x'))).toBe(false);
  });

  it('watchdog: reconnects with fresh credentials when connected but silent', async () => {
    vi.useFakeTimers();
    try {
      const { mqtt, clients } = setup(async (n) => creds(n), { silenceTimeoutMs: 60_000 });
      await mqtt.start();
      clients[0]!.emit('connect');
      await vi.advanceTimersByTimeAsync(45_000);
      clients[0]!.emit('message', '/app/device/property/SN1', Buffer.from([1]));
      await vi.advanceTimersByTimeAsync(45_000);
      expect(clients).toHaveLength(1); // a message reset the clock
      await vi.advanceTimersByTimeAsync(30_000);
      expect(clients[0]!.ended).toBe(true);
      expect(clients).toHaveLength(2);
      expect(clients[1]!.opts.username).toBe('acc2');
      await mqtt.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
