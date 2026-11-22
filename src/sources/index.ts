import type { Config } from '../config.js';
import type { Logger } from '../mqtt/client.js';
import type { EcoflowCredentials } from '../secrets/credentials.js';
import { EcoflowSource } from './ecoflow.js';
import type { Source } from './types.js';

export { SOURCES, type Source } from './types.js';

/** EcoFlow credentials from .env, if all of them are set (they win over the setup page). */
export function credentialsFromEnv(config: Config): EcoflowCredentials | undefined {
  if (!config.ecoflowUsername || !config.ecoflowPassword || !config.deviceSn) return undefined;
  return {
    username: config.ecoflowUsername,
    password: config.ecoflowPassword,
    sn: config.deviceSn,
    ...(config.ecoflowApiHost ? { apiHost: config.ecoflowApiHost } : {}),
  };
}

/** Builds the source named by config.source for these credentials (.env or the setup page). */
export function createSource(config: Config, creds: EcoflowCredentials, logger: Logger, adapter?: Source['adapter']): Source {
  switch (config.source) {
    case 'ecoflow-mqtt': {
      return new EcoflowSource({
        username: creds.username,
        password: creds.password,
        sn: creds.sn,
        ...(creds.apiHost ? { apiHost: creds.apiHost } : {}),
        requestQuotasEveryMs: config.quotaEveryS * 1000,
        silenceTimeoutMs: config.mqttSilenceTimeoutS * 1000,
        logger,
        ...(adapter ? { adapter } : {}),
      });
    }
  }
}
