/*****************************************************************************
 * TMF8829 register map subset required by the web application.
 * Values are taken from tmf8829_host_regs.py, tmf8829_application_registers.py
 * and tmf8829_config_page.py.
 *****************************************************************************/

/** Host interface registers. */
export const HostReg = Object.freeze({
  INT_STATUS: 0xe1,
  INT_ENAB: 0xe2,
  RESET: 0xf7,
  ENABLE: 0xf8,
  FIFOSTATUS: 0xfa,
  FIFO: 0xff,
});

/** ENABLE (0xf8) bit fields. Reset value has `pon` set. */
export const Enable = Object.freeze({
  RESET_VALUE: 0x04,
  STANDBY_MODE: { shift: 0, mask: 0x01 },
  TIMED_STANDBY_MODE: { shift: 1, mask: 0x02 },
  PON: { shift: 2, mask: 0x04 },
  POFF: { shift: 3, mask: 0x08 },
  POWERUP_SELECT: { shift: 4, mask: 0x30 },
  BOOTWITHOUTPLL: { shift: 6, mask: 0x40 },
  CPU_READY: { shift: 7, mask: 0x80 },
  POWERUP_NO_OVERRIDE: 0,
  POWERUP_FORCE_BOOTMONITOR: 1,
  POWERUP_RAM: 2,
});

/** RESET (0xf7) bit fields. Reset value has `reset_reason_coldstart` set. */
export const Reset = Object.freeze({
  RESET_VALUE: 0x20,
  SOFT_RESET: { shift: 6, mask: 0x40 },
  HARD_RESET: { shift: 7, mask: 0x80 },
});

/** Application registers. */
export const AppReg = Object.freeze({
  APP_ID: 0x00,
  CMD_STAT: 0x08,
  PREV_CMD: 0x09,
  SERIAL_NUMBER_0: 0x1c,
  CID_RID: 0x20,
  PAYLOAD: 0x21,
});

/** Application commands written to CMD_STAT. */
export const AppCmd = Object.freeze({
  MEASURE: 16,
  CLEAR_STATUS: 17,
  WRITE_PAGE_AND_MEASURE: 20,
  WRITE_PAGE: 21,
  LOAD_CONFIG_PAGE: 22,
  LOAD_DIAGNOSTIC_PAGE: 23,
  LOAD_CALIBRATION_PAGE: 24,
  OSC_TUNE_UP: 30,
  OSC_TUNE_DOWN: 31,
  LOAD_CFG_8X8: 64,
  LOAD_CFG_8X8_LONG_RANGE: 65,
  LOAD_CFG_8X8_HIGH_ACCURACY: 66,
  LOAD_CFG_16X16: 67,
  LOAD_CFG_16X16_HIGH_ACCURACY: 68,
  LOAD_CFG_32X32: 69,
  LOAD_CFG_32X32_HIGH_ACCURACY: 70,
  LOAD_CFG_48X32: 71,
  LOAD_CFG_48X32_HIGH_ACCURACY: 72,
  LOAD_CFG_8X8_EXTENDED_RANGE: 73,
  STOP: 255,
});

export const AppStat = Object.freeze({ OK: 0, ACCEPTED: 1 });

/** Configuration page register addresses. */
export const CfgReg = Object.freeze({
  PERIOD_MS_LSB: 0x22,
  KILO_ITERATIONS_LSB: 0x24,
  FP_MODE: 0x26,
  SPAD_SELECT: 0x27,
  REF_SPAD_SELECT: 0x28,
  SPAD_DEADTIME: 0x29,
  RESULT_FORMAT: 0x2a,
  DUMP_HISTOGRAMS: 0x2b,
  REF_SPAD_FRAME: 0x2c,
  POWER_MODES: 0x2e,
  HISTOGRAM_BINS_LSB: 0x40,
  BIN_SHIFT: 0x42,
  HA_KILO_ITERATIONS_LSB: 0x4a,
  ENABLE_DUAL_MODE: 0x4c,
  ALG_PEAK_BINS: 0x50,
  ALG_DISTANCE: 0x52,
  ALG_CONFIDENCE_THRESHOLD: 0x53,
  ALG_MIN_SIGNAL_LEVEL_LSB: 0x54,
  ALG_MIN_DISTANCE_LSB: 0x58,
  DISTANCE_RESOLUTION: 0x8f,
  LAST_AVAILABLE: 0xdf,
});

/** RESULT_FORMAT (0x2a) bit fields. */
export const ResultFormat = Object.freeze({
  NR_PEAKS: { shift: 0, mask: 0x07 },
  SIGNAL_STRENGTH: { shift: 3, mask: 0x08 },
  NOISE_STRENGTH: { shift: 4, mask: 0x10 },
  XTALK: { shift: 5, mask: 0x20 },
  SUB_RESULT: { shift: 6, mask: 0x40 },
  FULL_NOISE: { shift: 7, mask: 0x80 },
});

/** Bootloader constants. */
export const Bl = Object.freeze({
  READY: 0,
  ERR_PARAM: 1,
  ERR_ADDR: 2,
  ERR_SIZE: 3,
  MAX_DATA_SIZE: 0x80,
  REG_CMD_STAT: 0x08,
  REG_SIZE: 0x09,
  REG_DATA0: 0x0a,
  REG_FIFO_STATUS: 0xfe,
  REG_FIFO: 0xff,
  CMD_START_RAM_APP: 0x16,
  CMD_START_ROM_APP: 0x17,
  CMD_DEBUG: 0x18,
  CMD_LOG: 0x19,
  CMD_SPI_OFF: 0x20,
  CMD_I2C_OFF: 0x22,
  CMD_R_RAM: 0x40,
  CMD_W_RAM: 0x41,
  CMD_W_RAM_BOTH: 0x42,
  CMD_ADDR_RAM: 0x43,
  CMD_W_FIFO: 0x44,
  CMD_W_FIFO_BOTH: 0x45,
  CMD_R_HW: 0x80,
  CMD_W_HW: 0x81,
  CMD_W_HW_MASK: 0x82,
  BL_APP_ID: 0x80,
  APP_ID: 0x01,
});

/** Frame identifiers, interrupt bits and frame status flags. */
export const Frame = Object.freeze({
  FID_MASK: 0xf0,
  FPM_MASK: 0x0f,
  FID_RESULTS: 0x10,
  FID_HISTOGRAMS: 0x20,
  FID_REF_SPAD_SCAN: 0x30,
  INT_RESULTS: 0x01,
  INT_HISTOGRAMS: 0x08,
  VALID: 0x01,
  ABORTED: 0xc0,
  WARNING_HV_CP_OVERLOAD: 0x08,
  WARNING_VCDRV_OVERLOAD: 0x10,
  WARNING_VCDRV_BURST_EXCEEDED: 0x20,
  EOF: 0xe0f7,
  MAX_PEAKS: 4,
  PRE_HEADER_SIZE: 5,
  HEADER_SIZE: 16,
  FOOTER_SIZE: 12,
  REF_SPAD_FRAME_SIZE: 16 + 32 + 12,
  RESERVED_DISTANCE_IN_MM: 1,
});

export const FpMode = Object.freeze({
  M8x8A: 0,
  M8x8B: 1,
  M16x16: 2,
  M32x32: 3,
  M32x32s: 4,
  M48x32: 5,
});

export const FP_MODE_NAMES = Object.freeze({
  0: '8x8 (digital combine)',
  1: '8x8 (analog combine)',
  2: '16x16',
  3: '32x32',
  4: '32x32 single SPAD',
  5: '48x32',
});
