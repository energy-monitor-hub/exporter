import { ecoflowPlugin } from './ecoflow.js';
import type { AnyDevicePlugin } from './types.js';

export type { AnyDevicePlugin, DeviceCredentials, DevicePlugin, DiscoveryCodec, FormField, Source, SourceContext, Texts } from './types.js';

/**
 * Every kind of device this exporter can read. A new brand or protocol adds its plugin here
 * (docs/DEVICE_PLUGINS.md); nothing else in the exporter names a vendor.
 */
export const PLUGINS: readonly AnyDevicePlugin[] = [ecoflowPlugin];

/** Known plugin ids (SOURCE in .env). */
export const SOURCES = PLUGINS.map((p) => p.id);

export function pluginById(id: string): AnyDevicePlugin | undefined {
  return PLUGINS.find((p) => p.id === id);
}
