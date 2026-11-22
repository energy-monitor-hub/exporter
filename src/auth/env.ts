export interface EcoflowEnv {
  username: string;
  password: string;
  deviceSn: string;
  apiHost?: string;
}

/** Read the EcoFlow account from env (`.env`). Throws with the names of what is missing. */
export function loadEcoflowEnv(env: NodeJS.ProcessEnv = process.env): EcoflowEnv {
  const username = env.ECOFLOW_USERNAME?.trim();
  const password = env.ECOFLOW_PASSWORD;
  const deviceSn = env.DEVICE_SN?.trim();
  const missing = [
    !username && 'ECOFLOW_USERNAME',
    !password && 'ECOFLOW_PASSWORD',
    !deviceSn && 'DEVICE_SN',
  ].filter(Boolean);
  if (!username || !password || !deviceSn) {
    throw new Error(`Missing in .env: ${missing.join(', ')}`);
  }
  const apiHost = env.ECOFLOW_API_HOST?.trim();
  return apiHost ? { username, password, deviceSn, apiHost } : { username, password, deviceSn };
}
