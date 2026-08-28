/*****************************************************************************
 * EVM-H5 shield board abstraction: SPI bus, PIO pins and the TMF8829 SPI
 * register access layer. Mirrors aos_com/h5_com.py + spi_hal_register_io.py.
 *****************************************************************************/

import { CoreCmd } from './corefw.js';

/** PIO (pin) identifiers of the EVM-H5, see corefw_c/evm_h5.py. */
export const PioId = Object.freeze({
  USER_BTN: 0, STAT_LED: 1,
  IXC1_SCL: 2, IXC1_SDA: 3, IXC2_SCL: 4, IXC2_SDA: 5,
  SPI1_NSS: 6, SPI1_SCK: 7, SPI1_MOSI: 8, SPI1_MISO: 9,
  SPI2_NSS: 10, SPI2_SCK: 11, SPI2_MOSI: 12, SPI2_MISO: 13,
  GPIO0: 14, GPIO1: 15, GPIO2: 16, GPIO3: 17,
  UART_TX: 18, UART_RX: 19,
  EN_3V3: 20, EN_1V8: 21, EN_VIO: 22,
});

export const PioMode = Object.freeze({
  INPUT_TRIG_NONE: 0,
  INPUT_TRIG_RISING: 1,
  INPUT_TRIG_FALLING: 2,
  INPUT_TRIG_BOTH: 3,
  OUTPUT_TYPE_PP: 4,
  OUTPUT_TYPE_OD: 5,
});

export const PioPull = Object.freeze({ NONE: 0, UP: 1, DOWN: 2 });
export const PioState = Object.freeze({ RESET: 0, SET: 1, TOGGLE: 2 });
export const SpiFirstBit = Object.freeze({ MSB: 0, LSB: 1 });
export const SPI_MAIN = 0;

/** The TMF8829 shield wires ENABLE to GPIO1 and the sensor interrupt to GPIO0. */
export const TMF8829_ENABLE_PIN = PioId.GPIO1;
export const TMF8829_INTERRUPT_PIN = PioId.GPIO0;

/** Core FW payload limits for a single SPI_XFER_EXTENDED message. */
const MAX_SEND = 498;
const MAX_RECV = 2032;

/** NSS control bits of SPI_XFER_EXTENDED. */
const NSS_ASSERT_BEFORE = 0x01;
const NSS_RELEASE_AFTER = 0x02;

export class H5Board {
  /** @param {import('./corefw.js').CoreFw} corefw */
  constructor(corefw) {
    this.corefw = corefw;
    this.spiId = SPI_MAIN;
    this._pinModes = new Map();
  }

  // ------------------------------------------------------------------ SPI --

  async spiOpen(frequencyHz = 1_000_000, mode = 0, firstBit = SpiFirstBit.MSB) {
    const payload = new Uint8Array(8);
    payload[0] = 1;            // enable
    payload[1] = mode & 0x03;
    payload[2] = firstBit & 0x01;
    payload[3] = 0;            // reserved
    new DataView(payload.buffer).setUint32(4, frequencyHz, true);
    await this.corefw.request(CoreCmd.SPI_CONFIG, this.spiId, payload);
  }

  async spiClose() {
    const payload = new Uint8Array(8);
    await this.corefw.request(CoreCmd.SPI_CONFIG, this.spiId, payload);
  }

  /**
   * Single SPI_XFER_EXTENDED message: sends `sendData`, then clocks in
   * `recvSize` bytes. `nssFlags` gives direct control over the chip select so
   * that transfers larger than one message can share a single CS assertion.
   */
  async spiXfer(nssFlags, sendData, recvSize) {
    const payload = new Uint8Array(4 + sendData.length);
    payload[0] = nssFlags;
    payload[1] = 0;
    new DataView(payload.buffer).setUint16(2, recvSize, true);
    payload.set(sendData, 4);
    return this.corefw.request(CoreCmd.SPI_XFER_EXTENDED, this.spiId, payload);
  }

  // ------------------------------------------------------------------ PIO --

  async pioConfig(pin, mode, pull = PioPull.NONE) {
    await this.corefw.request(CoreCmd.PIO_CONFIG, pin, new Uint8Array([1, mode, pull]));
    this._pinModes.set(pin, mode);
  }

  async pioShutdown(pin) {
    await this.corefw.request(CoreCmd.PIO_CONFIG, pin, new Uint8Array([0, 0, 0]));
    this._pinModes.delete(pin);
  }

  async _ensureMode(pin, mode) {
    if (this._pinModes.get(pin) !== mode) await this.pioConfig(pin, mode);
  }

  async pinSet(pin, high) {
    await this._ensureMode(pin, PioMode.OUTPUT_TYPE_PP);
    const state = high ? PioState.SET : PioState.RESET;
    await this.corefw.request(CoreCmd.PIO_XFER, pin, new Uint8Array([state]));
  }

  async pinGet(pin) {
    await this._ensureMode(pin, PioMode.INPUT_TRIG_NONE);
    const payload = await this.corefw.request(CoreCmd.PIO_XFER, pin, new Uint8Array(0));
    return payload.length ? payload[0] : 0;
  }

  /** Forces a re-configuration on the next access (used after re-enabling). */
  forgetPinModes() {
    this._pinModes.clear();
  }
}

/**
 * TMF8829 register access over SPI.
 * Write frame: 0x02, address, data...
 * Read frame:  0x03, address, dummy byte, then the data is clocked in.
 */
export class SpiRegisterIo {
  static WR_CMD = 0x02;
  static RD_CMD = 0x03;

  /** @param {H5Board} board */
  constructor(board) {
    this.board = board;
  }

  /** Writes `data` starting at register `address`. */
  async tx(address, data) {
    const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data);
    const frame = new Uint8Array(2 + bytes.length);
    frame[0] = SpiRegisterIo.WR_CMD;
    frame[1] = address & 0xff;
    frame.set(bytes, 2);

    for (let offset = 0; offset < frame.length; offset += MAX_SEND) {
      const chunk = frame.subarray(offset, Math.min(offset + MAX_SEND, frame.length));
      const isFirst = offset === 0;
      const isLast = offset + chunk.length >= frame.length;
      const flags = (isFirst ? NSS_ASSERT_BEFORE : 0) | (isLast ? NSS_RELEASE_AFTER : 0);
      await this.board.spiXfer(flags, chunk, 0);
    }
  }

  /** Reads `size` bytes starting at register `address`. */
  async txRx(address, size) {
    const out = new Uint8Array(size);
    const head = new Uint8Array([SpiRegisterIo.RD_CMD, address & 0xff, 0x00]);
    if (size === 0) {
      await this.board.spiXfer(NSS_ASSERT_BEFORE | NSS_RELEASE_AFTER, head, 0);
      return out;
    }

    let offset = 0;
    let first = true;
    while (offset < size) {
      // recv_data is sampled from the first clock cycle, so the command phase
      // of the first message has to be received and skipped as well.
      const lead = first ? head.length : 0;
      const chunk = Math.min(MAX_RECV - lead, size - offset);
      const isLast = offset + chunk >= size;
      const flags = (first ? NSS_ASSERT_BEFORE : 0) | (isLast ? NSS_RELEASE_AFTER : 0);
      const received = await this.board.spiXfer(flags, first ? head : new Uint8Array(0), lead + chunk);
      if (received.length !== lead + chunk) {
        throw new Error(`SPI read returned ${received.length} bytes, expected ${lead + chunk}`);
      }
      out.set(received.subarray(lead), offset);
      offset += chunk;
      first = false;
    }
    return out;
  }

  async readByte(address) {
    return (await this.txRx(address, 1))[0];
  }

  async writeByte(address, value) {
    await this.tx(address, [value & 0xff]);
  }
}
