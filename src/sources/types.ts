import type { z } from 'zod';
import type { Config } from '../config.js';
import type { DeviceAdapter } from '../model/types.js';
import type { Logger } from '../mqtt/client.js';
import type { Scrubber } from '../record/scrub.js';

/** A string the status page shows, in its two languages. */
export interface Texts {
  en: string;
  uk: string;
}

/**
 * A connection to one device: brings raw payloads in and decodes them with its adapter.
 * Everything vendor-specific (login, transport, protocol) lives behind this interface;
 * the exporter, outbox and Supabase writer only see the common model (src/model/types.ts).
 */
export interface Source {
  /** Serial number as the device reports it (unique per owner in public.devices). */
  readonly sn: string;
  /** Model family code: picks a decoder pack (src/packs/) and goes into the model census. */
  readonly productCode: string;
  readonly adapter: DeviceAdapter & { readonly gridPresent?: boolean | undefined };
  readonly isConnected: boolean;
  /** How the model census and shared samples read this device's payloads (src/discovery/). */
  readonly discovery?: DiscoveryCodec | undefined;
  onPayload(cb: (payload: Uint8Array, at: Date, topic: string) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Drop the connection and connect again (the status page's "Reconnect" button). */
  reconnect(reason: string): void;
  /**
   * Identifiers that must never leave this machine in a shared sample (serial number,
   * account id, e-mail): the sample scrubber masks them (src/discovery/).
   */
  identifiers(): string[];
}

/** Message types in one payload, as the model census counts them. */
export interface DiscoveryCodec {
  /** One entry per message in the payload, or null if it is not a device message. */
  messages(payload: Uint8Array): { id: string; decoded: boolean }[] | null;
  /** Teach the scrubber identifiers the payload carries (serial numbers in headers or fields). */
  learnIdentifiers(scrubber: Scrubber, payload: Uint8Array): void;
  /** Byte keys the payload obfuscates parts of itself with: identifiers are masked under them too. */
  xorKeys(payload: Uint8Array): number[];
}

/** One input of the setup form; the page builds the form from these. */
export interface FormField {
  /** Key in the credentials object. */
  name: string;
  kind: 'text' | 'email' | 'password' | 'select';
  label: Texts;
  required?: boolean;
  maxLength?: number;
  /** HTML `pattern` (checked again on the server by the plugin's schema). */
  pattern?: string;
  autocomplete?: string;
  /** For `select`; an empty value leaves the field out. */
  options?: { value: string; label: string }[];
}

/** Every plugin's credentials name the device by its serial number. */
export interface DeviceCredentials {
  sn: string;
}

/** What a plugin gets to open a connection. */
export interface SourceContext {
  config: Config;
  logger: Logger;
  /** A decoder pack's adapter (src/packs/); the plugin's built-in code otherwise. */
  adapter?: Source['adapter'] | undefined;
}

/**
 * One kind of device (a brand and the way to reach it): everything the exporter needs to set
 * it up, connect and decode, behind one object. The rest of the exporter (setup page, decoder
 * packs, discovery, Supabase writer) only goes through this. A new brand or protocol is a new
 * plugin in PLUGINS (src/sources/index.ts), see docs/DEVICE_PLUGINS.md.
 */
export interface DevicePlugin<C extends DeviceCredentials = DeviceCredentials> {
  /** Stable id: SOURCE in .env, and stored with the encrypted credentials. */
  readonly id: string;
  /** Brand id: `devices.vendor`, decoder pack match, model census. */
  readonly vendor: string;
  /** Setup page: card title, form and texts. */
  readonly setup: {
    title: Texts;
    hint: Texts;
    privacy: Texts;
    fields: FormField[];
    /** The .env variables that set the credentials instead of the page. */
    envVars: string[];
  };
  /** Validates the setup form and the decrypted file. */
  readonly credentials: z.ZodType<C>;
  /** Credentials from .env, if all of them are set (they win over the setup page). */
  fromEnv(env: NodeJS.ProcessEnv): C | undefined;
  /** Checks the credentials with the device or its cloud before they are stored (throws if wrong). */
  verify(c: C, logger: Logger): Promise<void>;
  /** Model family code of this device, before it has connected. */
  productCode(c: C): string;
  open(c: C, ctx: SourceContext): Source;
  /** A readable line for errors that retrying cannot fix (rejected login), else undefined. */
  describeFatal?(err: unknown): string | undefined;
}

/** A plugin with its credential type erased, as the registry holds it. */
export type AnyDevicePlugin = DevicePlugin<DeviceCredentials>;

/** Puts a typed plugin into the registry. Safe: every call gets credentials its own schema parsed. */
export function definePlugin<C extends DeviceCredentials>(p: DevicePlugin<C>): AnyDevicePlugin {
  return p as unknown as AnyDevicePlugin;
}
