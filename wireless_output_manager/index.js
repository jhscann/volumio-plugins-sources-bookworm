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
  if (self.config.get('enabled') && self.config.get('autoReconnect')) self._scheduleReconnect(5000);
  return libQ.resolve();
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

WirelessOutputManager.prototype._clearReconnect = function () {
  if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
  this.reconnectTimer = null;
};

WirelessOutputManager.prototype._scheduleReconnect = function (delayMs) {
  var self = this;
  self._clearReconnect();
  if (!self.config.get('enabled') || !self.config.get('autoReconnect')) return;
  self.reconnectTimer = setTimeout(function () {
    self._reconnectPreferred().finally(function () { self._scheduleReconnect(45000); });
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
  return self.getUIConfig().then(function (uiConfig) {
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
    set('sections[0].content[3]', 'value', { value: self.config.get('fallbackOutput'), label: self.config.get('fallbackOutput') });
    set('sections[0].content[4]', 'value', { value: self.config.get('volumeMode'), label: self.config.get('volumeMode') });
    set('sections[0].content[5]', 'value', Boolean(self.config.get('debugLogging')));
    var preferred = self.config.get('preferredDeviceMac') || '';
    set('sections[1].content[0]', 'value', { value: preferred, label: self.config.get('preferredDeviceName') || 'No preferred device' });
    self.devices.forEach(function (device) {
      self.configManager.pushUIConfigParam(ui, 'sections[1].content[0].options', {
        value: device.id,
        label: device.name + (device.audioCapable === true ? ' (audio)' : '')
      });
    });
    var status = await self.bluetooth.getStatus(preferred).catch(function (error) { return { available: false, lastError: error.message }; });
    set('sections[1].content[10]', 'value', JSON.stringify(status, null, 2));
    set('sections[2].content[4]', 'value', self.lastDiagnostics ? JSON.stringify(self.lastDiagnostics, null, 2) : 'Run diagnostics to collect system state.');
    set('sections[2].content[5]', 'value', self.lastError || 'None');
    return ui;
  });
};

WirelessOutputManager.prototype.saveSettings = function (data) {
  var self = this;
  ['enabled', 'autoReconnect', 'debugLogging'].forEach(function (key) { self.config.set(key, Boolean(data[key])); });
  ['fallbackOutput', 'volumeMode'].forEach(function (key) {
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
  var selected = data.preferredDevice || data;
  var mac = selected.value || selected;
  var match = this.devices.find(function (device) { return device.id === mac; });
  this.config.set('preferredDeviceMac', mac || '');
  this.config.set('preferredDeviceName', match ? match.name : (selected.label || ''));
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
  return selected && selected.value ? selected.value : (selected || this.config.get('preferredDeviceMac'));
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
    return self.outputManager.createOutput(self.config.get('preferredDeviceMac'));
  }, 'Bluetooth ALSA output created');
};
WirelessOutputManager.prototype.removeBluetoothOutput = function () {
  return this._action('Removing Bluetooth output', this.outputManager.removeOutput.bind(this.outputManager), 'Bluetooth ALSA output removed');
};

WirelessOutputManager.prototype.runDiagnostics = function () {
  var self = this;
  return self.diagnostics.all().then(async function (result) {
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
