/*****************************************************************************
 * WebUSB CDC-ACM transport.
 *
 * The EVM-H5 shield enumerates as a USB CDC-ACM (virtual COM port) device.
 * On desktop Chrome/Edge the Web Serial API is the natural transport, but
 * Android Chrome does not expose Web Serial. It does expose WebUSB, so this
 * module wraps a `USBDevice` in a small object that mimics the subset of the
 * Web Serial `SerialPort` interface used by `CoreFw` (open, close, getInfo,
 * setSignals, readable.getReader(), writable.getWriter()).
 *
 * This lets the exact same driver stack run unchanged over either transport.
 *****************************************************************************/

// USB CDC (Communications Device Class) constants.
const USB_CLASS_CDC = 0x02;         // Communications interface class.
const USB_CLASS_CDC_DATA = 0x0a;    // CDC-Data interface class.

// CDC class-specific requests (bRequest).
const CDC_SET_LINE_CODING = 0x20;
const CDC_SET_CONTROL_LINE_STATE = 0x22;

// SET_CONTROL_LINE_STATE bitmap.
const CONTROL_LINE_DTR = 0x01;
const CONTROL_LINE_RTS = 0x02;

/**
 * Minimal Web Serial `SerialPort` look-alike backed by a WebUSB `USBDevice`.
 */
export class WebUsbSerialPort {
  /** @param {USBDevice} device */
  constructor(device) {
    this.device = device;
    this._controlInterface = null;   // CDC communications interface number.
    this._dataInterface = null;      // CDC-Data interface number.
    this._endpointIn = 0;
    this._endpointOut = 0;
    this._endpointInPacketSize = 64;
    this._opened = false;
    this._cancelRead = null;
    this.readable = null;
    this.writable = null;
  }

  /** Matches the shape returned by Web Serial `SerialPort.getInfo()`. */
  getInfo() {
    return { usbVendorId: this.device.vendorId, usbProductId: this.device.productId };
  }

  /**
   * Opens the device, locates the CDC-Data bulk endpoints and configures the
   * line coding. `baudRate` is forwarded via SET_LINE_CODING; for a native USB
   * device it has no physical effect but keeps the firmware handshake happy.
   */
  async open({ baudRate = 115200 } = {}) {
    if (this._opened) throw new Error('WebUSB port already open');

    if (!this.device.opened) await this.device.open();
    if (this.device.configuration === null) await this.device.selectConfiguration(1);

    this._locateInterfaces();
    if (this._dataInterface === null) {
      throw new Error('No CDC-Data interface with bulk endpoints found on this USB device');
    }

    await this._claimInterfaces();

    try {
      await this._setLineCoding(baudRate);
    } catch {
      // Not all firmware honours SET_LINE_CODING; ignore and continue.
    }

    this._opened = true;
    this._setupStreams();
  }

  /**
   * Claims the CDC interfaces. On Android the kernel `cdc_acm` driver binds the
   * whole function, so we must claim the communications interface FIRST (this
   * is what forces the kernel driver to detach) and only then the data
   * interface. Claiming the data interface first fails with "Unable to claim".
   */
  async _claimInterfaces() {
    try {
      if (this._controlInterface !== null && this._controlInterface !== this._dataInterface) {
        try {
          await this.device.claimInterface(this._controlInterface);
        } catch {
          // Best effort: on some hosts the comm interface stays with the OS
          // while the data interface can still be claimed on its own.
        }
      }
      await this.device.claimInterface(this._dataInterface);
    } catch (error) {
      throw new Error(
        `Unable to claim the USB interface (${error.message}). ` +
        'The device is held by another driver. On Android, fully unplug the sensor, ' +
        'wait a moment, replug it and accept the permission prompt again; if it keeps ' +
        'failing the phone\'s kernel serial driver is holding the port. On Windows/desktop, ' +
        'use the "Connect" (Web Serial) button instead of Web USB, or install a WinUSB ' +
        'driver via Zadig.');
    }
  }

  /**
   * Web Serial control-signal shim. Maps DTR/RTS onto the CDC
   * SET_CONTROL_LINE_STATE class request.
   */
  async setSignals({ dataTerminalReady = false, requestToSend = false } = {}) {
    let value = 0;
    if (dataTerminalReady) value |= CONTROL_LINE_DTR;
    if (requestToSend) value |= CONTROL_LINE_RTS;
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: CDC_SET_CONTROL_LINE_STATE,
      value,
      index: this._controlInterface ?? this._dataInterface,
    });
  }

  async close() {
    this._opened = false;
    // Unblock any read that is currently waiting on transferIn.
    this._cancelRead?.();
    this._cancelRead = null;
    try { await this.device.releaseInterface(this._dataInterface); } catch { /* ignore */ }
    if (this._controlInterface !== null && this._controlInterface !== this._dataInterface) {
      try { await this.device.releaseInterface(this._controlInterface); } catch { /* ignore */ }
    }
    try { await this.device.close(); } catch { /* ignore */ }
    this.readable = null;
    this.writable = null;
  }

  // --------------------------------------------------------------- internal --

  _locateInterfaces() {
    const configuration = this.device.configuration;
    for (const iface of configuration.interfaces) {
      const alternate = iface.alternate;
      const bulkIn = alternate.endpoints.find((ep) => ep.type === 'bulk' && ep.direction === 'in');
      const bulkOut = alternate.endpoints.find((ep) => ep.type === 'bulk' && ep.direction === 'out');

      if (alternate.interfaceClass === USB_CLASS_CDC) {
        this._controlInterface = iface.interfaceNumber;
      }
      if (bulkIn && bulkOut &&
          (alternate.interfaceClass === USB_CLASS_CDC_DATA || this._dataInterface === null)) {
        this._dataInterface = iface.interfaceNumber;
        this._endpointIn = bulkIn.endpointNumber;
        this._endpointOut = bulkOut.endpointNumber;
        this._endpointInPacketSize = bulkIn.packetSize || 64;
        if (alternate.interfaceClass === USB_CLASS_CDC_DATA) break;
      }
    }
  }

  async _setLineCoding(baudRate) {
    const data = new Uint8Array(7);
    const view = new DataView(data.buffer);
    view.setUint32(0, baudRate, true); // dwDTERate
    data[4] = 0;                        // bCharFormat: 1 stop bit
    data[5] = 0;                        // bParityType: none
    data[6] = 8;                        // bDataBits
    await this.device.controlTransferOut({
      requestType: 'class',
      recipient: 'interface',
      request: CDC_SET_LINE_CODING,
      value: 0,
      index: this._controlInterface ?? this._dataInterface,
    }, data);
  }

  _setupStreams() {
    this.readable = { getReader: () => this._makeReader() };
    this.writable = { getWriter: () => this._makeWriter() };
  }

  _makeReader() {
    const read = () => {
      // WebUSB has no way to abort a pending transferIn, so race it against an
      // explicit cancellation promise. When cancelled we report `done`, letting
      // the CoreFw read loop exit cleanly; the orphaned transfer settles later.
      const transfer = this.device.transferIn(this._endpointIn, this._endpointInPacketSize)
        .then((result) => {
          if (result.status === 'stall') {
            return this.device.clearHalt('in', this._endpointIn)
              .then(() => ({ value: new Uint8Array(0), done: false }));
          }
          return { value: new Uint8Array(result.data.buffer), done: false };
        })
        .catch(() => ({ value: undefined, done: true }));

      const cancelled = new Promise((resolve) => {
        this._cancelRead = () => resolve({ value: undefined, done: true });
      });

      return Promise.race([transfer, cancelled]);
    };

    return {
      read,
      cancel: async () => { this._cancelRead?.(); },
      releaseLock: () => { /* no lock to release */ },
    };
  }

  _makeWriter() {
    return {
      write: (data) => this.device.transferOut(this._endpointOut, data),
      releaseLock: () => { /* no lock to release */ },
    };
  }
}

/** Vendor/product filters for the EVM-H5 shield (matches the Web Serial ones). */
export const WEBUSB_FILTERS = Object.freeze([
  { vendorId: 0x1325, productId: 0x1000 },
  { vendorId: 0x1325 },
]);

/** True when the current browser exposes WebUSB. */
export function isWebUsbSupported() {
  return typeof navigator !== 'undefined' && 'usb' in navigator && !!navigator.usb?.requestDevice;
}

/**
 * Prompts the user to pick an EVM-H5 USB device and returns a Web Serial
 * look-alike port ready to be handed to `CoreFw.open()`.
 */
export async function requestWebUsbPort() {
  if (!isWebUsbSupported()) {
    throw new Error('This browser does not support WebUSB. On Android use Chrome; on desktop use Chrome or Edge over https or localhost.');
  }
  const device = await navigator.usb.requestDevice({ filters: WEBUSB_FILTERS });
  return new WebUsbSerialPort(device);
}
