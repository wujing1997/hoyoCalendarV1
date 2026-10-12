'use strict';

const fs = require('fs');
const { parseBaseUrl } = require('./cloud-api');

class RememberedLogin {
  constructor(file, encryption) {
    this.file = file;
    this.encryption = encryption;
  }

  get(serverUrl) {
    try {
      if (!this.encryption.isEncryptionAvailable() || !fs.existsSync(this.file)) return null;
      const entry = JSON.parse(this.encryption.decryptString(fs.readFileSync(this.file)));
      return entry.serverUrl === parseBaseUrl(serverUrl).origin
        ? { email: entry.email, password: entry.password } : null;
    } catch (_) { return null; }
  }

  save(serverUrl, email, password) {
    if (!this.encryption.isEncryptionAvailable()) throw new Error('系统加密不可用，无法记住密码');
    const payload = this.encryption.encryptString(JSON.stringify({
      serverUrl: parseBaseUrl(serverUrl).origin, email: String(email), password: String(password),
    }));
    const temporary = `${this.file}.tmp`;
    fs.writeFileSync(temporary, payload, { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }

  clear() {
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
  }
}

module.exports = { RememberedLogin };
