/*****************************************************************************
 * TMF8829 frame layout helpers and parsers.
 * Port of tmf8829_application_common.py / tmf8829_application_defines.py.
 *****************************************************************************/

import { Frame, FpMode, ResultFormat } from './registers.js';

export const MP_FOV_ROWS = 16;
export const MP_FOV_COLUMNS = 16;
export const REF_PIXEL = 4;

export function binsPerHistogram(fpMode) {
  return fpMode <= FpMode.M8x8B ? 256 : 64;
}

export function histogramsPerFrame(fpMode) {
  return fpMode <= FpMode.M8x8B ? 4 * 8 : 8 * 16;
}

export function pixelRows(fpMode) {
  if (fpMode <= FpMode.M8x8B) return 8;
  if (fpMode === FpMode.M16x16) return 16;
  return 32;
}

export function pixelColumns(fpMode) {
  if (fpMode <= FpMode.M8x8B) return 8;
  if (fpMode === FpMode.M16x16) return 16;
  if (fpMode === FpMode.M48x32) return 48;
  return 32;
}

export function resultsPerFrame(fpMode) {
  if (fpMode > FpMode.M16x16) return fpMode > FpMode.M32x32s ? 48 * 16 : 32 * 16;
  if (fpMode === FpMode.M16x16) return 16 * 16;
  return 8 * 8;
}

export function decodeResultFormat(resultFormat) {
  return {
    numPeaks: resultFormat & ResultFormat.NR_PEAKS.mask,
    useSignal: (resultFormat & ResultFormat.SIGNAL_STRENGTH.mask) !== 0,
    useNoise: (resultFormat & ResultFormat.NOISE_STRENGTH.mask) !== 0,
    useXtalk: (resultFormat & ResultFormat.XTALK.mask) !== 0,
    fullNoise: (resultFormat & ResultFormat.FULL_NOISE.mask) !== 0,
  };
}

export function pixelResultSize(resultFormat) {
  const f = decodeResultFormat(resultFormat);
  return f.numPeaks * (3 + (f.useSignal ? 2 : 0)) + (f.useNoise ? 2 : 0) + (f.useXtalk ? 2 : 0);
}

export function resultFrameDataSize(fpMode, resultFormat) {
  return pixelResultSize(resultFormat) * resultsPerFrame(fpMode);
}

export function histogramFrameDataSize(fpMode) {
  const bytesPerBin = 3;
  let size = 64 * bytesPerBin * REF_PIXEL;
  size += binsPerHistogram(fpMode) * bytesPerBin * histogramsPerFrame(fpMode);
  return size;
}

export function numberOfHistogramFrames(fpMode, dualMode = 0) {
  let histograms = 2;
  if (fpMode > FpMode.M16x16) histograms = 8;
  if (fpMode === FpMode.M48x32) histograms = 12;
  return dualMode === 1 ? histograms * 2 : histograms;
}

export function numberOfResultFrames(fpMode) {
  return fpMode > FpMode.M16x16 ? 2 : 1;
}

/** Total number of FIFO reads that make up one complete measurement. */
export function framesPerMeasurement(fpMode, histograms, dualMode = 0, refFrame = 0) {
  const results = numberOfResultFrames(fpMode);
  const histoFrames = histograms ? numberOfHistogramFrames(fpMode, dualMode) : 0;
  const refs = refFrame ? results : 0;
  return results + histoFrames + refs;
}

// ------------------------------------------------------------- structures --

/** Parses the 16 byte frame header located after the 5 pre-header bytes. */
export function parseHeader(frame) {
  const view = new DataView(frame.buffer, frame.byteOffset + Frame.PRE_HEADER_SIZE, Frame.HEADER_SIZE);
  return {
    id: view.getUint8(0),
    layout: view.getUint8(1),
    payload: view.getUint16(2, true),
    fNumber: view.getUint32(4, true),
    temperature: [view.getInt8(8), view.getInt8(9), view.getInt8(10)],
    bdv: view.getUint8(11),
    refPos: [view.getUint16(12, true), view.getUint16(14, true)],
  };
}

/** Parses the trailing 12 byte frame footer. */
export function parseFooter(frame) {
  const start = frame.length - Frame.FOOTER_SIZE;
  const view = new DataView(frame.buffer, frame.byteOffset + start, Frame.FOOTER_SIZE);
  return {
    t0Integration: view.getUint32(0, true),
    t1Integration: view.getUint32(4, true),
    frameStatus: view.getUint8(8),
    reserved: view.getUint8(9),
    eof: view.getUint16(10, true),
  };
}

/** Parses the reference SPAD frame: 4 reference pixels x 2 integrations. */
export function parseRefSpadFrame(frame) {
  const header = parseHeader(frame);
  const view = new DataView(frame.buffer, frame.byteOffset + Frame.PRE_HEADER_SIZE + Frame.HEADER_SIZE, 32);
  const sums = [[], []];
  for (let t = 0; t < 2; t++) {
    for (let i = 0; i < 4; i++) sums[t].push(view.getUint32((t * 4 + i) * 4, true));
  }
  return { header, sums };
}

/** Decodes one measurement pixel from `pixelResultSize` bytes. */
export function parsePixel(frame, offset, format) {
  const result = { noise: null, xtalk: null, peaks: [] };
  let index = offset;
  if (format.useNoise) {
    result.noise = frame[index] | (frame[index + 1] << 8);
    index += 2;
  }
  if (format.useXtalk) {
    result.xtalk = frame[index] | (frame[index + 1] << 8);
    index += 2;
  }
  for (let p = 0; p < format.numPeaks; p++) {
    const peak = {
      distance: frame[index] | (frame[index + 1] << 8),
      snr: frame[index + 2],
      signal: null,
    };
    index += 3;
    if (format.useSignal) {
      peak.signal = frame[index] | (frame[index + 1] << 8);
      index += 2;
    }
    result.peaks.push(peak);
  }
  return result;
}

/** Returns results[y][x] for a single result frame. */
export function parseResultFrame(frame, fpMode, resultFormat) {
  const format = decodeResultFormat(resultFormat);
  const size = pixelResultSize(resultFormat);
  let columns = 16;
  let rows = 16;
  if (fpMode < FpMode.M16x16) { columns = 8; rows = 8; }
  if (fpMode > FpMode.M16x16) {
    columns = fpMode > FpMode.M32x32s ? 48 : 32;
    rows = 16; // half of the rows, the second frame holds the interleaved rows
  }

  const base = Frame.PRE_HEADER_SIZE + Frame.HEADER_SIZE;
  const results = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < columns; x++) {
      row.push(parsePixel(frame, base + (y * columns + x) * size, format));
    }
    results.push(row);
  }
  return results;
}

/**
 * Combines the (one or two) result frames of a measurement into a full
 * pixel map. Distances are converted to millimetres unless the device already
 * reports millimetres.
 */
export function buildPixelMap(resultFrames, { toMillimetres = true } = {}) {
  const header = parseHeader(resultFrames[0]);
  const footer = parseFooter(resultFrames[0]);
  const fpMode = header.id & Frame.FPM_MASK;
  const resultFormat = header.layout;

  let pixels = parseResultFrame(resultFrames[0], fpMode, resultFormat);
  if (fpMode > FpMode.M16x16 && resultFrames.length === 2) {
    const second = parseResultFrame(resultFrames[1], fpMode, resultFormat);
    for (let row = 0; row < second.length; row++) pixels.splice(row * 2 + 1, 0, second[row]);
  }

  const alreadyMm = (footer.reserved & Frame.RESERVED_DISTANCE_IN_MM) !== 0;
  if (toMillimetres && !alreadyMm) {
    for (const row of pixels) {
      for (const pixel of row) {
        for (const peak of pixel.peaks) peak.distance /= 4;
      }
    }
  }

  return { fpMode, resultFormat, header, footer, pixels };
}

/** Returns the 4 reference histograms and the [y][x] histograms of one frame. */
export function parseHistogramFrame(frame, fpMode) {
  const bins = binsPerHistogram(fpMode);
  const columns = fpMode < FpMode.M16x16 ? 4 : 8;
  const rows = fpMode < FpMode.M16x16 ? 8 : 16;

  let index = Frame.PRE_HEADER_SIZE + Frame.HEADER_SIZE;
  const readBin = () => {
    const value = frame[index] | (frame[index + 1] << 8) | (frame[index + 2] << 16);
    index += 3;
    return value;
  };

  const refHistograms = [];
  for (let r = 0; r < 4; r++) {
    const histogram = new Uint32Array(64);
    for (let b = 0; b < 64; b++) histogram[b] = readBin();
    refHistograms.push(histogram);
  }

  const histograms = [];
  for (let y = 0; y < rows; y++) {
    const row = [];
    for (let x = 0; x < columns; x++) {
      const histogram = new Uint32Array(bins);
      for (let b = 0; b < bins; b++) histogram[b] = readBin();
      row.push(histogram);
    }
    histograms.push(row);
  }
  return { refHistograms, histograms };
}

/**
 * Assembles all histogram frames of a measurement into a full [y][x] map,
 * using the layout field to place each time-multiplexed sub-frame.
 */
export function buildHistogramMap(histogramFrames) {
  if (!histogramFrames.length) return null;
  const fpMode = parseHeader(histogramFrames[0]).id & Frame.FPM_MASK;

  const fovRows = fpMode < FpMode.M16x16 ? MP_FOV_ROWS / 2 : MP_FOV_ROWS;
  const fovColumns = fpMode < FpMode.M16x16 ? MP_FOV_COLUMNS / 2 : MP_FOV_COLUMNS;
  const columns = pixelColumns(fpMode);
  const rows = pixelRows(fpMode);
  const columnsPerMp = columns / fovColumns;
  const rowsPerMp = rows / fovRows;

  const map = Array.from({ length: rows }, () => new Array(columns).fill(null));
  const refHistograms = [];

  for (const frame of histogramFrames) {
    const header = parseHeader(frame);
    const { refHistograms: refs, histograms } = parseHistogramFrame(frame, fpMode);

    const leftFovOffset = (header.layout % 2 !== 0) ? columns / 2 : 0;
    let rowOffset = 0;
    let columnOffset = 0;
    if (fpMode <= FpMode.M32x32s) {
      if ([2, 3, 6, 7].includes(header.layout)) columnOffset = 1;
      if (header.layout > 3) rowOffset = 1;
    } else if (fpMode === FpMode.M48x32) {
      if ([2, 3, 8, 9].includes(header.layout)) columnOffset = 1;
      if ([4, 5, 10, 11].includes(header.layout)) columnOffset = 2;
      if (header.layout > 5) rowOffset = 1;
    }

    for (let i = 0; i < fovRows; i++) {
      for (let j = 0; j < fovColumns / 2; j++) {
        const y = i * rowsPerMp + rowOffset;
        const x = j * columnsPerMp + leftFovOffset + columnOffset;
        map[y][x] = histograms[i][j];
      }
    }
    refHistograms.push(...refs);
  }
  return { fpMode, map, refHistograms };
}
