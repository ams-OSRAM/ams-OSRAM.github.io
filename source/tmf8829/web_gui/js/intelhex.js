/*****************************************************************************
 * Minimal Intel HEX parser. The TMF8829 application image consists of a single
 * contiguous segment, which is what the bootloader download expects.
 *****************************************************************************/

/**
 * @param {string} text contents of an Intel HEX file
 * @returns {{startAddress: number, data: Uint8Array}}
 */
export function parseIntelHex(text) {
  const chunks = [];
  let upperAddress = 0;
  let lineNumber = 0;

  for (const rawLine of text.split(/\r?\n/)) {
    lineNumber++;
    const line = rawLine.trim();
    if (!line) continue;
    if (line[0] !== ':') throw new Error(`Line ${lineNumber}: record does not start with ':'`);
    if (line.length < 11 || line.length % 2 !== 1) {
      throw new Error(`Line ${lineNumber}: malformed record`);
    }

    const bytes = new Uint8Array((line.length - 1) / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(line.substr(1 + i * 2, 2), 16);
      if (Number.isNaN(bytes[i])) throw new Error(`Line ${lineNumber}: invalid hex digits`);
    }

    const byteCount = bytes[0];
    if (bytes.length !== byteCount + 5) throw new Error(`Line ${lineNumber}: wrong record length`);
    let sum = 0;
    for (const byte of bytes) sum = (sum + byte) & 0xff;
    if (sum !== 0) throw new Error(`Line ${lineNumber}: checksum error`);

    const offset = (bytes[1] << 8) | bytes[2];
    const recordType = bytes[3];
    const data = bytes.subarray(4, 4 + byteCount);

    switch (recordType) {
      case 0x00: // data
        chunks.push({ address: upperAddress + offset, data: data.slice() });
        break;
      case 0x01: // end of file
        break;
      case 0x02: // extended segment address
        upperAddress = ((data[0] << 8) | data[1]) * 16;
        break;
      case 0x04: // extended linear address
        upperAddress = ((data[0] << 8) | data[1]) * 65536;
        break;
      case 0x03: // start segment address - not relevant for the download
      case 0x05: // start linear address  - not relevant for the download
        break;
      default:
        throw new Error(`Line ${lineNumber}: unsupported record type 0x${recordType.toString(16)}`);
    }
  }

  if (chunks.length === 0) throw new Error('Intel HEX file contains no data records');
  chunks.sort((a, b) => a.address - b.address);

  const startAddress = chunks[0].address;
  let end = startAddress;
  for (const chunk of chunks) {
    if (chunk.address !== end) {
      throw new Error(`Expected a single contiguous segment, found a gap at 0x${chunk.address.toString(16)}`);
    }
    end += chunk.data.length;
  }

  const data = new Uint8Array(end - startAddress);
  for (const chunk of chunks) data.set(chunk.data, chunk.address - startAddress);
  return { startAddress, data };
}
