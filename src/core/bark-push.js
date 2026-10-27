'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

function validateEndpoint(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.hostname !== 'api.day.app' || url.port || url.username || url.password || url.search || url.hash || !/^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new Error();
    return url.href.replace(/\/$/, '');
  } catch { throw new Error('请填写有效的 https://api.day.app/推送密钥 地址'); }
}

function sendBark(config, reminder) {
  const endpoint = new URL(validateEndpoint(config.endpoint));
  const body = new URLSearchParams({
    title: `HoYoCalendar · ${reminder.title}`,
    body: `${reminder.date} ${reminder.time}\n日历：${reminder.calendar}\n日程已到时间。手机通知不会改变任务完成状态。`,
    group: 'HoYoCalendar', ttl: '600',
  }).toString();
  return new Promise((resolve, reject) => {
    const request = https.request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8', 'Content-Length': Buffer.byteLength(body) } }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        text += chunk;
        if (text.length > 65536) request.destroy(new Error('invalid_response'));
      });
      response.on('error', () => reject(new Error('手机推送响应中断')));
      response.on('end', () => {
        let data;
        try { data = JSON.parse(text); } catch { reject(new Error('手机推送服务响应异常')); return; }
        if (response.statusCode === 200 && Number(data.code) === 200) resolve();
        else {
          const error = new Error('手机推送失败，请检查推送地址和网络');
          error.permanent = [400, 401, 403, 404, 422].includes(response.statusCode) || [400, 401, 403, 404, 422].includes(Number(data.code));
          reject(error);
        }
      });
    });
    request.setTimeout(10000, () => request.destroy(new Error('timeout')));
    // Never propagate request errors containing a secret URL.
    request.on('error', () => reject(new Error('无法连接手机推送服务，将自动重试')));
    request.end(body);
  });
}

class BarkPush {
  constructor({ stateFile, getConfig, send = sendBark, now = () => Date.now(), onError = () => {} }) {
    Object.assign(this, { stateFile, getConfig, send, now, onError });
    try { this.records = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
    catch { this.records = {}; }
    if (!this.records || typeof this.records !== 'object' || Array.isArray(this.records)) this.records = {};
    this.candidates = new Map();
    this.running = null;
    this.disposed = false;
  }

  persist() {
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(`${this.stateFile}.tmp`, JSON.stringify(this.records), 'utf8');
    fs.renameSync(`${this.stateFile}.tmp`, this.stateFile);
  }

  tick(reminders) {
    this.candidates = new Map(reminders.map((item) => [item.key, item]));
    if (this.running) return this.running;
    this.running = this.flush().catch(() => this.onError(new Error('手机推送记录保存失败，请检查磁盘'))).finally(() => { this.running = null; });
    return this.running;
  }

  async flush() {
    for (const reminder of this.candidates.values()) {
      if (this.disposed) return;
      if (!this.candidates.has(reminder.key)) continue;
      const config = this.getConfig();
      if (!config?.enabled || !config.endpoint || !config.enabledAt) return;
      const scheduled = new Date(`${reminder.date}T${reminder.time}:00`).getTime();
      if (!Number.isFinite(scheduled) || scheduled < Number(config.enabledAt)) continue;
      const key = createHash('sha256').update(`${config.endpoint}\n${reminder.key}`).digest('hex');
      const record = this.records[key];
      if (record?.sent || record?.permanent || Number(record?.nextRetryAt || 0) > this.now()) continue;
      try {
        await this.send(config, reminder);
        this.records[key] = { sent: true, at: this.now() };
      } catch (error) {
        const attempts = Number(record?.attempts || 0) + 1;
        this.records[key] = { attempts, permanent: Boolean(error.permanent), nextRetryAt: this.now() + Math.min(300000, 5000 * 2 ** Math.min(attempts - 1, 6)), at: this.now() };
        this.onError(new Error(error.permanent ? '手机推送密钥可能无效，请检查设置' : '手机推送暂时失败，稍后自动重试'));
      }
      // Retain recent dedupe records only; the scheduler catches up today's tasks.
      for (const [id, entry] of Object.entries(this.records)) if (this.now() - Number(entry.at || 0) > 3 * 86400000) delete this.records[id];
      this.persist();
    }
  }

  dispose() { this.disposed = true; this.candidates.clear(); }
}

module.exports = { BarkPush, sendBark, validateEndpoint };
