'use strict';

const http = require('http');
const https = require('https');

const DEFAULT_SERVER_URL = 'https://api.jianghaihaoyang.online';
const LEGACY_DEFAULT_SERVER_URL = 'http://127.0.0.1:8000';

class CloudApiError extends Error {
  constructor(message, status, detail, code) {
    super(message);
    this.name = 'CloudApiError';
    this.status = status;
    this.detail = detail;
    this.code = code;
  }
}

function parseBaseUrl(rawUrl) {
  let url = String(rawUrl || '').trim();
  if (!url) url = DEFAULT_SERVER_URL;
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  const parsed = new URL(url);
  return { origin: parsed.origin, isHttps: parsed.protocol === 'https:' };
}

function migrateLegacyServerUrl(savedValue) {
  const trimmed = String(savedValue || '').trim();
  if (!trimmed) return savedValue;
  const normalized = parseBaseUrl(trimmed).origin;
  return normalized === LEGACY_DEFAULT_SERVER_URL ? DEFAULT_SERVER_URL : savedValue;
}

function request(url, method = 'GET', body = null, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 45000;
  const headers = { ...(options.headers || {}) };
  let payload = null;
  if (body !== null && body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const requestOptions = {
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: `${target.pathname}${target.search}`,
      method,
      headers,
      timeout: timeoutMs,
    };
    if (isHttps && options.rejectUnauthorized !== undefined) {
      requestOptions.rejectUnauthorized = options.rejectUnauthorized;
    }
    const req = transport.request(requestOptions, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        raw += chunk;
      });
      response.on('end', () => {
        let data = raw;
        try {
          data = raw ? JSON.parse(raw) : {};
        } catch (_) {
          data = raw;
        }
        resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data });
      });
    });
    req.on('error', (error) => reject(error));
    req.on('timeout', () => {
      req.destroy(new Error('request_timeout'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function messageFromResponse(response, fallback) {
  const data = response.data || {};
  if (typeof data === 'string') return data;
  if (typeof data.detail === 'string') return data.detail;
  if (Array.isArray(data.detail) && data.detail[0]?.msg) return data.detail[0].msg;
  if (data.message) return data.message;
  return fallback;
}

function requireOk(response, fallback) {
  if (!response.ok) {
    throw new CloudApiError(messageFromResponse(response, fallback), response.status, response.data);
  }
  return response;
}

class CloudApi {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || DEFAULT_SERVER_URL;
    this.timeoutMs = options.timeoutMs || 45000;
    this.request = options.request || request;
    this.onRefreshToken = options.onRefreshToken || null;
    this.onSessionExpired = options.onSessionExpired || null;
    this.refreshPromise = null;
    this.bearerToken = null;
    this.refreshToken = null;
    this.deviceId = null;
    this.accessTokenExpiresAt = 0;
  }

  setTokens(tokens) {
    if (tokens) {
      this.bearerToken = tokens.access_token || null;
      this.refreshToken = tokens.refresh_token || null;
      this.deviceId = tokens.device_id || null;
      this.accessTokenExpiresAt = tokens.expires_in
        ? Date.now() + Number(tokens.expires_in) * 1000 - 30000
        : 0;
    } else {
      this.bearerToken = null;
      this.refreshToken = null;
      this.deviceId = null;
      this.accessTokenExpiresAt = 0;
    }
  }

  getAuthenticated() {
    return Boolean(this.bearerToken);
  }

  tokenExpired() {
    return this.accessTokenExpiresAt > 0 && Date.now() >= this.accessTokenExpiresAt;
  }

  async call(path, options = {}) {
    if (options.auth !== false && !this.bearerToken) {
      throw new CloudApiError('未登录或登录已失效', 401, null, 'missing_auth');
    }
    const headers = {};
    if (options.auth !== false) {
      const token = options.bearerToken || this.bearerToken;
      if (token) headers.authorization = `Bearer ${token}`;
    }
    if (options.headers) Object.assign(headers, options.headers);
    const response = await this.request(`${this.baseUrl}${path}`, options.method || 'GET', options.body, {
      headers,
      timeoutMs: options.timeoutMs || this.timeoutMs,
    });
    return response;
  }

  async authCall(path, options = {}) {
    if (this.tokenExpired() && this.refreshToken) {
      const refreshed = await this.refreshSession();
      if (!refreshed.ok) {
        if (!refreshed.invalid) throw new CloudApiError('网络暂不可用，登录状态已保留', 0, null, 'refresh_unavailable');
        throw new CloudApiError('登录已失效，请重新登录', 401, null, 'session_expired');
      }
    }
    let response = await this.call(path, options);
    if (response.status === 401 && options.retried !== true && this.refreshToken) {
      const refreshed = await this.refreshSession();
      if (refreshed && refreshed.ok) {
        response = await this.call(path, { ...options, retried: true });
      } else if (!refreshed.invalid) {
        throw new CloudApiError('网络暂不可用，登录状态已保留', 0, null, 'refresh_unavailable');
      }
    }
    if (response.status === 401 && this.bearerToken) {
      this.setTokens(null);
      if (this.onSessionExpired) await this.onSessionExpired();
    }
    return response;
  }

  refreshSession() {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.performRefresh().finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  async performRefresh() {
    if (!this.refreshToken) return { ok: false, invalid: false, reason: 'no_token' };
    try {
      const response = await this.call('/api/v1/auth/refresh', {
        method: 'POST',
        body: { refresh_token: this.refreshToken },
        auth: false,
        timeoutMs: 15000,
      });
      if (response.ok) {
        this.setTokens(response.data);
        if (this.onRefreshToken && this.refreshToken) {
          await this.onRefreshToken(this.refreshToken);
        }
        return { ok: true, invalid: false };
      }
      const invalid = response.status === 400 || response.status === 401 || response.status === 403;
      if (invalid) {
        this.setTokens(null);
        if (this.onSessionExpired) await this.onSessionExpired();
      }
      return {
        ok: false,
        invalid,
        status: response.status,
        message: messageFromResponse(response, '刷新登录态失败'),
      };
    } catch (error) {
      return { ok: false, invalid: false, error };
    }
  }

  async register({ inviteCode, email, password, deviceName }) {
    const response = await this.call('/api/v1/auth/register', {
      method: 'POST',
      body: {
        invite_code: inviteCode,
        email,
        password,
        device_name: deviceName,
      },
      auth: false,
      timeoutMs: 20000,
    });
    requireOk(response, '注册失败');
    this.setTokens(response.data);
    return response.data;
  }

  async login({ email, password, deviceName }) {
    const response = await this.call('/api/v1/auth/login', {
      method: 'POST',
      body: { email, password, device_name: deviceName },
      auth: false,
      timeoutMs: 20000,
    });
    requireOk(response, '登录失败');
    this.setTokens(response.data);
    return response.data;
  }

  async logout() {
    try {
      await this.call('/api/v1/auth/logout', { method: 'POST', body: {}, timeoutMs: 10000 });
    } catch (_) {
      // 本地退出不受服务器状态影响
    }
    const hadSession = Boolean(this.bearerToken || this.refreshToken);
    this.setTokens(null);
    return hadSession;
  }

  async me() {
    const response = await this.authCall('/api/v1/me');
    requireOk(response, '获取账号信息失败');
    return response.data;
  }

  async sessions() {
    const response = await this.authCall('/api/v1/sessions');
    requireOk(response, '获取设备列表失败');
    return response.data;
  }

  async revokeSession(sessionId) {
    const response = await this.authCall(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
    requireOk(response, '撤销设备失败');
    return true;
  }

  async push(changes) {
    const response = await this.authCall('/api/v1/sync/push', {
      method: 'POST',
      body: { changes },
      timeoutMs: 60000,
    });
    requireOk(response, '推送失败');
    return response.data;
  }

  async pull(cursor, limit = 500) {
    const query = new URLSearchParams();
    if (Number.isFinite(Number(cursor))) query.set('cursor', String(cursor));
    query.set('limit', String(limit));
    const response = await this.authCall(`/api/v1/sync/pull?${query.toString()}`);
    requireOk(response, '拉取失败');
    return response.data;
  }

  async snapshot() {
    const response = await this.authCall('/api/v1/sync/snapshot');
    requireOk(response, '同步校验失败');
    return response.data;
  }

  async trash() {
    const response = await this.authCall('/api/v1/sync/trash');
    requireOk(response, '获取回收站失败');
    return response.data;
  }

  async restore(eventId) {
    const response = await this.authCall('/api/v1/sync/restore', {
      method: 'POST',
      body: { eventId },
    });
    requireOk(response, '恢复失败');
    return response.data;
  }

  async agentPlan({ message, date, sessionId, snapshot, receipts, continuePlanning }) {
    const body = {
      message,
      date: date || null,
      session_id: sessionId || null,
      snapshot: snapshot || [],
      receipts: receipts || [],
      continue_planning: continuePlanning === true,
    };
    const response = await this.authCall('/api/v1/agent/plan', {
      method: 'POST',
      body,
      timeoutMs: 90000,
    });
    if (!response.ok) {
      const message = messageFromResponse(response, '日程助手暂不可用');
      throw new CloudApiError(message, response.status, response.data, 'agent_error');
    }
    return response.data;
  }

  async health() {
    try {
      const response = await this.call('/healthz', { auth: false, timeoutMs: 5000 });
      return { ok: response.ok, status: response.status };
    } catch (_) {
      return { ok: false, status: 0 };
    }
  }
}

module.exports = { CloudApi, CloudApiError, request, parseBaseUrl, migrateLegacyServerUrl, DEFAULT_SERVER_URL, LEGACY_DEFAULT_SERVER_URL };
