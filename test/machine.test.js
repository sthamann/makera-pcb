import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import { parseStatus, crc16xmodem, encodeFrame, CarveraConnection } from '../src/machine.js';

const FRAME_HEADER = 0x8668;
const FRAME_END = 0x55aa;
const PTYPE_CTRL_SINGLE = 0xa1;
const PTYPE_FILE_START = 0xb0;
const PTYPE_FILE_MD5 = 0xb1;
const PTYPE_FILE_VIEW = 0xb2;
const PTYPE_FILE_DATA = 0xb3;
const PTYPE_FILE_END = 0xb4;
const PTYPE_STATUS_RES = 0x81;

test('crc16xmodem matches the standard check value', () => {
  assert.equal(crc16xmodem(Buffer.from('123456789')), 0x31c3);
});

test('encodeFrame produces a valid CRC-checked envelope', () => {
  const f = encodeFrame(PTYPE_CTRL_SINGLE, Buffer.from([0x3f])); // framed '?'
  assert.equal(f[0], 0x86);
  assert.equal(f[1], 0x68);
  const len = (f[2] << 8) | f[3];
  assert.equal(len, 1 + 1 + 2); // ptype + data + crc
  assert.equal(f[4], PTYPE_CTRL_SINGLE);
  assert.equal(f[5], 0x3f);
  const crc = (f[6] << 8) | f[7];
  assert.equal(crc, crc16xmodem(f.slice(2, 6)));
  assert.equal((f[8] << 8) | f[9], FRAME_END);
});

test('parseStatus extracts state and fields (pipe format)', () => {
  const s = parseStatus('<Idle|MPos:0.000,0.000,0.000|WPos:1.000,2.000,3.000|F:0,0,100|S:0,0,100|T:2,0>');
  assert.equal(s.state, 'Idle');
  assert.deepEqual(s.wpos, [1, 2, 3]);
  assert.deepEqual(s.tool, [2, 0]);
  assert.equal(s.feed[2], 100);
});

test('parseStatus extracts state and fields (Carvera comma format)', () => {
  const s = parseStatus('<Idle,MPos:0.000,0.000,0.000,WPos:1.000,2.000,3.000,F:0,0,100,S:0,0,100,T:2,0>');
  assert.equal(s.state, 'Idle');
  assert.deepEqual(s.mpos, [0, 0, 0]);
  assert.deepEqual(s.wpos, [1, 2, 3]);
  assert.deepEqual(s.feed, [0, 0, 100]);
  assert.deepEqual(s.tool, [2, 0]);
});

test('parseStatus returns null without a frame', () => {
  assert.equal(parseStatus('ok'), null);
});

const u32be = (n) => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);

// Independent frame parser for the mock machine (validates the client encoder).
function makeFrameParser(onFrame) {
  let state = 0, h0 = 0, h1 = 0, f0 = 0, f1 = 0, buf = [], need = 0, len = 0;
  return (data) => {
    for (const byte of data) {
      if (state === 0) {
        h0 = h1; h1 = byte;
        if (((h0 << 8) | h1) === FRAME_HEADER) { state = 1; need = 2; buf = []; }
      } else if (state === 1) {
        buf.push(byte);
        if (--need === 0) { len = (buf[0] << 8) | buf[1]; state = 2; need = len; }
      } else if (state === 2) {
        buf.push(byte);
        if (--need === 0) { state = 3; need = 2; }
      } else if (state === 3) {
        f0 = f1; f1 = byte;
        if (--need === 0) {
          state = 0;
          if (((f0 << 8) | f1) === FRAME_END) {
            const calc = crc16xmodem(Buffer.from(buf.slice(0, buf.length - 2)));
            const recv = (buf[buf.length - 2] << 8) | buf[buf.length - 1];
            if (calc === recv) onFrame(buf[2], Buffer.from(buf.slice(3, buf.length - 2)));
          }
        }
      }
    }
  };
}

// Framed mock machine mirroring current firmware (>= 1.0.5). It answers a
// framed "?" with a framed status frame and receives uploads via the framed
// file protocol, driving the transfer by requesting VIEW then each DATA block.
function startMockMachine() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      const send = (ptype, data) => socket.write(encodeFrame(ptype, data || Buffer.alloc(0)));
      let up = null; // { path, md5, packetSize, total, chunks }
      const parse = makeFrameParser((ptype, data) => {
        if (ptype === PTYPE_CTRL_SINGLE && data[0] === 0x3f) {
          send(PTYPE_STATUS_RES, Buffer.from('<Idle,MPos:0.000,0.000,0.000,WPos:1.000,2.000,3.000,F:0,0,100,S:0,0,100,T:1,0>'));
          return;
        }
        if (ptype === PTYPE_FILE_START) {
          const line = data.toString('latin1').trim();
          if (line.startsWith('upload ')) up = { path: line.slice(7).trim(), chunks: [] };
          return;
        }
        if (ptype === PTYPE_FILE_MD5) {
          if (!up) return;
          up.md5 = data.toString('latin1');
          send(PTYPE_FILE_VIEW); // request file metadata
          return;
        }
        if (ptype === PTYPE_FILE_VIEW) {
          if (!up) return;
          up.total = data.readUInt32BE(0);
          up.packetSize = data.readUInt16BE(4);
          send(PTYPE_FILE_DATA, u32be(1)); // request block 1
          return;
        }
        if (ptype === PTYPE_FILE_DATA) {
          if (!up) return;
          const seq = data.readUInt32BE(0);
          up.chunks[seq - 1] = data.subarray(4);
          if (seq < up.total) {
            send(PTYPE_FILE_DATA, u32be(seq + 1));
          } else {
            send(PTYPE_FILE_END);
            const file = Buffer.concat(up.chunks);
            server.emit('uploaded', { path: up.path, data: file, md5: up.md5 });
          }
          return;
        }
      });
      socket.on('data', parse);
      socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('detects the framed protocol and polls status after connecting', async () => {
  const { server, port } = await startMockMachine();
  const conn = new CarveraConnection('127.0.0.1', port);
  await conn.connect();
  const st = await new Promise((resolve) => conn.once('status', resolve));
  assert.equal(conn.mode, 'framed');
  assert.equal(st.state, 'Idle');
  assert.deepEqual(st.wpos, [1, 2, 3]);
  conn.disconnect();
  server.close();
});

test('uploads a payload via the framed file protocol, reassembled correctly', async () => {
  const { server, port } = await startMockMachine();
  const conn = new CarveraConnection('127.0.0.1', port);
  await conn.connect();
  await new Promise((resolve) => conn.once('status', resolve)); // wait for protocol detection

  // payload larger than one block to exercise multi-block transfer
  const content = 'G21\nG90\n' + 'X1 Y1\n'.repeat(3000);
  const expectedMd5 = crypto.createHash('md5').update(Buffer.from(content, 'utf8')).digest('hex');

  const uploaded = new Promise((resolve) => server.once('uploaded', resolve));
  const result = await conn.upload('my board.nc', content);
  const got = await uploaded;

  assert.equal(result.md5, expectedMd5);
  assert.equal(got.md5, expectedMd5);
  assert.equal(got.data.toString('utf8'), content);
  assert.equal(got.path, '/sd/gcodes/my_board.nc'); // spaces sanitised

  conn.disconnect();
  server.close();
});

test('handles an abrupt socket reset without throwing', async () => {
  const server = await new Promise((resolve) => {
    const s = net.createServer((sock) => {
      setTimeout(() => sock.destroy(), 60);
    });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
  const conn = new CarveraConnection('127.0.0.1', server.address().port);
  await conn.connect();
  const closed = new Promise((resolve) => conn.once('close', resolve));
  await closed; // must resolve (no unhandled 'error' crash)
  assert.equal(conn.connected, false);
  server.close();
});
