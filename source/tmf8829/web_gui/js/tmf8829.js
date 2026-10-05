/*****************************************************************************
 * TMF8829 driver: device control, bootloader download and application layer.
 * Port of tmf8829_bootloader.py and tmf8829_application.py.
 *****************************************************************************/

import { TMF8829_ENABLE_PIN, TMF8829_INTERRUPT_PIN } from './h5.js';
import { parseIntelHex } from './intelhex.js';
import {
  AppCmd, AppReg, AppStat, Bl, CfgReg, Enable, Frame, FpMode, HostReg, Reset, ResultFormat,
} from './registers.js';
import {
  framesPerMeasurement, histogramFrameDataSize, parseHeader, parseFooter, resultFrameDataSize,
} from './frames.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function insertField(value, field, fieldValue) {
  return (value & ~field.mask & 0xff) | ((fieldValue << field.shift) & field.mask);
}

export class Tmf8829 {
  /**
   * @param {import('./h5.js').H5Board} board
   * @param {import('./h5.js').SpiRegisterIo} io
   */
  constructor(board, io, { onLog = null } = {}) {
    this.board = board;
    this.io = io;
    this.onLog = onLog;

    // Shadow copies of write-only host registers (see aos_com RegisterIo).
    this.shadow = { [HostReg.ENABLE]: Enable.RESET_VALUE, [HostReg.RESET]: Reset.RESET_VALUE };

    // Cached configuration, kept in sync with the device config page.
    this.cfgFpMode = FpMode.M16x16;
    this.cfgResultFormat = 1;
    this.cfgHistograms = 0;
    this.cfgRefFrame = 0;
    this.cfgDualMode = 0;
  }

  _log(text) {
    if (this.onLog) this.onLog(text);
  }

  // --------------------------------------------------------- host registers -

  async _writeEnable(fields) {
    let value = this.shadow[HostReg.ENABLE];
    for (const [field, fieldValue] of fields) value = insertField(value, field, fieldValue);
    this.shadow[HostReg.ENABLE] = value;
    await this.io.writeByte(HostReg.ENABLE, value);
  }

  async readEnable() {
    const value = await this.io.readByte(HostReg.ENABLE);
    this.shadow[HostReg.ENABLE] = value;
    return value;
  }

  // ------------------------------------------------------------ device ------

  /** Configures the SPI bus and drives the sensor ENABLE pin low. */
  async open(spiSpeedHz = 20_000_000, spiMode = 0) {
    await this.board.spiOpen(spiSpeedHz, spiMode);
    this.board.forgetPinModes();
    await this.board.pioShutdown(TMF8829_INTERRUPT_PIN).catch(() => {});
    await this.board.pinSet(TMF8829_ENABLE_PIN, false);
  }

  async close() {
    await this.board.pinSet(TMF8829_ENABLE_PIN, false).catch(() => {});
    await this.board.spiClose().catch(() => {});
  }

  /** Raises ENABLE and (optionally) forces the device into the boot monitor. */
  async enable(sendWakeUpSequence = true) {
    await this.board.pinSet(TMF8829_ENABLE_PIN, true);
    await this.board.pinSet(TMF8829_ENABLE_PIN, true);
    await sleep(3);
    if (sendWakeUpSequence) return this.wakeUp(Enable.POWERUP_FORCE_BOOTMONITOR);
    return true;
  }

  async disable() {
    await this.board.pinSet(TMF8829_ENABLE_PIN, false);
  }

  async wakeUp(powerupSelect = Enable.POWERUP_RAM) {
    await this._writeEnable([[Enable.PON, 1], [Enable.POWERUP_SELECT, powerupSelect]]);
    await sleep(3);
    const value = await this.readEnable();
    return (value & Enable.CPU_READY.mask) !== 0;
  }

  async forceBootmonitor() {
    await this._writeEnable([[Enable.PON, 1], [Enable.POWERUP_SELECT, Enable.POWERUP_FORCE_BOOTMONITOR]]);
    await this.softResetPin();
  }

  async softResetPin() {
    const value = insertField(this.shadow[HostReg.RESET], Reset.SOFT_RESET, 1);
    this.shadow[HostReg.RESET] = value;
    await this.io.writeByte(HostReg.RESET, value);
    await sleep(3);
  }

  async isDeviceWakeup() {
    const value = await this.readEnable();
    return (value & Enable.PON.mask) !== 0 && (value & Enable.CPU_READY.mask) !== 0;
  }

  async isIntPinLow() {
    return (await this.board.pinGet(TMF8829_INTERRUPT_PIN)) === 0;
  }

  async readIntStatus() {
    return this.io.readByte(HostReg.INT_STATUS);
  }

  async clearIntStatus(mask) {
    await this.io.writeByte(HostReg.INT_STATUS, mask);
  }

  async enableInt(mask) {
    await this.io.writeByte(HostReg.INT_ENAB, mask);
  }

  async readAndClearInt(mask) {
    const status = (await this.readIntStatus()) & mask;
    if (status) await this.clearIntStatus(status);
    return status;
  }

  // ---------------------------------------------------------- bootloader ----

  /** Executes a boot monitor command and polls CMD_STAT for the response. */
  async blCmd(cmd, data = [], responseLength = 1, timeoutMs = 1000) {
    if (data.length) {
      await this.io.tx(Bl.REG_CMD_STAT, [cmd, data.length, ...data]);
    } else {
      await this.io.tx(Bl.REG_CMD_STAT, [cmd]);
    }
    if (responseLength <= 0) return new Uint8Array([Bl.READY]);

    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const response = await this.io.txRx(Bl.REG_CMD_STAT, responseLength);
      if (response[0] !== cmd) return response;
      if (performance.now() > deadline) {
        throw new Error(`Boot monitor command 0x${cmd.toString(16)} timed out`);
      }
    }
  }

  async _blCmdChecked(cmd, data = [], responseLength = 1, timeoutMs = 1000) {
    const response = await this.blCmd(cmd, data, responseLength, timeoutMs);
    if (response[0] !== Bl.READY) {
      throw new Error(`Boot monitor command 0x${cmd.toString(16)} failed with status ${response[0]}`);
    }
    return response;
  }

  blCmdI2cOff() { return this._blCmdChecked(Bl.CMD_I2C_OFF); }
  blCmdSpiOff() { return this._blCmdChecked(Bl.CMD_SPI_OFF); }

  blCmdAddrRam(address) {
    const bytes = [address & 0xff, (address >> 8) & 0xff, (address >> 16) & 0xff, (address >>> 24) & 0xff];
    return this._blCmdChecked(Bl.CMD_ADDR_RAM, bytes);
  }

  blCmdWRamBoth(chunk) { return this._blCmdChecked(Bl.CMD_W_RAM_BOTH, Array.from(chunk)); }

  async blCmdRRam(length) {
    const response = await this._blCmdChecked(Bl.CMD_R_RAM, [length], length + 2);
    return response.subarray(2);
  }

  async blCmdWFifoBoth(address, data) {
    if (data.length % 4 !== 0) throw new Error('FIFO download requires a word aligned size');
    const words = data.length / 4;
    const parameters = [
      address & 0xff, (address >> 8) & 0xff, (address >> 16) & 0xff, (address >>> 24) & 0xff,
      words & 0xff, (words >> 8) & 0xff,
    ];
    await this._blCmdChecked(Bl.CMD_W_FIFO_BOTH, parameters);
    await this.io.tx(Bl.REG_FIFO, data);
  }

  async blCmdStartRamApp(appId = Bl.APP_ID, timeoutMs = 200) {
    await this._blCmdChecked(Bl.CMD_START_RAM_APP, [], 10);
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const data = await this.io.txRx(0x00, 4);
      if (data[0] === appId) return data;
      if (performance.now() > deadline) {
        throw new Error(`Application did not start, expected app id 0x${appId.toString(16)}, read 0x${data[0].toString(16)}`);
      }
    }
  }

  /**
   * Downloads an Intel HEX image into the device RAM and starts it.
   * @param {string} hexText contents of tmf8829_application.hex
   */
  async downloadAndStartApp(hexText, { useFifo = true, verify = true, onProgress = null } = {}) {
    const { startAddress, data } = parseIntelHex(hexText);
    this._log(`Downloading ${data.length} bytes to 0x${startAddress.toString(16)}`);

    if (useFifo) {
      await this.blCmdWFifoBoth(startAddress, data);
      onProgress?.(1);
    } else {
      await this.blCmdAddrRam(startAddress);
      for (let offset = 0; offset < data.length; offset += Bl.MAX_DATA_SIZE) {
        await this.blCmdWRamBoth(data.subarray(offset, Math.min(offset + Bl.MAX_DATA_SIZE, data.length)));
        onProgress?.(offset / data.length);
      }
    }

    if (verify) {
      await this.blCmdAddrRam(startAddress);
      for (let offset = 0; offset < data.length; offset += Bl.MAX_DATA_SIZE) {
        const expected = data.subarray(offset, Math.min(offset + Bl.MAX_DATA_SIZE, data.length));
        const actual = await this.blCmdRRam(expected.length);
        for (let i = 0; i < expected.length; i++) {
          if (expected[i] !== actual[i]) {
            throw new Error(`Verify failed at 0x${(startAddress + offset + i).toString(16)}: ` +
                            `expected 0x${expected[i].toString(16)}, read 0x${actual[i].toString(16)}`);
          }
        }
        onProgress?.(offset / data.length);
      }
    }

    const appInfo = await this.blCmdStartRamApp();
    // Make sure a standby / timed standby leads to a proper reboot from RAM.
    await this._writeEnable([[Enable.POWERUP_SELECT, Enable.POWERUP_RAM]]);
    onProgress?.(1);
    return appInfo;
  }

  // --------------------------------------------------------- application ----

  async readSerialNumber() {
    const bytes = await this.io.txRx(AppReg.SERIAL_NUMBER_0, 4);
    return bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
  }

  async readAppId() {
    return this.io.txRx(AppReg.APP_ID, 4);
  }

  /** Writes a command to CMD_STAT and waits for it to be accepted. */
  async sendCommand(cmd, { timeoutMs = 1500, waitOnlyForOk = false } = {}) {
    await this.io.tx(AppReg.CMD_STAT, [cmd]);
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      const response = await this.io.txRx(AppReg.CMD_STAT, 2);
      if (response.length && response[0] < AppCmd.MEASURE) {
        if (response[0] > AppStat.ACCEPTED) {
          throw new Error(`Command ${cmd} failed with status ${response[0]}`);
        }
        if (!waitOnlyForOk || response[0] === AppStat.OK) return response;
      }
      if (performance.now() > deadline) throw new Error(`Command ${cmd} timed out`);
    }
  }

  /** Applies one of the built-in pre-configurations (CMD_LOAD_CFG_*). */
  async preConfigure(cmd) {
    await this.sendCommand(cmd);
    await this.loadConfig();
  }

  /** Reads the config page and refreshes the cached configuration. */
  async loadConfig() {
    await this.sendCommand(AppCmd.LOAD_CONFIG_PAGE);
    const count = CfgReg.LAST_AVAILABLE - CfgReg.PERIOD_MS_LSB + 1;
    const page = await this.io.txRx(CfgReg.PERIOD_MS_LSB, count);
    const at = (address) => page[address - CfgReg.PERIOD_MS_LSB];

    this.cfgFpMode = at(CfgReg.FP_MODE) & 0x0f;
    this.cfgResultFormat = at(CfgReg.RESULT_FORMAT);
    this.cfgHistograms = at(CfgReg.DUMP_HISTOGRAMS) & 0x01;
    this.cfgRefFrame = at(CfgReg.REF_SPAD_FRAME) & 0x01;
    this.cfgDualMode = at(CfgReg.ENABLE_DUAL_MODE) & 0x01;
    return {
      page,
      period: at(CfgReg.PERIOD_MS_LSB) | (at(CfgReg.PERIOD_MS_LSB + 1) << 8),
      iterations: at(CfgReg.KILO_ITERATIONS_LSB) | (at(CfgReg.KILO_ITERATIONS_LSB + 1) << 8),
      fpMode: this.cfgFpMode,
      resultFormat: this.cfgResultFormat,
      histograms: this.cfgHistograms,
      publish: this.cfgRefFrame,
      dualMode: this.cfgDualMode,
      confidenceThreshold: at(CfgReg.ALG_CONFIDENCE_THRESHOLD),
      distanceInMm: at(CfgReg.DISTANCE_RESOLUTION) & 0x01,
    };
  }

  /**
   * Loads the config page, patches the given settings and writes it back.
   * Only defined properties are modified.
   */
  async configure(settings = {}) {
    await this.sendCommand(AppCmd.LOAD_CONFIG_PAGE);

    const {
      period, iterations, fpMode, nrPeaks, signalStrength, noiseStrength, xtalk, fullNoise,
      histograms, publish, confidenceThreshold, dualMode, distanceInMm, highAccuracyIterations,
    } = settings;

    if (period !== undefined) {
      await this.io.tx(CfgReg.PERIOD_MS_LSB, [period & 0xff, (period >> 8) & 0xff]);
    }
    if (iterations !== undefined) {
      await this.io.tx(CfgReg.KILO_ITERATIONS_LSB, [iterations & 0xff, (iterations >> 8) & 0xff]);
    }
    if (highAccuracyIterations !== undefined) {
      await this.io.tx(CfgReg.HA_KILO_ITERATIONS_LSB,
        [highAccuracyIterations & 0xff, (highAccuracyIterations >> 8) & 0xff]);
    }
    if (fpMode !== undefined) {
      await this.io.writeByte(CfgReg.FP_MODE, fpMode);
      this.cfgFpMode = fpMode;
    }

    const formatFields = [
      [nrPeaks, ResultFormat.NR_PEAKS],
      [signalStrength, ResultFormat.SIGNAL_STRENGTH],
      [noiseStrength, ResultFormat.NOISE_STRENGTH],
      [xtalk, ResultFormat.XTALK],
      [fullNoise, ResultFormat.FULL_NOISE],
    ].filter(([value]) => value !== undefined);

    if (formatFields.length) {
      let format = await this.io.readByte(CfgReg.RESULT_FORMAT);
      for (const [value, field] of formatFields) format = insertField(format, field, Number(value));
      await this.io.writeByte(CfgReg.RESULT_FORMAT, format);
      this.cfgResultFormat = format;
    }

    if (histograms !== undefined) {
      await this.io.writeByte(CfgReg.DUMP_HISTOGRAMS, Number(histograms));
      this.cfgHistograms = Number(histograms);
    }
    if (publish !== undefined) {
      await this.io.writeByte(CfgReg.REF_SPAD_FRAME, Number(publish));
      this.cfgRefFrame = Number(publish);
    }
    if (dualMode !== undefined) {
      await this.io.writeByte(CfgReg.ENABLE_DUAL_MODE, Number(dualMode));
      this.cfgDualMode = Number(dualMode);
    }
    if (confidenceThreshold !== undefined) {
      await this.io.writeByte(CfgReg.ALG_CONFIDENCE_THRESHOLD, confidenceThreshold);
    }
    if (distanceInMm !== undefined) {
      await this.io.writeByte(CfgReg.DISTANCE_RESOLUTION, Number(distanceInMm));
    }

    await this.sendCommand(AppCmd.WRITE_PAGE);
  }

  async startMeasure() {
    await this.clearIntStatus(0xff);
    await this.enableInt(Frame.INT_RESULTS | Frame.INT_HISTOGRAMS);
    return this.sendCommand(AppCmd.MEASURE);
  }

  async stopMeasure() {
    if (!(await this.isDeviceWakeup())) await this.wakeUp();
    await this.enableInt(0);
    await this.clearIntStatus(0xff);
    return this.sendCommand(AppCmd.STOP, { waitOnlyForOk: true });
  }

  // -------------------------------------------------------------- frames ----

  /** Reads one frame from the FIFO and validates the footer. */
  async readFrameWithSize(dataSize) {
    const total = Frame.PRE_HEADER_SIZE + Frame.HEADER_SIZE + dataSize + Frame.FOOTER_SIZE;
    const frame = await this.io.txRx(HostReg.FIFOSTATUS, total);
    const footer = parseFooter(frame);
    if (footer.eof !== Frame.EOF) {
      throw new Error(`Frame has no EOF marker but 0x${footer.eof.toString(16)}`);
    }
    if (!(footer.frameStatus & Frame.VALID)) {
      throw new Error(`Frame status is not valid: 0x${footer.frameStatus.toString(16)}`);
    }
    if (footer.frameStatus & Frame.WARNING_HV_CP_OVERLOAD) this._log('Warning: HV CP overload');
    if (footer.frameStatus & Frame.WARNING_VCDRV_OVERLOAD) this._log('Warning: VCDRV overload');
    if (footer.frameStatus & Frame.WARNING_VCDRV_BURST_EXCEEDED) this._log('Warning: VCDRV burst exceeded');
    return frame;
  }

  /** Reads the reference SPAD frame from the register map (not the FIFO). */
  async readRefSpadFrame() {
    const data = await this.io.txRx(AppReg.CID_RID, Frame.REF_SPAD_FRAME_SIZE);
    if ((data[0] & Frame.FID_MASK) !== Frame.FID_REF_SPAD_SCAN) return null;
    const frame = new Uint8Array(Frame.PRE_HEADER_SIZE + data.length);
    frame.set(data, Frame.PRE_HEADER_SIZE);
    return frame;
  }

  /** Polls the interrupt status and reads a frame when one is pending. */
  async readFrameIfAvailable() {
    if (!(await this.isDeviceWakeup())) return null;
    const status = await this.readAndClearInt(Frame.INT_HISTOGRAMS | Frame.INT_RESULTS);
    if (!status) return null;
    if (status === (Frame.INT_HISTOGRAMS | Frame.INT_RESULTS)) {
      throw new Error('Result and histogram interrupt pending at the same time - cannot tell which frame is next');
    }
    if (status === Frame.INT_HISTOGRAMS) {
      return { frame: await this.readFrameWithSize(histogramFrameDataSize(this.cfgFpMode)), refFrame: null };
    }
    const refFrame = this.cfgRefFrame ? await this.readRefSpadFrame() : null;
    const frame = await this.readFrameWithSize(resultFrameDataSize(this.cfgFpMode, this.cfgResultFormat));
    return { frame, refFrame };
  }

  /** Collects all frames that belong to one complete measurement. */
  async readMeasurement({ timeoutMs = 5000, shouldStop = null } = {}) {
    const expected = framesPerMeasurement(this.cfgFpMode, this.cfgHistograms, this.cfgDualMode, this.cfgRefFrame);
    const resultFrames = [];
    const histogramFrames = [];
    const refFrames = [];
    let collected = 0;
    const deadline = performance.now() + timeoutMs;
    const twoResultFrames = this.cfgFpMode > FpMode.M16x16;
    const dropResults = () => {
      collected -= resultFrames.length + refFrames.length;
      resultFrames.length = 0;
      refFrames.length = 0;
    };

    while (collected < expected) {
      if (shouldStop?.()) return null;
      const item = await this.readFrameIfAvailable();
      if (!item) {
        if (performance.now() > deadline) throw new Error('Timeout while waiting for measurement frames');
        await sleep(1);
        continue;
      }
      const header = parseHeader(item.frame);
      if (twoResultFrames && (header.id & Frame.FID_MASK) === Frame.FID_RESULTS) {
        // A lost sub-frame would pair halves of different measurements (or swap rows), so resync on sub-frame 0.
        const sub = (header.layout & ResultFormat.SUB_RESULT.mask) ? 1 : 0;
        if (sub === 0 && resultFrames.length) dropResults();
        if (sub === 1 && (resultFrames.length !== 1 || parseHeader(resultFrames[0]).fNumber !== header.fNumber - 1)) {
          dropResults();
          continue;
        }
      }
      if (item.refFrame) {
        refFrames.push(item.refFrame);
        collected++;
      }
      const fid = header.id & Frame.FID_MASK;
      if (fid === Frame.FID_RESULTS) resultFrames.push(item.frame);
      else if (fid === Frame.FID_HISTOGRAMS) histogramFrames.push(item.frame);
      collected++;
    }
    return { resultFrames, histogramFrames, refFrames };
  }
}
