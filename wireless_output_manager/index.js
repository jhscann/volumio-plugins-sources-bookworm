'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var path = require('path');
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
    if (self.config.get('enabled') && self.config.get('autoReconnect')) self._scheduleReconnect(5000);
  });
};

WirelessOutputManager.prototype.onStop = function () {
  this.log.info('Stopping');
  this._clearReconnect();
  return libQ.resolve();
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
      await self.bluetooth.disconnect(mac).catch(function (error) {
        self.btLog.warn('The stale Bluetooth connection changed before it could be disconnected: ' + error.message);
      });
      await new Promise(function (resolve) { setTimeout(resolve, self.transportPollDelayMs); });
    }
    await self.bluetooth.connect(mac);

    for (var attempt = 0; attempt < self.transportPollAttempts; attempt += 1) {
      status = await self.codecManager.getStatus(mac);
      if (status.deviceConnected) {
        self.btLog.info('BlueALSA audio stream recovered for ' + mac + ' using ' + status.pcmPath);
        return status;
      }
      if (attempt + 1 < self.transportPollAttempts) {
        await new Promise(function (resolve) { setTimeout(resolve, self.transportPollDelayMs); });
      }
    }
    throw new Error('The selected Bluetooth device connected, but its audio stream did not become available');
  }).finally(function () { delete self.transportRecoveries[mac]; });

  return self.transportRecoveries[mac];
};

WirelessOutputManager.prototype._returnToDefaultIfWireless = async function () {
  var self = this;
  if (!self.config.get('outputEnabled')) return;
  await self._withPreservedSoftwareVolume(async function () {
    await self._stopPlaybackForRouting();
    await self.outputManager.removeOutput();
    self.config.set('outputEnabled', false);
  });
};

WirelessOutputManager.prototype._scheduleReconnect = function (delayMs) {
  var self = this;
  self._clearReconnect();
  if (!self.config.get('enabled') || !self.config.get('autoReconnect')) return;
  self.reconnectTimer = setTimeout(function () {
    self._reconnectPreferred().finally(function () { self._scheduleReconnect(15000); });
  }, delayMs);
  if (self.reconnectTimer.unref) self.reconnectTimer.unref();
};

WirelessOutputManager.prototype._reconnectPreferred = async function () {
  var mac = this.config.get('preferredDeviceMac');
  if (!mac || this.reconnectBusy) return;
  this.reconnectBusy = true;
  try {
    var info = await this.bluetooth.getDeviceInfo(mac);
    if (!info.connected) {
      this.btLog.info('Reconnecting preferred device ' + mac);
      await this.bluetooth.connect(mac);
    }
    this.lastError = '';
  } catch (error) {
    this.lastError = 'Selected Bluetooth audio device is unavailable: ' + error.message;
    this.btLog.warn(this.lastError);
  } finally {
    this.reconnectBusy = false;
  }
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
    self._toast('error', error.message);
    throw error;
  });
};

WirelessOutputManager.prototype._speakerOptionLabel = function (device, preferred) {
  var name = String(device.name || '').trim();
  if (!name || BluetoothAdapter.MAC_RE.test(name)) name = device.id;
  var states = [];
  if (device.id === preferred) states.push('selected');
  if (device.connected) states.push('connected');
  if (device.paired) states.push('paired');
  if (device.audioCapable === true) states.push('audio');
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

WirelessOutputManager.prototype.getUIConfig = function () {
  var self = this;
  var lang = self.commandRouter.sharedVars.get('language_code');
  return self.commandRouter.i18nJson(
    path.join(__dirname, 'i18n', 'strings_' + lang + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'), path.join(__dirname, 'UIConfig.json')
  ).then(async function (ui) {
    function set(index, key, value) { self.configManager.setUIConfigParam(ui, index + '.' + key, value); }
    set('sections[4].content[0]', 'value', Boolean(self.config.get('autoReconnect')));
    set('sections[5].content[0]', 'value', Boolean(self.config.get('debugLogging')));
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
    options.forEach(function (device) {
      self.configManager.pushUIConfigParam(ui, 'sections[1].content[1].options', {
        value: device.id,
        label: self._speakerOptionLabel(device, preferred)
      });
    });
    var connected = Boolean(status.preferred && status.preferred.connected);
    var paired = Boolean(status.preferred && status.preferred.paired);
    var outputEnabled = Boolean(self.config.get('outputEnabled'));
    var connectedAudio = options.filter(function (device) { return device.audioCapable === true && device.connected; });
    var connectedNames = connectedAudio.map(function (device) { return device.name || device.id; });
    var codecStatus = preferred ? await self.codecManager.getStatus(preferred).catch(function (error) {
      return { available: false, systemCodecs: [], availableCodecs: [], activeCodec: '', error: error.message };
    }) : { available: false, systemCodecs: [], availableCodecs: [], activeCodec: '' };
    var visibleCodecs = connected ? codecStatus.availableCodecs : codecStatus.systemCodecs;
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

    if (connectedAudio.length > 1) {
      set('sections[1]', 'description', 'Selected: ' + preferredName + '. Also connected: ' +
        connectedNames.filter(function (name) { return name !== preferredName; }).join(', ') +
        '. Choose one device and select Select and connect. Other Bluetooth audio devices will disconnect but remain paired. Music output does not change automatically.');
    } else if (connected) {
      set('sections[1]', 'description', preferredName +
        ' is selected and connected. To change devices, choose another one and select Select and connect. Music output does not change automatically.');
    } else if (paired) {
      set('sections[1]', 'description', preferredName +
        ' is selected but disconnected. Switch it on and use Reconnect selected device, or choose another device and select Select and connect.');
    } else {
      set('sections[1]', 'description',
        'For a new device: put it in pairing mode, search, choose it from the list, then select Select and connect. A previously paired device normally only needs to be switched on.');
    }

    var bluetoothDeviceVolume = connected && self.bluetoothVolume
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
        '%. This is local BlueALSA digital gain, not necessarily the device\'s physical volume. Routing caps it at 10% for safety; increase it gradually after playback begins.');
    }

    var outputDescription;
    if (outputEnabled && connected) {
      outputDescription = 'Music output: ' + preferredName + ' over Bluetooth. Changing output stops playback; press Play afterward. ' +
        'There is no automatic fallback. Volumio may display 100% after Bluetooth playback starts; actual loudness is controlled by Bluetooth stream volume and the device\'s own controls.';
    } else if (outputEnabled) {
      outputDescription = 'Music output is still set to ' + preferredName + ', but the device is disconnected. ' +
        'Reconnect it or return to the default audio output. There is no automatic fallback.';
    } else if (preferred) {
      outputDescription = 'Music output: the default device selected in Volumio Playback Options. Selected Bluetooth device: ' +
        preferredName + ' — ' + (connected ? 'connected' : 'disconnected') +
        '. Changing output stops playback; press Play afterward.';
    } else {
      outputDescription = 'Music output: the default device selected in Volumio Playback Options. ' +
        'Select and connect a Bluetooth audio device before choosing Bluetooth output.';
    }
    set('sections[0]', 'description', outputDescription);

    var pairedAudio = options.filter(function (device) { return device.paired && device.audioCapable === true; });
    set('sections[3]', 'hidden', !preferred && pairedAudio.length === 0);
    set('sections[3].content[0]', 'hidden', !preferred || connected);
    set('sections[3].content[1]', 'hidden', !connected);
    pairedAudio.forEach(function (device) {
      self.configManager.pushUIConfigParam(ui, 'sections[3].content[2].options', {
        value: device.id,
        label: self._speakerOptionLabel(device, preferred)
      });
    });
    set('sections[3].content[2]', 'value', {
      value: '',
      label: pairedAudio.length ? 'Select a paired audio device' : 'No paired audio devices'
    });
    set('sections[3].content[2]', 'hidden', pairedAudio.length === 0);
    set('sections[3].content[3]', 'hidden', !preferred);

    var codecDescription;
    var preferredCodecName = self.codecManager.displayName(preferredCodec);
    if (!preferred) {
      codecDescription = 'Select and connect a Bluetooth audio device to configure its codec and stream volume.';
    } else if (!connected) {
      codecDescription = 'Sound settings for ' + preferredName + '. Saved codec preference: ' + preferredCodecName +
        '. Connect the device to see mutually available codecs and adjust stream volume.';
    }
    else {
      codecDescription = 'Sound settings for ' + preferredName + '. Codec preference: ' + preferredCodecName + '. Active: ' + (codecStatus.activeCodec ? self.codecManager.displayName(codecStatus.activeCodec) : 'unknown') +
        '. Available: ' + (codecStatus.availableCodecs.map(function (codec) { return self.codecManager.displayName(codec); }).join(', ') || 'none reported') +
        '. Automatic chooses LDAC, aptX HD, AAC, aptX, then SBC. A codec change is applied the next time Bluetooth output is selected. ' +
        'Bluetooth stream volume is local digital gain and is capped at 10% whenever Bluetooth routing starts.';
      if (codecStatus.systemCodecs.indexOf('AAC') === -1) codecDescription += ' AAC is not available in the installed BlueALSA build.';
    }
    set('sections[2]', 'description', codecDescription);
    set('sections[2].content[0]', 'description', preferred
      ? 'Saved for ' + preferredName + '. The choice is applied and verified the next time Bluetooth output is selected.'
      : 'Select a Bluetooth audio device first.');

    set('sections[5].content[4]', 'value', self.lastDiagnostics ? JSON.stringify(self.lastDiagnostics, null, 2) : 'Run diagnostics to collect system state.');
    set('sections[5].content[5]', 'value', self.lastError || 'None');
    set('sections[5].content[4]', 'hidden', !self.lastDiagnostics);
    set('sections[5].content[5]', 'hidden', !self.lastError);
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
  self.config.set('activeBackend', 'bluetooth');
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
    if (data.preferredCodec !== undefined) {
      var submittedCodec = data.preferredCodec;
      for (var depth = 0; depth < 5 && submittedCodec && typeof submittedCodec === 'object'; depth += 1) {
        if (Array.isArray(submittedCodec)) submittedCodec = submittedCodec[0];
        else if (Object.prototype.hasOwnProperty.call(submittedCodec, 'value')) submittedCodec = submittedCodec.value;
        else break;
      }
      self._setPreferredCodecFor(deviceId, submittedCodec);
      changed.push('codec preference');
    }

    if (data.bluetoothDeviceVolume !== undefined) {
      var info = await self.bluetooth.getDeviceInfo(deviceId).catch(function () { return null; });
      if (info && info.connected) {
        var streamVolume = self._submittedNumber(
          data, 'bluetoothDeviceVolume', 'Bluetooth stream volume');
        await self.bluetoothVolume.setVolume(deviceId, streamVolume);
        changed.push('Bluetooth stream volume');
      }
    }

    if (!changed.length) {
      throw new Error('Connect the selected Bluetooth device before changing its stream volume');
    }
    await self.refreshUI();
    return { changed: changed };
  }, 'Bluetooth sound settings saved');
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
  var successMessage = changingSpeaker
    ? 'Device changed and connected. Music is on the default output; choose Play through selected Bluetooth device when ready.'
    : 'Bluetooth audio device selected and connected';
  var routeChanged = false;
  self.btLog.info('Pairing and connecting ' + id);
  return Promise.resolve().then(async function () {
    self._clearReconnect();
    try {
      await self.bluetooth.powerOn();
      // Preflight the target before changing a working route or disconnecting
      // another speaker. An unavailable target is an expected UI outcome, not
      // an exception that should escape into Volumio's controller.
      await self.bluetooth.pair(id);
      await self.bluetooth.trust(id);
      var beforeConnect = await self.bluetooth.getDeviceInfo(id).catch(function () { return null; });
      if (!beforeConnect || !beforeConnect.connected) await self.bluetooth.connect(id);
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
      if (self.config.get('autoReconnect')) self._scheduleReconnect(15000);
      await self.refreshUI();
      self.lastError = '';
      self._toast('success', successMessage);
      return { success: true, device: info };
    } catch (error) {
      if (changingSpeaker && routeChanged) {
        await self.bluetooth.disconnect(id).catch(function () {});
        await self.bluetooth.connect(previousId).catch(function (restoreError) {
          self.btLog.warn('Unable to reconnect the previous audio device after a failed switch: ' + restoreError.message);
        });
      }
      if (self.config.get('enabled') && self.config.get('autoReconnect')) self._scheduleReconnect(15000);
      var message = routeChanged
        ? 'Could not finish switching to ' + targetName + '. The previous device remains selected and music is on the default output.'
        : 'Could not connect to ' + targetName + '. Turn it on and try again. The current device and audio route were not changed.';
      self.lastError = message + ' ' + error.message;
      self.btLog.warn(self.lastError);
      self._toast('error', message);
      await self.refreshUI().catch(function () {});
      return { success: false, error: self.lastError, routeChanged: routeChanged };
    }
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
    var knownDevices = await self._loadKnownDevices().catch(function () { return self.devices; });
    var otherConnectedAudio = knownDevices.filter(function (device) {
      return device.id !== id && device.connected && device.audioCapable === true;
    });
    if (otherConnectedAudio.length) await self._returnToDefaultIfWireless();
    for (var deviceIndex = 0; deviceIndex < otherConnectedAudio.length; deviceIndex += 1) {
      await self.bluetooth.disconnect(otherConnectedAudio[deviceIndex].id);
    }
    var before = await self.bluetooth.getDeviceInfo(id).catch(function () { return null; });
    var result = before && before.connected ? { stdout: 'Device is already connected', exitCode: 0 } : await self.bluetooth.connect(id);
    var info = await self.bluetooth.getDeviceInfo(id);
    self.config.set('preferredDeviceMac', id);
    self.config.set('preferredDeviceName', info.name || id);
    await self._loadKnownDevices().catch(function () {});
    await self.refreshUI();
    return result;
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
    return libQ.reject(new Error('Select a paired audio device to forget'));
  }
  return self._action('Forgetting ' + id, async function () {
    var isPreferred = String(self.config.get('preferredDeviceMac') || '').toUpperCase() === id;
    if (isPreferred) {
      self._clearReconnect();
      await self._returnToDefaultIfWireless();
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
    self.devices = [];
    await self.refreshUI();
  }, 'Plugin setup reset; system Bluetooth pairings were preserved');
};

WirelessOutputManager.prototype.createBluetoothOutput = function () {
  var self = this;
  return self._action('Creating guarded BlueALSA output', function () {
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
        return result;
      });
    }).then(function (result) {
      return self.refreshUI().then(function () { return result; });
    });
  }, 'Bluetooth output is ready at 10% stream volume; press Play');
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
    return self._withPreservedSoftwareVolume(function () {
      return self._stopPlaybackForRouting().then(function () {
        return self.outputManager.removeOutput();
      }).then(function (result) {
        self.config.set('outputEnabled', false);
        return result;
      });
    }).then(function (result) {
      return self.refreshUI().then(function () { return result; });
    });
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
