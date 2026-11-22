import { Delta3MaxPlus } from '../decode/delta3maxplus.js';
import type { DeviceAdapter } from '../model/types.js';
import { EcoflowMqtt } from '../mqtt/client.js';
import type { Logger } from '../mqtt/client.js';
import type { Source } from './types.js';

export interface EcoflowSourceOptions {
  username: string;
  password: string;
  sn: string;
  apiHost?: string;
  requestQuotasEveryMs: number;
  silenceTimeoutMs: number;
  logger: Logger;
  /** A decoder pack's adapter (src/packs/); the built-in Delta 3 Max Plus code otherwise. */
  adapter?: DeviceAdapter & { readonly gridPresent?: boolean | undefined };
}

/** EcoFlow app account → private MQTT → protobuf (Delta 3 Max Plus). */
export class EcoflowSource implements Source {
  readonly adapter: DeviceAdapter & { readonly gridPresent?: boolean | undefined };
  readonly sn: string;
  private readonly mqtt: EcoflowMqtt;
  private readonly username: string;

  constructor(opts: EcoflowSourceOptions) {
    this.sn = opts.sn;
    this.adapter = opts.adapter ?? new Delta3MaxPlus();
    this.username = opts.username;
    this.mqtt = new EcoflowMqtt({
      auth: { username: opts.username, password: opts.password, ...(opts.apiHost ? { apiHost: opts.apiHost } : {}) },
      deviceSn: opts.sn,
      requestQuotasEveryMs: opts.requestQuotasEveryMs,
      silenceTimeoutMs: opts.silenceTimeoutMs,
      logger: opts.logger,
    });
  }

  get isConnected(): boolean {
    return this.mqtt.isConnected;
  }

  onPayload(cb: (payload: Uint8Array, at: Date, topic: string) => void): void {
    this.mqtt.on('message', (msg) => cb(msg.payload, msg.receivedAt, msg.topic));
  }

  start(): Promise<void> {
    return this.mqtt.start();
  }

  stop(): Promise<void> {
    return this.mqtt.stop();
  }

  reconnect(reason: string): void {
    this.mqtt.restart(reason);
  }

  identifiers(): string[] {
    return [this.sn, this.username, ...(this.mqtt.userId ? [this.mqtt.userId] : [])];
  }
}
