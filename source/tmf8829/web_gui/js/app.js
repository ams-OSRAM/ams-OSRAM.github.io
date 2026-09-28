/*****************************************************************************
 * Application controller: wires the UI to the Web Serial driver stack.
 *****************************************************************************/

import { CoreFw } from './corefw.js';
import { H5Board, SpiRegisterIo } from './h5.js';
import { Tmf8829 } from './tmf8829.js';
import { WebUsbSerialPort, isWebUsbSupported, requestWebUsbPort } from './webusb.js';
import { FP_MODE_NAMES } from './registers.js';
import { buildHistogramMap, buildPixelMap, parseRefSpadFrame, pixelColumns, pixelRows } from './frames.js';
import { drawColorBar, drawHeatMap, drawHistogram, drawPointCloud, getPixelXYZ } from './render.js';
import { HOST_VERSION, LOGGER_VERSION, WEB_GUI_VERSION, MeasurementLogger } from './logging.js';

const EVM_H5_FILTERS = [
  { usbVendorId: 0x1325, usbProductId: 0x1000 },
  { usbVendorId: 0x1325 },
];

const DEFAULT_HEX_URL = '../tmf8829/hex/tmf8829_application.hex';
const DEFAULT_BAUD_RATE = 115200;
const DEFAULT_USE_FIFO_DOWNLOAD = true;
const DEFAULT_VERIFY_DOWNLOAD = false;
const MEASUREMENT_POLL_TIMEOUT_MS = 800;

// Every mode is drawn with the 48x32 aspect ratio so the view size never jumps.
const PIXEL_MAP_ASPECT = 32 / 48;

const $ = (id) => document.getElementById(id);

function isEvmH5Port(port) {
  const info = port.getInfo?.() ?? {};
  if (info.usbVendorId !== 0x1325) return false;
  if (info.usbProductId === undefined) return true;
  return info.usbProductId === 0x1000;
}

class Application {
  constructor() {
    this.corefw = new CoreFw({ onLog: (text) => this.log(text) });
    this.board = new H5Board(this.corefw);
    this.io = new SpiRegisterIo(this.board);
    this.device = new Tmf8829(this.board, this.io, { onLog: (text) => this.log(text) });
    this.logger = new MeasurementLogger({
      onLog: (text) => this.log(text),
      onChange: () => this.updateRecordingUi(),
    });

    this.hexText = null;
    this.lastConfig = null;
    this.firmwareVersion = null;
    this.serialNumber = null;
    this.running = false;
    this.stopRequested = false;
    this.selectedPixel = null;
    this.lastHistogramMap = null;
    this.frameTimes = [];
    this.pointCloudPoints = [];
    this.pointCloudScaleReferencePoints = [];
    this.pointCloudScaleReferenceKey = '';
    this.selectedPointIndex = -1;
    this.autoStartupInProgress = false;
    this.runtimeReconfigureInProgress = false;
    this.runtimeReconfigurePendingKind = null;
    this.measurementRunPromise = null;
    this.pendingAutoApplyTimer = null;
    this.activePort = null;
    this.autoStartupDisabledByUser = false;
    this.pendingSerialAutoStartup = false;
    this.pointCloudView = {
      yaw: -0.75,
      pitch: 0.43,
      zoom: 4,
      dragging: false,
      pointerX: 0,
      pointerY: 0,
      pinchDistance: 0,
    };
    this.viewSections = {};

    this.bindUi();
    this.setState({ connected: false, initialized: false });

    // Auto-start only works for already-authorized serial ports.
    this.guard(() => this.tryAutoConnectAndInitialize('startup'));
  }

  // ------------------------------------------------------------------ UI ---

  bindUi() {
    $('connect').addEventListener('click', () => this.guard(() => this.connectInitializeAndStart()));
    $('connectUsb').addEventListener('click', () => this.guard(() => this.connectUsbInitializeAndStart()));
    $('disconnect').addEventListener('click', () => this.guard(() => this.disconnect({ userInitiated: true })));
    $('initialize').addEventListener('click', () => this.guard(() => this.initialize()));
    $('start').addEventListener('click', () => this.guard(() => this.startMeasurement()));
    $('stop').addEventListener('click', () => { this.stopRequested = true; });
    $('record').addEventListener('click', () => this.guard(() => this.toggleRecording()));
    $('clearLog').addEventListener('click', () => { $('log').textContent = ''; });

    $('hexFile').addEventListener('change', async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      this.hexText = await file.text();
      this.log(`Loaded firmware image "${file.name}" (${file.size} bytes)`);
    });

    $('pixelMap').addEventListener('click', (event) => this.onPixelMapClick(event));
    $('mapSource').addEventListener('change', () => this.redraw());
    $('autoScale').addEventListener('change', () => this.redraw());
    $('histograms').addEventListener('change', () => this.updateHistogramNotice());
    $('histLogScale').addEventListener('change', () => this.drawHistograms());
    $('histAutoScale').addEventListener('change', () => {
      this.updateHistogramScaleInput();
      this.drawHistograms();
    });
    $('histScaleMax').addEventListener('input', () => this.drawHistograms());
    $('preConfig').addEventListener('change', () => this.updateHighAccuracyIterationsVisibility());

    const runtimeConfigIds = [
      'preConfig', 'period', 'iterations', 'highAccuracyIterations', 'nrPeaks', 'confidence',
      'signalStrength', 'noiseStrength', 'xtalk', 'fullNoise', 'histograms',
    ];
    for (const id of runtimeConfigIds) {
      const element = $(id);
      element.addEventListener('change', () => this.onRuntimeConfigControlChanged(id, false));

      // Number fields should also auto-apply while typing, not only on blur.
      if (element.tagName === 'INPUT' && element.type === 'number') {
        element.addEventListener('input', () => this.onRuntimeConfigControlChanged(id, true));
      }
    }

    this.bindViewSectionToggles();
    this.updateHighAccuracyIterationsVisibility();
    this.updateHistogramScaleInput();

    const iterations = $('iterations');
    const iterationsSlider = $('iterationsSlider');
    iterationsSlider.addEventListener('input', () => {
      iterations.value = iterationsSlider.value;
      // Re-use the auto-apply path that is bound to the number field.
      iterations.dispatchEvent(new Event('input', { bubbles: true }));
    });
    iterations.addEventListener('input', () => { iterationsSlider.value = iterations.value; });

    const pointCloudCanvas = $('pointCloud');
    pointCloudCanvas.addEventListener('mousedown', (event) => this.onPointCloudDragStart(event));
    pointCloudCanvas.addEventListener('mousemove', (event) => this.onPointCloudDragMove(event));
    pointCloudCanvas.addEventListener('mouseup', () => this.onPointCloudDragEnd());
    pointCloudCanvas.addEventListener('mouseleave', () => this.onPointCloudDragEnd());
    pointCloudCanvas.addEventListener('wheel', (event) => this.onPointCloudWheel(event), { passive: false });

    // Touch: one finger rotates, two fingers pinch to zoom.
    pointCloudCanvas.addEventListener('touchstart', (event) => this.onPointCloudTouchStart(event), { passive: false });
    pointCloudCanvas.addEventListener('touchmove', (event) => this.onPointCloudTouchMove(event), { passive: false });
    pointCloudCanvas.addEventListener('touchend', (event) => this.onPointCloudTouchEnd(event));
    pointCloudCanvas.addEventListener('touchcancel', (event) => this.onPointCloudTouchEnd(event));

    const maxDistanceSlider = $('pointCloudMaxDistance');
    const maxDistanceValue = $('pointCloudMaxDistanceValue');
    maxDistanceValue.textContent = `${maxDistanceSlider.value} mm`;
    maxDistanceSlider.addEventListener('input', () => {
      maxDistanceValue.textContent = `${maxDistanceSlider.value} mm`;
      this.updatePointCloud();
    });

    if ('serial' in navigator && navigator.serial?.addEventListener) {
      navigator.serial.addEventListener('connect', () => {
        this.guard(() => this.tryAutoConnectAndInitialize('serial-connect'));
      });

      navigator.serial.addEventListener('disconnect', (event) => {
        this.guard(() => this.onSerialDisconnect(event));
      });
    }

    if (!('serial' in navigator)) {
      this.log('This browser does not support the Web Serial API. Use Chrome or Edge over https or localhost.');
      $('connect').disabled = true;
    }

    if ('usb' in navigator && navigator.usb?.addEventListener) {
      navigator.usb.addEventListener('disconnect', (event) => {
        this.guard(() => this.onUsbDisconnect(event));
      });
    }

    if (!isWebUsbSupported()) {
      this.log('This browser does not support WebUSB. On Android use Chrome; on desktop use Chrome or Edge over https or localhost.');
      $('connectUsb').disabled = true;
    }
  }

  bindViewSectionToggles() {
    this.viewSections = {
      setup: {
        panels: [$('panelSetup')],
        bodies: [$('setupBody')],
        toggles: [$('toggleSetup')],
        open: true,
      },
      pointCloud: {
        panels: [$('panelPointCloud')],
        bodies: [$('pointCloudBody')],
        toggles: [$('togglePointCloud')],
        open: true,
      },
      pixelAndHistogram: {
        panels: [$('panelPixelMap'), $('panelHistogram')],
        bodies: [$('pixelMapBody'), $('histogramBody')],
        toggles: [$('togglePixelMap'), $('toggleHistogram')],
        open: false,
      },
      log: {
        panels: [$('panelLog')],
        bodies: [$('logBody')],
        toggles: [$('toggleLog')],
        open: true,
      },
    };

    for (const section of Object.values(this.viewSections)) {
      const headers = section.panels
        .map((panel) => panel.querySelector('.view-header'))
        .filter(Boolean);

      for (const header of headers) {
        header.addEventListener('click', (event) => {
          // Keep explicit controls in the header (buttons, links, form fields) independent.
          if (event.target.closest('button, input, select, textarea, a, label')) return;
          this.setSectionVisibility(section, !section.open);
        });
      }

      for (const toggle of section.toggles) {
        toggle.addEventListener('click', (event) => {
          event.stopPropagation();
          this.setSectionVisibility(section, !section.open);
        });
      }
      this.setSectionVisibility(section, section.open);
    }

    this.updateHistogramNotice();
  }

  setSectionVisibility(section, open) {
    section.open = open;
    for (const panel of section.panels) panel.classList.toggle('is-collapsed', !open);
    for (const body of section.bodies) body.hidden = !open;
    for (const toggle of section.toggles) {
      toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      toggle.textContent = open ? 'Hide' : 'Show';
    }
    this.updateHistogramNotice();
  }

  updateHistogramNotice() {
    const notice = $('histogramDisabledNotice');
    const histogramBody = $('histogramBody');
    if (!notice || !histogramBody) return;

    const tabOpen = !histogramBody.hidden;
    const histogramsEnabled = $('histograms').checked;
    notice.hidden = !tabOpen || histogramsEnabled;
  }

  updateHistogramScaleInput() {
    $('histScaleMax').disabled = $('histAutoScale').checked;
  }

  parseConfigurationSelection() {
    const preConfig = $('preConfig');
    const [cmdText, dualText] = String(preConfig.value).split(':');
    let cmd = Number(cmdText);
    let dualMode = Number(dualText ?? 0);

    // Compatibility guard: force long-range + dual mode for this profile,
    // even if the option value is stale from an older HTML build.
    const selectedName = preConfig.selectedOptions?.[0]?.textContent?.trim().toLowerCase() ?? '';
    if (selectedName === '8x8 long range dual mode') {
      cmd = 65;
      dualMode = 1;
    }

    return { cmd, dualMode };
  }

  updateHighAccuracyIterationsVisibility() {
    const row = $('haIterationsRow');
    const input = $('highAccuracyIterations');
    if (!row || !input) return;

    const { dualMode } = this.parseConfigurationSelection();
    const show = dualMode === 1;
    row.hidden = !show;
    input.disabled = !show || !this.initialized;
  }

  setState({ connected, initialized }) {
    if (connected !== undefined) this.connected = connected;
    if (initialized !== undefined) this.initialized = initialized;
    const configLocked = !this.initialized;

    $('connect').disabled = this.connected;
    $('connectUsb').disabled = this.connected || !isWebUsbSupported();
    $('disconnect').disabled = !this.connected;
    $('initialize').disabled = !this.connected || this.running;
    $('preConfig').disabled = configLocked;
    $('start').disabled = !this.initialized || this.running;
    $('stop').disabled = !this.running;
    this.updateRecordingUi();
    this.updateHighAccuracyIterationsVisibility();
  }

  onRuntimeConfigControlChanged(id, fromInputEvent) {
    if (!this.initialized) return;

    if (this.pendingAutoApplyTimer) {
      clearTimeout(this.pendingAutoApplyTimer);
      this.pendingAutoApplyTimer = null;
    }

    const isPreConfig = id === 'preConfig';
    const applyAction = async () => {
      if (isPreConfig) {
        this.log(`Auto-applying configuration (${id})`);
        await this.applyPreConfigWithRestartIfRunning(`changed ${id}`);
      } else {
        this.log(`Auto-applying configuration (${id})`);
        await this.applyConfigWithRestartIfRunning(`changed ${id}`);
      }
    };

    if (fromInputEvent) {
      this.pendingAutoApplyTimer = setTimeout(() => {
        this.pendingAutoApplyTimer = null;
        this.guard(applyAction);
      }, 350);
      return;
    }

    this.guard(applyAction);
  }

  mergeReconfigureKinds(currentKind, nextKind) {
    if (!currentKind) return nextKind;
    if (currentKind === 'preConfig' || nextKind === 'preConfig') return 'preConfig';
    return 'config';
  }

  async applyPreConfigWithRestartIfRunning(trigger = 'configuration change') {
    if (this.runtimeReconfigureInProgress) {
      this.runtimeReconfigurePendingKind = this.mergeReconfigureKinds(this.runtimeReconfigurePendingKind, 'preConfig');
      return;
    }

    if (!this.running) {
      await this.applyPreConfig();
      return;
    }
    await this.requestRuntimeReconfigure('preConfig', trigger);
  }

  async applyConfigWithRestartIfRunning(trigger = 'configuration change') {
    if (this.runtimeReconfigureInProgress) {
      this.runtimeReconfigurePendingKind = this.mergeReconfigureKinds(this.runtimeReconfigurePendingKind, 'config');
      return;
    }

    if (!this.running) {
      await this.applyConfig();
      return;
    }
    await this.requestRuntimeReconfigure('config', trigger);
  }

  async requestRuntimeReconfigure(kind, trigger) {
    this.runtimeReconfigurePendingKind = this.mergeReconfigureKinds(this.runtimeReconfigurePendingKind, kind);
    if (this.runtimeReconfigureInProgress) return;

    this.runtimeReconfigureInProgress = true;
    try {
      while (this.runtimeReconfigurePendingKind) {
        const pendingKind = this.runtimeReconfigurePendingKind;
        this.runtimeReconfigurePendingKind = null;
        await this.restartMeasurementForConfigurationChange(pendingKind, trigger);
      }
    } finally {
      this.runtimeReconfigureInProgress = false;
    }
  }

  async restartMeasurementForConfigurationChange(kind, trigger) {
    if (!this.running) {
      if (kind === 'preConfig') await this.applyPreConfig();
      else await this.applyConfig();
      return;
    }

    const what = 'configuration';
    this.log(`${trigger} detected during measurement; applying updated ${what}...`);
    this.stopRequested = true;

    if (this.measurementRunPromise) {
      await this.measurementRunPromise;
    }

    if (kind === 'preConfig') await this.applyPreConfig();
    else await this.applyConfig();

    this.log('Restarting measurement with new settings');
    this.guard(() => this.startMeasurement());
  }

  log(text) {
    const element = $('log');
    const time = new Date().toLocaleTimeString();
    element.textContent += `[${time}] ${text}\n`;
    element.scrollTop = element.scrollHeight;
  }

  status(text) {
    $('status').textContent = text;
  }

  async guard(action) {
    try {
      await action();
    } catch (error) {
      this.log(`Error: ${error.message}`);
      this.status(`Error: ${error.message}`);
      console.error(error);
    }
  }

  // ------------------------------------------------------------ connection --

  async tryAutoConnectAndInitialize(reason) {
    if (this.running) {
      if (String(reason).startsWith('serial-connect')) {
        this.pendingSerialAutoStartup = true;
      }
      return;
    }
    if (this.connected || this.initialized || this.autoStartupInProgress) return;
    if (!('serial' in navigator) || !navigator.serial?.getPorts) return;
    if (String(reason).startsWith('serial-connect') && this.autoStartupDisabledByUser) {
      this.log('Auto-start is paused after manual disconnect. Use Connect to resume automatic startup.');
      return;
    }

    if (String(reason).startsWith('serial-connect')) {
      this.pendingSerialAutoStartup = false;
    }

    this.autoStartupInProgress = true;
    try {
      const reconnectConfigSnapshot = String(reason).startsWith('serial-connect')
        ? this.snapshotConfigurationControls()
        : null;

      const ports = await navigator.serial.getPorts();
      const port = ports.find((candidate) => isEvmH5Port(candidate));
      if (!port) return;

      this.log(`Authorized EVM-H5 detected (${reason}), starting automatic connect and firmware download...`);
      await this.connect({ port });
      await this.initialize();
      await this.reapplyConfiguredSettingsAfterReconnect(reason, reconnectConfigSnapshot);
      if (!this.running) {
        this.log('Starting measurement automatically...');
        this.startMeasurement();
      }
      if (this.viewSections.setup) {
        this.setSectionVisibility(this.viewSections.setup, false);
      }
      this.log('Automatic startup complete');
    } catch (error) {
      this.log(`Automatic startup failed: ${error.message}`);
      if (this.connected && !this.initialized) {
        try {
          await this.disconnect({ userInitiated: false });
        } catch {
          // Ignore clean-up errors after failed auto-start.
        }
      }
    } finally {
      this.autoStartupInProgress = false;
    }
  }

  async onSerialDisconnect(event) {
    const unpluggedPort = event?.target ?? null;
    if (!this.connected && !this.initialized && !this.activePort) return;
    if (this.activePort && unpluggedPort && this.activePort !== unpluggedPort) return;

    this.log('Hardware disconnected');
    await this.disconnect({ userInitiated: false, transportLost: true });
  }

  async onUsbDisconnect(event) {
    const unpluggedDevice = event?.device ?? null;
    if (!(this.activePort instanceof WebUsbSerialPort)) return;
    if (unpluggedDevice && this.activePort.device !== unpluggedDevice) return;

    this.log('Hardware disconnected');
    await this.disconnect({ userInitiated: false, transportLost: true });
  }

  async connectInitializeAndStart() {
    await this.connect({ userInitiated: true });
    await this.initialize();
    await this.startMeasurement();
  }

  async connectUsbInitializeAndStart() {
    // WebUSB is the fallback transport for platforms without Web Serial (Android).
    const port = await requestWebUsbPort();
    await this.connect({ port, userInitiated: true });
    await this.initialize();
    await this.startMeasurement();
  }

  async connect({ port = null, userInitiated = false } = {}) {
    if (userInitiated) {
      this.autoStartupDisabledByUser = false;
    }
    const selectedPort = port ?? await navigator.serial.requestPort({ filters: EVM_H5_FILTERS });
    await this.corefw.open(selectedPort, DEFAULT_BAUD_RATE);
    this.activePort = selectedPort;
    this.setState({ connected: true, initialized: false });
    this.status('Connected');

    const info = [];
    for (const [label, reader] of [
      ['Application', () => this.corefw.applicationName()],
      ['Version', () => this.corefw.version()],
      ['HW revision', () => this.corefw.hardwareRevision()],
      ['Serial', () => this.corefw.serialNumber()],
    ]) {
      try {
        info.push(`${label}: ${await reader()}`);
      } catch (error) {
        info.push(`${label}: n/a`);
      }
    }
    $('boardInfo').textContent = info.join('\n');
    this.log('Shield board connected');
  }

  async disconnect({ userInitiated = false, transportLost = false } = {}) {
    if (userInitiated) {
      this.autoStartupDisabledByUser = true;
    }
    this.stopRequested = true;

    // Update UI/state immediately so unplug feels instantaneous.
    this.activePort = null;
    this.pointCloudPoints = [];
    this.pointCloudScaleReferencePoints = [];
    this.pointCloudScaleReferenceKey = '';
    this.setState({ connected: false, initialized: false });
    $('boardInfo').textContent = '';
    $('deviceInfo').textContent = '';
    this.status('Disconnected');
    this.log('Disconnected');

    if (transportLost) {
      void this.corefw.close().catch(() => {
        // Ignore close failures after cable unplug.
      });
      return;
    }

    try {
      if (this.initialized) await this.device.close();
    } catch { /* ignore */ }
    try {
      await this.corefw.close();
    } catch {
      // Closing can fail if the USB cable was unplugged while active.
    }
  }

  // ------------------------------------------------------------- sensor -----

  async loadFirmware() {
    if (this.hexText) return this.hexText;

    const embedded = $('embeddedFirmware');
    if (embedded) {
      this.hexText = embedded.textContent.trim();
      this.log('Using the firmware image embedded in this page');
      return this.hexText;
    }

    const response = await fetch(DEFAULT_HEX_URL);
    if (!response.ok) {
      throw new Error(`Could not load ${DEFAULT_HEX_URL} (${response.status}). Select the hex file manually.`);
    }
    this.hexText = await response.text();
    this.log(`Loaded firmware image from ${DEFAULT_HEX_URL}`);
    return this.hexText;
  }

  snapshotConfigurationControls() {
    return {
      preConfig: $('preConfig').value,
      period: $('period').value,
      iterations: $('iterations').value,
      highAccuracyIterations: $('highAccuracyIterations').value,
      nrPeaks: $('nrPeaks').value,
      confidence: $('confidence').value,
      signalStrength: $('signalStrength').checked,
      noiseStrength: $('noiseStrength').checked,
      xtalk: $('xtalk').checked,
      fullNoise: $('fullNoise').checked,
      histograms: $('histograms').checked,
    };
  }

  restoreConfigurationControls(snapshot) {
    if (!snapshot) return;
    $('preConfig').value = snapshot.preConfig;
    $('period').value = snapshot.period;
    $('iterations').value = snapshot.iterations;
    $('iterationsSlider').value = snapshot.iterations;
    $('highAccuracyIterations').value = snapshot.highAccuracyIterations;
    $('nrPeaks').value = snapshot.nrPeaks;
    $('confidence').value = snapshot.confidence;
    $('signalStrength').checked = Boolean(snapshot.signalStrength);
    $('noiseStrength').checked = Boolean(snapshot.noiseStrength);
    $('xtalk').checked = Boolean(snapshot.xtalk);
    $('fullNoise').checked = Boolean(snapshot.fullNoise);
    $('histograms').checked = Boolean(snapshot.histograms);
    this.updateHistogramNotice();
    this.updateHighAccuracyIterationsVisibility();
  }

  async reapplyConfiguredSettingsAfterReconnect(reason, snapshot = null) {
    if (!String(reason).startsWith('serial-connect')) return;

    this.restoreConfigurationControls(snapshot);
    this.log('Re-applying configured settings after reconnect...');
    await this.applyPreConfig();
    // applyPreConfig reads back device defaults; restore requested UI values before final apply.
    this.restoreConfigurationControls(snapshot);
    await this.applyConfig();
  }

  async initialize() {
    const hexText = await this.loadFirmware();

    this.status('Opening SPI bus...');
    await this.device.open(Number($('spiSpeed').value) * 1000, 0);

    this.status('Enabling sensor...');
    const awake = await this.device.enable(true);
    this.log(`ENABLE register reads 0x${(await this.device.readEnable()).toString(16).padStart(2, '0')}`);
    if (!awake) {
      throw new Error('Sensor did not report CPU ready. Check the SPI wiring, the SPI clock and that the sensor is seated.');
    }
    await this.device.forceBootmonitor();
    await this.device.blCmdI2cOff();

    this.status('Downloading firmware...');
    const appInfo = await this.device.downloadAndStartApp(hexText, {
      useFifo: DEFAULT_USE_FIFO_DOWNLOAD,
      verify: DEFAULT_VERIFY_DOWNLOAD,
      onProgress: (fraction) => this.status(`Downloading firmware... ${(fraction * 100).toFixed(0)}%`),
    });

    const serial = await this.device.readSerialNumber();
    this.firmwareVersion = Array.from(appInfo);
    this.serialNumber = serial;
    const config = await this.device.loadConfig();
    $('deviceInfo').textContent =
      `Firmware version: ${appInfo[1]}.${appInfo[2]}.${appInfo[3]}\n` +
      `Serial number: 0x${serial.toString(16).padStart(8, '0')}`;

    this.syncFormFromConfig(config);
    this.setState({ initialized: true });
    this.status('Sensor ready');
    this.log('Application firmware started');
  }

  syncFormFromConfig(config) {
    this.lastConfig = config;
    $('period').value = config.period;
    $('iterations').value = config.iterations;
    $('iterationsSlider').value = config.iterations;
    $('nrPeaks').value = String(config.resultFormat & 0x07);
    $('signalStrength').checked = (config.resultFormat & 0x08) !== 0;
    $('noiseStrength').checked = (config.resultFormat & 0x10) !== 0;
    $('xtalk').checked = (config.resultFormat & 0x20) !== 0;
    $('fullNoise').checked = (config.resultFormat & 0x80) !== 0;
    $('histograms').checked = config.histograms === 1;
    $('confidence').value = config.confidenceThreshold;
    if (config.page) {
      const highAccuracyIterations = config.page[0x4a - 0x22] | (config.page[0x4b - 0x22] << 8);
      $('highAccuracyIterations').value = highAccuracyIterations || 100;
    }
    this.updateHistogramNotice();
    this.updateHighAccuracyIterationsVisibility();
  }

  async applyPreConfig() {
    const { cmd, dualMode } = this.parseConfigurationSelection();
    this.status('Applying configuration...');
    await this.device.preConfigure(cmd);
    await this.device.configure({
      dualMode,
      highAccuracyIterations: dualMode ? Number($('highAccuracyIterations').value) : undefined,
    });
    const config = await this.device.loadConfig();
    this.syncFormFromConfig(config);
    const name = $('preConfig').selectedOptions[0].textContent;
    this.status(`Configuration "${name}" applied`);
    this.log(`Configuration "${name}" applied, focal plane mode ${FP_MODE_NAMES[config.fpMode]}, dual mode ${dualMode}`);
  }

  async applyConfig() {
    const { dualMode } = this.parseConfigurationSelection();
    this.status('Writing configuration...');
    await this.device.configure({
      period: Number($('period').value),
      iterations: Number($('iterations').value),
      dualMode,
      highAccuracyIterations: dualMode ? Number($('highAccuracyIterations').value) : undefined,
      nrPeaks: Number($('nrPeaks').value),
      signalStrength: $('signalStrength').checked ? 1 : 0,
      noiseStrength: $('noiseStrength').checked ? 1 : 0,
      xtalk: $('xtalk').checked ? 1 : 0,
      fullNoise: $('fullNoise').checked ? 1 : 0,
      histograms: $('histograms').checked ? 1 : 0,
      confidenceThreshold: Number($('confidence').value),
    });
    const config = await this.device.loadConfig();
    this.syncFormFromConfig(config);
    this.selectedPixel = null;
    this.status('Configuration written');
    this.log('Configuration written');
  }

  // -------------------------------------------------------- measurement -----

  async startMeasurement() {
    if (this.running) return;

    this.running = true;
    this.stopRequested = false;
    this.frameTimes = [];
    this.setState({});
    this.status('Measuring...');
    this.log('Measurement started');

    this.measurementRunPromise = (async () => {
      try {
        await this.device.startMeasure();
        while (!this.stopRequested) {
          let measurement = null;
          try {
            measurement = await this.device.readMeasurement({
              timeoutMs: MEASUREMENT_POLL_TIMEOUT_MS,
              shouldStop: () => this.stopRequested,
            });
          } catch (error) {
            if (error?.message?.includes('Timeout while waiting for measurement frames')) {
              continue;
            }
            throw error;
          }
          if (!measurement) break;
          this.onMeasurement(measurement);
          // Yield to the browser so the UI stays responsive.
          await new Promise((resolve) => requestAnimationFrame(resolve));
        }
      } finally {
        if (this.connected && this.activePort) {
          try {
            await this.device.stopMeasure();
            this.log('Measurement stopped');
          } catch (error) {
            this.log(`Stop failed: ${error.message}`);
          }
        } else {
          this.log('Measurement stopped (transport lost)');
        }
        this.running = false;
        this.stopRequested = false;
        this.setState({});
        this.status('Idle');
        this.measurementRunPromise = null;

        if (this.logger.recording) this.guard(() => this.logger.finish());

        if (this.pendingSerialAutoStartup) {
          this.guard(() => this.tryAutoConnectAndInitialize('serial-connect-pending'));
        }
      }
    })();

    await this.measurementRunPromise;
  }

  onMeasurement({ resultFrames, histogramFrames, refFrames }) {
    if (!resultFrames.length) return;

    const now = performance.now();
    this.frameTimes.push(now);
    while (this.frameTimes.length > 20) this.frameTimes.shift();
    const fps = this.frameTimes.length > 1
      ? (this.frameTimes.length - 1) * 1000 / (now - this.frameTimes[0])
      : 0;

    this.lastMeasurement = buildPixelMap(resultFrames, { toMillimetres: true });
    this.lastHistogramMap = histogramFrames.length ? buildHistogramMap(histogramFrames) : null;
    this.lastRefFrames = refFrames;

    const { header, footer, fpMode } = this.lastMeasurement;
    let info =
      `frame ${header.fNumber} | ${FP_MODE_NAMES[fpMode] ?? fpMode} | ` +
      `${pixelColumns(fpMode)}x${pixelRows(fpMode)} | ` +
      `temp ${header.temperature[0]} C | bdv ${header.bdv} | ` +
      `t0 ${footer.t0Integration} us | ${fps.toFixed(1)} fps`;
    if (refFrames.length) {
      const { sums } = parseRefSpadFrame(refFrames[0]);
      info += `\nreference SPAD sums t0: [${sums[0].join(', ')}]  t1: [${sums[1].join(', ')}]`;
    }
    $('frameInfo').textContent = info;

    if (this.logger.recording) {
      this.logger.addMeasurement({ resultFrames, histogramFrames });
      if (this.logger.complete) this.guard(() => this.logger.finish());
    }

    this.redraw();
  }

  // ------------------------------------------------------------ logging -----

  async toggleRecording() {
    if (this.logger.recording) {
      await this.logger.finish();
      return;
    }
    if (!this.initialized || !this.lastConfig) {
      throw new Error('Download the firmware before recording a log file.');
    }

    this.logger.start({
      frames: Number($('recordFrames').value),
      configPage: this.lastConfig.page,
      info: {
        'host version': HOST_VERSION,
        'fw version': this.firmwareVersion ?? [],
        'logger version': LOGGER_VERSION,
        'web_gui_version': WEB_GUI_VERSION,
        'serial number': this.serialNumber ?? 0,
      },
    });
    this.log(`Recording ${this.logger.requestedFrames} frames into a log file`);
    if (!this.running) this.guard(() => this.startMeasurement());
  }

  updateRecordingUi() {
    const button = $('record');
    const status = $('recordStatus');
    if (!button || !status) return;

    button.disabled = !this.initialized;
    button.textContent = this.logger.recording ? 'Stop & save' : 'Record';
    status.textContent = this.logger.recording
      ? `Recording ${this.logger.recordedFrames} / ${this.logger.requestedFrames} frames`
      : 'Not recording';
  }

  redraw() {
    if (!this.lastMeasurement) return;
    const { pixels, resultFormat } = this.lastMeasurement;
    const source = $('mapSource').value;
    const hasPeaks = (resultFormat & 0x07) > 0;

    const values = pixels.map((row) => row.map((pixel) => {
      switch (source) {
        case 'distance': return hasPeaks && pixel.peaks[0]?.distance ? pixel.peaks[0].distance : null;
        case 'snr': return hasPeaks ? pixel.peaks[0]?.snr ?? null : null;
        case 'signal': return hasPeaks ? pixel.peaks[0]?.signal ?? null : null;
        case 'noise': return pixel.noise;
        case 'xtalk': return pixel.xtalk;
        default: return null;
      }
    }));

    const finite = values.flat().filter((value) => value !== null && value !== undefined && !Number.isNaN(value));
    let min = 0;
    let max = 1;
    if (finite.length) {
      if ($('autoScale').checked) {
        min = Math.min(...finite);
        max = Math.max(...finite);
      } else {
        min = Number($('scaleMin').value);
        max = Number($('scaleMax').value);
      }
    }
    if (max <= min) max = min + 1;

    const unit = source === 'distance' ? 'mm' : '';
    const canvas = $('pixelMap');
    const height = Math.round(canvas.width * PIXEL_MAP_ASPECT);
    if (canvas.height !== height) canvas.height = height;
    drawHeatMap(canvas, values, { min, max, highlight: this.selectedPixel });
    drawColorBar($('colorBar'), min, max, unit);
    this.updatePointCloud();
    this.drawHistograms();
  }

  updatePointCloud() {
    if (!this.lastMeasurement) return;

    const rows = this.lastMeasurement.pixels.length;
    const columns = rows ? this.lastMeasurement.pixels[0].length : 0;
    const scaleReferenceKey = `${rows}x${columns}`;
    const maxDistance = Number($('pointCloudMaxDistance').value);
    const allPoints = [];
    const points = [];
    let selected = -1;

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < columns; col++) {
        const pixel = this.lastMeasurement.pixels[row][col];
        const distance = pixel.peaks[0]?.distance ?? 0;
        if (!distance || distance <= 0) continue;

        const xyz = getPixelXYZ(row, col, distance, columns, rows, pixel.fovCorrection ?? null);
        const point = {
          row,
          col,
          distance,
          ...xyz,
        };
        allPoints.push(point);

        if (distance > maxDistance) continue;
        points.push(point);

        if (this.selectedPixel && this.selectedPixel.x === col && this.selectedPixel.y === row) {
          selected = points.length - 1;
        }
      }
    }

    if (this.pointCloudScaleReferenceKey !== scaleReferenceKey) {
      this.pointCloudScaleReferenceKey = scaleReferenceKey;
      this.pointCloudScaleReferencePoints = allPoints.slice();
    } else if (!this.pointCloudScaleReferencePoints.length && allPoints.length) {
      this.pointCloudScaleReferencePoints = allPoints.slice();
    }

    this.pointCloudPoints = points;
    this.selectedPointIndex = selected;
    this.drawPointCloud();
  }

  drawPointCloud() {
    const canvas = $('pointCloud');
    const targetHeight = Math.round(canvas.width * 0.62);
    if (canvas.height !== targetHeight) canvas.height = targetHeight;
    const resolutionPointCount = this.lastMeasurement
      ? this.lastMeasurement.pixels.length * this.lastMeasurement.pixels[0].length
      : 256;

    drawPointCloud(canvas, this.pointCloudPoints, {
      yaw: this.pointCloudView.yaw,
      pitch: this.pointCloudView.pitch,
      zoom: this.pointCloudView.zoom,
      selectedIndex: this.selectedPointIndex,
      referencePoints: this.pointCloudScaleReferencePoints,
      pointCountForSizing: resolutionPointCount,
      maxDistanceForColor: Number($('pointCloudMaxDistance').value),
    });
    drawColorBar($('pointCloudColorBar'), 0, Number($('pointCloudMaxDistance').value), 'mm');

    const selected = this.selectedPointIndex >= 0 ? this.pointCloudPoints[this.selectedPointIndex] : null;
    const maxDistance = Number($('pointCloudMaxDistance').value);
    $('pointCloudInfo').textContent = selected
      ? `xyz (${selected.x}, ${selected.y}, ${selected.z}) mm | ${this.pointCloudPoints.length} points <= ${maxDistance} mm`
      : `${this.pointCloudPoints.length} points <= ${maxDistance} mm | drag to rotate, wheel to zoom`;
  }

  onPointCloudDragStart(event) {
    this.pointCloudView.dragging = true;
    this.pointCloudView.pointerX = event.clientX;
    this.pointCloudView.pointerY = event.clientY;
    $('pointCloud').classList.add('dragging');
  }

  onPointCloudDragMove(event) {
    if (!this.pointCloudView.dragging) return;
    const deltaX = event.clientX - this.pointCloudView.pointerX;
    const deltaY = event.clientY - this.pointCloudView.pointerY;
    this.pointCloudView.pointerX = event.clientX;
    this.pointCloudView.pointerY = event.clientY;

    this.pointCloudView.yaw += deltaX * 0.01;
    this.pointCloudView.pitch = Math.max(-1.45, Math.min(1.45, this.pointCloudView.pitch + deltaY * 0.01));
    this.drawPointCloud();
  }

  onPointCloudDragEnd() {
    if (!this.pointCloudView.dragging) return;
    this.pointCloudView.dragging = false;
    $('pointCloud').classList.remove('dragging');
  }

  onPointCloudWheel(event) {
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    this.pointCloudView.zoom = Math.max(0.12, Math.min(12, this.pointCloudView.zoom * factor));
    this.drawPointCloud();
  }

  onPointCloudTouchStart(event) {
    event.preventDefault();
    if (event.touches.length === 1) {
      const touch = event.touches[0];
      this.pointCloudView.dragging = true;
      this.pointCloudView.pointerX = touch.clientX;
      this.pointCloudView.pointerY = touch.clientY;
      $('pointCloud').classList.add('dragging');
    } else if (event.touches.length >= 2) {
      this.pointCloudView.dragging = false;
      this.pointCloudView.pinchDistance = this._touchDistance(event.touches);
    }
  }

  onPointCloudTouchMove(event) {
    event.preventDefault();
    if (event.touches.length === 1 && this.pointCloudView.dragging) {
      const touch = event.touches[0];
      const deltaX = touch.clientX - this.pointCloudView.pointerX;
      const deltaY = touch.clientY - this.pointCloudView.pointerY;
      this.pointCloudView.pointerX = touch.clientX;
      this.pointCloudView.pointerY = touch.clientY;

      this.pointCloudView.yaw += deltaX * 0.01;
      this.pointCloudView.pitch = Math.max(-1.45, Math.min(1.45, this.pointCloudView.pitch + deltaY * 0.01));
      this.drawPointCloud();
    } else if (event.touches.length >= 2) {
      const distance = this._touchDistance(event.touches);
      const previous = this.pointCloudView.pinchDistance;
      if (previous > 0 && distance > 0) {
        this.pointCloudView.zoom = Math.max(0.12, Math.min(12, this.pointCloudView.zoom * (distance / previous)));
        this.drawPointCloud();
      }
      this.pointCloudView.pinchDistance = distance;
    }
  }

  onPointCloudTouchEnd(event) {
    if (event.touches.length === 0) {
      this.pointCloudView.pinchDistance = 0;
      this.onPointCloudDragEnd();
    } else if (event.touches.length === 1) {
      // Second finger lifted: resume single-finger rotation from the remaining touch.
      const touch = event.touches[0];
      this.pointCloudView.pinchDistance = 0;
      this.pointCloudView.dragging = true;
      this.pointCloudView.pointerX = touch.clientX;
      this.pointCloudView.pointerY = touch.clientY;
    }
  }

  _touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  drawHistograms() {
    this.updateHistogramNotice();

    const logScale = $('histLogScale').checked;
    const max = $('histAutoScale').checked ? null : Number($('histScaleMax').value);

    const palette = ['#4fc3f7', '#81c784', '#ffb74d', '#e57373'];
    const refSeries = [];
    if (this.lastHistogramMap) {
      this.lastHistogramMap.refHistograms.slice(0, 4).forEach((data, index) => {
        refSeries.push({ data, color: palette[index], label: `ref ${index}` });
      });
    }
    drawHistogram($('refHistogram'), refSeries, { title: 'Reference histograms', logScale, max });

    const pixelSeries = [];
    if (this.lastHistogramMap && this.selectedPixel) {
      const { x, y } = this.selectedPixel;
      const data = this.lastHistogramMap.map[y]?.[x];
      if (data) pixelSeries.push({ data, color: '#4fc3f7', label: `pixel ${x},${y}` });
    }
    const title = this.selectedPixel
      ? `Pixel histogram (${this.selectedPixel.x}, ${this.selectedPixel.y})`
      : 'Pixel histogram - click a pixel';
    drawHistogram($('pixelHistogram'), pixelSeries, { title, logScale, max });
  }

  onPixelMapClick(event) {
    if (!this.lastMeasurement) return;
    const canvas = $('pixelMap');
    const rect = canvas.getBoundingClientRect();
    const columns = this.lastMeasurement.pixels[0].length;
    const rows = this.lastMeasurement.pixels.length;
    const x = Math.min(columns - 1, Math.floor(((event.clientX - rect.left) / rect.width) * columns));
    const y = Math.min(rows - 1, Math.floor(((event.clientY - rect.top) / rect.height) * rows));
    this.selectedPixel = { x, y };

    const pixel = this.lastMeasurement.pixels[y][x];
    const distance = pixel.peaks[0]?.distance ?? 0;
    const signal = pixel.peaks[0]?.signal ?? null;
    const xyz = distance > 0
      ? getPixelXYZ(y, x, distance, columns, rows, pixel.fovCorrection ?? null)
      : null;
    const peaks = pixel.peaks
      .map((peak, index) => `  peak ${index}: ${peak.distance} mm, snr ${peak.snr}` +
        (peak.signal === null ? '' : `, signal ${peak.signal}`))
      .join('\n');
    $('pixelInfo').textContent =
      `Pixel (${x}, ${y})\n` +
      (xyz ? `  xyz: (${xyz.x}, ${xyz.y}, ${xyz.z}) mm\n` : '') +
      `  signal: ${signal ?? '-'}\n` +
      `  noise: ${pixel.noise ?? '-'}\n` +
      `  xtalk: ${pixel.xtalk ?? '-'}\n` +
      (peaks || '  no peaks reported');

    this.redraw();
  }
}

// Start the application after the DOM is ready.
window.addEventListener('DOMContentLoaded', () => {
  new Application();
});
