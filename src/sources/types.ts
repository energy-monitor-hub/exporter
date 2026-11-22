import type { DeviceAdapter } from '../model/types.js';

/**
 * A connection to one device: brings raw payloads in and decodes them with its adapter.
 * Everything vendor-specific (login, transport, protocol) lives behind this interface;
 * the exporter, outbox and Supabase writer only see the common model (src/model/types.ts).
 * New brands / protocols add a source here and an entry in createSource (issue #12).
 */
export interface Source {
  /** Serial number as the device reports it (unique per owner in public.devices). */
  readonly sn: string;
  readonly adapter: DeviceAdapter & { readonly gridPresent?: boolean | undefined };
  readonly isConnected: boolean;
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

/** Known sources (SOURCE in .env); createSource builds them. */
export const SOURCES = ['ecoflow-mqtt'] as const;
