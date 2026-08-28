/*****************************************************************************
 * CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF, no reflection, no final xor)
 * This is the checksum used by the ams OSRAM Core FW RPC protocol.
 *****************************************************************************/

const TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 8;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
    }
    table[i] = crc & 0xffff;
  }
  return table;
})();

/**
 * @param {Uint8Array} bytes
 * @param {number} [seed]
 * @returns {number} 16-bit checksum
 */
export function crc16ccitt(bytes, seed = 0xffff) {
  let crc = seed & 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ bytes[i]) & 0xff]) & 0xffff;
  }
  return crc;
}
