const assert = require('node:assert/strict');
const test = require('node:test');
const { localSmokeBaseUrl } = require('./smoke-target');

test('accepts only the isolated local API origin', () => {
  assert.equal(localSmokeBaseUrl('http://localhost:5173', 5173), 'http://127.0.0.1:5173');
  assert.equal(localSmokeBaseUrl('http://127.0.0.1:5173/', 5173), 'http://127.0.0.1:5173');
});

test('rejects HTTPS and remote IP targets', () => {
  assert.throws(() => localSmokeBaseUrl('https://localhost:5173', 5173));
  assert.throws(() => localSmokeBaseUrl('http://192.168.1.20:5173', 5173));
  assert.throws(() => localSmokeBaseUrl('http://10.2.3.4:5173', 5173));
  assert.throws(() => localSmokeBaseUrl('http://172.16.0.2:5173', 5173));
  assert.throws(() => localSmokeBaseUrl('http://172.31.255.254:5173', 5173));
  assert.throws(() => localSmokeBaseUrl('http://8.8.8.8:5173', 5173));
});

test('rejects public, Render, and Netlify domains', () => {
  assert.throws(() => localSmokeBaseUrl('http://example.com:5173', 5173));
  assert.throws(() => localSmokeBaseUrl('https://le-wassa.onrender.com', 5173));
  assert.throws(() => localSmokeBaseUrl('https://le-wassa.netlify.app', 5173));
});

test('rejects empty, malformed, or non-isolated local URLs', () => {
  assert.throws(() => localSmokeBaseUrl('', 5173));
  assert.throws(() => localSmokeBaseUrl('not a URL', 5173));
  assert.throws(() => localSmokeBaseUrl('http://localhost:5174', 5173));
  assert.throws(() => localSmokeBaseUrl('http://localhost:5173/path', 5173));
});
