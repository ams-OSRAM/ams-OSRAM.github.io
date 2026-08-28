/*****************************************************************************
 * ams OSRAM Core FW RPC protocol (v11.0.1) over the Web Serial API.
 *
 * Message layout (little endian):
 *   [0]     synchronization byte, always 0x55
 *   [1]     command id
 *   [2]     target id
 *   [3]     error code (0 in requests)
 *   [4..7]  payload length (uint32)
 *   [8..]   payload
 *   [..]    checksum (uint16, CRC-16/CCITT-FALSE over all preceding bytes)
 *
 * The protocol is synchronous: one request is answered by one response with
 * the same command id / target id. The device may additionally send
 * unsolicited (asynchronous) messages, which are dispatched separately.
 *****************************************************************************/

import { crc16ccitt } from './crc16.js';

export const SYNC_BYTE = 0x55;
export const HEADER_SIZE = 8;
export const CHECKSUM_SIZE = 2;
export const MAX_PAYLOAD = 2048;

export const CoreCmd = Object.freeze({
  APPL_NAME: 0x00,
  VERSION: 0x01,
  RESET: 0x02,
  I2C_CONFIG: 0x03,
  I2C_XFER: 0x04,
  SPI_CONFIG: 0x05,
  SPI_XFER: 0x06,
  PIO_CONFIG: 0x07,
  PIO_XFER: 0x08,
  PIO_STATE: 0x09,
  SYS_START_BL: 0x0a,
  I2C_XFER_16BIT: 0x0e,
  HW_REV: 0x0f,
  HW_PLATFORM: 0x10,
  SERIAL_NUMBER: 0x13,
  CORE_FW_VERSION: 0x15,
  SPI_XFER_EXTENDED: 0x1d,
});

export const ERROR_NAMES = Object.freeze({
  0: 'SUCCESS', 1: 'PERMISSION', 2: 'MESSAGE', 3: 'MESSAGE_SIZE', 4: 'POINTER',
  5: 'ACCESS', 6: 'ARGUMENT', 7: 'SIZE', 8: 'NOT_SUPPORTED', 9: 'TIMEOUT',
  10: 'CHECKSUM', 11: 'OVERFLOW', 12: 'EVENT', 13: 'INTERRUPT', 14: 'TIMER_ACCESS',
  15: 'LED_ACCESS', 16: 'TEMP_SENSOR_ACCESS', 17: 'DATA_TRANSFER', 18: 'FIFO',
  19: 'OVER_TEMP', 20: 'IDENTIFICATION', 21: 'COM_INTERFACE', 22: 'SYNCHRONIZATION',
  23: 'PROTOCOL', 24: 'MEMORY', 25: 'THREAD', 26: 'SPI', 27: 'DAC_ACCESS',
  29: 'NO_DATA', 30: 'SYSTEM_CONFIG', 31: 'USB_ACCESS', 32: 'ADC_ACCESS',
  33: 'SENSOR_CONFIG', 34: 'SATURATION', 35: 'MUTEX', 36: 'ACCELEROMETER',
  37: 'CONFIG', 38: 'BLE', 39: 'FILE', 40: 'DATA', 41: 'BUSY',
});

export class CoreFwError extends Error {
  constructor(cmdId, targetId, code) {
    super(`Core FW command 0x${cmdId.toString(16)} (target ${targetId}) failed: ` +
          `${ERROR_NAMES[code] ?? 'UNKNOWN'} (${code})`);
    this.name = 'CoreFwError';
    this.cmdId = cmdId;
    this.targetId = targetId;
    this.code = code;
  }
}

/** Growable FIFO byte buffer used by the receive path. */
class RxBuffer {
  constructor(capacity = 1 << 16) {
    this.buf = new Uint8Array(capacity);
    this.start = 0;
    this.end = 0;
  }

  get length() {
    return this.end - this.start;
  }

  push(chunk) {
    if (this.end + chunk.length > this.buf.length) {
      const used = this.length;
      if (used + chunk.length > this.buf.length) {
        const grown = new Uint8Array(Math.max(this.buf.length * 2, used + chunk.length));
        grown.set(this.buf.subarray(this.start, this.end));
        this.buf = grown;
      } else {
        this.buf.copyWithin(0, this.start, this.end);
      }
      this.start = 0;
      this.end = used;
    }
    this.buf.set(chunk, this.end);
    this.end += chunk.length;
  }

  at(index) {
    return this.buf[this.start + index];
  }

  view(offset, length) {
    return this.buf.subarray(this.start + offset, this.start + offset + length);
  }

  consume(count) {
    this.start += count;
    if (this.start >= this.end) {
      this.start = 0;
      this.end = 0;
    }
  }

  clear() {
    this.start = 0;
    this.end = 0;
  }
}

export class CoreFw {
  /**
   * @param {object} [options]
   * @param {(msg: object) => void} [options.onAsyncMessage] called for unsolicited messages
   * @param {(text: string) => void} [options.onLog]
   */
  constructor({ onAsyncMessage = null, onLog = null } = {}) {
    this.port = null;
    this.onAsyncMessage = onAsyncMessage;
    this.onLog = onLog;
    this._reader = null;
    this._writer = null;
    this._readTask = null;
    this._rx = new RxBuffer();
    this._pending = null;
    this._queue = Promise.resolve();
    this._closing = false;
  }

  get isOpen() {
    return this.port !== null;
  }

  _log(text) {
    if (this.onLog) this.onLog(text);
  }

  /**
   * Opens a serial port. The Core FW requires RTS to be asserted.
   * @param {SerialPort} port
   * @param {number} baudRate
   */
  async open(port, baudRate = 115200) {
    if (this.port) throw new Error('Port already open');
    await port.open({ baudRate, dataBits: 8, stopBits: 1, parity: 'none', bufferSize: 1 << 18 });
    try {
      await port.setSignals({ dataTerminalReady: true, requestToSend: true });
    } catch (err) {
      this._log(`Warning: could not set RTS/DTR (${err.message})`);
    }
    this.port = port;
    this._closing = false;
    this._rx.clear();
    this._writer = port.writable.getWriter();
    this._reader = port.readable.getReader();
    this._readTask = this._readLoop();
  }

  async close() {
    if (!this.port) return;
    this._closing = true;
    const port = this.port;
    this.port = null;
    try { await this._reader?.cancel(); } catch { /* ignore */ }
    try { await this._readTask; } catch { /* ignore */ }
    try { this._reader?.releaseLock(); } catch { /* ignore */ }
    try { this._writer?.releaseLock(); } catch { /* ignore */ }
    this._reader = null;
    this._writer = null;
    this._readTask = null;
    if (this._pending) {
      this._pending.reject(new Error('Port closed'));
      this._pending = null;
    }
    try { await port.close(); } catch { /* ignore */ }
  }

  async _readLoop() {
    while (!this._closing) {
      let result;
      try {
        result = await this._reader.read();
      } catch (err) {
        if (!this._closing) this._log(`Serial read error: ${err.message}`);
        break;
      }
      if (result.done) break;
      if (result.value && result.value.length) {
        this._rx.push(result.value);
        this._parse();
      }
    }
  }

  _parse() {
    for (;;) {
      // Re-synchronize on the sync byte.
      while (this._rx.length > 0 && this._rx.at(0) !== SYNC_BYTE) {
        this._rx.consume(1);
      }
      if (this._rx.length < HEADER_SIZE) return;

      const header = this._rx.view(0, HEADER_SIZE);
      const payloadLength = new DataView(header.buffer, header.byteOffset, HEADER_SIZE).getUint32(4, true);
      if (payloadLength > MAX_PAYLOAD) {
        this._rx.consume(1);
        continue;
      }
      const total = HEADER_SIZE + payloadLength + CHECKSUM_SIZE;
      if (this._rx.length < total) return;

      const body = this._rx.view(0, HEADER_SIZE + payloadLength);
      const expected = crc16ccitt(body);
      const actual = this._rx.at(total - 2) | (this._rx.at(total - 1) << 8);
      if (expected !== actual) {
        this._log('Checksum mismatch - resynchronizing');
        this._rx.consume(1);
        continue;
      }

      const message = {
        cmdId: this._rx.at(1),
        targetId: this._rx.at(2),
        errorCode: this._rx.at(3),
        payload: this._rx.view(HEADER_SIZE, payloadLength).slice(),
      };
      this._rx.consume(total);
      this._dispatch(message);
    }
  }

  _dispatch(message) {
    const pending = this._pending;
    if (pending && pending.cmdId === message.cmdId && pending.targetId === message.targetId) {
      this._pending = null;
      clearTimeout(pending.timer);
      if (message.errorCode !== 0) {
        pending.reject(new CoreFwError(message.cmdId, message.targetId, message.errorCode));
      } else {
        pending.resolve(message.payload);
      }
      return;
    }
    if (this.onAsyncMessage) this.onAsyncMessage(message);
  }

  static buildMessage(cmdId, targetId, payload) {
    const frame = new Uint8Array(HEADER_SIZE + payload.length + CHECKSUM_SIZE);
    const view = new DataView(frame.buffer);
    frame[0] = SYNC_BYTE;
    frame[1] = cmdId & 0xff;
    frame[2] = targetId & 0xff;
    frame[3] = 0;
    view.setUint32(4, payload.length, true);
    frame.set(payload, HEADER_SIZE);
    const crc = crc16ccitt(frame.subarray(0, HEADER_SIZE + payload.length));
    view.setUint16(HEADER_SIZE + payload.length, crc, true);
    return frame;
  }

  /**
   * Sends a request and waits for the matching response.
   * @returns {Promise<Uint8Array>} the response payload
   */
  request(cmdId, targetId = 0, payload = new Uint8Array(0), { timeout = 3000, expectResponse = true } = {}) {
    const run = async () => {
      if (!this.port) throw new Error('Serial port is not open');
      const frame = CoreFw.buildMessage(cmdId, targetId, payload);
      if (!expectResponse) {
        await this._writer.write(frame);
        return new Uint8Array(0);
      }
      const responsePromise = new Promise((resolve, reject) => {
        this._pending = {
          cmdId, targetId, resolve, reject,
          timer: setTimeout(() => {
            this._pending = null;
            reject(new Error(`Timeout waiting for response to command 0x${cmdId.toString(16)}`));
          }, timeout),
        };
      });
      try {
        await this._writer.write(frame);
      } catch (error) {
        if (this._pending) {
          clearTimeout(this._pending.timer);
          this._pending = null;
        }
        throw error;
      }
      return responsePromise;
    };
    const result = this._queue.then(run, run);
    this._queue = result.catch(() => {});
    return result;
  }

  // ---------------------------------------------------------------- info ---

  async readString(cmdId) {
    const payload = await this.request(cmdId, 0);
    return new TextDecoder().decode(payload).replace(/\0+$/, '');
  }

  applicationName() { return this.readString(CoreCmd.APPL_NAME); }
  version() { return this.readString(CoreCmd.VERSION); }
  hardwareRevision() { return this.readString(CoreCmd.HW_REV); }
  serialNumber() { return this.readString(CoreCmd.SERIAL_NUMBER); }
  coreFwVersion() { return this.readString(CoreCmd.CORE_FW_VERSION); }

  async hardwarePlatform() {
    const payload = await this.request(CoreCmd.HW_PLATFORM, 0);
    return { type: payload[0], variant: payload[1] };
  }
}
