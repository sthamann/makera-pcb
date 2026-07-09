// LAN address helpers: list the machine's non-internal IPv4 addresses so the
// mobile remote-control URL (http://<lan-ip>:PORT/mobile) can be printed at
// server start and shown in the UI. Pure functions, unit-tested in test/lan.test.js.

import os from 'node:os';

// Return the unique, non-internal IPv4 addresses of this host.
// `interfaces` is injectable for testing (defaults to os.networkInterfaces()).
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces || {})) {
    for (const info of list || []) {
      // Node <18.0 reported family as 'IPv4', newer versions may use the number 4.
      const isV4 = info.family === 'IPv4' || info.family === 4;
      if (isV4 && !info.internal && info.address) out.push(info.address);
    }
  }
  return [...new Set(out)];
}

// Base URLs (http://ip:port) for every LAN address.
export function lanUrls(port, interfaces) {
  return lanAddresses(interfaces).map((ip) => `http://${ip}:${port}`);
}
