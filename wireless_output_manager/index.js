'use strict';

var libQ = require('kew');
var fs = require('fs-extra');
var path = require('path');
var CommandRunner = require('./lib/commandRunner').CommandRunner;
var BluetoothAdapter = require('./lib/adapters/bluetooth');
var Diagnostics = require('./lib/diagnostics');
var OutputManager = require('./lib/outputManager');
var createLogger = require('./lib/logger');

module.exports = WirelessOutputManager;

function WirelessOutputManager(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.configManager = context.configManager;
  this.reconnectTimer = null;
  this.reconnectBusy = false;
  this.positionRestoreTimer = null;
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
  this._clearPositionRestore();
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

WirelessOutputManager.prototype._clearReconnect = function () {
  if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  this.reconnectTimer = null;
};

WirelessOutputManager.prototype._clearPositionRestore = function () {
  if (this.positionRestoreTimer) clearInterval(this.positionRestoreTimer);
  this.positionRestoreTimer = null;
};

WirelessOutputManager.prototype._stopPlaybackForRouting = function () {
  this._clearPositionRestore();
  var snapshot = null;
  try {
    var state = this.commandRouter.volumioGetState();
    var seek = Number(state && state.seek);
    var duration = Number(state && state.duration);
    if (Number.isFinite(seek) && seek > 0 && Number.isFinite(duration) && duration > 0) {
      snapshot = { seek: seek, uri: state.uri || '', title: state.title || '' };
    }
  } catch (stateError) {
    this.log.warn('Unable to capture playback position: ' + stateError.message);
  }
  try {
    // Volumio 4's stop command is fire-and-forget. Do not chain its return
    // value; give MPD a short, bounded interval to release the current PCM.
    this.commandRouter.volumioStop();
  } catch (error) {
    return Promise.reject(new Error('Unable to stop playback before switching output: ' + error.message));
  }
  return new Promise(function (resolve) { setTimeout(function () { resolve(snapshot); }, 1000); });
};

WirelessOutputManager.prototype._restorePlaybackPosition = function (snapshot) {
  var self = this;
  if (!snapshot || !Number.isFinite(snapshot.seek) || snapshot.seek <= 0) return Promise.resolve();
  if (typeof self.commandRouter.volumioSeek !== 'function') {
    self.log.warn('Playback position was not restored because volumioSeek is unavailable');
    return Promise.resolve();
  }
  // The ALSA rebuild leaves MPD with no current song. Keep routing manual and
  // wait for the user to press Play; seek only after Volumio reports that the
  // same track has actually been loaded by MPD.
  var expiresAt = Date.now() + 300000;
  self.log.info('Playback position restore armed for ' + Math.round(snapshot.seek) + ' ms');
  self.positionRestoreTimer = setInterval(function () {
    var state;
    try {
      state = self.commandRouter.volumioGetState();
    } catch (error) {
      return;
    }
    if (Date.now() >= expiresAt) {
      self._clearPositionRestore();
      self.log.warn('Playback position restore expired before Play was pressed');
      return;
    }
    if (!state || state.status !== 'play' || state.seek === null || state.seek === undefined) return;
    if (snapshot.uri && state.uri && state.uri !== snapshot.uri) {
      self._clearPositionRestore();
      self.log.info('Playback position restore cancelled because a different track was selected');
      return;
    }
    self._clearPositionRestore();
    try {
      self.commandRouter.volumioSeek(Math.round(snapshot.seek));
      self.log.info('Restored playback position to ' + Math.round(snapshot.seek) + ' ms');
    } catch (seekError) {
      self.log.warn('Unable to restore playback position: ' + seekError.message);
    }
  }, 250);
  if (self.positionRestoreTimer.unref) self.positionRestoreTimer.unref();
  return Promise.resolve();
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

WirelessOutputManager.prototype.getUIConfig = function () {
  var self = this;
  var lang = self.commandRouter.sharedVars.get('language_code');
  return self.commandRouter.i18nJson(
    path.join(__dirname, 'i18n', 'strings_' + lang + '.json'),
    path.join(__dirname, 'i18n', 'strings_en.json'), path.join(__dirname, 'UIConfig.json')
  ).then(async function (ui) {
    function set(index, key, value) { self.configManager.setUIConfigParam(ui, index + '.' + key, value); }
    set('sections[0].content[0]', 'value', Boolean(self.config.get('enabled')));
    set('sections[0].content[1]', 'value', { value: 'bluetooth', label: 'Bluetooth' });
    set('sections[0].content[2]', 'value', Boolean(self.config.get('autoReconnect')));
    set('sections[0].content[3]', 'value', { value: self.config.get('volumeMode'), label: self.config.get('volumeMode') });
    set('sections[0].content[4]', 'value', Boolean(self.config.get('debugLogging')));
    var preferred = self.config.get('preferredDeviceMac') || '';
    var preferredName = self.config.get('preferredDeviceName') || 'No preferred device';
    set('sections[1].content[0]', 'value', { value: preferred, label: preferredName });
    // A newly loaded plugin has no in-memory scan results. Keep the persisted
    // selection in the option list so Volumio does not discard or hide a
    // select control whose current value has no matching option.
    if (preferred) {
      self.configManager.pushUIConfigParam(ui, 'sections[1].content[0].options', {
        value: preferred,
        label: preferredName
      });
    }
    self.devices.forEach(function (device) {
      if (device.id === preferred) return;
      self.configManager.pushUIConfigParam(ui, 'sections[1].content[0].options', {
        value: device.id,
        label: device.name + (device.audioCapable === true ? ' (audio)' : '')
      });
    });
    var status = await self.bluetooth.getStatus(preferred).catch(function (error) { return { available: false, lastError: error.message }; });
    set('sections[1].content[11]', 'value', JSON.stringify(status, null, 2));
    set('sections[2].content[3]', 'value', self.lastDiagnostics ? JSON.stringify(self.lastDiagnostics, null, 2) : 'Run diagnostics to collect system state.');
    set('sections[2].content[4]', 'value', self.lastError || 'None');
    return ui;
  });
};

WirelessOutputManager.prototype.saveSettings = function (data) {
  var self = this;
  ['enabled', 'autoReconnect', 'debugLogging'].forEach(function (key) { self.config.set(key, Boolean(data[key])); });
  ['volumeMode'].forEach(function (key) {
    var value = data[key] && data[key].value !== undefined ? data[key].value : data[key];
    if (value !== undefined) self.config.set(key, value);
  });
  self.config.set('activeBackend', 'bluetooth');
  if (self.config.get('enabled') && self.config.get('autoReconnect')) self._scheduleReconnect(1000);
  else self._clearReconnect();
  self._toast('success', 'Settings saved');
  return libQ.resolve();
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
    var result = await self.bluetooth.connect(id);
    var info = await self.bluetooth.getDeviceInfo(id);
    self.config.set('preferredDeviceMac', id);
    self.config.set('preferredDeviceName', info.name || id);
    return result;
  }, 'Bluetooth speaker connected');
};
WirelessOutputManager.prototype.disconnectDevice = function (data) {
  var id = this._selected(data); return this._action('Disconnecting ' + id, this.bluetooth.disconnect.bind(this.bluetooth, id), 'Device disconnected');
};
WirelessOutputManager.prototype.forgetDevice = function (data) {
  var self = this; var id = self._selected(data);
  return self._action('Forgetting ' + id, async function () {
    var result = await self.bluetooth.forget(id);
    if (self.config.get('preferredDeviceMac') === id) {
      self.config.set('preferredDeviceMac', ''); self.config.set('preferredDeviceName', '');
    }
    return result;
  }, 'Device forgotten');
};

WirelessOutputManager.prototype.createBluetoothOutput = function () {
  var self = this;
  return self._action('Creating guarded BlueALSA output', function () {
    var playbackSnapshot;
    return self._stopPlaybackForRouting().then(function (snapshot) {
      playbackSnapshot = snapshot;
      return self.outputManager.createOutput(self.config.get('preferredDeviceMac'));
    }).then(function (result) {
      self.config.set('outputEnabled', true);
      return self._restorePlaybackPosition(playbackSnapshot).then(function () { return result; });
    });
  }, 'Bluetooth ALSA output created');
};
WirelessOutputManager.prototype.removeBluetoothOutput = function () {
  var self = this;
  return self._action('Removing Bluetooth output', function () {
    var playbackSnapshot;
    return self._stopPlaybackForRouting().then(function (snapshot) {
      playbackSnapshot = snapshot;
      return self.outputManager.removeOutput();
    }).then(function (result) {
      self.config.set('outputEnabled', false);
      return self._restorePlaybackPosition(playbackSnapshot).then(function () { return result; });
    });
  }, 'Bluetooth ALSA output removed');
};

WirelessOutputManager.prototype.runDiagnostics = function () {
  var self = this;
  return self.diagnostics.all().then(async function (result) {
    result.wirelessOutput = await self.outputManager.getStatus();
    result.preferredDevice = await self.bluetooth.getStatus(self.config.get('preferredDeviceMac'));
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
