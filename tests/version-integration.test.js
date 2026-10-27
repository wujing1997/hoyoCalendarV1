'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('package metadata and installer artifact target version 3.0.12', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));

  assert.equal(pkg.version, '3.0.12');
  assert.equal(lock.version, '3.0.12');
  assert.equal(lock.packages[''].version, '3.0.12');
  // A stable product name keeps one HoYoCalendar.exe across upgrades.
  assert.equal(pkg.build.productName, 'HoYoCalendar');
  assert.equal(pkg.build.nsis.include, 'installer/installer.nsh');
  assert.equal(pkg.build.nsis.artifactName, 'HoYoCalendarV3.0.12-setup.exe');
});

test('window and about fallbacks display version 3.0.12', () => {
  const indexSource = read('index.html');
  const rendererSource = read('renderer.js');

  assert.match(indexSource, /<title>HoYoCalendar V3\.0\.12<\/title>/);
  assert.match(indexSource, /id="appVersion">V3\.0\.12</);
  assert.match(rendererSource, /version \|\| '3\.0\.12'/);
});

test('backend health fallback reports version 3.0.12', () => {
  const backendSource = read('backend/app.py');
  assert.match(backendSource, /HOYO_CALENDAR_VERSION', '3\.0\.12'/);
});

test('installer removes executables left by versioned builds', () => {
  const script = read('installer/installer.nsh');
  // Closing by image name would also match and kill the HoYoCalendarV*-setup.exe installer.
  assert.doesNotMatch(script, /taskkill[^\n]*HoYoCalendarV\*/);
  assert.match(script, /!macro customInit[\s\S]*ExecutablePath -like '\$INSTDIR\\HoYoCalendarV\*\.exe'/);
  assert.match(script, /IfFileExists "\$1" hoyo_uninstall_checked\s+DeleteRegValue HKCU "\$\{UNINSTALL_REGISTRY_KEY\}" "UninstallString"/);
  assert.doesNotMatch(script, /hoyo-install-debug/);
  assert.match(script, /Delete "\$INSTDIR\\HoYoCalendarV\*\.exe"/);
  assert.match(script, /Delete "\$INSTDIR\\Uninstall HoYoCalendarV\*\.exe"/);
  assert.doesNotMatch(script, /Delete "\$INSTDIR\\HoYoCalendar\.exe"/);
});
