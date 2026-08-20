'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var path = require('path');
var AirPlayAdapter = require('./lib/adapters/airplay');
var AirPlayLiveBridge = require('./lib/airplayLiveBridge');
var CommandRunner = require('./lib/commandRunner').CommandRunner;
var BluetoothAdapter = require('./lib/adapters/bluetooth');
var BluetoothVolumeManager = require('./lib/bluetoothVolumeManager');
var CodecManager = require('./lib/codecManager');
var Diagnostics = require('./lib/diagnostics');
var OutputManager = require('./lib/outputManager');
var VolumioApi = require('./lib/volumioApi');
var createLogger = require('./lib/logger');

module.exports = WirelessOutputManager;

function WirelessOutputManager(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.configManager = context.configManager;
  this.reconnectTimer = null;
  this.reconnectBusy = false;
  this.reconnectPromise = null;
  this.foregroundBluetoothBusy = false;
  this.routingBusy = false;
  this.transportRecoveries = {};
  this.transportPollAttempts = 10;
  this.transportPollDelayMs = 500;
  this.volumeRestoreTimeoutMs = 15000;
  this.volumeRestoreSettleMs = 1500;
  this.volumeRestoreVerifyMs = 750;
  this.volumeRestoreStableMs = 1500;
  this.volumeRestoreRetryMs = 500;
  this.lastError = '';
  this.lastDiagnostics = null;
  this.devices = [];
  this.airplayReceivers = [];
}

WirelessOutputManager.prototype.onVolumioStart = function () {
  var configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  this.config = new (require('v-conf'))();
  this.config.loadFile(configFile);
  this.log = createLogger(this.logger, '', this._debugEnabled.bind(this));
  this.btLog = createLogger(this.logger, 'Bluetooth', this._debugEnabled.bind(this));
  this.diagLog = createLogger(this.logger, 'Diagnostics', this._debugEnabled.bind(this));
  this.runner = new CommandRunner({ logger: this.log, defaultTimeoutMs: 15000 });
  this.bluetooth = new BluetoothAdapter({ runner: this.runner, logger: this.btLog });
  this.airplay = new AirPlayAdapter({ runner: this.runner, logger: this.log, pluginDir: __dirname });
  this.airplayBridge = new AirPlayLiveBridge({
    adapter: this.airplay,
    runner: this.runner,
    logger: this.log,
    maximumVolume: 100,
    onUnexpectedExit: this._handleUnexpectedAirPlayExit.bind(this)
  });
  this.bluetoothVolume = new BluetoothVolumeManager({
    runner: this.runner, logger: this.btLog, safeMaximumPercent: 10
  });
  this.codecManager = new CodecManager({ runner: this.runner, logger: this.btLog });
  this.volumioApi = new VolumioApi();
  this.diagnostics = new Diagnostics({ runner: this.runner, logger: this.diagLog });
  this.outputManager = new OutputManager({
    pluginDir: __dirname, runner: this.runner, logger: this.log, commandRouter: this.commandRouter
  });
  return libQ.resolve();
};

WirelessOutputManager.prototype.onStart = function () {
  var self = this;
  self.log.info('Starting');
  // Volumio 4 validates lifecycle methods using Kew's promise interface.
  // Assimilate the native promise returned by OutputManager into a Kew
  // promise so plugin enablement is not incorrectly marked as failed.
  return libQ.resolve(self.outputManager.getStatus()).then(function (status) {
    // Migrate installations created before outputEnabled was persisted.
    if (status.configured && self.config.get('outputEnabled') !== true) {
      self.config.set('outputEnabled', true);
    }
    if (status.backend && status.backend !== 'conflict') self.config.set('activeBackend', status.backend);
    // An AirPlay ALSA contribution cannot safely survive a Volumio restart:
    // its private sender and FIFO belong to the previous process. Return to
    // the default output instead of leaving MPD pointed at a dead pipe.
    if (status.backend === 'airplay' || status.backend === 'conflict') {
      return self.outputManager.removeOutput().then(function () {
        self.config.set('outputEnabled', false);
        self.config.set('activeBackend', '');
        self.log.warn('Removed a stale AirPlay route during startup; select it manually when ready');
      });
    }
    if (self.config.get('enabled') && self.config.get('autoReconnect')) self._scheduleReconnect(5000);
  });
};

WirelessOutputManager.prototype.onStop = function () {
  var self = this;
  self.log.info('Stopping');
  self._clearReconnect();
  if (!self.airplayBridge || (self.config.get('activeBackend') !== 'airplay' &&
    !self.airplayBridge.getStatus().running)) return libQ.resolve();
  return libQ.resolve(Promise.resolve().then(async function () {
    await self._stopPlaybackForRouting().catch(function () {});
    await self.outputManager.removeOutput().catch(function (error) {
      self.log.warn('Unable to remove the AirPlay route while stopping: ' + error.message);
    });
    await self.airplayBridge.stop().catch(function (error) {
      self.log.warn('Unable to stop the AirPlay sender cleanly: ' + error.message);
    });
    self.config.set('outputEnabled', false);
    self.config.set('activeBackend', '');
  }));
};

WirelessOutputManager.prototype.onRestart = function () {
  var self = this;
  return self.onStop().then(function () { return self.onStart(); });
};

WirelessOutputManager.prototype.onInstall = function () { return libQ.resolve(); };
WirelessOutputManager.prototype.onUninstall = function () { return libQ.resolve(); };
WirelessOutputManager.prototype.getConfigurationFiles = function () { return ['config.json']; };
WirelessOutputManager.prototype._debugEnabled = function () { return Boolean(this.config && this.config.get('debugLogging')); };

WirelessOutputManager.prototype._codecPreferences = function () {
  try {
    var parsed = JSON.parse(this.config.get('codecPreferences') || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    this.log.warn('Ignoring invalid saved codec preferences: ' + error.message);
    return {};
  }
};

WirelessOutputManager.prototype._preferredCodecFor = function (deviceId) {
  var mac = String(deviceId || '').toUpperCase();
  return this.codecManager.normalize(this._codecPreferences()[mac] || 'AUTO');
};

WirelessOutputManager.prototype._setPreferredCodecFor = function (deviceId, codec) {
  var mac = String(deviceId || '').toUpperCase();
  if (!BluetoothAdapter.MAC_RE.test(mac)) throw new Error('Choose a Bluetooth audio device before saving its codec preference');
  var preferences = this._codecPreferences();
  preferences[mac] = this.codecManager.normalize(codec);
  this.config.set('codecPreferences', JSON.stringify(preferences));
};

WirelessOutputManager.prototype._removeCodecPreferenceFor = function (deviceId) {
  var mac = String(deviceId || '').toUpperCase();
  var preferences = this._codecPreferences();
  if (Object.prototype.hasOwnProperty.call(preferences, mac)) {
    delete preferences[mac];
    this.config.set('codecPreferences', JSON.stringify(preferences));
  }
};

WirelessOutputManager.prototype._clearReconnect = function () {
  if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  this.reconnectTimer = null;
};

WirelessOutputManager.prototype._stopPlaybackForRouting = function () {
  try {
    // Volumio 4's stop command is fire-and-forget. Do not chain its return
    // value; give MPD a short, bounded interval to release the current PCM.
    this.commandRouter.volumioStop();
  } catch (error) {
    return Promise.reject(new Error('Unable to stop playback before switching output: ' + error.message));
  }
  return new Promise(function (resolve) { setTimeout(resolve, 1000); });
};

WirelessOutputManager.prototype._captureVolumeState = async function () {
  var state;
  try {
    state = await this.volumioApi.getState();
  } catch (error) {
    throw new Error('Unable to verify Volumio volume before changing audio routing; no routing change was made.');
  }
  if (state.disableVolumeControl === true || state.volume === null || state.volume === undefined) return null;
  var volume = Number(state.volume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 100) {
    throw new Error('Volumio returned an unsafe volume value; no routing change was made.');
  }
  return { volume: volume, mute: Boolean(state.mute) };
};

WirelessOutputManager.prototype._forceSafeVolumeState = async function () {
  var self = this;
  // Mute first so reducing the numeric value cannot produce an audible burst.
  await self.volumioApi.setVolume('mute');
  await self.volumioApi.setVolume(0);
  await self.volumioApi.setVolume('mute');
  await new Promise(function (resolve) { setTimeout(resolve, self.volumeRestoreVerifyMs); });
  var state = await self.volumioApi.getState();
  if (Number(state.volume) !== 0 || Boolean(state.mute) !== true) {
    throw new Error('Volumio could not be muted at 0%');
  }
};

WirelessOutputManager.prototype._restoreVolumeState = async function (saved) {
  var self = this;
  if (!saved) return;
  var delay = function (milliseconds) {
    return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
  };
  var matchesMutedVolume = function (state) {
    return state && Number(state.volume) === saved.volume && Boolean(state.mute) === true;
  };
  var matchesFinalState = function (state) {
    return state && Number(state.volume) === saved.volume && Boolean(state.mute) === saved.mute;
  };
  var deadline = Date.now() + self.volumeRestoreTimeoutMs;
  var attempts = 0;

  // BlueZ/BlueALSA can publish an initial absolute-volume value while the new
  // transport settles. Wait briefly, then reapply Volumio's saved state until
  // it remains stable across two checks. Playback is already stopped here.
  await delay(self.volumeRestoreSettleMs);
  while (Date.now() <= deadline) {
    attempts += 1;
    try {
      await self.volumioApi.setVolume('mute');
      await self.volumioApi.setVolume(saved.volume);
      await self.volumioApi.setVolume('mute');
    } catch (error) {
      self.log.warn('Volume restoration attempt ' + attempts + ' failed: ' + error.message);
      if (Date.now() < deadline) await delay(self.volumeRestoreRetryMs);
      continue;
    }

    await delay(self.volumeRestoreVerifyMs);
    var state = await self.volumioApi.getState().catch(function () { return null; });
    if (matchesMutedVolume(state)) {
      await delay(self.volumeRestoreStableMs);
      state = await self.volumioApi.getState().catch(function () { return null; });
      if (matchesMutedVolume(state)) {
        if (!saved.mute) {
          await self.volumioApi.setVolume('unmute').catch(function () {});
          await delay(self.volumeRestoreVerifyMs);
          state = await self.volumioApi.getState().catch(function () { return null; });
        }
      }
      if (matchesFinalState(state)) {
        self.log.info('Restored Volumio volume to ' + saved.volume + '%' + (saved.mute ? ' (muted)' : '') +
          ' after changing audio routing' + (attempts > 1 ? ' (' + attempts + ' attempts)' : ''));
        return;
      }
    }
    if (Date.now() < deadline) await delay(self.volumeRestoreRetryMs);
  }
  await self._forceSafeVolumeState().catch(function (error) {
    self.log.warn('Unable to confirm the 0% muted safety state: ' + error.message);
  });
  throw new Error('Volumio volume could not be verified after routing changed; playback remains stopped. Set the volume manually before pressing Play.');
};

WirelessOutputManager.prototype._withPreservedSoftwareVolume = async function (operation) {
  var volumeState = await this._captureVolumeState();
  if (volumeState) {
    try {
      await this._forceSafeVolumeState();
    } catch (error) {
      throw new Error('Unable to mute Volumio at 0% before changing audio routing; no routing change was made.');
    }
  }
  var result;
  try {
    result = await operation();
  } catch (operationError) {
    if (operationError.keepSafeVolume === true) {
      await this._forceSafeVolumeState().catch(function () {});
      throw operationError;
    }
    try {
      await this._restoreVolumeState(volumeState);
    } catch (volumeError) {
      throw new Error(operationError.message + ' Volume restoration also failed: ' + volumeError.message);
    }
    throw operationError;
  }
  await this._restoreVolumeState(volumeState);
  return result;
};

WirelessOutputManager.prototype._ensureBluetoothAudioTransport = function (deviceId) {
  var self = this;
  var mac = String(deviceId || '').toUpperCase();
  if (!BluetoothAdapter.MAC_RE.test(mac)) {
    return Promise.reject(new Error('Choose a Bluetooth audio device before routing playback'));
  }
  if (self.transportRecoveries[mac]) return self.transportRecoveries[mac];

  self.transportRecoveries[mac] = Promise.resolve().then(async function () {
    var status = await self.codecManager.getStatus(mac);
    if (!status.available) {
      throw new Error('BlueALSA audio service is unavailable' + (status.error ? ': ' + status.error : ''));
    }
    if (status.deviceConnected) return status;

    var device = await self.bluetooth.getDeviceInfo(mac);
    self.btLog.warn('Recovering missing BlueALSA audio stream for ' + mac +
      (device.adapterAddress ? ' on adapter ' + device.adapterAddress : ''));
    if (device.connected) {
      // A base Bluetooth connection commonly becomes visible just before its
      // A2DP PCM. Let that settle before doing anything disruptive.
      status = await self._pollBluetoothAudioTransport(mac, self.transportPollAttempts);
      if (status) return status;

      await self.bluetooth.connectAudioProfile(mac).catch(function (error) {
        self.btLog.warn('The selected device did not accept a direct A2DP profile request: ' + error.message);
      });
      status = await self._pollBluetoothAudioTransport(mac, self.transportPollAttempts);
      if (status) return status;

      self.btLog.warn('A2DP did not become ready after the profile request; attempting one full reconnect for ' + mac);
      await self.bluetooth.disconnect(mac).catch(function (error) {
        self.btLog.warn('The stale Bluetooth connection changed before it could be disconnected: ' + error.message);
      });
      await new Promise(function (resolve) { setTimeout(resolve, self.transportPollDelayMs); });
    }
    await self.bluetooth.connect(mac);
    status = await self._pollBluetoothAudioTransport(mac, self.transportPollAttempts);
    if (status) {
      self.btLog.info('BlueALSA audio stream recovered for ' + mac + ' using ' + status.pcmPath);
      return status;
    }
    throw new Error('The selected Bluetooth device connected, but its audio stream did not become available');
  }).finally(function () { delete self.transportRecoveries[mac]; });

  return self.transportRecoveries[mac];
};

WirelessOutputManager.prototype._pollBluetoothAudioTransport = async function (deviceId, attempts) {
  var self = this;
  attempts = Math.max(1, Number(attempts) || 1);
  for (var attempt = 0; attempt < attempts; attempt += 1) {
    var status = await self.codecManager.getStatus(deviceId);
    if (!status.available) {
      throw new Error('BlueALSA audio service is unavailable' + (status.error ? ': ' + status.error : ''));
    }
    if (status.deviceConnected) return status;
    if (attempt + 1 < attempts) {
      await new Promise(function (resolve) { setTimeout(resolve, self.transportPollDelayMs); });
    }
  }
  return null;
};

WirelessOutputManager.prototype._returnToDefaultIfWireless = async function () {
  var self = this;
  if (!self.config.get('outputEnabled')) return;
  await self._withPreservedSoftwareVolume(async function () {
    await self._stopPlaybackForRouting();
    await self.outputManager.removeOutput();
    if (self.airplayBridge) await self.airplayBridge.stop();
    self.config.set('outputEnabled', false);
    self.config.set('activeBackend', '');
  });
};

WirelessOutputManager.prototype._scheduleReconnect = function (delayMs) {
  var self = this;
  self._clearReconnect();
  if (self.foregroundBluetoothBusy || !self.config.get('enabled') || !self.config.get('autoReconnect')) return;
  self.reconnectTimer = setTimeout(function () {
    self._reconnectPreferred().finally(function () { self._scheduleReconnect(15000); });
  }, delayMs);
  if (self.reconnectTimer.unref) self.reconnectTimer.unref();
};

WirelessOutputManager.prototype._reconnectPreferred = async function () {
  var self = this;
  var mac = self.config.get('preferredDeviceMac');
  if (!mac || self.foregroundBluetoothBusy) return;
  if (self.reconnectPromise) return self.reconnectPromise;
  self.reconnectBusy = true;
  self.reconnectPromise = Promise.resolve().then(async function () {
    try {
      var info = await self.bluetooth.getDeviceInfo(mac);
      if (!info.connected) {
        self.btLog.info('Reconnecting preferred device ' + mac);
        await self.bluetooth.connect(mac);
      }
      await self._ensureBluetoothAudioTransport(mac);
      self.lastError = '';
    } catch (error) {
      self.lastError = 'Selected Bluetooth audio device is unavailable: ' + error.message;
      self.btLog.warn(self.lastError);
    }
  }).finally(function () {
    self.reconnectBusy = false;
    self.reconnectPromise = null;
  });
  return self.reconnectPromise;
};

WirelessOutputManager.prototype._withReconnectSuspended = async function (operation) {
  var self = this;
  if (self.foregroundBluetoothBusy) {
    var busyError = new Error('Another Bluetooth operation is still finishing. Please wait and try again.');
    busyError.userMessage = busyError.message;
    throw busyError;
  }
  self._clearReconnect();
  self.foregroundBluetoothBusy = true;
  try {
    if (self.reconnectPromise) await self.reconnectPromise.catch(function () {});
    return await operation();
  } finally {
    self.foregroundBluetoothBusy = false;
    if (self.config.get('enabled') && self.config.get('autoReconnect')) self._scheduleReconnect(15000);
  }
};

WirelessOutputManager.prototype._withRoutingLock = async function (operation) {
  if (this.routingBusy) throw new Error('Another output change is still finishing. Please wait and try again.');
  this.routingBusy = true;
  try {
    return await operation();
  } finally {
    this.routingBusy = false;
  }
};

WirelessOutputManager.prototype._handleUnexpectedAirPlayExit = async function (outcome) {
  var self = this;
  if (!self.config || self.config.get('activeBackend') !== 'airplay') return;
  var detail = outcome && outcome.error ? ': ' + outcome.error.message : '';
  self.log.warn('AirPlay sender stopped unexpectedly' + detail);
  await self._withRoutingLock(async function () {
    await self._stopPlaybackForRouting().catch(function () {});
    await self.outputManager.removeOutput();
    await self.airplayBridge.stop().catch(function () {});
    self.config.set('outputEnabled', false);
    self.config.set('activeBackend', '');
    await self.refreshUI().catch(function () {});
    self._toast('warning', 'The AirPlay session ended, so playback was stopped and the default audio output was restored.');
  });
};

WirelessOutputManager.prototype._toast = function (level, message) {
  this.commandRouter.pushToastMessage(level, 'Wireless Output Manager', message);
};

WirelessOutputManager.prototype.refreshUI = function () {
  var self = this;
  return Promise.resolve(self.getUIConfig()).then(function (uiConfig) {
    self.commandRouter.broadcastMessage('pushUiConfig', uiConfig);
    return uiConfig;
  }).catch(function (error) {
    self.log.warn('Unable to refresh settings page: ' + error.message);
    throw error;
  });
};

WirelessOutputManager.prototype._action = function (name, operation, successMessage) {
  var self = this;
  self.btLog.info(name);
  return Promise.resolve().then(operation).then(function (result) {
    self.lastError = '';
    if (successMessage) self._toast('success', successMessage);
    return result;
  }).catch(function (error) {
    self.lastError = error.message;
    self.btLog.error(name + ' failed: ' + error.message);
    var message = error.userMessage || (/\b(?:busctl|bluetoothctl)\b|br-connection-/i.test(error.message)
      ? 'Bluetooth did not finish the requested operation. Keep the device nearby and turned on. If it is already paired, press its Bluetooth button until the pairing light flashes, then try again.'
      : error.message);
    self._toast('error', message);
    self.refreshUI().catch(function () {});
    return { success: false, error: self.lastError, message: message };
  });
};

WirelessOutputManager.prototype._speakerOptionLabel = function (device, preferred) {
  var name = String(device.name || '').trim();
  if (!name || BluetoothAdapter.MAC_RE.test(name)) name = device.id;
  var states = [];
  if (device.id === preferred) states.push('selected');
  if (device.connected) states.push('connected');
  if (device.paired) states.push('paired');
  if (device.audioCapable === true) states.push('audio-capable');
  else if (device.audioCapable === null) states.push('unidentified device');
  return name + (states.length ? ' — ' + states.join(', ') : '');
};

WirelessOutputManager.prototype._speakerOptions = function (preferred, preferredInfo) {
  var self = this;
  var byId = {};
  self.devices.forEach(function (device) { byId[device.id] = device; });
  if (preferredInfo) byId[preferredInfo.id] = preferredInfo;
  else if (preferred && !byId[preferred]) {
    byId[preferred] = {
      id: preferred,
      name: self.config.get('preferredDeviceName') || preferred,
      paired: false,
      connected: false,
      audioCapable: true
    };
  }
  return Object.keys(byId).map(function (id) { return byId[id]; })
    .filter(function (device) { return device.audioCapable !== false || device.id === preferred; })
    .sort(function (a, b) {
      function rank(device) {
        if (device.id === preferred) return 0;
        if (device.audioCapable === true && device.connected) return 1;
        if (device.audioCapable === true && device.paired) return 2;
        if (device.audioCapable === true) return 3;
        return 4;
      }
      return rank(a) - rank(b) || String(a.name || a.id).localeCompare(String(b.name || b.id));
    });
};

WirelessOutputManager.prototype._loadKnownDevices = async function () {
  if (!this.bluetooth || typeof this.bluetooth.listDevices !== 'function') return this.devices;
  this.devices = await this.bluetooth.listDevices();
  return this.devices;
};

WirelessOutputManager.prototype._loadAirPlayReceivers = async function () {
  var self = this;
  var discovered = await self.airplay.discover();
  var checked = await Promise.all(discovered.map(async function (receiver) {
    var sourceAddress = await self.airplay.getSourceAddress(receiver.address).catch(function () { return ''; });
    if (sourceAddress && sourceAddress === receiver.address) {
      self.log.info('Excluding local AirPlay receiver ' + receiver.name + ' at ' + receiver.address);
      return null;
    }
    return receiver;
  }));
  self.airplayReceivers = checked.filter(Boolean);
  return self.airplayReceivers;
};

WirelessOutputManager.prototype._findAirPlayReceiver = function (receiverId) {
  var wanted = String(receiverId || '').trim().toLowerCase();
  return this.airplayReceivers.find(function (receiver) {
    return String(receiver.id || '').toLowerCase() === wanted;
  }) || null;
};

WirelessOutputManager.prototype._airPlayVolume = function () {
  var volume = Number(this.config.get('airPlayReceiverVolume'));
  return Number.isFinite(volume) && volume >= 0 && volume <= 100 ? Math.round(volume) : 15;
};

WirelessOutputManager.prototype.getUIConfig = function () {
  var self = this;
  var lang = self.commandRouter.sharedVars.get('language_code');
  return self.commandRouter.i18nJson(
    path.join(__dirname, 'i18n', 'strings_' + lang + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'), path.join(__dirname, 'UIConfig.json')
  ).then(async function (ui) {
    function set(index, key, value) { self.configManager.setUIConfigParam(ui, index + '.' + key, value); }
    set('sections[5].content[0]', 'value', Boolean(self.config.get('autoReconnect')));
    set('sections[6].content[0]', 'value', Boolean(self.config.get('debugLogging')));
    var preferred = self.config.get('preferredDeviceMac') || '';
    var preferredCodec = self._preferredCodecFor(preferred);
    var preferredName = self.config.get('preferredDeviceName') || 'No device selected';
    if (!self.devices.length) await self._loadKnownDevices().catch(function () {});
    var status = await self.bluetooth.getStatus(preferred).catch(function (error) { return { available: false, lastError: error.message }; });
    var options = self._speakerOptions(preferred, status.preferred);
    var selectedOption = options.find(function (device) { return device.id === preferred; });
    set('sections[1].content[1]', 'value', {
      value: preferred,
      label: selectedOption ? self._speakerOptionLabel(selectedOption, preferred) : preferredName
    });
    // Volumio removes a select control when its current value has no matching
    // option. A clean installation has no saved device, so keep the empty
    // value in the option list until selection and connection succeed.
    if (!preferred) {
      self.configManager.pushUIConfigParam(ui, 'sections[1].content[1].options', {
        value: '',
        label: 'Choose a Bluetooth audio device'
      });
    }
    options.forEach(function (device) {
      self.configManager.pushUIConfigParam(ui, 'sections[1].content[1].options', {
        value: device.id,
        label: self._speakerOptionLabel(device, preferred)
      });
    });
    var connected = Boolean(status.preferred && status.preferred.connected);
    var paired = Boolean(status.preferred && status.preferred.paired);
    var outputEnabled = Boolean(self.config.get('outputEnabled'));
    var activeBackend = outputEnabled ? String(self.config.get('activeBackend') || 'bluetooth') : '';
    var bluetoothOutputActive = outputEnabled && activeBackend === 'bluetooth';
    var airplayOutputActive = outputEnabled && activeBackend === 'airplay';
    var connectedAudio = options.filter(function (device) { return device.audioCapable === true && device.connected; });
    var connectedNames = connectedAudio.map(function (device) { return device.name || device.id; });
    var codecStatus = preferred ? await self.codecManager.getStatus(preferred).catch(function (error) {
      return { available: false, systemCodecs: [], availableCodecs: [], activeCodec: '', error: error.message };
    }) : { available: false, systemCodecs: [], availableCodecs: [], activeCodec: '' };
    var audioReady = connected && Boolean(codecStatus.deviceConnected);
    var visibleCodecs = audioReady ? codecStatus.availableCodecs : codecStatus.systemCodecs;
    var codecOptions = [{ value: 'AUTO', label: 'Automatic — best available' }];
    ['LDAC', 'APTX-HD', 'AAC', 'APTX', 'SBC'].forEach(function (codec) {
      if (visibleCodecs.indexOf(codec) !== -1 || preferredCodec === codec) {
        codecOptions.push({
          value: codec,
          label: codec === 'LDAC' ? 'LDAC — highest available quality' :
            (codec === 'APTX-HD' ? 'aptX HD — high quality' :
              (codec === 'APTX' ? 'aptX' :
                (codec === 'SBC' ? 'SBC — maximum compatibility' : 'AAC')))
        });
      }
    });
    var selectedCodecOption = codecOptions.find(function (option) { return option.value === preferredCodec; });
    set('sections[2].content[0]', 'options', codecOptions);
    set('sections[2].content[0]', 'value', selectedCodecOption || codecOptions[0]);
    set('sections[2].content[0]', 'hidden', !preferred);
    set('sections[2]', 'hidden', !preferred);

    if (bluetoothOutputActive && connected) {
      set('sections[1]', 'description', preferredName +
        ' is the active Bluetooth output. To use another device, first select Return to default audio output above. Then choose the other device, select Select and connect, and route playback to Bluetooth again.');
    } else if (connected && !audioReady) {
      set('sections[1]', 'description', preferredName +
        ' has a Bluetooth connection, but its audio stream is still preparing. Keep it nearby and switched on, then use Reconnect selected device if the Play button does not appear.');
    } else if (connectedAudio.length > 1) {
      set('sections[1]', 'description', 'Selected: ' + preferredName + '. Also connected: ' +
        connectedNames.filter(function (name) { return name !== preferredName; }).join(', ') +
        '. Choose one device and select Select and connect. Other Bluetooth audio devices will disconnect but remain paired. Music output does not change automatically.');
    } else if (audioReady) {
      set('sections[1]', 'description', preferredName +
        ' is selected and connected. To change devices, choose another one and select Select and connect. Music output does not change automatically.');
    } else if (paired) {
      set('sections[1]', 'description', preferredName +
        ' is selected but disconnected. Switch it on and use Reconnect selected device. If that fails, press its Bluetooth button until the pairing light flashes and retry. You can also choose another device and select Select and connect.');
    } else {
      set('sections[1]', 'description',
        'For a new device: put it in pairing mode, search, choose it, then select Select and connect. Keep its pairing light flashing until audio is ready; some devices may need their Bluetooth button pressed again. A previously paired device normally only needs to be switched on.');
    }

    var bluetoothDeviceVolume = audioReady && self.bluetoothVolume
      ? await self.bluetoothVolume.getVolume(preferred).catch(function (error) {
        self.btLog.warn('Unable to read selected Bluetooth stream volume for the UI: ' + error.message);
        return null;
      })
      : null;
    set('sections[2].content[1]', 'hidden', !bluetoothDeviceVolume);
    if (bluetoothDeviceVolume) {
      set('sections[2].content[1]', 'value', bluetoothDeviceVolume.maximum);
      set('sections[2].content[1]', 'description',
        'Current Bluetooth stream volume: ' + bluetoothDeviceVolume.maximum +
        '%. This is local BlueALSA digital gain, not necessarily the device\'s physical volume. A normal switch to Bluetooth starts at 10% for safety; Apply codec and volume uses the level entered here.');
    }

    var listeningSafety = 'Listening safety: wireless loudness may be controlled at three points: Volumio volume when its software mixer is enabled, Bluetooth stream volume or AirPlay sender volume, and the receiving device\'s own volume. Keep headphones off your head until routing and volume setup is complete and you have confirmed a safe level. ';
    var outputDescription;
    if (bluetoothOutputActive && audioReady) {
      outputDescription = 'Music output: ' + preferredName + ' over Bluetooth. Changing output stops playback; press Play afterward. ' +
        'There is no automatic fallback. Volumio may display 100% after Bluetooth playback starts; actual loudness is controlled by Bluetooth stream volume and the device\'s own controls.';
    } else if (bluetoothOutputActive) {
      outputDescription = 'Music output is still set to ' + preferredName + ', but the device is disconnected. ' +
        'Reconnect it or return to the default audio output. There is no automatic fallback.';
    } else if (airplayOutputActive) {
      outputDescription = 'Music output: ' + (self.config.get('preferredAirPlayName') || 'the selected AirPlay receiver') +
        ' over AirPlay at a starting receiver volume of ' + self._airPlayVolume() + '%. Changing output stops playback; press Play afterward. ' +
        'There is no automatic fallback if the receiver or network becomes unavailable.';
    } else if (preferred) {
      outputDescription = 'Music output: the default device selected in Volumio Playback Options. Selected Bluetooth device: ' +
        preferredName + ' — ' + (audioReady ? 'audio ready' : (connected ? 'preparing audio' : 'disconnected')) +
        '. Changing output stops playback; press Play afterward.';
    } else if (self.config.get('preferredAirPlayId')) {
      outputDescription = 'Music output: the default device selected in Volumio Playback Options. Selected AirPlay receiver: ' +
        (self.config.get('preferredAirPlayName') || self.config.get('preferredAirPlayId')) +
        '. Changing output stops playback; press Play afterward.';
    } else {
      outputDescription = 'Music output: the default device selected in Volumio Playback Options. ' +
        'Set up a Bluetooth audio device or AirPlay receiver before choosing a wireless output.';
    }
    set('sections[0]', 'description', listeningSafety + outputDescription);
    set('sections[0].content[0]', 'hidden', !preferred || !audioReady || outputEnabled);
    set('sections[0].content[1]', 'hidden', !self.config.get('preferredAirPlayId') || outputEnabled);
    set('sections[0].content[2]', 'hidden', !outputEnabled);

    var pairedAudio = options.filter(function (device) { return device.paired && device.audioCapable === true; });
    set('sections[4]', 'hidden', !preferred && pairedAudio.length === 0);
    set('sections[4].content[0]', 'hidden', !preferred || audioReady);
    set('sections[4].content[1]', 'hidden', !connected);
    pairedAudio.forEach(function (device) {
      self.configManager.pushUIConfigParam(ui, 'sections[4].content[2].options', {
        value: device.id,
        label: self._speakerOptionLabel(device, preferred)
      });
    });
    set('sections[4].content[2]', 'value', {
      value: '',
      label: pairedAudio.length ? 'Select a paired audio device' : 'No paired audio devices'
    });
    set('sections[4].content[2]', 'hidden', pairedAudio.length === 0);
    set('sections[4].content[3]', 'hidden', !preferred);

    var codecDescription;
    var preferredCodecName = self.codecManager.displayName(preferredCodec);
    if (!preferred) {
      codecDescription = 'Select and connect a Bluetooth audio device to configure its codec and stream volume.';
    } else if (!audioReady) {
      codecDescription = 'Sound settings for ' + preferredName + '. Saved codec preference: ' + preferredCodecName +
        '. Connect the device and wait for its audio stream to become ready to see mutually available codecs and adjust stream volume.';
    }
    else {
      codecDescription = 'Sound settings for ' + preferredName + '. Codec preference: ' + preferredCodecName + '. Active: ' + (codecStatus.activeCodec ? self.codecManager.displayName(codecStatus.activeCodec) : 'unknown') +
        '. Available: ' + (codecStatus.availableCodecs.map(function (codec) { return self.codecManager.displayName(codec); }).join(', ') || 'none reported') +
        '. Automatic chooses LDAC, aptX HD, AAC, aptX, then SBC. ' +
        (bluetoothOutputActive
          ? 'Apply codec and volume stops playback, applies and verifies both settings, and keeps Bluetooth selected. Press Play afterward. '
          : 'The codec preference is saved for the next Bluetooth connection. ') +
        'A normal switch to Bluetooth starts at 10% stream volume for safety.';
      if (codecStatus.systemCodecs.indexOf('AAC') === -1) codecDescription += ' AAC is not available in the installed BlueALSA build.';
    }
    set('sections[2]', 'description', codecDescription);
    set('sections[2].content[0]', 'description', preferred
      ? 'Saved for ' + preferredName + '. ' + (bluetoothOutputActive
        ? 'Apply codec and volume changes and verifies the codec now; there is no need to change output first.'
        : 'The choice is applied and verified the next time Bluetooth output is selected.')
      : 'Select a Bluetooth audio device first.');

    var savedAirPlayId = String(self.config.get('preferredAirPlayId') || '');
    var savedAirPlayName = String(self.config.get('preferredAirPlayName') || 'No AirPlay receiver selected');
    var selectedAirPlay = self._findAirPlayReceiver(savedAirPlayId);
    var airplayOptions = self.airplayReceivers.slice();
    var selectedAirPlayLabel = savedAirPlayName;
    if (savedAirPlayId && !selectedAirPlay) {
      airplayOptions.unshift({
        id: savedAirPlayId,
        name: savedAirPlayName,
        address: String(self.config.get('preferredAirPlayAddress') || ''),
        addresses: [],
        protocols: []
      });
    }
    if (!savedAirPlayId) {
      self.configManager.pushUIConfigParam(ui, 'sections[3].content[1].options', {
        value: '', label: 'Choose an AirPlay receiver'
      });
    }
    airplayOptions.forEach(function (receiver) {
      var protocol = receiver.protocols && receiver.protocols.indexOf('airplay2') !== -1
        ? 'AirPlay 2' : 'AirPlay';
      var optionLabel = receiver.name + ' — ' + protocol +
        (receiver.id === savedAirPlayId ? ', selected' : '');
      self.configManager.pushUIConfigParam(ui, 'sections[3].content[1].options', {
        value: receiver.id,
        label: optionLabel
      });
      if (receiver.id === savedAirPlayId) selectedAirPlayLabel = optionLabel;
    });
    set('sections[3].content[1]', 'value', {
      value: savedAirPlayId,
      label: selectedAirPlayLabel
    });
    set('sections[3].content[2]', 'value', self._airPlayVolume());
    if (airplayOutputActive) {
      set('sections[3]', 'description', (self.config.get('preferredAirPlayName') || 'The selected receiver') +
        ' is the active AirPlay output. Return to the default audio output before selecting another receiver. Playback does not move automatically.');
    } else if (savedAirPlayId) {
      set('sections[3]', 'description', 'Selected AirPlay receiver: ' + savedAirPlayName +
        '. Search again if it has changed address or does not respond. Music remains on the current output until you select Play through selected AirPlay receiver.');
    }

    set('sections[6].content[4]', 'value', self.lastDiagnostics ? JSON.stringify(self.lastDiagnostics, null, 2) : 'Run diagnostics to collect system state.');
    set('sections[6].content[5]', 'value', self.lastError || 'None');
    set('sections[6].content[4]', 'hidden', !self.lastDiagnostics);
    set('sections[6].content[5]', 'hidden', !self.lastError);
    return ui;
  });
};

WirelessOutputManager.prototype.saveSettings = function (data) {
  var self = this;
  ['autoReconnect', 'debugLogging'].forEach(function (key) {
    if (data[key] !== undefined) self.config.set(key, Boolean(data[key]));
  });
  if (data.preferredCodec !== undefined) {
    var submittedCodec = data.preferredCodec;
    if (Array.isArray(submittedCodec)) submittedCodec = submittedCodec[0];
    if (submittedCodec && typeof submittedCodec === 'object') submittedCodec = submittedCodec.value;
    self._setPreferredCodecFor(self.config.get('preferredDeviceMac'), submittedCodec);
  }
  if (self.config.get('enabled') && self.config.get('autoReconnect')) self._scheduleReconnect(1000);
  else self._clearReconnect();
  self._toast('success', 'Settings saved');
  return libQ.resolve();
};

WirelessOutputManager.prototype.saveBluetoothSoundSettings = function (data) {
  var self = this;
  return self._action('Applying Bluetooth sound settings', async function () {
    data = data || {};
    var deviceId = String(self.config.get('preferredDeviceMac') || '').toUpperCase();
    if (!BluetoothAdapter.MAC_RE.test(deviceId)) {
      throw new Error('Select and connect a Bluetooth audio device first');
    }

    var changed = [];
    var currentCodec = self._preferredCodecFor(deviceId);
    var submittedCodec = currentCodec;
    if (data.preferredCodec !== undefined) {
      submittedCodec = data.preferredCodec;
      for (var depth = 0; depth < 5 && submittedCodec && typeof submittedCodec === 'object'; depth += 1) {
        if (Array.isArray(submittedCodec)) submittedCodec = submittedCodec[0];
        else if (Object.prototype.hasOwnProperty.call(submittedCodec, 'value')) submittedCodec = submittedCodec.value;
        else break;
      }
      submittedCodec = self.codecManager.normalize(submittedCodec);
    }

    var streamVolume = data.bluetoothDeviceVolume !== undefined
      ? self._submittedNumber(data, 'bluetoothDeviceVolume', 'Bluetooth stream volume')
      : null;
    var codecChanged = submittedCodec !== currentCodec;
    var outputEnabled = Boolean(self.config.get('outputEnabled')) &&
      String(self.config.get('activeBackend') || 'bluetooth') === 'bluetooth';
    var playbackStopped = false;
    var appliedVolume = null;
    var activeCodec = '';
    var info = await self.bluetooth.getDeviceInfo(deviceId).catch(function () { return null; });

    if (codecChanged && outputEnabled) {
      if (!info || !info.connected) {
        throw new Error('Reconnect the selected Bluetooth device before changing its active codec');
      }
      await self._withPreservedSoftwareVolume(async function () {
        await self._stopPlaybackForRouting();
        playbackStopped = true;
        await self._ensureBluetoothAudioTransport(deviceId);
        var codecResult = await self.codecManager.select(deviceId, submittedCodec);
        activeCodec = codecResult.activeCodec || submittedCodec;
        self._setPreferredCodecFor(deviceId, submittedCodec);
        changed.push('codec');
        try {
          appliedVolume = streamVolume === null
            ? await self.bluetoothVolume.applySafetyCap(deviceId)
            : await self.bluetoothVolume.setVolume(deviceId, streamVolume);
        } catch (error) {
          await self.bluetoothVolume.applySafetyCap(deviceId).catch(function (safetyError) {
            self.btLog.warn('Unable to restore the Bluetooth stream safety cap after a codec change: ' + safetyError.message);
          });
          throw error;
        }
        changed.push('Bluetooth stream volume');
      });
    } else {
      if (codecChanged) {
        self._setPreferredCodecFor(deviceId, submittedCodec);
        changed.push('codec preference');
      }
      if (streamVolume !== null && info && info.connected) {
        appliedVolume = await self.bluetoothVolume.setVolume(deviceId, streamVolume);
        changed.push('Bluetooth stream volume');
      }
    }

    if (!changed.length) {
      throw new Error('Connect the selected Bluetooth device before changing its stream volume');
    }
    await self.refreshUI();
    var volumePercent = appliedVolume && appliedVolume.maximum !== undefined
      ? appliedVolume.maximum
      : (appliedVolume && appliedVolume.volume && appliedVolume.volume.maximum !== undefined
        ? appliedVolume.volume.maximum
        : streamVolume);
    if (playbackStopped) {
      self._toast('success', self.codecManager.displayName(activeCodec) + ' is active' +
        (volumePercent === null ? '' : ' at ' + volumePercent + '% Bluetooth stream volume') +
        '. Press Play.');
    } else if (codecChanged) {
      self._toast('success', self.codecManager.displayName(submittedCodec) +
        ' saved for the next Bluetooth connection' +
        (volumePercent === null ? '.' : '; stream volume set to ' + volumePercent + '%.'));
    } else {
      self._toast('success', 'Bluetooth stream volume set to ' + volumePercent + '%.');
    }
    return { changed: changed, playbackStopped: playbackStopped, volume: volumePercent };
  });
};

WirelessOutputManager.prototype.pairAndConnectDevice = function (data) {
  var self = this;
  var id = self._selected(data);
  if (!BluetoothAdapter.MAC_RE.test(id)) {
    self._toast('error', 'Find and select a Bluetooth audio device first');
    return libQ.resolve({ success: false, error: 'Find and select a Bluetooth audio device first' });
  }
  var previousId = String(self.config.get('preferredDeviceMac') || '').toUpperCase();
  var changingSpeaker = BluetoothAdapter.MAC_RE.test(previousId) && previousId !== id;
  var selected = data && data.preferredDevice;
  if (Array.isArray(selected)) selected = selected[0];
  var targetName = selected && typeof selected === 'object' ? selected.label : '';
  targetName = String(targetName || id).replace(/\s+—.*$/, '').replace(/\s+\(audio\)$/, '');
  if (changingSpeaker && self.config.get('outputEnabled')) {
    var manualSwitchMessage = 'Return to the default audio output before changing Bluetooth devices. Then select ' +
      targetName + ', choose Select and connect, and route playback to Bluetooth again.';
    self.lastError = manualSwitchMessage;
    self.btLog.info('Blocked live Bluetooth device change from ' + previousId + ' to ' + id);
    self._toast('warning', manualSwitchMessage);
    return libQ.resolve({ success: false, blocked: true, error: manualSwitchMessage });
  }
  var successMessage = changingSpeaker
    ? 'Device changed and connected. Music is on the default output; choose Play through selected Bluetooth device when ready.'
    : 'Bluetooth audio device selected and connected';
  var routeChanged = false;
  var onboardingStage = 'pairing';
  self.btLog.info('Pairing and connecting ' + id);
  return Promise.resolve().then(function () {
    return self._withReconnectSuspended(async function () {
      await self.bluetooth.powerOn();
      // Preflight the target before changing a working route or disconnecting
      // another speaker. An unavailable target is an expected UI outcome, not
      // an exception that should escape into Volumio's controller.
      await self.bluetooth.pair(id);
      onboardingStage = 'trusting';
      await self.bluetooth.trust(id);
      onboardingStage = 'connecting';
      var beforeConnect = await self.bluetooth.getDeviceInfo(id).catch(function () { return null; });
      if (!beforeConnect || !beforeConnect.connected) await self.bluetooth.connect(id);
      onboardingStage = 'preparing-audio';
      await self._ensureBluetoothAudioTransport(id).catch(function (error) {
        var readinessError = new Error('The Bluetooth pairing was saved, but no A2DP audio stream became ready: ' + error.message);
        readinessError.userMessage = 'Bluetooth pairing was saved, but the audio connection did not become ready. Keep the device in pairing mode and select Select and connect again.';
        throw readinessError;
      });
      var info = await self.bluetooth.getDeviceInfo(id);
      if (!info.connected) throw new Error('The selected Bluetooth audio device did not report a connected state');

      var knownDevices = await self._loadKnownDevices().catch(function () { return self.devices; });
      var otherConnectedAudio = knownDevices.filter(function (device) {
        return device.id !== id && device.connected && device.audioCapable === true;
      });
      if (changingSpeaker && !otherConnectedAudio.some(function (device) { return device.id === previousId; })) {
        var previousInfo = await self.bluetooth.getDeviceInfo(previousId).catch(function () { return null; });
        if (previousInfo && previousInfo.connected) otherConnectedAudio.push(previousInfo);
      }
      if (changingSpeaker || otherConnectedAudio.length) {
        await self._returnToDefaultIfWireless();
        routeChanged = true;
      }
      for (var deviceIndex = 0; deviceIndex < otherConnectedAudio.length; deviceIndex += 1) {
        await self.bluetooth.disconnect(otherConnectedAudio[deviceIndex].id);
      }
      self.config.set('preferredDeviceMac', id);
      self.config.set('preferredDeviceName', info.name || id);
      self.config.set('enabled', true);
      await self._loadKnownDevices().catch(function () {});
      await self.refreshUI();
      self.lastError = '';
      self._toast('success', successMessage);
      return { success: true, device: info };
    });
  }).catch(async function (error) {
      if (changingSpeaker && routeChanged) {
        await self.bluetooth.disconnect(id).catch(function () {});
        await self.bluetooth.connect(previousId).catch(function (restoreError) {
          self.btLog.warn('Unable to reconnect the previous audio device after a failed switch: ' + restoreError.message);
        });
      }
      await self._loadKnownDevices().catch(function () {});
      var message;
      if (error.userMessage) {
        message = error.userMessage;
      } else if (onboardingStage === 'pairing') {
        message = 'Pairing with ' + targetName + ' did not complete. Put it back in pairing mode, select Search for devices again, then retry.';
      } else if (routeChanged) {
        message = 'Could not finish switching to ' + targetName + '. The previous device remains selected and music is on the default output.';
      } else {
        message = 'Could not connect to ' + targetName + '. Keep it nearby and switched on, then try again. The current device and audio route were not changed.';
      }
      self.lastError = message + ' ' + error.message;
      self.btLog.warn(self.lastError);
      self._toast('error', message);
      await self.refreshUI().catch(function () {});
      return { success: false, error: self.lastError, routeChanged: routeChanged };
  });
};

WirelessOutputManager.prototype.savePreferredDevice = function (data) {
  var selected = data && data.preferredDevice !== undefined ? data.preferredDevice : data;
  if (Array.isArray(selected)) selected = selected[0];
  var mac = selected && typeof selected === 'object' ? selected.value : selected;
  mac = String(mac || '').toUpperCase();
  var match = this.devices.find(function (device) { return device.id === mac; });
  var submittedLabel = selected && typeof selected === 'object' ? selected.label : '';
  this.config.set('preferredDeviceMac', mac);
  this.config.set('preferredDeviceName', match ? match.name : submittedLabel);
  this._toast('success', 'Preferred device saved');
  return libQ.resolve();
};

WirelessOutputManager.prototype.startBluetooth = function () {
  return this._action('Starting Bluetooth service', this.bluetooth.start.bind(this.bluetooth), 'Bluetooth service started');
};
WirelessOutputManager.prototype.stopBluetooth = function () {
  return this._action('Stopping Bluetooth service', this.bluetooth.stop.bind(this.bluetooth), 'Bluetooth service stopped');
};
WirelessOutputManager.prototype.scanDevices = function () {
  var self = this;
  return self._action('Scanning for devices', function () {
    return self.bluetooth.scan(12).then(function (result) {
      self.devices = result.devices;
      return self.refreshUI().then(function () { return result; });
    });
  }, 'Bluetooth scan finished');
};

WirelessOutputManager.prototype.discoverAirPlayReceivers = function () {
  var self = this;
  return self._action('Searching for AirPlay receivers', async function () {
    await self.airplay.checkSender();
    var receivers = await self._loadAirPlayReceivers();
    await self.refreshUI();
    return { receivers: receivers };
  }, 'AirPlay search finished');
};

WirelessOutputManager.prototype._submittedSelect = function (data, field) {
  var selected = data && Object.prototype.hasOwnProperty.call(data, field) ? data[field] : data;
  for (var depth = 0; depth < 5; depth += 1) {
    if (Array.isArray(selected)) selected = selected[0];
    else if (selected && typeof selected === 'object' &&
      Object.prototype.hasOwnProperty.call(selected, 'value')) selected = selected.value;
    else break;
  }
  return String(selected || '').trim();
};

WirelessOutputManager.prototype.saveAirPlayReceiver = function (data) {
  var self = this;
  return self._action('Saving AirPlay receiver', async function () {
    var receiverId = self._submittedSelect(data, 'preferredAirPlayReceiver');
    if (!receiverId) throw new Error('Search for and choose an AirPlay receiver first');
    var receiver = self._findAirPlayReceiver(receiverId);
    var savedId = String(self.config.get('preferredAirPlayId') || '');
    if (!receiver && receiverId === savedId) {
      receiver = {
        id: savedId,
        name: String(self.config.get('preferredAirPlayName') || savedId),
        address: String(self.config.get('preferredAirPlayAddress') || ''),
        addresses: []
      };
    }
    if (!receiver) throw new Error('That AirPlay receiver is no longer in the search results. Search again.');
    if (self.config.get('outputEnabled') && self.config.get('activeBackend') === 'airplay' &&
      savedId && savedId !== receiver.id) {
      throw new Error('Return to the default audio output before changing AirPlay receivers');
    }
    var volume = self._submittedNumber(data, 'airPlayReceiverVolume', 'AirPlay receiver volume');
    self.config.set('preferredAirPlayId', receiver.id);
    self.config.set('preferredAirPlayName', receiver.name || receiver.id);
    self.config.set('preferredAirPlayAddress', receiver.address || '');
    self.config.set('airPlayReceiverVolume', volume);
    await self.refreshUI();
    return { receiver: receiver, volume: volume };
  }, 'AirPlay receiver and starting volume saved');
};
WirelessOutputManager.prototype._selected = function (data) {
  var selected = data && (data.device || data.preferredDevice || data);
  if (Array.isArray(selected)) selected = selected[0];
  if (selected && typeof selected === 'object') selected = selected.value;
  selected = String(selected || '').toUpperCase();
  if (BluetoothAdapter.MAC_RE.test(selected)) return selected;

  var preferred = String(this.config.get('preferredDeviceMac') || '').toUpperCase();
  return BluetoothAdapter.MAC_RE.test(preferred) ? preferred : selected;
};
WirelessOutputManager.prototype.pairDevice = function (data) {
  var id = this._selected(data); return this._action('Pairing ' + id, this.bluetooth.pair.bind(this.bluetooth, id), 'Device paired');
};
WirelessOutputManager.prototype.trustDevice = function (data) {
  var id = this._selected(data); return this._action('Trusting ' + id, this.bluetooth.trust.bind(this.bluetooth, id), 'Device trusted');
};
WirelessOutputManager.prototype.connectDevice = function (data) {
  var self = this; var id = self._selected(data);
  return self._action('Connecting ' + id, async function () {
    return self._withReconnectSuspended(async function () {
      var before = await self.bluetooth.getDeviceInfo(id).catch(function () { return null; });
      var result = before && before.connected ? { stdout: 'Device is already connected', exitCode: 0 } : await self.bluetooth.connect(id);
      await self._ensureBluetoothAudioTransport(id);
      var info = await self.bluetooth.getDeviceInfo(id);
      var knownDevices = await self._loadKnownDevices().catch(function () { return self.devices; });
      var otherConnectedAudio = knownDevices.filter(function (device) {
        return device.id !== id && device.connected && device.audioCapable === true;
      });
      if (otherConnectedAudio.length) await self._returnToDefaultIfWireless();
      for (var deviceIndex = 0; deviceIndex < otherConnectedAudio.length; deviceIndex += 1) {
        await self.bluetooth.disconnect(otherConnectedAudio[deviceIndex].id);
      }
      self.config.set('preferredDeviceMac', id);
      self.config.set('preferredDeviceName', info.name || id);
      await self._loadKnownDevices().catch(function () {});
      await self.refreshUI();
      return result;
    });
  }, 'Bluetooth audio device connected');
};
WirelessOutputManager.prototype.disconnectDevice = function (data) {
  var self = this; var id = self._selected(data);
  return self._action('Disconnecting ' + id, async function () {
    await self._returnToDefaultIfWireless();
    var result = await self.bluetooth.disconnect(id);
    await self.refreshUI();
    return result;
  }, 'Bluetooth audio device disconnected');
};
WirelessOutputManager.prototype.forgetDevice = function (data) {
  var self = this;
  var selected = data && data.pairedDeviceToForget !== undefined ? data.pairedDeviceToForget : data;
  if (Array.isArray(selected)) selected = selected[0];
  if (selected && typeof selected === 'object') selected = selected.value;
  var id = String(selected || '').toUpperCase();
  if (!BluetoothAdapter.MAC_RE.test(id)) {
    self._toast('error', 'Select a paired audio device to forget');
    return libQ.resolve({ success: false, error: 'Select a paired audio device to forget' });
  }
  return self._action('Forgetting ' + id, async function () {
    var isPreferred = String(self.config.get('preferredDeviceMac') || '').toUpperCase() === id;
    if (isPreferred) {
      self._clearReconnect();
      if (self.config.get('outputEnabled') &&
        String(self.config.get('activeBackend') || 'bluetooth') === 'bluetooth') {
        await self._returnToDefaultIfWireless();
      }
    }
    var result = await self.bluetooth.forget(id);
    if (isPreferred) {
      self.config.set('preferredDeviceMac', '');
      self.config.set('preferredDeviceName', '');
      self.config.set('enabled', false);
      self.config.set('outputEnabled', false);
    }
    self._removeCodecPreferenceFor(id);
    self.devices = self.devices.filter(function (device) { return device.id !== id; });
    await self.refreshUI();
    return result;
  }, 'Selected device forgotten; other Bluetooth pairings were preserved');
};

WirelessOutputManager.prototype.resetSpeakerSetup = function () {
  var self = this;
  return self._action('Resetting plugin setup', async function () {
    await self._returnToDefaultIfWireless();
    self._clearReconnect();
    self.config.set('preferredDeviceMac', '');
    self.config.set('preferredDeviceName', '');
    self.config.set('enabled', false);
    self.config.set('outputEnabled', false);
    self.config.set('codecPreferences', '{}');
    self.config.set('preferredAirPlayId', '');
    self.config.set('preferredAirPlayName', '');
    self.config.set('preferredAirPlayAddress', '');
    self.config.set('airPlayReceiverVolume', 15);
    self.config.set('activeBackend', '');
    self.devices = [];
    self.airplayReceivers = [];
    if (self.airplayBridge) await self.airplayBridge.stop().catch(function () {});
    await self.refreshUI();
  }, 'Plugin setup reset; system Bluetooth pairings were preserved');
};

WirelessOutputManager.prototype.createBluetoothOutput = function () {
  var self = this;
  return self._action('Creating guarded BlueALSA output', function () {
    return self._withRoutingLock(function () { return self._withReconnectSuspended(function () {
      if (self.config.get('outputEnabled')) {
        throw new Error('Return to the default audio output before selecting another wireless output');
      }
      return self._withPreservedSoftwareVolume(function () {
        return self._stopPlaybackForRouting().then(function () {
          return self._ensureBluetoothAudioTransport(self.config.get('preferredDeviceMac'));
        }).then(function () {
          return self.codecManager.select(
            self.config.get('preferredDeviceMac'),
            self._preferredCodecFor(self.config.get('preferredDeviceMac'))
          );
        }).then(function () {
          return self.outputManager.createOutput(self.config.get('preferredDeviceMac'));
        }).then(async function (result) {
          try {
            await self.bluetoothVolume.applySafetyCap(self.config.get('preferredDeviceMac'));
            return result;
          } catch (error) {
            var rollbackSucceeded = true;
            await self.outputManager.removeOutput().catch(function (rollbackError) {
              rollbackSucceeded = false;
              self.log.warn('Unable to roll back Bluetooth routing after device-volume safety failure: ' + rollbackError.message);
            });
            self.config.set('outputEnabled', false);
            var safetyError = new Error(rollbackSucceeded
              ? 'Bluetooth stream volume could not be made safe; routing returned to the default output. ' + error.message
              : 'Bluetooth stream volume and routing safety could not be verified. Playback remains stopped at 0% and muted. ' + error.message);
            safetyError.keepSafeVolume = true;
            throw safetyError;
          }
        }).then(function (result) {
          self.config.set('outputEnabled', true);
          self.config.set('activeBackend', 'bluetooth');
          return result;
        });
      }).then(function (result) {
        return self.refreshUI().then(function () { return result; });
      });
    }); });
  }, 'Bluetooth output is ready at 10% stream volume; press Play');
};

WirelessOutputManager.prototype.createAirPlayOutput = function () {
  var self = this;
  return self._action('Preparing AirPlay output', function () {
    return self._withRoutingLock(async function () {
      if (self.config.get('outputEnabled')) {
        throw new Error('Return to the default audio output before selecting another wireless output');
      }
      var receiverId = String(self.config.get('preferredAirPlayId') || '');
      if (!receiverId) throw new Error('Search for and save an AirPlay receiver first');
      var receivers = await self._loadAirPlayReceivers();
      var receiver = self._findAirPlayReceiver(receiverId);
      if (!receiver) {
        throw new Error('The saved AirPlay receiver is not currently available. Wake it, check the network and search again.');
      }
      var savedAddress = String(self.config.get('preferredAirPlayAddress') || '');
      var advertised = receiver.addresses && receiver.addresses.length
        ? receiver.addresses : [receiver.address];
      var selectedAddress = advertised.indexOf(savedAddress) !== -1 ? savedAddress : receiver.address;
      var volume = self._airPlayVolume();
      return self._withPreservedSoftwareVolume(async function () {
        await self._stopPlaybackForRouting();
        var ready;
        var routeInstalled = false;
        try {
          ready = await self.airplayBridge.start(receiver, {
            address: selectedAddress,
            volume: volume
          });
          var result = await self.outputManager.createAirPlayOutput(ready.fifo);
          routeInstalled = true;
          var bridgeStatus = self.airplayBridge.getStatus();
          if (!bridgeStatus.running || !bridgeStatus.ready) {
            throw new Error('The AirPlay sender stopped while audio routing was being prepared');
          }
          self.config.set('preferredAirPlayName', receiver.name || receiver.id);
          self.config.set('preferredAirPlayAddress', ready.address);
          self.config.set('outputEnabled', true);
          self.config.set('activeBackend', 'airplay');
          return result;
        } catch (error) {
          if (routeInstalled) await self.outputManager.removeOutput().catch(function (rollbackError) {
            self.log.warn('Unable to roll back AirPlay routing after sender failure: ' + rollbackError.message);
          });
          await self.airplayBridge.stop().catch(function () {});
          throw error;
        }
      });
    }).then(function (result) {
      return self.refreshUI().then(function () { return result; });
    });
  }, 'AirPlay output is ready at ' + self._airPlayVolume() + '% receiver volume; press Play');
};

WirelessOutputManager.prototype.removeBluetoothOutput = function () {
  var self = this;
  return self._action('Removing Bluetooth output', async function () {
    var outputStatus = typeof self.outputManager.getStatus === 'function'
      ? await self.outputManager.getStatus().catch(function () { return null; })
      : null;
    if (!self.config.get('outputEnabled') && outputStatus && !outputStatus.configured) {
      await self.refreshUI();
      return { alreadyDefault: true };
    }
    return self._withRoutingLock(function () { return self._withPreservedSoftwareVolume(function () {
      return self._stopPlaybackForRouting().then(function () {
        return self.outputManager.removeOutput();
      }).then(async function (result) {
        if (self.airplayBridge) await self.airplayBridge.stop();
        self.config.set('outputEnabled', false);
        self.config.set('activeBackend', '');
        return result;
      });
    }).then(function (result) {
      return self.refreshUI().then(function () { return result; });
    }); });
  }, 'Music will play on the default audio output');
};

WirelessOutputManager.prototype._submittedNumber = function (data, field, label) {
  function extract(value, depth) {
    if (depth > 5 || value === null || value === undefined) return undefined;
    if (typeof value === 'string' || typeof value === 'number') return value;

    if (Array.isArray(value)) {
      for (var index = 0; index < value.length; index += 1) {
        var item = value[index];
        if (item && typeof item === 'object' &&
          (item.id === field || Object.prototype.hasOwnProperty.call(item, field))) {
          var matched = extract(item.id === field ? item.value : item[field], depth + 1);
          if (matched !== undefined) return matched;
        }
      }
      return value.length === 1 ? extract(value[0], depth + 1) : undefined;
    }

    if (typeof value === 'object') {
      if (Object.prototype.hasOwnProperty.call(value, field)) return extract(value[field], depth + 1);
      if (value.id === field && Object.prototype.hasOwnProperty.call(value, 'value')) {
        return extract(value.value, depth + 1);
      }
      if (Object.prototype.hasOwnProperty.call(value, 'value')) return extract(value.value, depth + 1);
      if (Object.prototype.hasOwnProperty.call(value, 'data')) return extract(value.data, depth + 1);
      var keys = Object.keys(value);
      if (keys.length === 1) return extract(value[keys[0]], depth + 1);
    }
    return undefined;
  }

  var submitted = extract(data, 0);
  var requested = Number(submitted);
  if (submitted === '' || submitted === null || submitted === undefined ||
    !Number.isFinite(requested) || requested < 0 || requested > 100) {
    throw new Error(label + ' must be between 0 and 100');
  }
  return Math.round(requested);
};

WirelessOutputManager.prototype.setBluetoothDeviceVolume = function (data) {
  var self = this;
  var requested;
  var deviceId = String(self.config.get('preferredDeviceMac') || '').toUpperCase();
  return self._action('Setting Bluetooth stream volume', async function () {
    requested = self._submittedNumber(data, 'bluetoothDeviceVolume', 'Bluetooth stream volume');
    if (!BluetoothAdapter.MAC_RE.test(deviceId)) throw new Error('Choose a Bluetooth audio device first');
    var info = await self.bluetooth.getDeviceInfo(deviceId);
    if (!info.connected) throw new Error('Connect the selected Bluetooth device before changing its volume');
    var result = await self.bluetoothVolume.setVolume(deviceId, requested);
    await self.refreshUI();
    return result;
  }, 'Bluetooth stream volume updated');
};

WirelessOutputManager.prototype.setVolumioSoftwareVolume = function (data) {
  var self = this;
  var requested;
  return self._action('Setting Volumio software volume', async function () {
    requested = self._submittedNumber(data, 'volumioSoftwareVolume', 'Volumio software volume');
    var before = await self.volumioApi.getState();
    if (before.disableVolumeControl === true) {
      throw new Error('Volumio software volume is disabled. Change Mixer Type in Volumio Playback Options.');
    }
    await self.volumioApi.setVolume(requested);
    var verified = null;
    for (var attempt = 0; attempt < 8; attempt += 1) {
      await new Promise(function (resolve) { setTimeout(resolve, 250); });
      verified = await self.volumioApi.getState().catch(function () { return null; });
      // Bluetooth absolute-volume steps can quantize Volumio by a small amount.
      if (verified && Math.abs(Number(verified.volume) - requested) <= 2) break;
    }
    if (!verified || Math.abs(Number(verified.volume) - requested) > 2) {
      throw new Error('Volumio software volume could not be verified');
    }
    await self.refreshUI();
    return { requested: requested, actual: Number(verified.volume) };
  }, 'Volumio software volume updated');
};

WirelessOutputManager.prototype.saveVolumeSettings = function (data) {
  var self = this;
  return self._action('Applying volume settings', async function () {
    data = data || {};
    var changed = [];
    var deviceId = String(self.config.get('preferredDeviceMac') || '').toUpperCase();
    var deviceInfo = BluetoothAdapter.MAC_RE.test(deviceId)
      ? await self.bluetooth.getDeviceInfo(deviceId).catch(function () { return null; })
      : null;

    if (deviceInfo && deviceInfo.connected && data.bluetoothDeviceVolume !== undefined) {
      var bluetoothVolume = self._submittedNumber(
        data, 'bluetoothDeviceVolume', 'Bluetooth stream volume');
      await self.bluetoothVolume.setVolume(deviceId, bluetoothVolume);
      changed.push('Bluetooth device');
    }

    if (data.volumioSoftwareVolume !== undefined) {
      var softwareVolume = self._submittedNumber(
        data, 'volumioSoftwareVolume', 'Volumio software volume');
      var before = await self.volumioApi.getState();
      if (before.disableVolumeControl === true) {
        throw new Error('Volumio software volume is disabled. Change Mixer Type in Volumio Playback Options.');
      }
      await self.volumioApi.setVolume(softwareVolume);
      var verified = null;
      for (var attempt = 0; attempt < 8; attempt += 1) {
        await new Promise(function (resolve) { setTimeout(resolve, 250); });
        verified = await self.volumioApi.getState().catch(function () { return null; });
        if (verified && Math.abs(Number(verified.volume) - softwareVolume) <= 2) break;
      }
      if (!verified || Math.abs(Number(verified.volume) - softwareVolume) > 2) {
        throw new Error('Volumio software volume could not be verified');
      }
      changed.push('Volumio software');
    }

    if (!changed.length) {
      throw new Error(deviceInfo && !deviceInfo.connected
        ? 'Connect the selected Bluetooth device before changing its stream volume'
        : 'No available volume setting was received');
    }
    await self.refreshUI();
    return { changed: changed };
  }, 'Volume settings updated');
};

WirelessOutputManager.prototype.runDiagnostics = function () {
  var self = this;
  return self.diagnostics.all().then(async function (result) {
    result.wirelessOutput = await self.outputManager.getStatus();
    result.preferredDevice = await self.bluetooth.getStatus(self.config.get('preferredDeviceMac'));
    result.bluetoothCodec = await self.codecManager.getStatus(self.config.get('preferredDeviceMac')).catch(function (error) {
      return { available: false, error: error.message };
    });
    result.bluetoothCodec.preference = self._preferredCodecFor(self.config.get('preferredDeviceMac'));
    result.bluetoothDeviceVolume = await self.bluetoothVolume.getVolume(self.config.get('preferredDeviceMac')).catch(function (error) {
      return { available: false, error: error.message };
    });
    result.airplay = {
      selectedId: self.config.get('preferredAirPlayId') || '',
      selectedName: self.config.get('preferredAirPlayName') || '',
      selectedAddress: self.config.get('preferredAirPlayAddress') || '',
      receiverVolume: self._airPlayVolume(),
      discoveredReceivers: self.airplayReceivers.map(function (receiver) {
        return {
          id: receiver.id,
          name: receiver.name,
          address: receiver.address,
          protocols: receiver.protocols
        };
      }),
      bridge: self.airplayBridge ? self.airplayBridge.getStatus() : { running: false }
    };
    self.lastDiagnostics = result;
    await self.refreshUI();
    self._toast('success', 'Diagnostics complete');
    return result;
  }).catch(function (error) {
    self.lastError = error.message;
    self._toast('error', error.message);
    throw error;
  });
};

WirelessOutputManager.prototype.exportDebugLog = async function () {
  if (!this.lastDiagnostics) this.lastDiagnostics = await this.diagnostics.all();
  var exportDir = '/data/INTERNAL/wireless-output-manager';
  var target = path.join(exportDir, 'diagnostics-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  await fs.ensureDir(exportDir);
  await fs.writeJson(target, this.lastDiagnostics, { spaces: 2, mode: 0o640 });
  this._toast('success', 'Diagnostics exported to ' + target);
  return { path: target };
};
