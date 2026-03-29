const test = require('node:test');
const assert = require('node:assert/strict');

const { parseProxyUrl } = require('../lib/browser');

test('parses standard proxy URL with auth', () => {
  const parsed = parseProxyUrl('http://proxy-user:proxy-pass@198.51.100.10:8080');

  assert.deepEqual(parsed, {
    protocol: 'http',
    username: 'proxy-user',
    password: 'proxy-pass',
    host: '198.51.100.10',
    port: 8080,
    proxyServer: 'http://198.51.100.10:8080',
    hasAuth: true,
    authString: 'proxy-user:proxy-pass',
    display: 'http://198.51.100.10:8080 (with auth)',
  });
});

test('parses standard proxy URL without auth', () => {
  const parsed = parseProxyUrl('http://198.51.100.20:9000');

  assert.deepEqual(parsed, {
    protocol: 'http',
    username: undefined,
    password: undefined,
    host: '198.51.100.20',
    port: 9000,
    proxyServer: 'http://198.51.100.20:9000',
    hasAuth: false,
    authString: null,
    display: 'http://198.51.100.20:9000',
  });
});

test('parses legacy host:port:user:pass proxy format', () => {
  const parsed = parseProxyUrl('198.51.100.30:1080:proxy-user:proxy-pass');

  assert.deepEqual(parsed, {
    protocol: 'http',
    username: 'proxy-user',
    password: 'proxy-pass',
    host: '198.51.100.30',
    port: 1080,
    proxyServer: 'http://198.51.100.30:1080',
    hasAuth: true,
    authString: 'proxy-user:proxy-pass',
    display: 'http://198.51.100.30:1080 (with auth)',
  });
});
