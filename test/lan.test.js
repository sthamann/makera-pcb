import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lanAddresses, lanUrls } from '../src/lan.js';

test('lanAddresses returns only non-internal IPv4 addresses, deduplicated', () => {
  const ifaces = {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [
      { address: 'fe80::1', family: 'IPv6', internal: false },
      { address: '192.168.1.23', family: 'IPv4', internal: false },
    ],
    // numeric family (newer Node) + duplicate address across interfaces
    en1: [{ address: '192.168.1.23', family: 4, internal: false }],
    utun0: [{ address: '10.8.0.2', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(lanAddresses(ifaces), ['192.168.1.23', '10.8.0.2']);
});

test('lanAddresses tolerates empty or sparse interface maps', () => {
  assert.deepEqual(lanAddresses({}), []);
  assert.deepEqual(lanAddresses({ en0: undefined }), []);
  // null bypasses the default parameter (undefined would fall back to the
  // REAL os.networkInterfaces() and make the test machine-dependent)
  assert.deepEqual(lanAddresses(null), []);
});

test('lanUrls builds http base URLs with the given port', () => {
  const ifaces = { en0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }] };
  assert.deepEqual(lanUrls(4321, ifaces), ['http://10.0.0.5:4321']);
});
