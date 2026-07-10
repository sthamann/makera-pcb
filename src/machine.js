// Carvera / Carvera Air network client.
//
// Two wire protocols exist and this client speaks both:
//
//   * "plain"  - legacy firmware (<= 1.0.4): line based grbl/Smoothie over TCP.
//                "?" -> "<State|MPos:..|..>" status, classic XMODEM for files.
//
//   * "framed" - current firmware (>= 1.0.5, e.g. Carvera Air 1.0.6): every
//                command AND every response is wrapped in a binary frame:
//
//                  [0x86 0x68][len:u16][ptype:u8][data ...][crc16:u16][0x55 0xAA]
//
//                len   = 1 (ptype) + data.length + 2 (crc)
//                crc16 = CRC-16/XMODEM over (len + ptype + data)
//
//                A plain-text "?" is silently ignored by this firmware which is
//                why older clients see "0 bytes"/empty status. The machine only
//                answers framed clients (it otherwise replies "Please use
//                Controller version V0.9.12 or later to connect.").
//
// Discovery is unchanged: the machine broadcasts "name,ip,port,busy" on UDP 3333.
//
// parseStatus() and crc16xmodem() are exported for unit testing.

import dgram from 'node:dgram';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const DISCOVERY_PORT = 3333;
export const DEFAULT_PORT = 2222;

// -- framed protocol constants ------------------------------------------------
const FRAME_HEAD_HI = 0x86;
const FRAME_HEAD_LO = 0x68;
const FRAME_HEADER = 0x8668;
const FRAME_END = 0x55aa;

const PTYPE_CTRL_SINGLE = 0xa1; // single byte command (e.g. '?', '!', '~', reset)
const PTYPE_CTRL_MULTI = 0xa2; // multi byte command / gcode line
const PTYPE_FILE_START = 0xb0; // "upload <path>\n" / "download <path>\n"
const PTYPE_FILE_MD5 = 0xb1;
const PTYPE_FILE_VIEW = 0xb2;
const PTYPE_FILE_DATA = 0xb3;
const PTYPE_FILE_END = 0xb4;
const PTYPE_FILE_CAN = 0xb5;
const PTYPE_FILE_RETRY = 0xb6;

const PTYPE_STATUS_RES = 0x81;
const PTYPE_DIAG_RES = 0x82;
const PTYPE_LOAD_FINISH = 0x84;
const PTYPE_LOAD_ERROR = 0x85;
const PTYPE_NORMAL_INFO = 0x90;

// classic XMODEM control bytes (legacy firmware only)
const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const NAK = 0x15;
const CAN = 0x18;
const FILL = 0x1a;
const MCRC = 0x43; // 'C'

const BLOCK_SIZE = 8192; // wifi packet payload size (framed + classic)

export function crc16xmodem(buf) {
  let crc = 0;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc & 0xffff;
}

// Wrap a command/payload in the framed protocol envelope.
export function encodeFrame(ptype, data) {
  const body = data == null ? Buffer.alloc(0) : Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = 1 + body.length + 2;
  const head = Buffer.concat([Buffer.from([(len >> 8) & 0xff, len & 0xff, ptype]), body]);
  const crc = crc16xmodem(head);
  return Buffer.concat([
    Buffer.from([FRAME_HEAD_HI, FRAME_HEAD_LO]),
    head,
    Buffer.from([(crc >> 8) & 0xff, crc & 0xff, (FRAME_END >> 8) & 0xff, FRAME_END & 0xff]),
  ]);
}

const u32be = (n) => Buffer.from([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
const u16be = (n) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);

// The SimpleShell splits command arguments on spaces, so paths are escaped with
// the same control-byte scheme the firmware unescapes: space->0x01, ?->0x02,
// &->0x03, !->0x04, ~->0x05.
const SHELL_ESC = [[' ', '\x01'], ['?', '\x02'], ['&', '\x03'], ['!', '\x04'], ['~', '\x05']];
export function escapeShellPath(p) {
  let s = String(p);
  for (const [plain, code] of SHELL_ESC) s = s.split(plain).join(code);
  return s;
}
export function unescapeShellPath(p) {
  let s = String(p);
  for (const [plain, code] of SHELL_ESC) s = s.split(code).join(plain);
  return s;
}

// Incremental byte-wise decoder for the framed protocol. onFrame(ptype, data)
// is invoked for every CRC-valid frame; malformed frames are dropped.
class FrameDecoder {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.state = 0; // 0 wait-header, 1 read-len, 2 read-body, 3 read-footer
    this.h0 = 0;
    this.h1 = 0;
    this.f0 = 0;
    this.f1 = 0;
    this.buf = [];
    this.need = 0;
    this.len = 0;
  }

  push(byte) {
    switch (this.state) {
      case 0:
        this.h0 = this.h1;
        this.h1 = byte;
        if (((this.h0 << 8) | this.h1) === FRAME_HEADER) {
          this.state = 1;
          this.need = 2;
          this.buf = [];
        }
        break;
      case 1:
        this.buf.push(byte);
        if (--this.need === 0) {
          this.len = (this.buf[0] << 8) | this.buf[1];
          if (this.len >= 0 && this.len <= 8200) {
            this.state = 2;
            this.need = this.len;
          } else {
            this.state = 0;
          }
        }
        break;
      case 2:
        this.buf.push(byte);
        if (--this.need === 0) {
          this.state = 3;
          this.need = 2;
        }
        break;
      case 3:
        this.f0 = this.f1;
        this.f1 = byte;
        if (--this.need === 0) {
          this.state = 0;
          if (((this.f0 << 8) | this.f1) === FRAME_END) this._emit();
        }
        break;
    }
  }

  feed(data) {
    for (let i = 0; i < data.length; i++) this.push(data[i]);
  }

  _emit() {
    const pkt = this.buf; // [len_hi, len_lo, ptype, ...data, crc_hi, crc_lo]
    if (pkt.length < 5) return;
    const calc = crc16xmodem(Buffer.from(pkt.slice(0, pkt.length - 2)));
    const recv = (pkt[pkt.length - 2] << 8) | pkt[pkt.length - 1];
    if (calc !== recv) return;
    const ptype = pkt[2];
    const data = Buffer.from(pkt.slice(3, pkt.length - 2));
    this.onFrame(ptype, data);
  }
}

// Field keys of the official firmware status report (Kernel.cpp
// get_query_string(), v1.0.6 lines 256-489). The 1.0.6 format is
// pipe-separated with 5-value MPos/WPos (X,Y,Z,A,B):
//   <Idle|MPos:x,y,z,a,b|WPos:x,y,z,a,b|F:cur,req,ovr|S:rpm,req,ovr,vac,
//    spindleT,powerT,0,0,ext|T:active,tlo,target|W:volt|L:...|P:lines,pct,secs
//    [|A:atcState][|O:maxLevelDelta][|H:haltReason]|C:model,func,inch,abs>
//   * T carries the TARGET tool as 3rd value on manual-tool-change machines
//     (Air), Kernel.cpp:408-411.
//   * O only appears while auto-leveling compensation is ACTIVE and carries
//     the height map's max deviation (Kernel.cpp:469-474) — surfaced as
//     `leveling` for the UI plausibility warnings.
const STATUS_KEYS = {
  MPos: 'mpos',
  WPos: 'wpos',
  F: 'feed',
  S: 'spindle',
  T: 'tool',
  L: 'laser',
  W: 'probe',
  P: 'play',
  A: 'setup',
  O: 'leveling',
  H: 'halt',
  C: 'modes',
};

// Parse a status frame into an object. Handles both the Carvera comma format
//   <Idle,MPos:0,0,0,WPos:1,2,3,F:0,0,100,S:0,0,100,T:1,0>
// and the grbl-style pipe format of the current firmware (see STATUS_KEYS)
//   <Idle|MPos:0,0,0,0,0|WPos:1,2,3,0,0|...>
export function parseStatus(text) {
  const lt = text.indexOf('<');
  const gt = text.indexOf('>', lt);
  if (lt < 0 || gt < 0) return null;
  const inner = text.slice(lt + 1, gt);
  const status = { raw: text.slice(lt, gt + 1) };

  const assign = (key, val) => {
    if (val == null) return;
    status[STATUS_KEYS[key] || key] = val.split(',').map((v) => parseFloat(v));
  };

  if (inner.includes('|')) {
    const parts = inner.split('|');
    status.state = parts[0];
    for (let i = 1; i < parts.length; i++) {
      const idx = parts[i].indexOf(':');
      if (idx > 0) assign(parts[i].slice(0, idx), parts[i].slice(idx + 1));
    }
    return status;
  }

  const firstComma = inner.indexOf(',');
  status.state = firstComma < 0 ? inner : inner.slice(0, firstComma);
  const rest = firstComma < 0 ? '' : inner.slice(firstComma + 1);
  const re = /([A-Za-z]+):([-0-9.,]+?)(?=,[A-Za-z]+:|$)/g;
  let m;
  while ((m = re.exec(rest)) !== null) assign(m[1], m[2]);
  return status;
}

// Listen for UDP broadcasts for `timeout` ms and return discovered machines.
export function discover(timeout = 2500) {
  return new Promise((resolve) => {
    const found = new Map();
    let sock;
    try {
      sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    } catch (err) {
      resolve([]);
      return;
    }
    const done = () => {
      try { sock.close(); } catch {}
      resolve([...found.values()]);
    };
    sock.on('error', done);
    sock.on('message', (msg) => {
      const [name, ip, port, busy] = msg.toString().trim().split(',');
      if (name && ip) found.set(ip, { name, ip, port: Number(port) || DEFAULT_PORT, busy: busy === '1' });
    });
    sock.on('listening', () => {
      try { sock.setBroadcast(true); } catch {}
    });
    try {
      sock.bind(DISCOVERY_PORT);
    } catch (err) {
      resolve([]);
      return;
    }
    setTimeout(done, timeout);
  });
}

export class CarveraConnection extends EventEmitter {
  constructor(ip, port = DEFAULT_PORT) {
    super();
    this.ip = ip;
    this.port = port;
    this.socket = null;
    this.connected = false;
    this.xmitting = false;
    this.status = null;
    this.log = [];
    this.bytesReceived = 0;
    this.connectedAt = 0;
    this.mode = 'detecting'; // 'detecting' | 'framed' | 'plain'
    this._textBuf = '';
    this._pollTimer = null;
    this._lastSend = 0;
    this._closed = false;
    this.lastError = null;
    this.lastAlarm = null;
    this._fileHandler = null;
    this._rawTap = null; // when set, console output is siphoned here (see runShell)
    this._decoder = new FrameDecoder((p, d) => this._handleFrame(p, d));
    // Safety net: never let an unlistened 'error' event crash the process.
    this.on('error', () => {});
  }

  connect(timeout = 8000) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.ip, port: this.port });
      this.socket = socket;
      const onError = (err) => { cleanup(); reject(err); };
      const onTimeout = () => { cleanup(); socket.destroy(); reject(new Error('connection timeout')); };
      const timer = setTimeout(onTimeout, timeout);
      const cleanup = () => { clearTimeout(timer); socket.off('error', onError); };

      socket.once('error', onError);
      socket.on('connect', () => {
        cleanup();
        try { socket.setNoDelay(true); } catch {}
        this.connected = true;
        this.connectedAt = Date.now();
        this.bytesReceived = 0;
        this.mode = 'detecting';
        socket.on('data', (d) => this._onData(d));
        socket.on('close', () => this._onClose());
        socket.on('error', (e) => { this.lastError = e.message; this._onClose(); });
        this._detectFirmware();
        resolve({ ip: this.ip, port: this.port });
      });
    });
  }

  // Probe which protocol the firmware speaks. Newer firmware answers a framed
  // "?" with a framed status frame; legacy firmware echoes a plain "echo echo".
  // Defaults to framed (current firmware) if nothing conclusive arrives.
  _detectFirmware() {
    this._detectFrames = 0;
    this._detectText = '';
    // ask both ways
    this._writeRaw(encodeFrame(PTYPE_CTRL_SINGLE, Buffer.from([0x3f]))); // framed '?'
    this._writeRaw(Buffer.from('echo echo\n')); // plain echo probe
    const deadline = Date.now() + 1600;
    const tick = () => {
      if (this._closed) return;
      if (this._detectFrames > 0) { this._finishDetect('framed'); return; }
      if (this._detectText.includes('echo')) { this._finishDetect('plain'); return; }
      if (Date.now() >= deadline) { this._finishDetect('framed'); return; }
      // re-probe the framed side once mid-way in case the first was dropped
      if (Date.now() > deadline - 800 && !this._reprobed) {
        this._reprobed = true;
        this._writeRaw(encodeFrame(PTYPE_CTRL_SINGLE, Buffer.from([0x3f])));
      }
      this._detectTimer = setTimeout(tick, 120);
    };
    this._detectTimer = setTimeout(tick, 120);
  }

  _finishDetect(mode) {
    if (this.mode !== 'detecting') return;
    this.mode = mode;
    this.emit('mode', mode);
    this._startPolling();
  }

  disconnect() {
    this._stopPolling();
    if (this._detectTimer) { clearTimeout(this._detectTimer); this._detectTimer = null; }
    if (this.socket) {
      try { this.socket.end(); } catch {}
    }
    this.connected = false;
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    this.connected = false;
    this._stopPolling();
    if (this._detectTimer) { clearTimeout(this._detectTimer); this._detectTimer = null; }
    this.emit('close');
  }

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => {
      if (!this.connected || this.xmitting || this.mode === 'detecting') return;
      const refresh = this.status?.state === 'Run' ? 250 : 1000;
      if (Date.now() - this._lastSend >= refresh) this._queryStatus();
    }, 120);
    if (this._pollTimer.unref) this._pollTimer.unref();
  }

  _stopPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    this._pollTimer = null;
  }

  _writeRaw(buf) {
    if (!this.socket || !this.connected) return;
    this._lastSend = Date.now();
    this.socket.write(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
  }

  _queryStatus() {
    if (this.mode === 'plain') this._writeRaw('?');
    else this._writeRaw(encodeFrame(PTYPE_CTRL_SINGLE, Buffer.from([0x3f])));
  }

  // MDI / console command (a newline is appended if missing).
  send(line) {
    if (this.xmitting) throw new Error('busy uploading');
    const s = line.endsWith('\n') ? line : line + '\n';
    if (this.mode === 'plain') this._writeRaw(s);
    else this._writeRaw(encodeFrame(PTYPE_CTRL_MULTI, Buffer.from(s)));
  }

  // Real-time control byte: '!' feed hold, '~' resume, 0x18 reset,
  // 0x19 stop continuous jog.
  sendRealtime(code) {
    const map = { pause: 0x21, resume: 0x7e, reset: 0x18, jogstop: 0x19 };
    const b = map[code];
    if (b == null) throw new Error(`unknown realtime code: ${code}`);
    if (this.mode === 'plain') this._writeRaw(Buffer.from([b]));
    else this._writeRaw(encodeFrame(PTYPE_CTRL_SINGLE, Buffer.from([b])));
  }

  _onData(data) {
    this.bytesReceived += data.length;
    if (this.mode === 'detecting') {
      this._detectText += data.toString('latin1');
      this._decoder.feed(data); // counts frames via _handleFrame
      return;
    }
    if (this.mode === 'framed') {
      this._decoder.feed(data);
    } else {
      this._ingestText(data.toString('latin1'));
    }
  }

  _handleFrame(ptype, data) {
    // A valid frame is conclusive proof of the framed protocol: settle the mode
    // synchronously so status/upload never race the detection timer.
    if (this.mode === 'detecting') { this._detectFrames++; this._finishDetect('framed'); }
    if (ptype >= PTYPE_FILE_START && ptype <= PTYPE_FILE_RETRY) {
      if (this._fileHandler) this._fileHandler(ptype, data);
      return;
    }
    // Status frames are always parsed so the live position keeps flowing even
    // during a shell capture; every other console frame (ls/cat/echo output)
    // is siphoned raw to the active tap so file bytes survive verbatim.
    if (ptype !== PTYPE_STATUS_RES && this._rawTap) { this._rawTap(data.toString('latin1')); return; }
    // text-bearing frames: status / diagnose / normal info / load / etc.
    this._ingestText(data.toString('latin1'));
  }

  // Shared text ingestion for plain mode and framed text payloads. Extracts
  // "<...>" status frames and newline-terminated log lines.
  _ingestText(text) {
    this._textBuf += text;
    let lt;
    while ((lt = this._textBuf.indexOf('<')) >= 0) {
      const gt = this._textBuf.indexOf('>', lt);
      if (gt < 0) break;
      const frame = this._textBuf.slice(lt, gt + 1);
      const st = parseStatus(frame);
      if (st) { this.status = st; this.emit('status', st); }
      this._textBuf = this._textBuf.slice(0, lt) + this._textBuf.slice(gt + 1);
    }
    let nl;
    while ((nl = this._textBuf.indexOf('\n')) >= 0) {
      const line = this._textBuf.slice(0, nl).trim();
      this._textBuf = this._textBuf.slice(nl + 1);
      if (line) {
        this.log.push(line);
        if (this.log.length > 400) this.log.shift();
        // Surface machine alarms/errors (grbl/Smoothie style) so the UI can warn.
        if (/^(error|alarm|halt)\b|ALARM:|error:|MSG:\s*(Reset|Halt|Alarm)|Reset to continue|limit|soft ?limit|hard ?limit|Probe fail|too small|out of|not connect/i.test(line)) {
          this.lastAlarm = { text: line, at: Date.now() };
          this.emit('alarm', this.lastAlarm);
        }
        this.emit('line', line);
      }
    }
    // guard against unbounded growth if a '<' never closes
    if (this._textBuf.length > 8192) this._textBuf = this._textBuf.slice(-4096);
  }

  // Upload a text/gcode payload. `nameOrPath` may be a bare filename (stored
  // under /sd/gcodes) or an absolute /sd/... path (used by the file browser to
  // write into any directory). `content` may be a string or a Buffer.
  upload(nameOrPath, content) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('not connected'));
      if (this.xmitting) return reject(new Error('busy uploading'));
      if (this.mode === 'detecting') return reject(new Error('protocol not detected yet'));
      let path;
      if (typeof nameOrPath === 'string' && nameOrPath.startsWith('/')) {
        const dir = nameOrPath.slice(0, nameOrPath.lastIndexOf('/') + 1);
        const base = nameOrPath.slice(nameOrPath.lastIndexOf('/') + 1).replace(/[^\w.\- ]/g, '_');
        path = dir + base;
      } else {
        path = `/sd/gcodes/${String(nameOrPath).replace(/[^\w.\-]/g, '_')}`;
      }
      const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
      const md5hex = crypto.createHash('md5').update(buffer).digest('hex');

      this.xmitting = true;
      this._stopPolling();
      const done = (err) => {
        this.xmitting = false;
        this._fileHandler = null;
        this._startPolling();
        if (err) reject(err); else resolve({ path, md5: md5hex });
      };

      if (this.mode === 'framed') this._uploadFramed(path, buffer, md5hex, done);
      else this._uploadClassic(path, buffer, md5hex, done);
    });
  }

  // Framed file transfer (current firmware). The machine drives the transfer by
  // requesting VIEW (file metadata) then each DATA block by 1-based sequence.
  _uploadFramed(path, buffer, md5hex, done) {
    const packetSize = BLOCK_SIZE;
    const total = Math.ceil(buffer.length / packetSize) || 1;
    let lastFrame = null;
    let finished = false;
    let timer = null;

    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(new Error('upload timeout')), 12000);
      if (timer.unref) timer.unref();
    };
    const finish = (err) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      done(err || null);
    };
    const sendFrame = (ptype, data) => {
      lastFrame = encodeFrame(ptype, data);
      this._writeRaw(lastFrame);
      arm();
    };

    this._fileHandler = (ptype, data) => {
      if (finished) return;
      arm();
      switch (ptype) {
        case PTYPE_FILE_CAN:
          finish(new Error('upload canceled by machine'));
          break;
        case PTYPE_FILE_RETRY:
          if (lastFrame) { this._writeRaw(lastFrame); arm(); }
          break;
        case PTYPE_FILE_MD5:
          sendFrame(PTYPE_FILE_MD5, Buffer.from(md5hex));
          break;
        case PTYPE_FILE_VIEW:
          sendFrame(PTYPE_FILE_VIEW, Buffer.concat([u32be(total), u16be(packetSize)]));
          break;
        case PTYPE_FILE_DATA: {
          const seq = data.length >= 4 ? data.readUInt32BE(0) : 1;
          const start = (seq - 1) * packetSize;
          const chunk = buffer.subarray(start, Math.min(buffer.length, start + packetSize));
          sendFrame(PTYPE_FILE_DATA, Buffer.concat([u32be(seq), chunk]));
          this.emit('upload-progress', { seq, total });
          break;
        }
        case PTYPE_FILE_END:
          finish(null);
          break;
      }
    };

    // Kick off: announce the upload target, then present the md5.
    this._writeRaw(encodeFrame(PTYPE_FILE_START, Buffer.from(`upload ${escapeShellPath(path)}\n`)));
    sendFrame(PTYPE_FILE_MD5, Buffer.from(md5hex));
  }

  // Classic XMODEM-CRC transfer (legacy firmware). First block carries the md5.
  _uploadClassic(path, buffer, md5hex, done) {
    const chunks = [Buffer.from(md5hex)];
    for (let i = 0; i < buffer.length; i += BLOCK_SIZE) {
      chunks.push(buffer.subarray(i, Math.min(buffer.length, i + BLOCK_SIZE)));
    }
    this._writeRaw(`upload ${escapeShellPath(path)}\n`);
    this._xmodemSend(chunks).then(() => done(null)).catch((err) => done(err));
  }

  _xmodemSend(chunks) {
    return new Promise((resolve, reject) => {
      const socket = this.socket;
      let blockNumber = 0;
      let started = false;
      let sentEof = false;
      let inStatusFrame = false;
      const currentBlock = Buffer.alloc(BLOCK_SIZE + 2);
      const timeout = setTimeout(() => finish(new Error('xmodem timeout')), 30000);

      const finish = (err) => {
        clearTimeout(timeout);
        socket.off('data', onData);
        if (err) reject(err); else resolve();
      };

      const sendBlock = (nr) => {
        if (nr >= chunks.length) return false;
        const dataBlock = chunks[nr];
        currentBlock.fill(FILL);
        dataBlock.copy(currentBlock, 2);
        currentBlock[0] = (dataBlock.length >> 8) & 0xff;
        currentBlock[1] = dataBlock.length & 0xff;
        const dataCRC = crc16xmodem(currentBlock);
        const blockData = Buffer.concat([
          Buffer.from([STX, nr & 0xff, 255 - (nr & 0xff)]),
          currentBlock,
          Buffer.from([(dataCRC >> 8) & 0xff, dataCRC & 0xff]),
        ]);
        socket.write(blockData);
        return true;
      };

      const advance = () => {
        if (sentEof) return finish(null);
        blockNumber++;
        if (!sendBlock(blockNumber)) {
          sentEof = true;
          socket.write(Buffer.from([EOT]));
        }
      };

      const onData = (data) => {
        for (const b of data) {
          if (inStatusFrame) { if (b === 0x3e) inStatusFrame = false; continue; }
          if (b === 0x3c) { inStatusFrame = true; continue; }
          if (!started) { if (b === MCRC) { started = true; sendBlock(0); } continue; }
          if (b === ACK) advance();
          else if (b === NAK) { if (!sendBlock(blockNumber)) { sentEof = true; socket.write(Buffer.from([EOT])); } }
          else if (b === CAN) { socket.write(Buffer.from([CAN, CAN, CAN, 0x0a])); return finish(new Error('cancelled by machine')); }
        }
      };

      socket.on('data', onData);
    });
  }

  // Run a SimpleShell command and capture its raw console output. A unique
  // sentinel is echoed right after the command; because the firmware runs
  // console commands strictly in order, the sentinel is guaranteed to arrive
  // after the command's full output, giving us a reliable end marker without
  // relying on EOT handling. Status frames keep flowing (position stays live).
  runShell(command, { timeout = 20000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('not connected'));
      if (this.xmitting) return reject(new Error('busy'));
      if (this.mode === 'detecting') return reject(new Error('protocol not detected yet'));
      const sentinel = 'CV' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const marker = 'echo: ' + sentinel;
      let raw = '';
      let done = false;
      const finish = (err, val) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this._rawTap = null;
        this.xmitting = false;
        this._startPolling();
        if (err) reject(err); else resolve(val);
      };
      const timer = setTimeout(() => finish(new Error(`shell timeout: ${command}`)), timeout);
      if (timer.unref) timer.unref();

      this.xmitting = true; // block polling + concurrent transfers
      this._stopPolling();
      this._rawTap = (text) => {
        raw += text;
        const idx = raw.indexOf(marker);
        if (idx >= 0) finish(null, raw.slice(0, idx));
      };
      const write = (line) => {
        const s = line.endsWith('\n') ? line : line + '\n';
        if (this.mode === 'plain') this._writeRaw(s);
        else this._writeRaw(encodeFrame(PTYPE_CTRL_MULTI, Buffer.from(s, 'latin1')));
      };
      write(command);
      write('echo ' + sentinel);
    });
  }

  // List a directory. Returns [{ name, size, isDir, timestamp }]. Uses `ls -s`
  // which prints "name[/] size YYYYMMDDhhmmss" per entry (dirs get a trailing
  // slash and size 0); spaces in names arrive as 0x01 and are unescaped here.
  async list(path = '/sd') {
    const clean = path.replace(/\/+$/, '') || '/';
    const raw = await this.runShell(`ls -s ${escapeShellPath(clean)}`);
    if (/Could not open directory/i.test(raw)) throw new Error(`cannot open directory: ${path}`);
    const entries = [];
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      const m = line.match(/^(.*?)\s+(\d+)\s+(\d{12,14})$/);
      if (!m) continue;
      let name = unescapeShellPath(m[1]);
      const isDir = name.endsWith('/');
      if (isDir) name = name.slice(0, -1);
      if (!name || name === '.' || name === '..') continue;
      entries.push({ name, size: isDir ? 0 : Number(m[2]), isDir, timestamp: m[3] });
    }
    entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return entries;
  }

  // Download a file. Current firmware (framed) uses the framed file transfer
  // (the inverse of upload — we pull VIEW then each DATA block by sequence).
  // Legacy plain firmware streams the file as text via `cat`.
  download(path) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('not connected'));
      if (this.xmitting) return reject(new Error('busy'));
      if (this.mode === 'detecting') return reject(new Error('protocol not detected yet'));
      if (this.mode !== 'framed') {
        this.runShell(`cat ${escapeShellPath(path)}`, { timeout: 120000 })
          .then((raw) => {
            if (/^File not found:/m.test(raw)) reject(new Error(`file not found: ${path}`));
            else resolve(Buffer.from(raw, 'latin1'));
          })
          .catch(reject);
        return;
      }
      this.xmitting = true;
      this._stopPolling();
      const done = (err, buf) => {
        this.xmitting = false;
        this._fileHandler = null;
        this._startPolling();
        if (err) reject(err); else resolve(buf);
      };
      this._downloadFramed(path, done);
    });
  }

  // Framed file download. Mirrors _uploadFramed but with the roles reversed:
  // here WE are the receiver and drive the transfer, requesting the md5, then
  // VIEW (total blocks + packet size), then each DATA block by 1-based
  // sequence; the machine answers each request. Returns the reassembled bytes.
  _downloadFramed(path, done) {
    const trace = process.env.MACHINE_TRACE ? (dir, p, n) => console.error(`  DL ${dir} ptype=0x${p.toString(16)} len=${n}`) : null;
    let total = 0;
    let packetSize = BLOCK_SIZE;
    let md5hex = null;
    let finished = false;
    let timer = null;
    let lastFrame = null;
    const chunks = new Map();

    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish(new Error('download timeout')), 15000);
      if (timer.unref) timer.unref();
    };
    const finish = (err, buf) => {
      if (finished) return;
      finished = true;
      if (timer) clearTimeout(timer);
      done(err || null, buf || null);
    };
    const assemble = () => {
      const parts = [];
      for (let i = 1; i <= total; i++) parts.push(chunks.get(i) || Buffer.alloc(0));
      return Buffer.concat(parts);
    };
    const req = (ptype, data) => {
      lastFrame = encodeFrame(ptype, data || Buffer.alloc(0));
      if (trace) trace('>', ptype, data ? data.length : 0);
      this._writeRaw(lastFrame);
      arm();
    };

    this._fileHandler = (ptype, data) => {
      if (finished) return;
      if (trace) trace('<', ptype, data.length);
      arm();
      switch (ptype) {
        case PTYPE_FILE_CAN:
          finish(new Error('download canceled by machine'));
          break;
        case PTYPE_FILE_RETRY:
          if (lastFrame) { this._writeRaw(lastFrame); arm(); }
          break;
        case PTYPE_FILE_MD5:
          md5hex = data.toString('latin1').trim();
          req(PTYPE_FILE_VIEW); // acknowledge md5, ask for metadata
          break;
        case PTYPE_FILE_VIEW:
          total = data.length >= 4 ? data.readUInt32BE(0) : 0;
          packetSize = data.length >= 6 ? data.readUInt16BE(4) : BLOCK_SIZE;
          if (total <= 0) { finish(null, Buffer.alloc(0)); break; }
          req(PTYPE_FILE_DATA, u32be(1));
          break;
        case PTYPE_FILE_DATA: {
          const seq = data.length >= 4 ? data.readUInt32BE(0) : 1;
          chunks.set(seq, data.subarray(4));
          this.emit('download-progress', { seq, total });
          if (seq >= total) { req(PTYPE_FILE_END); finish(null, assemble()); }
          else req(PTYPE_FILE_DATA, u32be(seq + 1));
          break;
        }
        case PTYPE_FILE_END:
          finish(null, assemble());
          break;
      }
    };

    // Kick off: announce the download target, then request the md5. The machine
    // may also push the md5 unprompted — either way the handler drives on.
    this._writeRaw(encodeFrame(PTYPE_FILE_START, Buffer.from(`download ${escapeShellPath(path)}\n`)));
    if (trace) trace('>', PTYPE_FILE_START, 0);
    req(PTYPE_FILE_MD5);
  }

  async makeDir(path) {
    await this.runShell(`mkdir ${escapeShellPath(path)}`);
    return true;
  }

  async remove(path) {
    const raw = await this.runShell(`rm ${escapeShellPath(path)}`);
    if (/Could not delete/i.test(raw)) throw new Error(`could not delete: ${path}`);
    return true;
  }

  async rename(from, to) {
    const raw = await this.runShell(`mv ${escapeShellPath(from)} ${escapeShellPath(to)}`);
    if (/Could not|error/i.test(raw)) throw new Error(`could not rename: ${from}`);
    return true;
  }
}
