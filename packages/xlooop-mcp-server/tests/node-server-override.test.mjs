import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { getRequestListener } from '@hono/node-server';

test('patched node-server override preserves the MCP Web Request adapter', async (t) => {
  const listener = getRequestListener((request) => {
    const url = new URL(request.url);
    return new Response(JSON.stringify({ method: request.method, pathname: url.pathname }), {
      headers: { 'content-type': 'application/json' },
      status: 200,
    });
  });
  const server = createServer(listener);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));

  const address = server.address();
  assert.notEqual(address, null);
  assert.equal(typeof address, 'object');

  const response = await fetch(`http://127.0.0.1:${address.port}/mcp-health`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    method: 'GET',
    pathname: '/mcp-health',
  });
});
