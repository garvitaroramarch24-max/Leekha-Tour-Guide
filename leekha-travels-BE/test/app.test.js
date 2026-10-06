import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createApp } from '../src/app.js';

function createMockSupabase({ packages = [], isAdmin = true } = {}) {
  const rows = [...packages];
  let nextId = rows.length + 1;

  const client = {
    auth: {
      getUser: async (token) => token === 'valid-token'
        ? { data: { user: { id: 'user-1' } }, error: null }
        : { data: { user: null }, error: new Error('invalid token') },
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        remove: async () => ({ error: null }),
        getPublicUrl: (imagePath) => ({ data: { publicUrl: `https://example.supabase.co/storage/${imagePath}` } }),
      }),
    },
    from(table) {
      let filters = {};
      let insertValue;
      let operation = 'select';
      const builder = {
        select() { return builder; },
        order() { return builder; },
        eq(column, value) { filters[column] = value; return builder; },
        maybeSingle() {
          if (table === 'admin_users') return Promise.resolve({ data: isAdmin ? { user_id: 'user-1' } : null, error: null });
          return Promise.resolve({ data: rows.find((row) => row.id === filters.id) ?? null, error: null });
        },
        insert(value) { insertValue = value; operation = 'insert'; return builder; },
        single() {
          const row = { id: nextId++, rating: 4.5, reviews: 0, ...insertValue };
          rows.push(row);
          return Promise.resolve({ data: row, error: null });
        },
        delete() { operation = 'delete'; return builder; },
        then(resolve, reject) {
          if (table === 'packages' && operation === 'delete') {
            const index = rows.findIndex((row) => row.id === filters.id);
            if (index !== -1) rows.splice(index, 1);
            return Promise.resolve({ data: null, error: null }).then(resolve, reject);
          }
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
        },
      };
      return builder;
    },
  };
  return client;
}

async function withServer(app, run) {
  const server = createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

test('health and public package list use the backend service', async () => {
  const app = createApp({
    adminClient: createMockSupabase({ packages: [{ id: 1, name: 'Shimla trip', destination: 'Shimla' }] }),
    authClientFactory: () => ({ auth: { signInWithPassword: async () => ({ data: {}, error: null }) } }),
    env: { FRONTEND_ORIGIN: 'http://localhost:5173' },
  });

  await withServer(app, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.deepEqual(await health.json(), { status: 'ok' });
    const response = await fetch(`${baseUrl}/api/packages`);
    assert.equal(response.status, 200);
    assert.equal((await response.json())[0].destination, 'Shimla');
  });
});

test('admin routes reject missing and invalid bearer tokens', async () => {
  const app = createApp({
    adminClient: createMockSupabase(),
    authClientFactory: () => ({ auth: { signInWithPassword: async () => ({ data: {}, error: null }) } }),
    env: { FRONTEND_ORIGIN: 'http://localhost:5173' },
  });

  await withServer(app, async (baseUrl) => {
    const missing = await fetch(`${baseUrl}/api/auth/session`);
    assert.equal(missing.status, 401);
    const invalid = await fetch(`${baseUrl}/api/auth/session`, { headers: { Authorization: 'Bearer wrong-token' } });
    assert.equal(invalid.status, 401);
  });
});

test('allowed admins can sign in, publish a photo package, and delete it', async () => {
  const adminClient = createMockSupabase();
  const authClientFactory = () => ({
    auth: {
      signInWithPassword: async ({ email, password }) =>
        email === 'admin@example.com' && password === 'secret'
          ? { data: { user: { id: 'user-1' }, session: { access_token: 'valid-token', expires_at: 2000000000 } }, error: null }
          : { data: {}, error: new Error('invalid credentials') },
    },
  });
  const app = createApp({ adminClient, authClientFactory, env: { FRONTEND_ORIGIN: 'http://localhost:5173' } });

  await withServer(app, async (baseUrl) => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'secret' }),
    });
    assert.equal(login.status, 200);
    const { accessToken } = await login.json();

    const packageForm = new FormData();
    packageForm.append('name', 'Mussoorie Weekend');
    packageForm.append('destination', 'Mussoorie');
    packageForm.append('budget', '12000');
    packageForm.append('days', '3 Days / 2 Nights');
    packageForm.append('type', 'Hill Station');
    packageForm.append('highlights', 'Mall Road and Kempty Falls');
    packageForm.append(
      'photo',
      new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/qioAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }),
      'mussoorie.png'
    );

    const created = await fetch(`${baseUrl}/api/packages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: packageForm,
    });
    assert.equal(created.status, 201);
    const travelPackage = await created.json();
    assert.equal(travelPackage.destination, 'Mussoorie');
    assert.match(travelPackage.img, /^https:\/\/example\.supabase\.co\/storage\//);

    const removed = await fetch(`${baseUrl}/api/packages/${travelPackage.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    assert.equal(removed.status, 204);
  });
});