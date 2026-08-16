'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var path = require('path');
var CommandRunner = require('./lib/commandRunner').CommandRunner;
var BluetoothAdapter = require('./lib/adapters/bluetooth');
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
  if (!BluetoothAdapter.MAC_RE.test(mac)) throw new Error('Choose a speaker before saving its codec preference');
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

WirelessOutputManager.prototype._restoreVolumeState = async function (saved) {
  var self = this;
  if (!saved) return;
  try {
    await self.volumioApi.setVolume(saved.volume);
    if (saved.mute) await self.volumioApi.setVolume('mute');
    else await self.volumioApi.setVolume('unmute');
  } catch (error) {
    throw new Error('Volumio volume could not be restored; playback remains stopped. Set the volume manually before pressing Play.');
  }
  for (var attempt = 0; attempt < 10; attempt += 1) {
    var state = await self.volumioApi.getState().catch(function () { return null; });
    if (state && Number(state.volume) === saved.volume && Boolean(state.mute) === saved.mute) {
      self.log.info('Restored Volumio volume to ' + saved.volume + '%' + (saved.mute ? ' (muted)' : '') + ' after changing audio routing');
      return;
    }
    if (attempt < 9) await new Promise(function (resolve) { setTimeout(resolve, 250); });
  }
  throw new Error('Volumio volume could not be verified after routing changed; playback remains stopped. Set the volume manually before pressing Play.');
};

WirelessOutputManager.prototype._withPreservedSoftwareVolume = async function (operation) {
  var volumeState = await this._captureVolumeState();
  var result;
  try {
    result = await operation();
  } catch (operationError) {
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
    this.lastError = 'Preferred speaker is unavailable: ' + error.message;
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
    set('sections[3].content[0]', 'value', Boolean(self.config.get('autoReconnect')));
    set('sections[3].content[1]', 'value', Boolean(self.config.get('debugLogging')));
    var preferred = self.config.get('preferredDeviceMac') || '';
    var preferredCodec = self._preferredCodecFor(preferred);
    var preferredName = self.config.get('preferredDeviceName') || 'No speaker selected';
    if (!self.devices.length) await self._loadKnownDevices().catch(function () {});
    var status = await self.bluetooth.getStatus(preferred).catch(function (error) { return { available: false, lastError: error.message }; });
    var options = self._speakerOptions(preferred, status.preferred);
    var selectedOption = options.find(function (device) { return device.id === preferred; });
    set('sections[0].content[1]', 'value', {
      value: preferred,
      label: selectedOption ? self._speakerOptionLabel(selectedOption, preferred) : preferredName
    });
    options.forEach(function (device) {
      self.configManager.pushUIConfigParam(ui, 'sections[0].content[1].options', {
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
    set('sections[3].content[2]', 'options', codecOptions);
    set('sections[3].content[2]', 'value', selectedCodecOption || codecOptions[0]);
    set('sections[3].content[2]', 'hidden', !preferred);
    if (connectedAudio.length > 1) set('sections[0]', 'description', 'Selected: ' + preferredName + '. Also connected: ' + connectedNames.filter(function (name) { return name !== preferredName; }).join(', ') + '. Choose one speaker and select Use selected speaker. Other audio speakers will disconnect but remain paired; music will move to the default output until you choose Play on Bluetooth speaker.');
    else if (connected) set('sections[0]', 'description', preferredName + ' is selected and connected. To change speakers: search, choose another speaker, then select Use selected speaker. The current speaker will disconnect but remain paired. Next, choose Play on Bluetooth speaker.');
    else if (paired) set('sections[0]', 'description', preferredName + ' is saved but disconnected. Use Reconnect speaker below, or search to choose another speaker.');
    else set('sections[0]', 'description', 'Put your speaker in pairing mode, select Search for speakers, choose it from the list, then select Use selected speaker.');
    set('sections[1]', 'hidden', !preferred);
    set('sections[1].content[0]', 'hidden', !connected);
    set('sections[1]', 'description', outputEnabled
      ? 'Music is routed to ' + preferredName + '. If the speaker turns off or disconnects, there is no automatic fallback: choose Play on default audio output manually. With Mixer Type set to Hardware, Bluetooth is effectively sent at 100%; choose Software to control Bluetooth volume from Volumio.'
      : 'Music is routed to the default device selected in Volumio Playback Options. To use the connected saved speaker, choose Play on Bluetooth speaker, then press Play.');
    var pairedAudio = options.filter(function (device) { return device.paired && device.audioCapable === true; });
    set('sections[2]', 'hidden', !preferred && pairedAudio.length === 0);
    set('sections[2].content[0]', 'hidden', !preferred || connected);
    set('sections[2].content[1]', 'hidden', !connected);
    pairedAudio.forEach(function (device) {
      self.configManager.pushUIConfigParam(ui, 'sections[2].content[2].options', {
        value: device.id,
        label: self._speakerOptionLabel(device, preferred)
      });
    });
    set('sections[2].content[2]', 'value', {
      value: '',
      label: pairedAudio.length ? 'Select a paired audio device' : 'No paired audio devices'
    });
    set('sections[2].content[2]', 'hidden', pairedAudio.length === 0);
    set('sections[2].content[3]', 'hidden', !preferred);
    var codecDescription;
    var preferredCodecName = self.codecManager.displayName(preferredCodec);
    if (!preferred) codecDescription = 'Choose a speaker before selecting a Bluetooth audio codec.';
    else if (!connected) codecDescription = 'Saved for ' + preferredName + ': ' + preferredCodecName + '. Connect the Bluetooth audio device to see the codecs it shares with Volumio.';
    else {
      codecDescription = 'Saved for ' + preferredName + ': ' + preferredCodecName + '. Active: ' + (codecStatus.activeCodec ? self.codecManager.displayName(codecStatus.activeCodec) : 'unknown') +
        '. Available: ' + (codecStatus.availableCodecs.map(function (codec) { return self.codecManager.displayName(codec); }).join(', ') || 'none reported') +
        '. Automatic chooses LDAC, aptX HD, AAC, aptX, then SBC. The choice is applied when you select Play on Bluetooth speaker. Volumio volume and mute state are preserved while routing changes.';
      if (codecStatus.systemCodecs.indexOf('AAC') === -1) codecDescription += ' AAC is not available in the installed BlueALSA build.';
    }
    set('sections[3].content[2]', 'description', codecDescription);
    set('sections[4].content[3]', 'value', self.lastDiagnostics ? JSON.stringify(self.lastDiagnostics, null, 2) : 'Run diagnostics to collect system state.');
    set('sections[4].content[4]', 'value', self.lastError || 'None');
    set('sections[4].content[3]', 'hidden', !self.lastDiagnostics);
    set('sections[4].content[4]', 'hidden', !self.lastError);
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

WirelessOutputManager.prototype.pairAndConnectDevice = function (data) {
  var self = this;
  var id = self._selected(data);
  if (!BluetoothAdapter.MAC_RE.test(id)) {
    self._toast('error', 'Find and select a Bluetooth speaker first');
    return libQ.resolve({ success: false, error: 'Find and select a Bluetooth speaker first' });
  }
  var previousId = String(self.config.get('preferredDeviceMac') || '').toUpperCase();
  var changingSpeaker = BluetoothAdapter.MAC_RE.test(previousId) && previousId !== id;
  var selected = data && data.preferredDevice;
  if (Array.isArray(selected)) selected = selected[0];
  var targetName = selected && typeof selected === 'object' ? selected.label : '';
  targetName = String(targetName || id).replace(/\s+—.*$/, '').replace(/\s+\(audio\)$/, '');
  var successMessage = changingSpeaker
    ? 'Speaker changed and connected. Music is on the default output; choose Play on Bluetooth speaker when ready.'
    : 'Speaker paired, connected and saved';
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
      if (!info.connected) throw new Error('The selected speaker did not report a connected state');

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
          self.btLog.warn('Unable to reconnect the previous speaker after a failed switch: ' + restoreError.message);
        });
      }
      if (self.config.get('enabled') && self.config.get('autoReconnect')) self._scheduleReconnect(15000);
      var message = routeChanged
        ? 'Could not finish switching to ' + targetName + '. The previous speaker remains selected and music is on the default output.'
        : 'Could not connect to ' + targetName + '. Turn it on and try again. The current speaker and audio route were not changed.';
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
  }, 'Bluetooth speaker connected');
};
WirelessOutputManager.prototype.disconnectDevice = function (data) {
  var self = this; var id = self._selected(data);
  return self._action('Disconnecting ' + id, async function () {
    await self._returnToDefaultIfWireless();
    var result = await self.bluetooth.disconnect(id);
    await self.refreshUI();
    return result;
  }, 'Speaker disconnected');
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
  return self._action('Resetting speaker setup', async function () {
    await self._returnToDefaultIfWireless();
    self._clearReconnect();
    self.config.set('preferredDeviceMac', '');
    self.config.set('preferredDeviceName', '');
    self.config.set('enabled', false);
    self.config.set('outputEnabled', false);
    self.config.set('codecPreferences', '{}');
    self.devices = [];
    await self.refreshUI();
  }, 'Speaker setup reset; system Bluetooth pairings were preserved');
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
      }).then(function (result) {
        self.config.set('outputEnabled', true);
        return self.refreshUI().then(function () { return result; });
      });
    });
  }, 'Music will play on the Bluetooth speaker');
};
WirelessOutputManager.prototype.removeBluetoothOutput = function () {
  var self = this;
  return self._action('Removing Bluetooth output', function () {
    return self._withPreservedSoftwareVolume(function () {
      return self._stopPlaybackForRouting().then(function () {
        return self.outputManager.removeOutput();
      }).then(function (result) {
        self.config.set('outputEnabled', false);
        return self.refreshUI().then(function () { return result; });
      });
    });
  }, 'Music will play on the default audio output');
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
