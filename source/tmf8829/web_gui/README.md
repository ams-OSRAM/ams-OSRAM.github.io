# TMF8829 Shield Board Web App Viewer

A browser-only viewer for the **TMF8829** on the **TMF8829_EVM_EB_SHIELD Evaluation kit**. The
page talks directly to the board over USB using the [Web Serial
API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API) — there is no
Python backend, no WebSocket bridge and no Arduino firmware involved.

![TMF8829 Web GUI](../../../media/tmf8829_web_gui.gif)

Connect Shield EVM board via USB and open [tmf8829_web_gui.html](https://ams-osram.github.io/tmf8829/tmf8829_web_gui.html)
in a browser, which supports WebSerial.

The EVM board can be ordered from https://ams-osram.com/products/boards-kits-accessories/kits/ams-tmf8829-evm-eb-shield-evaluation-kit

The complete driver stack of [`tmf8829_driver_python`](https://github.com/ams-OSRAM/tmf8829_driver_python)
has been ported to JavaScript:

| Layer | File | Python counterpart |
| --- | --- | --- |
| CRC-16/CCITT-FALSE | [js/crc16.js](js/crc16.js) | `corefw_client` |
| WebUSB CDC-ACM transport (Android) | [js/webusb.js](js/webusb.js) | `pyserial` |
| Core FW RPC framing | [js/corefw.js](js/corefw.js) | `corefw_c` |
| EVM-H5 SPI / PIO + register HAL | [js/h5.js](js/h5.js) | `aos_com/h5_com.py`, `aos_com/spi_hal_register_io.py` |
| Register maps | [js/registers.js](js/registers.js) | `tmf8829_host_regs.py`, `tmf8829_application_registers.py`, `tmf8829_config_page.py` |
| Intel HEX parser | [js/intelhex.js](js/intelhex.js) | `intelhex` |
| Device / bootloader / application | [js/tmf8829.js](js/tmf8829.js) | `tmf8829_bootloader.py`, `tmf8829_application.py` |
| Frame parsing | [js/frames.js](js/frames.js) | `tmf8829_application_common.py` |
| Measurement logging | [js/logging.js](js/logging.js) | `tmf8829_zeromq_client` |
| Visualisation | [js/render.js](js/render.js), [js/app.js](js/app.js) | `utilities/tmf8829_visualisation.py` |

## Requirements

* Chrome, Edge or another Chromium based browser (Web Serial is not available
  in Firefox or Safari).
* An EVM-H5 shield board with the TMF8829 attached, connected over USB
  (it enumerates as a USB CDC ACM serial port, VID `0x1325`).

## Running

Open in browser: [tmf8829_web_gui.html](https://ams-osram.github.io/tmf8829/tmf8829_web_gui.html)

### Build standalone, without a web server

Build the single self-contained page:

```powershell
python build_and_run.py
```

This writes `html/tmf8829/tmf8829_web_gui.html` at the repository root, which
inlines the stylesheet, the whole JavaScript stack and the sensor firmware image
— it has no external references at all. The build then opens the page
automatically in your default browser. You can also double-click it, or open it
in Chrome from `file://`.

Re-run the build after changing anything under `web_gui/js` or `web_gui/css`.

### From a local server

The unbundled sources need a server because Chrome blocks ES modules and
`fetch()` on `file://` pages. From the repository root:

```powershell
python -m http.server 8000
```

Then open <http://localhost:8000/webapp/>. Serving from the repository root lets
the page fetch the firmware from `tmf8829/hex/tmf8829_application.hex`; if you
serve the `webapp` folder on its own, pick the hex file manually in the *Sensor
firmware* panel.

[offline_unit_tests.html](offline_unit_tests.html) verifies the CRC, the frame
size formulas and the Intel HEX parser against the shipped firmware image.

## WebUSB

On Android, where Web Serial is unavailable, the app can also connect over the
[WebUSB API](https://developer.mozilla.org/docs/Web/API/WebUSB_API) via a
separate *Connect (USB)* button, reaching the board's USB CDC interface
(Chromium browsers only).

<img width="300" alt="TMF8829 Web GUI on Android" src="../../../media/tmf8829_web_gui_android.png" />

## Current behavior

The current web app is optimized for direct bring-up and live inspection:

* **App name**: `TMF8829 Shield Board Web App Viewer`
* **Board connect**: the board is a USB CDC device
* **Auto-start**: if the browser already has permission for an EVM-H5 port, the
  app automatically connects, downloads firmware, and starts measurement.
* **Configuration apply**: configuration changes are applied automatically.
  When measurement is running, the app stops measurement, applies the new
  settings, and restarts measurement.

## Usage

1. **Shield board** – press *Connect* if the board was not auto-detected. The
   board identification (application name, Core FW version, hardware revision,
   serial number) is read over the Core FW RPC protocol.
2. **Sensor firmware** – press *Enable & download* if firmware was not already
   downloaded automatically. This raises the sensor ENABLE pin (GPIO1 of the
   shield), forces the boot monitor, disables the unused I2C interface and
   downloads `tmf8829_application.hex` into the device RAM before starting it.
3. **Configuration** – select a built-in configuration profile and edit the
   live settings. Changes are applied automatically after the sensor is
   initialized.
4. **Measurement** – measurement may start automatically. The main views are a
   3D point cloud, pixel map, histograms and a log pane.
5. **Logging** – set the number of frames and press *Record*. Measurement is
   started if it is not already running, and the recorded frames are written to
   a `tmf8829_log_<epoch>.json.gz` file in the download folder. *Stop & save*
   ends the recording early and saves what was recorded so far.

## Log file format

The log file is the gzip compressed JSON format of the TMF8829 EVM logger and
can be opened with the [JSON viewer](https://ams-osram.github.io/tmf8829/ams_osram_tmf8829_json_viewer.html):

* `configuration` – the config page parameters (named fields plus the raw
  `blob` of the page bytes from `0x22` to `0xDF`)
* `info` – host version, firmware version, logger version, `web_gui_version`
  and serial number
* `Result_Set` – one entry per recorded measurement with
  * `info` – `frame_number`, `read_time`, `systick_t0`, `systick_t1`,
    `temperature` and `warnings`
  * `results` – `[row][column]` pixels with `noise`, `xtalk` and the `peaks`
    (`distance` in mm, `snr`, `signal` and the point cloud corrected `x`, `y`,
    `z`)
  * `ref_histo` / `mp_histo` – the reference and pixel histograms, only present
    when histograms are enabled; in dual mode the high accuracy pass is stored
    in `ref_histo_HA` / `mp_histo_HA`

Fields that are not enabled in the configuration are omitted, exactly as the
EVM logger does. `read_time` is a host timestamp in microseconds, the EVM
logger writes the device systick instead.

## Configuration modes

The configuration selector currently exposes these built-in profiles:

* `8x8`
* `8x8 Long Range`
* `8x8 High Accuracy`
* `8x8 Dual Mode`
* `8x8 Long Range Dual Mode`
* `8x8 Extended Range`
* `16x16`
* `16x16 High Accuracy`
* `16x16 Dual Mode`
* `32x32`
* `32x32 High Accuracy`
* `32x32 Dual Mode`
* `48x32`
* `48x32 High Accuracy`
* `48x32 Dual Mode`

For dual-mode profiles, the UI exposes **High accuracy iterations (k)** with a
default of `100`.

## Visualisation

The current viewer includes:

* **3D point cloud** with drag-to-rotate, wheel zoom, and max-distance filter
* **Pixel map** with selectable source: distance, SNR, signal, noise, xtalk
* **Pixel inspection** on click, including XYZ, signal, noise, xtalk and peaks
* **Histograms** with a notice when histogram output is disabled in the sensor
  configuration
* **Collapsible view sections** for point cloud, pixel map, histograms and log

## Protocol notes

The Core FW RPC message layout (little endian) is:

```
[0]     0x55 synchronization byte
[1]     command id
[2]     target id
[3]     error code
[4..7]  payload length (uint32)
[8..]   payload
[..]    CRC-16/CCITT-FALSE over all preceding bytes (uint16)
```

RTS is asserted when the port is opened, as required by the Core FW.

Register access uses `CMD_BASE_ID_SPI_XFER_EXTENDED` (0x1D) because it allows
different send and receive lengths and gives direct control over the chip
select. Transfers larger than one RPC message (498 bytes out, 2032 bytes in)
are split into several messages that share a single chip select assertion, so
large histogram frames can be read in one SPI transaction.

## Changelog

### V1.2

* **Measurement logging** – new *Logging* panel records a selectable number of
  frames into a `tmf8829_log_<epoch>.json.gz` file in the EVM log file format
  ([js/logging.js](js/logging.js)). Recording starts the measurement if it is
  not running, *Stop & save* ends it early, and the panel shows the recording
  progress.
* Log files carry the new `web_gui_version` entry in the `info` block, next to
  host, firmware and logger version.
* Added a disclaimer to the *Logging* panel: recordings are for informational
  purposes only and must not be used to analyse performance or accuracy.
* Added an *Analyse logfiles* link to the
  [JSON viewer](https://ams-osram.github.io/tmf8829/ams_osram_tmf8829_json_viewer.html).
* Histogram plots now show rounded bin numbers and vertical grid lines on the
  x-axis.
* Offline unit tests cover the log file configuration block against a reference
  EVM log file.

### V1.1

* First public release of the TMF8829 Shield Board Web App Viewer: Web Serial /
  WebUSB connection, firmware download, configuration profiles, 3D point cloud,
  pixel map, pixel inspection and histogram views.
