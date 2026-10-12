'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { RememberedLogin } = require('../src/core/remembered-login');

test('remembered password is encrypted, server-scoped and removable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoyo-password-'));
  const file = path.join(dir, 'password.bin');
  const key = crypto.randomBytes(32);
  const encryption = {
    isEncryptionAvailable: () => true,
    encryptString: (text) => {
      const iv = crypto.randomBytes(16);
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
      return Buffer.concat([iv, cipher.update(text, 'utf8'), cipher.final()]);
    },
    decryptString: (data) => {
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, data.subarray(0, 16));
      return Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]).toString('utf8');
    },
  };
  try {
    const store = new RememberedLogin(file, encryption);
    assert.equal(store.get('https://example.com'), null);
    store.save('https://example.com/', 'a@b.c', 'secret-password');
    assert.equal(fs.readFileSync(file).includes(Buffer.from('secret-password')), false);
    assert.deepEqual(store.get('https://example.com'), { email: 'a@b.c', password: 'secret-password' });
    assert.equal(store.get('https://other.example.com'), null);
    const unavailable = new RememberedLogin(file, { isEncryptionAvailable: () => false });
    assert.equal(unavailable.get('https://example.com'), null);
    assert.throws(() => unavailable.save('https://example.com', 'a@b.c', 'secret'), /加密不可用/);
    store.clear();
    store.clear();
    assert.equal(fs.existsSync(file), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
