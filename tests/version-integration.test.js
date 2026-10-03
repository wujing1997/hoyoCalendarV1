'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('package metadata and installer artifact target version 3.0.8', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  assert.equal(pkg.version, '3.0.8');
  assert.equal(lock.version, '3.0.8');
  assert.equal(lock.packages[''].version, '3.0.8');
  assert.equal(pkg.build.productName, 'HoYoCalendarV3.0.8');
  assert.equal(pkg.build.nsis.artifactName, 'HoYoCalendarV3.0.8-setup.exe');
});

test('window and about fallbacks display version 3.0.8', () => {
  const indexSource = read('index.html');
  const rendererSource = read('renderer.js');

  assert.match(indexSource, /<title>HoYoCalendar V3\.0\.8<\/title>/);
  assert.match(indexSource, /id="appVersion">V3\.0\.8</);
  assert.match(rendererSource, /version \|\| '3\.0\.8'/);
});

test('backend health fallback reports version 3.0.8', () => {
  const backendSource = read('backend/app.py');
  assert.match(backendSource, /HOYO_CALENDAR_VERSION', '3\.0\.8'/);
});
