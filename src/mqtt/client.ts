import { EventEmitter } from 'node:events';
import mqtt, { type IClientOptions, type MqttClient } from 'mqtt';
import { getMqttCredentials, type AuthOptions, type MqttCredentials } from '../auth/client.js';
import { EcoflowAuthError } from '../auth/errors.js';
import { backoffDelay, sleep } from './backoff.js';
import { encodeLatestQuotasRequest } from './quota.js';
import { deviceTopics, subscribeTopics, topicKind, type DeviceTopics, type TopicKind } from './topics.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface EcoflowMessage {
  topic: string;
  kind: TopicKind;
  payload: Buffer;
  receivedAt: Date;
}

export interface EcoflowMqttEvents {
  connected: [info: { host: string; port: number; userId: string }];
  disconnected: [];
  message: [msg: EcoflowMessage];
}

export interface EcoflowMqttOptions {
  auth: AuthOptions;
  deviceSn: string;
  /**
   * Ask the device for a full snapshot on connect and then every N ms (ioBroker does it every 5 min).
   * 0 disables it; then we only receive what the device pushes on its own.
   */
  requestQuotasEveryMs?: number;
  /**
   * Watchdog (issue #14): if the connection looks up but no message arrived for this long,
   * drop it and log in again with fresh credentials. 0 disables it. The device pushes
   * something every few seconds, and we ask for a full snapshot every few minutes.
   */
  silenceTimeoutMs?: number;
  /** Delay between plain reconnect attempts done by mqtt.js. */
  reconnectPeriodMs?: number;
  logger?: Logger;
  /** Injection points for tests. */
  getCredentials?: (auth: AuthOptions) => Promise<MqttCredentials>;
  connect?: (url: string, opts: IClientOptions) => MqttClient;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** CONNACK return codes that mean "these credentials are no good": MQTT 3.1.1 (4, 5) and 5.0 (134, 135). */
const AUTH_REFUSED = new Set([4, 5, 134, 135]);

export function isAuthRefusal(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' && AUTH_REFUSED.has(code);
}

/**
 * Keeps one MQTT connection to the EcoFlow broker alive:
 * - network drops: mqtt.js reconnects every `reconnectPeriodMs` with the same credentials;
 * - broker refuses the credentials (they expire or get revoked): log in again and get fresh ones,
 *   with exponential backoff, forever (power/internet outages can last hours);
 * - wrong email/password on the very first login: `start()` rejects, retrying would not help.
 */
export class EcoflowMqtt extends EventEmitter<EcoflowMqttEvents> {
  private readonly opts: EcoflowMqttOptions;
  private readonly log: Logger;
  private readonly abort = new AbortController();
  private client: MqttClient | undefined;
  private creds: MqttCredentials | undefined;
  private topics: DeviceTopics | undefined;
  private quotaTimer: NodeJS.Timeout | undefined;
  private watchdogTimer: NodeJS.Timeout | undefined;
  private lastActivity = 0;
  private lastMessage: Date | undefined;
  private connected = false;
  private everConnected = false;
  private reauthing = false;
  private authFailures = 0;

  constructor(opts: EcoflowMqttOptions) {
    super();
    this.opts = opts;
    this.log = opts.logger ?? console;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  /** When the last MQTT message arrived. */
  get lastMessageAt(): Date | undefined {
    return this.lastMessage;
  }

  get userId(): string | undefined {
    return this.creds?.userId;
  }

  async start(): Promise<void> {
    this.creds = await this.acquireCredentials(true);
    if (this.abort.signal.aborted) return;
    this.open(this.creds);
    this.startWatchdog();
  }

  /** Drop the connection and log in again (fresh credentials). */
  restart(reason: string): void {
    this.log.warn(`mqtt: ${reason}; reconnecting with fresh credentials`);
    void this.reauth();
  }

  /** Checked every 1/4 of the timeout; time is counted from the last message or (re)connect. */
  private startWatchdog(): void {
    const timeout = this.opts.silenceTimeoutMs ?? 0;
    if (timeout <= 0) return;
    this.lastActivity = Date.now();
    this.watchdogTimer = setInterval(() => {
      if (this.reauthing || this.abort.signal.aborted) return;
      const silent = Date.now() - this.lastActivity;
      if (this.connected && silent >= timeout) {
        this.lastActivity = Date.now();
        this.restart(`no messages for ${Math.round(silent / 1000)}s`);
      }
    }, Math.max(1000, Math.floor(timeout / 4)));
    this.watchdogTimer.unref();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    this.clearQuotaTimer();
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = undefined;
    const client = this.client;
    this.client = undefined;
    if (client) await new Promise<void>((resolve) => client.end(false, {}, () => resolve()));
    this.setDisconnected();
  }

  /** Ask the device to send all its current values (answer arrives on get_reply). */
  requestQuotas(): void {
    if (!this.client || !this.topics || !this.connected) return;
    this.client.publish(this.topics.get, Buffer.from(encodeLatestQuotasRequest()), { qos: 1 }, (err) => {
      if (err) this.log.warn(`mqtt: quota request failed: ${err.message}`);
    });
  }

  private async acquireCredentials(first: boolean): Promise<MqttCredentials> {
    const get = this.opts.getCredentials ?? getMqttCredentials;
    const wait = this.opts.sleep ?? sleep;
    for (let attempt = 0; ; attempt++) {
      try {
        const creds = await get(this.opts.auth);
        this.log.info(`auth: got MQTT credentials for ${creds.host}:${creds.port}`);
        return creds;
      } catch (err) {
        // Rejected email/password before we ever connected: fail fast so the user sees it.
        if (err instanceof EcoflowAuthError && first && !this.everConnected) throw err;
        if (this.abort.signal.aborted) throw err;
        const delay = backoffDelay(attempt);
        this.log.warn(`auth: ${(err as Error).message}; retrying in ${Math.round(delay / 1000)}s`);
        await wait(delay, this.abort.signal);
        if (this.abort.signal.aborted) throw err;
      }
    }
  }

  private open(creds: MqttCredentials): void {
    const connect = this.opts.connect ?? mqtt.connect;
    this.topics = deviceTopics(creds.userId, this.opts.deviceSn);
    const topics = subscribeTopics(this.topics);
    const client = connect(`mqtts://${creds.host}:${creds.port}`, {
      clientId: creds.clientId,
      username: creds.username,
      password: creds.password,
      protocolVersion: 4,
      clean: true,
      keepalive: 60,
      connectTimeout: 30_000,
      reconnectPeriod: this.opts.reconnectPeriodMs ?? 5_000,
      rejectUnauthorized: true,
    });
    this.client = client;

    client.on('connect', () => {
      if (client !== this.client) return;
      this.connected = true;
      this.everConnected = true;
      this.lastActivity = Date.now();
      this.authFailures = 0;
      this.log.info(`mqtt: connected to ${creds.host}:${creds.port}`);
      client.subscribe(topics, { qos: 1 }, (err) => {
        if (err) {
          this.log.error(`mqtt: subscribe failed: ${err.message}`);
          return;
        }
        this.emit('connected', { host: creds.host, port: creds.port, userId: creds.userId });
        this.startQuotaTimer();
      });
    });

    client.on('message', (topic, payload) => {
      if (client !== this.client) return;
      this.lastActivity = Date.now();
      this.lastMessage = new Date();
      this.emit('message', { topic, kind: topicKind(topic), payload, receivedAt: new Date() });
    });

    client.on('close', () => {
      if (client === this.client) this.setDisconnected();
    });

    client.on('error', (err) => {
      if (client !== this.client) return;
      if (isAuthRefusal(err)) {
        this.log.warn(`mqtt: ${err.message}; logging in again`);
        void this.reauth();
      } else {
        this.log.warn(`mqtt: ${err.message}`);
      }
    });
  }

  private async reauth(): Promise<void> {
    if (this.reauthing || this.abort.signal.aborted) return;
    this.reauthing = true;
    try {
      const old = this.client;
      this.client = undefined;
      old?.end(true);
      this.setDisconnected();
      const wait = this.opts.sleep ?? sleep;
      await wait(backoffDelay(this.authFailures++), this.abort.signal);
      if (this.abort.signal.aborted) return;
      this.creds = await this.acquireCredentials(false);
      if (this.abort.signal.aborted) return;
      this.open(this.creds);
    } catch (err) {
      if (!this.abort.signal.aborted) this.log.error(`auth: giving up: ${(err as Error).message}`);
    } finally {
      this.reauthing = false;
    }
  }

  private startQuotaTimer(): void {
    this.clearQuotaTimer();
    const every = this.opts.requestQuotasEveryMs ?? 0;
    if (every <= 0) return;
    this.requestQuotas();
    this.quotaTimer = setInterval(() => this.requestQuotas(), every);
    this.quotaTimer.unref();
  }

  private clearQuotaTimer(): void {
    if (this.quotaTimer) clearInterval(this.quotaTimer);
    this.quotaTimer = undefined;
  }

  private setDisconnected(): void {
    this.clearQuotaTimer();
    if (!this.connected) return;
    this.connected = false;
    this.log.warn('mqtt: disconnected');
    this.emit('disconnected');
  }
}
