// The other tests replace src/utils/email.js with a fake, so they cannot notice when the REAL module stops
// exporting something (as happened when a merge left three module.exports lines and the last one won).
// This checks the real module against every name the app imports from it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return jsFiles(full);
    return entry.name.endsWith('.js') ? [full] : [];
  });
}

test('the real email module exports every function the app imports from it', () => {
  const email = require(path.join(root, 'src/utils/email.js'));
  const pattern = /const\s*\{([^}]+)\}\s*=\s*require\(['"][./]+utils\/email['"]\)/g;

  const imported = new Map(); // name -> files that import it
  for (const file of jsFiles(path.join(root, 'src'))) {
    for (const match of fs.readFileSync(file, 'utf8').matchAll(pattern)) {
      for (const name of match[1].split(',').map((n) => n.split(':')[0].trim()).filter(Boolean)) {
        imported.set(name, [...(imported.get(name) || []), path.relative(root, file)]);
      }
    }
  }

  assert.ok(imported.size >= 5, `found only ${imported.size} imported names; is the pattern still right?`);
  for (const [name, files] of imported) {
    assert.equal(typeof email[name], 'function', `${name} (used by ${files.join(', ')}) is not exported by src/utils/email.js`);
  }
});

test('src/utils/email.js has a single module.exports', () => {
  const source = fs.readFileSync(path.join(root, 'src/utils/email.js'), 'utf8');
  assert.equal(source.match(/^module\.exports\s*=/gm).length, 1);
});
