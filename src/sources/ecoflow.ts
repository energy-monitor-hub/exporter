import { z } from 'zod';
import { login } from '../auth/client.js';
import { EcoflowAuthError } from '../auth/errors.js';
import { productCode } from '../discovery/census.js';
import { Delta3MaxPlus } from '../decode/delta3maxplus.js';
import { decodePayload } from '../decode/envelope.js';
import type { DeviceAdapter } from '../model/types.js';
import { EcoflowMqtt } from '../mqtt/client.js';
import type { Logger } from '../mqtt/client.js';
import { peekHeaders } from '../mqtt/header.js';
import { xorKeysOf } from '../record/scrub.js';
import { type DiscoveryCodec, type Source, definePlugin } from './types.js';

/** What the setup page stores for EcoFlow: the app account and the station to read. */
export const ecoflowCredentialsSchema = z.object({
  username: z.string().trim().min(3).max(200),
  password: z.string().min(1).max(200),
  sn: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9]{6,40}$/, 'serial number: 6-40 letters and digits'),
  apiHost: z
    .string()
    .trim()
    .regex(/^[a-z0-9.-]+\.ecoflow\.com$/, 'API host must be an ecoflow.com host name')
    .optional(),
});

export type EcoflowCredentials = z.infer<typeof ecoflowCredentialsSchema>;

/** EcoFlow's protobuf envelope: `cmdFunc/cmdId` per message, serials in the headers, XOR-ed pdata. */
export const ecoflowDiscovery: DiscoveryCodec = {
  messages: (payload) => decodePayload(payload)?.map((m) => ({ id: `${m.cmdFunc}/${m.cmdId}`, decoded: m.data !== undefined && m.type !== undefined })) ?? null,
  learnIdentifiers: (scrubber, payload) => {
    const headers = peekHeaders(payload);
    if (!headers) return;
    scrubber.learnFromHeaders(headers);
    scrubber.learnFromDecoded(decodePayload(payload));
  },
  xorKeys: (payload) => xorKeysOf(peekHeaders(payload)),
};

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
  readonly productCode: string;
  readonly discovery = ecoflowDiscovery;
  private readonly mqtt: EcoflowMqtt;
  private readonly username: string;

  constructor(opts: EcoflowSourceOptions) {
    this.sn = opts.sn;
    this.productCode = productCode(opts.sn);
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

const auth = (c: EcoflowCredentials) => ({ username: c.username, password: c.password, ...(c.apiHost ? { apiHost: c.apiHost } : {}) });

/** EcoFlow stations through the EcoFlow app account (cloud MQTT, protobuf). */
export const ecoflowPlugin = definePlugin<EcoflowCredentials>({
  id: 'ecoflow-mqtt',
  vendor: 'ecoflow',
  setup: {
    title: { en: 'EcoFlow account', uk: 'Акаунт EcoFlow' },
    hint: { en: 'Enter your EcoFlow app account and the station to read.', uk: 'Введи акаунт застосунку EcoFlow і станцію, яку читати.' },
    privacy: {
      en: 'The password is checked with EcoFlow, then stored only on this computer, encrypted. The key is kept with your exporter login, so revoking this exporter on the dashboard makes a copy of the file useless. The exporter uses EcoFlow’s unofficial app interface with your account, at your own risk.',
      uk: 'Пароль перевіряється в EcoFlow, потім зберігається лише на цьому комп’ютері в зашифрованому вигляді. Ключ зберігається разом із входом експортера, тож якщо відкликати цей експортер на дашборді, копія файлу стає непридатною. Експортер використовує неофіційний інтерфейс застосунку EcoFlow з твоїм акаунтом, на твій ризик.',
    },
    fields: [
      {
        name: 'username',
        kind: 'email',
        label: { en: 'E-mail of the EcoFlow app account', uk: 'E-mail акаунта застосунку EcoFlow' },
        required: true,
        maxLength: 200,
        autocomplete: 'username',
      },
      { name: 'password', kind: 'password', label: { en: 'Password', uk: 'Пароль' }, required: true, maxLength: 200, autocomplete: 'current-password' },
      {
        name: 'sn',
        kind: 'text',
        label: { en: 'Serial number of the station', uk: 'Серійний номер станції' },
        required: true,
        pattern: '[A-Za-z0-9]{6,40}',
        autocomplete: 'off',
      },
      {
        name: 'apiHost',
        kind: 'select',
        label: { en: 'Server', uk: 'Сервер' },
        options: [
          { value: '', label: 'api.ecoflow.com' },
          { value: 'api-e.ecoflow.com', label: 'api-e.ecoflow.com (EU)' },
          { value: 'api-a.ecoflow.com', label: 'api-a.ecoflow.com' },
        ],
      },
    ],
    envVars: ['ECOFLOW_USERNAME', 'ECOFLOW_PASSWORD', 'DEVICE_SN'],
  },
  credentials: ecoflowCredentialsSchema,
  fromEnv(env) {
    const username = env.ECOFLOW_USERNAME;
    const password = env.ECOFLOW_PASSWORD;
    const sn = env.DEVICE_SN;
    if (!username || !password || !sn) return undefined;
    return { username, password, sn, ...(env.ECOFLOW_API_HOST ? { apiHost: env.ECOFLOW_API_HOST } : {}) };
  },
  async verify(c) {
    await login(auth(c));
  },
  productCode: (c) => productCode(c.sn),
  open: (c, ctx) =>
    new EcoflowSource({
      ...auth(c),
      sn: c.sn,
      requestQuotasEveryMs: ctx.config.quotaEveryS * 1000,
      silenceTimeoutMs: ctx.config.mqttSilenceTimeoutS * 1000,
      logger: ctx.logger,
      ...(ctx.adapter ? { adapter: ctx.adapter } : {}),
    }),
  describeFatal: (err) => (err instanceof EcoflowAuthError ? `EcoFlow rejected the login (code ${err.code}): ${err.message}` : undefined),
});
