import type { SupabaseClient } from '@supabase/supabase-js';
import { ensureDevice } from '../db/client.js';
import type { DeviceDescriptor } from '../model/types.js';
import type { Op } from './ops.js';

/** Where ops go. Throws if the batch was not stored; then the whole batch is retried later. */
export interface Sink {
  send(ops: readonly Op[]): Promise<void>;
}

/**
 * Supabase writer, as the signed-in user (RLS: own devices only). Samples are upserted with ignoreDuplicates on their primary
 * key, outages are upserted / updated by (device_id, started_at), so re-sending is harmless.
 */
export class SupabaseSink implements Sink {
  private readonly devices = new Map<string, string>();

  constructor(
    private readonly db: SupabaseClient,
    /** vendor / model of the device with this serial number (from its source's adapter). */
    private readonly describe: (sn: string) => DeviceDescriptor,
  ) {}

  async send(ops: readonly Op[]): Promise<void> {
    // Consecutive ops of the same sample kind go in one request; order is kept otherwise.
    let i = 0;
    while (i < ops.length) {
      const op = ops[i]!;
      if (op.kind === 'telemetry' || op.kind === 'pack') {
        let j = i;
        while (j < ops.length && ops[j]!.kind === op.kind && ops[j]!.sn === op.sn) j++;
        await this.sendSamples(op.kind, op.sn, ops.slice(i, j));
        i = j;
      } else if (op.kind === 'state') {
        await this.sendState(op);
        i++;
      } else {
        await this.sendOutage(op);
        i++;
      }
    }
  }

  private async deviceId(sn: string): Promise<string> {
    let id = this.devices.get(sn);
    if (!id) {
      id = await ensureDevice(this.db, sn, this.describe(sn));
      this.devices.set(sn, id);
    }
    return id;
  }

  private async sendSamples(kind: 'telemetry' | 'pack', sn: string, ops: readonly Op[]): Promise<void> {
    const device_id = await this.deviceId(sn);
    const rows = ops.map((o) => ({ device_id, ...(o as Extract<Op, { kind: typeof kind }>).row }));
    const table = kind === 'telemetry' ? 'telemetry_raw' : 'pack_raw';
    const onConflict = kind === 'telemetry' ? 'device_id,ts' : 'device_id,pack,ts';
    const { error } = await this.db.from(table).upsert(rows, { onConflict, ignoreDuplicates: true });
    if (error) throw new Error(`${table}: ${error.message}`);
  }

  private async sendState(op: Extract<Op, { kind: 'state' }>): Promise<void> {
    const device_id = await this.deviceId(op.sn);
    const { error } = await this.db
      .from('device_state')
      .upsert({ device_id, updated_at: op.updated_at, state: op.state }, { onConflict: 'device_id' });
    if (error) throw new Error(`device_state: ${error.message}`);
  }

  private async sendOutage(op: Extract<Op, { kind: 'outage_start' | 'outage_end' }>): Promise<void> {
    const device_id = await this.deviceId(op.sn);
    if (op.kind === 'outage_start') {
      const { error } = await this.db
        .from('outages')
        .upsert({ device_id, started_at: op.started_at, soc_start_pct: op.soc_start_pct }, { onConflict: 'device_id,started_at', ignoreDuplicates: true });
      if (error) throw new Error(`outages (start): ${error.message}`);
      return;
    }
    // Insert-or-update, so an end whose start never reached the DB still lands as a full row.
    const { error } = await this.db.from('outages').upsert(
      {
        device_id,
        started_at: op.started_at,
        ended_at: op.ended_at,
        soc_end_pct: op.soc_end_pct,
        energy_out_wh: op.energy_out_wh,
      },
      { onConflict: 'device_id,started_at' },
    );
    if (error) throw new Error(`outages (end): ${error.message}`);
  }
}
