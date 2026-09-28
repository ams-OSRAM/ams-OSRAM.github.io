/*****************************************************************************
 * Measurement logger: records measurements into an EVM compatible
 * `tmf8829_log_<epoch>.json.gz` file (see the EVM output file format).
 *****************************************************************************/

import { CfgReg } from './registers.js';
import { buildHistogramMap, buildPixelMap } from './frames.js';
import { getPixelXYZExact } from './render.js';

export const LOGGER_VERSION = '1';
export const HOST_VERSION = [1, 1];
// Keep in sync with the version shown in the page header.
export const WEB_GUI_VERSION = '1.2';

const CONFIG_BASE = CfgReg.PERIOD_MS_LSB;

/**
 * Config page fields as documented in `tmf8829_config_page.txt`. `bytes` are
 * read little endian, `shift`/`mask` select the field inside the raw value.
 */
const CONFIG_FIELDS = [
  { name: 'period', address: 0x22, bytes: 2 },
  { name: 'iterations', address: 0x24, bytes: 2 },
  { name: 'fp_mode', address: 0x26, mask: 0x07 },
  { name: 'spad_select', address: 0x27, mask: 0x3f },
  { name: 'ref_spad_select', address: 0x28, mask: 0x3f },
  { name: 'dead_time', address: 0x29, mask: 0x3f },
  { name: 'nr_peaks', address: 0x2a, mask: 0x07 },
  { name: 'signal_strength', address: 0x2a, shift: 3, mask: 0x01 },
  { name: 'noise_strength', address: 0x2a, shift: 4, mask: 0x01 },
  { name: 'xtalk', address: 0x2a, shift: 5, mask: 0x01 },
  { name: 'sub_result', address: 0x2a, shift: 6, mask: 0x01 },
  { name: 'full_noise', address: 0x2a, shift: 7, mask: 0x01 },
  { name: 'histograms', address: 0x2b, mask: 0x01 },
  { name: 'publish', address: 0x2c, mask: 0x01 },
  { name: 'bdv_temp_sensor', address: 0x2d, mask: 0x03 },
  { name: 'cpu_sleep', address: 0x2e, mask: 0x01 },
  { name: 'device_sleep', address: 0x2e, shift: 1, mask: 0x01 },
  { name: 'lp_osc_device_sleep', address: 0x2e, shift: 2, mask: 0x01 },
  { name: 'spad_cropping', address: 0x2e, shift: 3, mask: 0x01 },
  { name: 't0_vcsel', address: 0x30, mask: 0x03 },
  { name: 't1_vcsel', address: 0x30, shift: 2, mask: 0x03 },
  { name: 'dither_increment', address: 0x31, mask: 0x07 },
  { name: 'dither_rounds', address: 0x31, shift: 4, mask: 0x07 },
  { name: 'pulse_width', address: 0x32, mask: 0x03 },
  { name: 'ext_clk_input', address: 0x32, shift: 7, mask: 0x01 },
  { name: 'current', address: 0x33, mask: 0x7f },
  { name: 'hi_len', address: 0x34, mask: 0x0f },
  { name: 'ext_en_output', address: 0x34, shift: 4, mask: 0x01 },
  { name: 'ext_inv_output', address: 0x34, shift: 5, mask: 0x01 },
  { name: 'vcsel_period', address: 0x36, bytes: 2, mask: 0x03ff },
  { name: 'vcdrv_offset', address: 0x38, bytes: 2, mask: 0x03ff },
  { name: 'vc_spr_spec_amp', address: 0x3a, mask: 0x0f },
  { name: 'vc_spr_spec_cfg', address: 0x3a, shift: 4, mask: 0x03 },
  { name: 'vc_spr_spec_single_edge', address: 0x3a, shift: 6, mask: 0x01 },
  { name: 'histogram_bins', address: 0x40, bytes: 2, mask: 0x03ff },
  { name: 'bin_shift', address: 0x42, mask: 0x03 },
  { name: 'ref_bin_shift', address: 0x43, mask: 0x03 },
  { name: 'tdc_offset', address: 0x44, bytes: 2, mask: 0x03ff },
  { name: 'settling', address: 0x46, bytes: 2, mask: 0x03ff },
  { name: 'spr_spec_amp', address: 0x48, mask: 0x0f },
  { name: 'spr_spec_cfg', address: 0x48, shift: 4, mask: 0x03 },
  { name: 'spr_spec_single_edge', address: 0x48, shift: 6, mask: 0x01 },
  { name: 'high_accuracy_iterations', address: 0x4a, bytes: 2 },
  { name: 'dual_mode', address: 0x4c, mask: 0x03 },
  { name: 'hv_cp_overload_detect', address: 0x4d, mask: 0x01 },
  { name: 'peak_bins', address: 0x50, mask: 0x03 },
  { name: 'ref_peak_bins', address: 0x51, mask: 0x03 },
  { name: 'select', address: 0x52, mask: 0x03 },
  { name: 'confidence_threshold', address: 0x53 },
  { name: 'signal_level', address: 0x54, bytes: 2 },
  { name: 'poisson', address: 0x56 },
  { name: 'peak_detect_start', address: 0x57 },
  { name: 'min_distance_uq', address: 0x58, bytes: 2 },
  { name: 'parameter_a', address: 0x5a, bytes: 2 },
  { name: 'parameter_b', address: 0x5c, bytes: 2 },
  { name: 'add_100_mm_offset', address: 0x5f, mask: 0x01 },
  { name: 'int_zone_mask', address: 0x60, bytes: 8, signed: true },
  { name: 'int_threshold_low', address: 0x68, bytes: 2 },
  { name: 'int_threshold_high', address: 0x6a, bytes: 2 },
  { name: 'int_persistence', address: 0x6c },
  { name: 'post_processing', address: 0x6d },
  { name: 'prox_distance', address: 0x6e },
  { name: 'mp_top_x', address: 0x70, mask: 0x0f },
  { name: 'mp_top_y', address: 0x71, mask: 0x0f },
  { name: 'mp_bottom_x', address: 0x72, mask: 0x0f },
  { name: 'mp_bottom_y', address: 0x73, mask: 0x0f },
  { name: 'ref_mp', address: 0x74, mask: 0x0f },
  { name: 'fov_correction', address: 0x78, mask: 0x0f },
  { name: 'gpio0', address: 0x80, mask: 0x07 },
  { name: 'gpio1', address: 0x81, mask: 0x07 },
  { name: 'gpio2', address: 0x82, mask: 0x07 },
  { name: 'gpio3', address: 0x83, mask: 0x07 },
  { name: 'gpio4', address: 0x84, mask: 0x07 },
  { name: 'gpio5', address: 0x85, mask: 0x07 },
  { name: 'gpio6', address: 0x86, mask: 0x07 },
  { name: 'pre_delay', address: 0x87, mask: 0x03 },
  { name: 'i2c_slave_address', address: 0x90 },
  { name: 'xtalk_distance_mm', address: 0xa0 },
  { name: 'xtalk_max', address: 0xa2, bytes: 2 },
  { name: 'xtalk_edge', address: 0xa4, bytes: 2 },
  { name: 'motion_distance', address: 0xb0, bytes: 2 },
  { name: 'detect_snr', address: 0xb2 },
  { name: 'release_snr', address: 0xb3 },
  { name: 'motion_adjacent', address: 0xb4, mask: 0x0f },
  { name: 'last_cfg_register', address: 0xdf },
];

function readConfigField(page, { address, bytes = 1, shift = 0, mask = null, signed = false }) {
  const offset = address - CONFIG_BASE;
  if (offset < 0 || offset + bytes > page.length) return 0;

  if (bytes > 4) {
    let value = 0n;
    for (let i = bytes - 1; i >= 0; i--) value = (value << 8n) | BigInt(page[offset + i]);
    return Number(signed ? BigInt.asIntN(bytes * 8, value) : value);
  }

  let value = 0;
  for (let i = bytes - 1; i >= 0; i--) value = value * 256 + page[offset + i];
  const fieldMask = mask ?? (2 ** (bytes * 8) - 1);
  return Math.floor(value / 2 ** shift) & fieldMask;
}

function sortedByKey(object) {
  const sorted = {};
  for (const key of Object.keys(object).sort()) sorted[key] = object[key];
  return sorted;
}

/** Converts the raw config page into the named parameters of the log file. */
export function buildConfiguration(page) {
  const configuration = {};
  for (const field of CONFIG_FIELDS) configuration[field.name] = readConfigField(page, field);
  configuration.blob = Array.from(page, (byte) => `0x${byte.toString(16).padStart(2, '0')}`);
  return sortedByKey(configuration);
}

function toBinObjects(histograms) {
  return histograms.map((histogram) => ({ bin: histogram ? Array.from(histogram) : [] }));
}

function toHistogramMatrix(map) {
  return map.map((row) => toBinObjects(row));
}

/** Compresses a string with gzip; returns null when the browser cannot. */
async function gzip(text) {
  if (typeof CompressionStream !== 'function') return null;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

function download(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser a moment to start the download before dropping the blob.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export class MeasurementLogger {
  constructor({ onLog = null, onChange = null } = {}) {
    this._log = onLog;
    this._onChange = onChange;
    this.recording = false;
    this.records = [];
    this.requestedFrames = 0;
    this.configuration = null;
    this.info = null;
    this.dualMode = 0;
    this.fovCorrection = null;
  }

  get recordedFrames() {
    return this.records.length;
  }

  get complete() {
    return this.recording && this.records.length >= this.requestedFrames;
  }

  /**
   * Arms the logger. `configPage` is the raw config page as returned by
   * `Tmf8829.loadConfig()`, `info` holds the version / serial number block.
   */
  start({ frames, configPage, info }) {
    if (!configPage) throw new Error('No configuration available - initialize the sensor first.');
    this.records = [];
    this.requestedFrames = Math.max(1, Number(frames) || 1);
    this.configuration = buildConfiguration(configPage);
    this.info = info;
    this.dualMode = this.configuration.dual_mode;
    this.fovCorrection = this.configuration.fov_correction;
    this.recording = true;
    this._notify();
  }

  /** Appends one measurement; ignored when the logger is not recording. */
  addMeasurement({ resultFrames, histogramFrames = [] }) {
    if (!this.recording || !resultFrames?.length) return;
    if (this.records.length >= this.requestedFrames) return;
    this.records.push(this._buildRecord(resultFrames, histogramFrames));
    this._notify();
  }

  /** Stops recording and downloads the log file. Returns the file name. */
  async finish() {
    if (!this.recording) return null;
    this.recording = false;
    this._notify();

    const frames = this.records.length;
    if (!frames) {
      this._log?.('Logging stopped, no frames were recorded');
      return null;
    }

    const text = JSON.stringify({
      Result_Set: this.records,
      configuration: this.configuration,
      info: [this.info],
    }, null, 4);
    this.records = [];

    const epoch = Math.floor(Date.now() / 1000);
    const compressed = await gzip(text);
    const fileName = compressed ? `tmf8829_log_${epoch}.json.gz` : `tmf8829_log_${epoch}.json`;
    const blob = compressed ?? new Blob([text], { type: 'application/json' });
    download(blob, fileName);
    this._log?.(`Wrote ${fileName} with ${frames} frames (${(blob.size / 1024).toFixed(0)} kB)`);
    return fileName;
  }

  cancel() {
    this.recording = false;
    this.records = [];
    this._notify();
  }

  _notify() {
    this._onChange?.();
  }

  _buildRecord(resultFrames, histogramFrames) {
    const { header, footer, pixels } = buildPixelMap(resultFrames, { toMillimetres: true });
    const rows = pixels.length;
    const columns = rows ? pixels[0].length : 0;

    const results = pixels.map((row, y) => row.map((pixel, x) => {
      const entry = {};
      if (pixel.noise !== null) entry.noise = pixel.noise;
      entry.peaks = pixel.peaks.map((peak) => {
        const xyz = getPixelXYZExact(y, x, peak.distance, columns, rows, this.fovCorrection);
        const out = { distance: peak.distance };
        if (peak.signal !== null) out.signal = peak.signal;
        out.snr = peak.snr;
        out.x = xyz.x.toFixed(2);
        out.y = xyz.y.toFixed(2);
        out.z = xyz.z.toFixed(2);
        return out;
      });
      if (pixel.xtalk !== null) entry.xtalk = pixel.xtalk;
      return entry;
    }));

    const record = {
      info: {
        frame_number: header.fNumber,
        read_time: Math.round(performance.now() * 1000),
        systick_t0: footer.t0Integration,
        systick_t1: footer.t1Integration,
        temperature: header.temperature[0],
        warnings: (footer.frameStatus & 0xf8) >> 3,
      },
    };

    // In dual mode the second half of the histogram frames is the high accuracy pass.
    const splitHa = this.dualMode && histogramFrames.length > 1 && histogramFrames.length % 2 === 0;
    const normalFrames = splitHa ? histogramFrames.slice(0, histogramFrames.length / 2) : histogramFrames;
    const haFrames = splitHa ? histogramFrames.slice(histogramFrames.length / 2) : [];

    const normal = normalFrames.length ? buildHistogramMap(normalFrames) : null;
    if (normal) {
      record.mp_histo = toHistogramMatrix(normal.map);
      if (haFrames.length) {
        const highAccuracy = buildHistogramMap(haFrames);
        record.mp_histo_HA = toHistogramMatrix(highAccuracy.map);
        record.ref_histo = toBinObjects(normal.refHistograms);
        record.ref_histo_HA = toBinObjects(highAccuracy.refHistograms);
      } else {
        record.ref_histo = toBinObjects(normal.refHistograms);
      }
    }

    record.results = results;
    return sortedByKey(record);
  }
}
