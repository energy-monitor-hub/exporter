import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UpdaterService } from './service.js';

/** The updater's HTTP API: GET /status, POST /update {version}, POST /auto {enabled}. */

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  let text = '';
  for await (const chunk of req as AsyncIterable<Buffer>) {
    text += chunk.toString('utf8');
    if (text.length > 1024) throw new Error('request body too large');
  }
  const v: unknown = text ? JSON.parse(text) : {};
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

export async function handle(updater: UpdaterService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Only the exporter container may ask; nothing else on the network (or the host) can.
  const peer = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  if (!(await updater.exporterAddresses()).includes(peer)) {
    send(res, 403, { error: 'only the exporter container may call the updater' });
    return;
  }
  const path = new URL(req.url ?? '/', 'http://updater').pathname;
  if (req.method === 'GET' && path === '/status') {
    send(res, 200, await updater.status());
    return;
  }
  if (req.method === 'POST' && path === '/update') {
    const body = await readBody(req);
    try {
      if (typeof body.version !== 'string') throw new Error('version is required');
      updater.request(body.version);
    } catch (err) {
      send(res, 409, { error: (err as Error).message });
      return;
    }
    send(res, 202, { ok: true });
    return;
  }
  if (req.method === 'POST' && path === '/auto') {
    const body = await readBody(req);
    if (typeof body.enabled !== 'boolean') {
      send(res, 400, { error: 'enabled must be true or false' });
      return;
    }
    updater.setAuto(body.enabled);
    send(res, 200, { ok: true });
    return;
  }
  send(res, 404, { error: 'not found' });
}
