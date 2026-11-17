// Express "trust proxy" setting: TRUST_PROXY, or 1 on Render, or nothing.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { trustProxySetting } = require('../src/utils/trustProxy');

test('TRUST_PROXY is used when set', () => {
  assert.equal(trustProxySetting({ TRUST_PROXY: '1' }), 1);
  assert.equal(trustProxySetting({ TRUST_PROXY: '2', RENDER: 'true' }), 2);
  assert.equal(trustProxySetting({ TRUST_PROXY: '0', RENDER: 'true' }), 0, '0 turns it off, even on Render');
  assert.equal(trustProxySetting({ TRUST_PROXY: 'loopback' }), 'loopback');
});

test('on Render it defaults to one proxy', () => {
  assert.equal(trustProxySetting({ RENDER: 'true' }), 1);
  assert.equal(trustProxySetting({ RENDER: 'true', TRUST_PROXY: '' }), 1);
});

test('elsewhere, with nothing set, proxies are not trusted', () => {
  assert.equal(trustProxySetting({}), undefined);
});
