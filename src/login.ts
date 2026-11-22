// Exporter login: `npm run login` (Docker: README, "Exporter login"). The exporter's local
// status page (http://127.0.0.1:9101/) can do the same from the browser.
//
// Registers this exporter as an OAuth client of the Supabase project (once), opens the
// authorization request and waits for the code: either the browser comes back to
// http://127.0.0.1:<OAUTH_CALLBACK_PORT>/callback (exporter on this computer), or the user
// pastes that address from the browser (exporter elsewhere, the page did not open).
// Tokens go to OAUTH_TOKEN_PATH; the running exporter picks them up by itself.
import 'dotenv/config';
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { loadConfig } from './config.js';
import { parseCallback } from './oauth/client.js';
import { beginLogin } from './oauth/flow.js';

const TIMEOUT_MS = 15 * 60_000;

async function main(): Promise<void> {
  const config = loadConfig();
  if (!config.supabaseUrl) throw new Error('SUPABASE_URL is not set in .env');
  const supabaseUrl = config.supabaseUrl;
  const redirectUri = `http://127.0.0.1:${config.oauthCallbackPort}/callback`;

  const login = await beginLogin({
    supabaseUrl,
    tokenPath: config.oauthTokenPath,
    clientName: config.oauthClientName,
    redirectUri,
  });
  if (login.registered) console.log(`Registered exporter "${config.oauthClientName}".`);

  console.log('\nOpen this in a browser, sign in to the dashboard and approve the request:\n');
  console.log(`  ${login.url}\n`);
  console.log('If the 127.0.0.1 page does not open afterwards (the exporter runs on another computer),');
  console.log('copy its address from the browser\'s address bar and paste it here. Quit: Ctrl+C or q.\n');

  const code = await waitForCode(config.oauthCallbackPort, login.state);
  await login.finish(code);
  console.log(`\nDone: token saved to ${config.oauthTokenPath}. The running exporter picks it up by itself.`);
  console.log('You can revoke access on the dashboard\'s Exporters page (/exporters).');
  process.exit(0);
}

function page(title: string, text: string): string {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${title}</title>
<body style="font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 16px"><h1 style="font-size:20px">${title}</h1><p>${text}</p></body>`;
}

/** Resolves with the authorization code from the loopback callback or from a pasted URL. */
function waitForCode(port: number, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
    const done = (fn: () => void) => {
      clearTimeout(timer);
      server.close();
      server.closeAllConnections();
      rl.close();
      fn();
    };
    const timer = setTimeout(() => done(() => reject(new Error('Timed out (15 min), run the login again'))), TIMEOUT_MS);

    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
      if (u.pathname !== '/callback') {
        res.writeHead(404).end();
        return;
      }
      const r = parseCallback(u.toString(), state);
      res.writeHead('code' in r ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
      res.end('code' in r ? page('Exporter connected', 'You can close this tab.') : page('Login failed', r.error));
      if ('code' in r) done(() => resolve(r.code));
      else console.error(`Error: ${r.error}`);
    });
    // 0.0.0.0: in Docker the port is published to the host's 127.0.0.1 only (deploy/docker-compose.yml).
    server.on('error', (err) => console.error(`Cannot listen on :${port} (${err.message}), paste the address by hand instead.`));
    server.listen(port, '0.0.0.0');

    const cancel = () => done(() => reject(new Error('Login cancelled')));
    // In Docker this runs as PID 1, which gets no default SIGINT handler: Ctrl+C would do nothing.
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);

    rl.on('line', (line) => {
      const input = line.trim();
      if (!input) return;
      if (['q', 'quit', 'exit'].includes(input.toLowerCase())) {
        cancel();
        return;
      }
      const r = parseCallback(input, state);
      if ('code' in r) done(() => resolve(r.code));
      else console.error(`Error: ${r.error}. Try again (or q to quit).`);
    });
  });
}

main().catch((err: unknown) => {
  console.error(`login: ${(err as Error).message}`);
  process.exit(1);
});
