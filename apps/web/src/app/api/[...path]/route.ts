import type { NextRequest } from 'next/server';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Frontend transport only. NestJS owns authentication, authorization and domain routing.
async function forward(request: NextRequest) {
  const gateway = new URL(
    process.env.API_GATEWAY_URL ?? 'http://127.0.0.1:3000',
  );
  const target = new URL(
    request.nextUrl.pathname + request.nextUrl.search,
    gateway,
  );
  const headers: Record<string, string> = {};
  for (const name of [
    'authorization',
    'cookie',
    'content-type',
    'origin',
    'sec-fetch-site',
    'host',
  ]) {
    const value = request.headers.get(name);
    if (value) headers[name] = value;
  }
  try {
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? undefined
        : Buffer.from(await request.arrayBuffer());
    if (body) headers['content-length'] = String(body.byteLength);
    // Node fetch normalizes Host to the upstream destination. Native HTTP must
    // preserve the browser Host for the Gateway's existing same-origin check.
    return await new Promise<Response>((resolve, reject) => {
      const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const upstream = send(
        target,
        { method: request.method, headers },
        (response) => {
          const outgoing = new Headers({ 'Cache-Control': 'no-store' });
          for (const name of ['content-type', 'www-authenticate']) {
            const value = response.headers[name];
            if (typeof value === 'string') outgoing.set(name, value);
          }
          for (const cookie of response.headers['set-cookie'] ?? [])
            outgoing.append('set-cookie', cookie);
          const status = response.statusCode ?? 502;
          const noBody =
            request.method === 'HEAD' || [204, 304].includes(status);
          if (noBody) response.resume();
          resolve(
            new Response(
              noBody
                ? null
                : (Readable.toWeb(response) as ReadableStream<Uint8Array>),
              { status, headers: outgoing },
            ),
          );
        },
      );
      upstream.setTimeout(30000, () =>
        upstream.destroy(new Error('Gateway timeout')),
      );
      upstream.on('error', reject);
      upstream.end(body);
    });
  } catch {
    return Response.json(
      { message: 'Gateway unavailable. Please try again.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
export {
  forward as GET,
  forward as POST,
  forward as PATCH,
  forward as DELETE,
  forward as PUT,
  forward as HEAD,
  forward as OPTIONS,
};
