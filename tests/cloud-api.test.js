'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { CloudApi, CloudApiError, parseBaseUrl, migrateLegacyServerUrl, DEFAULT_SERVER_URL, LEGACY_DEFAULT_SERVER_URL } = require('../src/core/cloud-api');

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port });
    });
  });
}

function jsonHandler(status, body) {
  return (_req, res) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
}

test('concurrent expired access tokens share one proactive refresh', async () => {
  let refreshes = 0;
  const { server, port } = await startServer((req, res) => {
    if (req.url === '/api/v1/auth/refresh') {
      refreshes++;
      setTimeout(() => jsonHandler(200, { access_token: 'new', refresh_token: 'rotated', expires_in: 900 })(req, res), 20);
    } else {
      assert.equal(req.headers.authorization, 'Bearer new');
      jsonHandler(200, { email: 'a@b.c' })(req, res);
    }
  });
  try {
    const api = new CloudApi({ baseUrl: `http://127.0.0.1:${port}` });
    api.setTokens({ access_token: 'old', refresh_token: 'old-refresh', expires_in: 1 });
    await Promise.all([api.me(), api.me(), api.me()]);
    assert.equal(refreshes, 1);
    assert.equal(api.refreshToken, 'rotated');
  } finally { server.close(); }
});

test('rejected renewal notifies expiry, while network failure retains credentials', async () => {
  let expired = 0;
  const api = new CloudApi({ onSessionExpired: () => { expired++; } });
  api.setTokens({ access_token: 'old', refresh_token: 'rt', expires_in: 1 });
  api.call = async () => { throw new Error('offline'); };
  await assert.rejects(api.me(), /网络暂不可用/);
  assert.equal(expired, 0);
  assert.equal(api.refreshToken, 'rt');
  api.call = async () => ({ ok: false, status: 401, data: { detail: 'expired' } });
  await assert.rejects(api.me(), /登录已失效/);
  assert.equal(expired, 1);
  assert.equal(api.refreshToken, null);
});

test('parseBaseUrl normalizes host and scheme', () => {
  assert.deepEqual(parseBaseUrl('127.0.0.1:8000'), { origin: 'http://127.0.0.1:8000', isHttps: false });
  assert.deepEqual(parseBaseUrl('https://example.com'), { origin: 'https://example.com', isHttps: true });
  assert.equal(parseBaseUrl('').origin, DEFAULT_SERVER_URL);
});

test('production default server url is the public HTTPS endpoint', () => {
  assert.equal(DEFAULT_SERVER_URL, 'https://api.jianghaihaoyang.online');
  assert.equal(parseBaseUrl(DEFAULT_SERVER_URL).isHttps, true);
  assert.notEqual(DEFAULT_SERVER_URL, LEGACY_DEFAULT_SERVER_URL);
});

test('migrateLegacyServerUrl upgrades only the legacy default', () => {
  assert.equal(migrateLegacyServerUrl('http://127.0.0.1:8000'), DEFAULT_SERVER_URL);
  assert.equal(migrateLegacyServerUrl('127.0.0.1:8000'), DEFAULT_SERVER_URL);
  assert.equal(migrateLegacyServerUrl('http://127.0.0.1:8000/'), DEFAULT_SERVER_URL);
});

test('migrateLegacyServerUrl preserves custom and empty values', () => {
  assert.equal(migrateLegacyServerUrl('https://custom.example.com'), 'https://custom.example.com');
  assert.equal(migrateLegacyServerUrl('http://127.0.0.1:9000'), 'http://127.0.0.1:9000');
  assert.equal(migrateLegacyServerUrl(''), '');
  assert.equal(migrateLegacyServerUrl(null), null);
  assert.equal(migrateLegacyServerUrl(undefined), undefined);
  assert.equal(migrateLegacyServerUrl(DEFAULT_SERVER_URL), DEFAULT_SERVER_URL);
});

test('CloudApi defaults to the public HTTPS endpoint', () => {
  const api = new CloudApi();
  assert.equal(api.baseUrl, DEFAULT_SERVER_URL);
});

test('login posts to /api/v1/auth/login and stores tokens', async () => {
  const { server, port } = await startServer((req, res) => {
    assert.equal(req.url, '/api/v1/auth/login');
    assert.equal(req.method, 'POST');
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.email, 'a@b.c');
      assert.equal(body.password, 'secret');
      assert.equal(body.device_name, '我的电脑');
      jsonHandler(200, { access_token: 'at', refresh_token: 'rt', expires_in: 900, device_id: 'd1' })(req, res);
    });
  });
  try {
    const api = new CloudApi({ baseUrl: `http://127.0.0.1:${port}` });
    const tokens = await api.login({ email: 'a@b.c', password: 'secret', deviceName: '我的电脑' });
    assert.equal(tokens.access_token, 'at');
    assert.equal(api.bearerToken, 'at');
    assert.equal(api.refreshToken, 'rt');
  } finally {
    server.close();
  }
});

test('register sends invite code and surfaces the server message on 400', async () => {
  const { server, port } = await startServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.invite_code, 'CODE-123');
      jsonHandler(400, { detail: '无效的邀请码' })(req, res);
    });
  });
  try {
    const api = new CloudApi({ baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(
      () => api.register({ inviteCode: 'CODE-123', email: 'a@b.c', password: '12345678', deviceName: 'd' }),
      (error) => error instanceof CloudApiError && error.status === 400 && error.message === '无效的邀请码',
    );
  } finally {
    server.close();
  }
});

test('authenticated calls attach the bearer header', async () => {
  const { server, port } = await startServer((req, res) => {
    assert.equal(req.headers.authorization, 'Bearer at-123');
    jsonHandler(200, { id: 'u1', email: 'a@b.c', status: 'active', created_at: '2026-01-01T00:00:00Z' })(req, res);
  });
  try {
    const api = new CloudApi({ baseUrl: `http://127.0.0.1:${port}` });
    api.bearerToken = 'at-123';
    const me = await api.me();
    assert.equal(me.email, 'a@b.c');
  } finally {
    server.close();
  }
});

test('401 on authenticated calls triggers refresh once then retries', async () => {
  let calls = 0;
  const persistedTokens = [];
  const { server, port } = await startServer((req, res) => {
    calls += 1;
    if (req.url === '/api/v1/auth/refresh') {
      jsonHandler(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 900, device_id: 'd1' })(req, res);
      return;
    }
    if (calls === 1) {
      jsonHandler(401, { detail: 'expired' })(req, res);
      return;
    }
    assert.equal(req.headers.authorization, 'Bearer at-new');
    jsonHandler(200, { id: 'u1', email: 'a@b.c', status: 'active', created_at: '2026-01-01T00:00:00Z' })(req, res);
  });
  try {
    const api = new CloudApi({
      baseUrl: `http://127.0.0.1:${port}`,
      onRefreshToken: async (token) => persistedTokens.push(token),
    });
    api.bearerToken = 'at-old';
    api.refreshToken = 'rt-old';
    const me = await api.me();
    assert.equal(me.email, 'a@b.c');
    assert.equal(api.bearerToken, 'at-new');
    assert.deepEqual(persistedTokens, ['rt-new']);
    assert.equal(calls, 3);
  } finally {
    server.close();
  }
});

test('pull serializes cursor and limit query params', async () => {
  const { server, port } = await startServer((req, res) => {
    assert.equal(req.url, '/api/v1/sync/pull?cursor=42&limit=500');
    jsonHandler(200, { cursor: 42, hasMore: false, reconcileRequired: false, events: [] })(req, res);
  });
  try {
    const api = new CloudApi({ baseUrl: `http://127.0.0.1:${port}` });
    api.bearerToken = 'at';
    const result = await api.pull(42, 500);
    assert.equal(result.cursor, 42);
  } finally {
    server.close();
  }
});

test('push posts changes and maps conflict status without throwing', async () => {
  const { server, port } = await startServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.changes[0].eventId, 'e1');
      assert.equal(body.changes[0].op, 'upsert');
      jsonHandler(200, {
        results: [{ eventId: 'e1', status: 'conflict', version: 3, serverVersion: 3, serverData: { event: '云端' }, message: '版本冲突' }],
        cursor: 9,
      })(req, res);
    });
  });
  try {
    const api = new CloudApi({ baseUrl: `http://127.0.0.1:${port}` });
    api.bearerToken = 'at';
    const result = await api.push([{ eventId: 'e1', version: 2, baseVersion: 1, operationId: 'op1', op: 'upsert', data: { event: '本机' } }]);
    assert.equal(result.results[0].status, 'conflict');
  } finally {
    server.close();
  }
});

test('agent plan error carries the readable message and code', async () => {
  const { server, port } = await startServer(jsonHandler(503, { detail: 'AI 未配置或已禁用' }));
  try {
    const api = new CloudApi({ baseUrl: `http://127.0.0.1:${port}` });
    api.bearerToken = 'at';
    await assert.rejects(
      () => api.agentPlan({ message: 'hi' }),
      (error) => error instanceof CloudApiError && error.status === 503 && error.message === 'AI 未配置或已禁用',
    );
  } finally {
    server.close();
  }
});

test('agent plan serializes session id and action receipts', async () => {
  const { server, port } = await startServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw);
      assert.equal(body.session_id, 'session-stable');
      assert.equal(body.continue_planning, true);
      assert.deepEqual(body.receipts, [{
        plan_id: '11111111-1111-4111-8111-111111111111',
        draft_id: 'draft-1', status: 'approved', event_id: 'event-1',
      }]);
      jsonHandler(200, {
        plan_id: '22222222-2222-4222-8222-222222222222',
        message: 'ok', actions: [], usage: {}, budget: {},
      })(req, res);
    });
  });
  try {
    const api = new CloudApi({ baseUrl: `http://127.0.0.1:${port}` });
    api.bearerToken = 'at';
    const result = await api.agentPlan({
      message: '继续', sessionId: 'session-stable', snapshot: [],
      continuePlanning: true,
      receipts: [{
        plan_id: '11111111-1111-4111-8111-111111111111',
        draft_id: 'draft-1', status: 'approved', event_id: 'event-1',
      }],
    });
    assert.equal(result.message, 'ok');
  } finally {
    server.close();
  }
});

test('network errors are reported gracefully by health()', async () => {
  const api = new CloudApi({ baseUrl: 'http://127.0.0.1:1' });
  const result = await api.health();
  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
});

test('https requests go through the https transport on port 443', async () => {
  const https = require('node:https');
  const fs = require('node:fs');
  const path = require('node:path');
  const key = fs.readFileSync(path.join(__dirname, 'fixtures', 'https-key.pem'));
  const cert = fs.readFileSync(path.join(__dirname, 'fixtures', 'https-cert.pem'));
  const server = https.createServer({ key, cert }, (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const { request } = require('../src/core/cloud-api');
    const result = await request(`https://127.0.0.1:${port}/healthz`, 'GET', null, {
      timeoutMs: 5000,
      rejectUnauthorized: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.ok, true);
  } finally {
    server.close();
  }
});

test('authenticated calls without a bearer token are blocked client-side', async () => {
  const api = new CloudApi({ baseUrl: 'http://127.0.0.1:1' });
  await assert.rejects(
    () => api.me(),
    (error) => error instanceof CloudApiError && error.status === 401 && error.code === 'missing_auth',
  );
});

test('refreshSession reports server-rejected refresh as invalid', async () => {
  const { server, port } = await startServer((_req, res) => {
    jsonHandler(401, { detail: 'refresh token expired' })(_req, res);
  });
  try {
    const api = new CloudApi({ baseUrl: `http://127.0.0.1:${port}` });
    api.refreshToken = 'rt-dead';
    const result = await api.refreshSession();
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.equal(api.bearerToken, null);
  } finally {
    server.close();
  }
});

test('refreshSession reports network failure as transient, not invalid', async () => {
  const api = new CloudApi({ baseUrl: 'http://127.0.0.1:1' });
  api.refreshToken = 'rt-kept';
  const result = await api.refreshSession();
  assert.equal(result.ok, false);
  assert.equal(result.invalid, false);
  assert.ok(result.error);
});

test('refreshSession without any refresh token reports no_token', async () => {
  const api = new CloudApi({ baseUrl: 'http://127.0.0.1:1' });
  const result = await api.refreshSession();
  assert.equal(result.ok, false);
  assert.equal(result.invalid, false);
  assert.equal(result.reason, 'no_token');
});

test('successful refreshSession exchanges tokens and reports ok', async () => {
  const persistedTokens = [];
  const { server, port } = await startServer((_req, res) => {
    jsonHandler(200, { access_token: 'at-new', refresh_token: 'rt-new', expires_in: 900, device_id: 'd1' })(_req, res);
  });
  try {
    const api = new CloudApi({
      baseUrl: `http://127.0.0.1:${port}`,
      onRefreshToken: async (token) => persistedTokens.push(token),
    });
    api.refreshToken = 'rt-old';
    const result = await api.refreshSession();
    assert.equal(result.ok, true);
    assert.equal(result.invalid, false);
    assert.equal(api.bearerToken, 'at-new');
    assert.equal(api.refreshToken, 'rt-new');
    assert.deepEqual(persistedTokens, ['rt-new']);
  } finally {
    server.close();
  }
});
