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

WirelessOutputManager.prototype._returnToDefaultIfWireless = async function () {
  if (!this.config.get('outputEnabled')) return;
  await this._stopPlaybackForRouting();
  await this.outputManager.removeOutput();
  this.config.set('outputEnabled', false);
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
    return libQ.reject(new Error('Find and select a Bluetooth speaker first'));
  }
  var previousId = String(self.config.get('preferredDeviceMac') || '').toUpperCase();
  var changingSpeaker = BluetoothAdapter.MAC_RE.test(previousId) && previousId !== id;
  var successMessage = changingSpeaker
    ? 'Speaker changed and connected. Music is on the default output; choose Play on Bluetooth speaker when ready.'
    : 'Speaker paired, connected and saved';
  return self._action('Pairing and connecting ' + id, async function () {
    self._clearReconnect();
    try {
      await self.bluetooth.powerOn();
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
      }
      for (var deviceIndex = 0; deviceIndex < otherConnectedAudio.length; deviceIndex += 1) {
        await self.bluetooth.disconnect(otherConnectedAudio[deviceIndex].id);
      }
      await self.bluetooth.pair(id);
      await self.bluetooth.trust(id);
      var beforeConnect = await self.bluetooth.getDeviceInfo(id).catch(function () { return null; });
      if (!beforeConnect || !beforeConnect.connected) await self.bluetooth.connect(id);
      var info = await self.bluetooth.getDeviceInfo(id);
      if (!info.connected) throw new Error('The selected speaker did not report a connected state');
      self.config.set('preferredDeviceMac', id);
      self.config.set('preferredDeviceName', info.name || id);
      self.config.set('enabled', true);
      await self._loadKnownDevices().catch(function () {});
      if (self.config.get('autoReconnect')) self._scheduleReconnect(15000);
      await self.refreshUI();
      return info;
    } catch (error) {
      if (changingSpeaker) {
        await self.bluetooth.disconnect(id).catch(function () {});
        await self.bluetooth.connect(previousId).catch(function (restoreError) {
          self.btLog.warn('Unable to reconnect the previous speaker after a failed switch: ' + restoreError.message);
        });
        if (self.config.get('enabled') && self.config.get('autoReconnect')) self._scheduleReconnect(15000);
        await self.refreshUI().catch(function () {});
        throw new Error('Could not switch speakers. The previous speaker remains selected and music is on the default output: ' + error.message);
      }
      if (self.config.get('enabled') && self.config.get('autoReconnect')) self._scheduleReconnect(15000);
      throw error;
    }
  }, successMessage);
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
    self.devices = [];
    await self.refreshUI();
  }, 'Speaker setup reset; system Bluetooth pairings were preserved');
};

WirelessOutputManager.prototype.createBluetoothOutput = function () {
  var self = this;
  return self._action('Creating guarded BlueALSA output', function () {
    return self._stopPlaybackForRouting().then(function () {
      return self.outputManager.createOutput(self.config.get('preferredDeviceMac'));
    }).then(function (result) {
      self.config.set('outputEnabled', true);
      return self.refreshUI().then(function () { return result; });
    });
  }, 'Music will play on the Bluetooth speaker');
};
WirelessOutputManager.prototype.removeBluetoothOutput = function () {
  var self = this;
  return self._action('Removing Bluetooth output', function () {
    return self._stopPlaybackForRouting().then(function () {
      return self.outputManager.removeOutput();
    }).then(function (result) {
      self.config.set('outputEnabled', false);
      return self.refreshUI().then(function () { return result; });
    });
  }, 'Music will play on the default audio output');
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
