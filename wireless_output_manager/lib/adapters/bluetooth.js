'use strict';

var MAC_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/i;
var AUDIO_UUIDS = [
  '0000110b-0000-1000-8000-00805f9b34fb',
  '0000110d-0000-1000-8000-00805f9b34fb',
  '0000110e-0000-1000-8000-00805f9b34fb'
];
var AUDIO_SINK_UUID = '0000110b-0000-1000-8000-00805f9b34fb';
var DEVICE_PATH_RE = /^\/org\/bluez\/(hci[^/]+)\/dev_([0-9A-F_]{17})$/i;

function BluetoothAdapter(options) {
  this.runner = options.runner;
  this.logger = options.logger;
  this.lastError = '';
  this.connectAttempts = {};
}

BluetoothAdapter.prototype._mac = function (value) {
  var mac = String(value || '').toUpperCase();
  if (!MAC_RE.test(mac)) throw new Error('Select a valid Bluetooth device');
  return mac;
};

BluetoothAdapter.prototype._ctl = function (args, timeoutMs) {
  var self = this;
  return self.runner.run('bluetoothctl', args, { timeoutMs: timeoutMs || 15000 })
    .catch(function (error) {
      self.lastError = error.message + (error.result && error.result.stderr ? ': ' + error.result.stderr : '');
      throw error;
    });
};

BluetoothAdapter.prototype._bus = function (args, timeoutMs, allowFailure) {
  var self = this;
  return this.runner.run('busctl', ['--system'].concat(args), {
    timeoutMs: timeoutMs || 15000,
    allowFailure: Boolean(allowFailure)
  }).catch(function (error) {
    self.lastError = error.message + (error.result && error.result.stderr ? ': ' + error.result.stderr : '');
    throw error;
  });
};

BluetoothAdapter.prototype._parseBusValue = function (text) {
  text = String(text || '').trim();
  if (/^b\s+/.test(text)) return /\btrue\s*$/.test(text);
  if (/^s\s+/.test(text)) {
    var quoted = text.slice(2).trim();
    try { return JSON.parse(quoted); } catch (error) { return quoted.replace(/^"|"$/g, ''); }
  }
  if (/^as\s+/.test(text)) {
    var values = [];
    var match;
    var pattern = /"((?:\\.|[^"\\])*)"/g;
    while ((match = pattern.exec(text))) {
      try { values.push(JSON.parse('"' + match[1] + '"')); } catch (error) { values.push(match[1]); }
    }
    return values;
  }
  return text;
};

BluetoothAdapter.prototype._getProperty = async function (path, iface, property) {
  var result = await this._bus(['get-property', 'org.bluez', path, iface, property], 10000, true);
  if (result.exitCode !== 0) return null;
  return this._parseBusValue(result.stdout);
};

BluetoothAdapter.prototype._listDevicePaths = async function () {
  var result = await this._bus(['tree', 'org.bluez'], 10000);
  return String(result.stdout || '').split(/\r?\n/).map(function (line) {
    var match = line.match(/(\/org\/bluez\/hci[^/\s]+\/dev_[0-9A-F_]{17})(?:\s|$)/i);
    return match ? match[1] : null;
  }).filter(Boolean);
};

BluetoothAdapter.prototype._pathIdentity = function (path) {
  var match = String(path || '').match(DEVICE_PATH_RE);
  if (!match) return null;
  return {
    path: path,
    adapterPath: '/org/bluez/' + match[1],
    id: match[2].replace(/_/g, ':').toUpperCase()
  };
};

BluetoothAdapter.prototype._deviceFromPath = async function (path) {
  var identity = this._pathIdentity(path);
  if (!identity) throw new Error('Invalid BlueZ device path: ' + path);
  var values = await Promise.all([
    this._getProperty(path, 'org.bluez.Device1', 'Name'),
    this._getProperty(path, 'org.bluez.Device1', 'Alias'),
    this._getProperty(path, 'org.bluez.Device1', 'Paired'),
    this._getProperty(path, 'org.bluez.Device1', 'Bonded'),
    this._getProperty(path, 'org.bluez.Device1', 'Trusted'),
    this._getProperty(path, 'org.bluez.Device1', 'Connected'),
    this._getProperty(path, 'org.bluez.Device1', 'UUIDs'),
    this._getProperty(identity.adapterPath, 'org.bluez.Adapter1', 'Address')
  ]);
  var uuids = Array.isArray(values[6]) ? values[6].map(function (uuid) { return uuid.toLowerCase(); }) : [];
  return {
    id: identity.id,
    name: values[0] || values[1] || identity.id,
    paired: values[2] === true,
    bonded: values[3] === true,
    trusted: values[4] === true,
    connected: values[5] === true,
    uuids: uuids,
    audioCapable: uuids.length ? uuids.some(function (uuid) { return AUDIO_UUIDS.indexOf(uuid) !== -1; }) : null,
    objectPath: path,
    adapterPath: identity.adapterPath,
    adapterAddress: values[7] || ''
  };
};

BluetoothAdapter.prototype._candidateRank = function (device) {
  // A bonded or paired object owns the durable relationship. A connected
  // duplicate is preferred only when pairing ownership is otherwise equal.
  return Number(device.bonded) * 8 + Number(device.paired) * 4 + Number(device.connected) * 2 + Number(device.trusted);
};

BluetoothAdapter.prototype._pickBest = function (devices) {
  var self = this;
  return devices.slice().sort(function (a, b) {
    return self._candidateRank(b) - self._candidateRank(a) || a.objectPath.localeCompare(b.objectPath);
  })[0] || null;
};

BluetoothAdapter.prototype.resolveDevice = async function (deviceId) {
  var mac = this._mac(deviceId);
  var candidates = (await this._listDevicePaths()).map(this._pathIdentity.bind(this)).filter(function (identity) {
    return identity && identity.id === mac;
  });
  if (!candidates.length) throw new Error('Device ' + mac + ' is not available on any Bluetooth adapter');
  var devices = await Promise.all(candidates.map(function (identity) {
    return this._deviceFromPath(identity.path);
  }, this));
  var selected = this._pickBest(devices);
  this.logger.info('Resolved ' + mac + ' to ' + selected.objectPath +
    (selected.adapterAddress ? ' on adapter ' + selected.adapterAddress : ''));
  return selected;
};

BluetoothAdapter.prototype._callDevice = async function (deviceId, method, timeoutMs) {
  var device = await this.resolveDevice(deviceId);
  var result = await this._bus(['call', 'org.bluez', device.objectPath, 'org.bluez.Device1', method], timeoutMs);
  result.device = device;
  return result;
};

BluetoothAdapter.prototype.start = function () {
  return this.runner.run('systemctl', ['start', 'bluetooth'], { timeoutMs: 20000 });
};
BluetoothAdapter.prototype.stop = function () {
  return this.runner.run('systemctl', ['stop', 'bluetooth'], { timeoutMs: 20000 });
};
BluetoothAdapter.prototype.powerOn = function () { return this._ctl(['power', 'on']); };

BluetoothAdapter.prototype.scan = async function (seconds) {
  seconds = Math.max(5, Math.min(Number(seconds) || 12, 30));
  this.logger.info('Starting a ' + seconds + ' second scan');
  var result = await this._ctl(['--timeout', String(seconds), 'scan', 'on'], (seconds + 5) * 1000);
  return { command: result, devices: await this.listDevices() };
};

BluetoothAdapter.prototype._parseDeviceLines = function (text) {
  return String(text || '').split(/\r?\n/).map(function (line) {
    var match = line.match(/^Device\s+([0-9A-F:]{17})\s+(.+)$/i);
    return match ? { id: match[1].toUpperCase(), name: match[2].trim() } : null;
  }).filter(Boolean);
};

BluetoothAdapter.prototype.getDeviceInfo = function (deviceId) { return this.resolveDevice(deviceId); };

BluetoothAdapter.prototype._enrich = function (devices) {
  var self = this;
  return Promise.all(devices.map(function (device) {
    return self.getDeviceInfo(device.id).catch(function () {
      device.audioCapable = null;
      return device;
    });
  }));
};

BluetoothAdapter.prototype.listDevices = async function () {
  var paths = await this._listDevicePaths();
  var discovered = await Promise.all(paths.map(function (path) {
    return this._deviceFromPath(path).catch(function () { return null; });
  }, this));
  var grouped = {};
  discovered.filter(Boolean).forEach(function (device) {
    if (!grouped[device.id]) grouped[device.id] = [];
    grouped[device.id].push(device);
  });
  var devices = Object.keys(grouped).map(function (id) { return this._pickBest(grouped[id]); }, this);
  return devices.sort(function (a, b) {
    return Number(b.audioCapable === true) - Number(a.audioCapable === true) || a.name.localeCompare(b.name);
  });
};

BluetoothAdapter.prototype.listPairedDevices = async function () {
  return (await this.listDevices()).filter(function (device) { return device.paired || device.bonded; });
};
BluetoothAdapter.prototype._legacyPaired = function () { return this._ctl(['paired-devices']); };
BluetoothAdapter.prototype.pair = async function (id) {
  var mac = this._mac(id);
  var existing = await this.getDeviceInfo(mac).catch(function () { return null; });
  if (existing && (existing.paired || existing.bonded)) return { stdout: 'Device is already paired', exitCode: 0, device: existing };
  try {
    // Keep the established bluetoothctl agent flow for first-time pairing.
    // Multi-adapter ownership is resolved for all subsequent operations once
    // BlueZ marks the new device object as paired or bonded.
    return await this._ctl(['pair', mac], 60000);
  } catch (error) {
    var after = await this.getDeviceInfo(mac).catch(function () { return null; });
    if (after && after.paired) return { stdout: 'Pairing completed', exitCode: 0 };
    var detail = error.result && (error.result.stderr || error.result.stdout);
    if (detail) error.message += ': ' + detail;
    throw error;
  }
};
BluetoothAdapter.prototype.trust = async function (id) {
  var device = await this.resolveDevice(id);
  if (device.trusted) return { stdout: 'Device is already trusted', exitCode: 0, device: device };
  var result = await this._bus(['set-property', 'org.bluez', device.objectPath, 'org.bluez.Device1', 'Trusted', 'b', 'true']);
  result.device = device;
  return result;
};
BluetoothAdapter.prototype.connect = function (id) {
  var self = this;
  var mac = self._mac(id);
  if (self.connectAttempts[mac]) return self.connectAttempts[mac];
  self.connectAttempts[mac] = Promise.resolve().then(async function () {
    var device = await self.resolveDevice(mac);
    if (device.connected) return { stdout: 'Device is already connected', exitCode: 0, device: device };
    var powered = await self._getProperty(device.adapterPath, 'org.bluez.Adapter1', 'Powered');
    if (powered === false) {
      await self._bus(['set-property', 'org.bluez', device.adapterPath, 'org.bluez.Adapter1', 'Powered', 'b', 'true']);
    }
    var result = await self._bus(['call', 'org.bluez', device.objectPath, 'org.bluez.Device1', 'Connect'], 30000);
    result.device = device;
    return result;
  }).finally(function () { delete self.connectAttempts[mac]; });
  return self.connectAttempts[mac];
};
BluetoothAdapter.prototype.connectAudioProfile = function (id) {
  var self = this;
  var mac = self._mac(id);
  return self.resolveDevice(mac).then(function (device) {
    return self._bus([
      'call', 'org.bluez', device.objectPath, 'org.bluez.Device1',
      'ConnectProfile', 's', AUDIO_SINK_UUID
    ], 20000).then(function (result) {
      result.device = device;
      return result;
    });
  });
};
BluetoothAdapter.prototype.disconnect = function (id) { return this._callDevice(id, 'Disconnect', 20000); };
BluetoothAdapter.prototype.forget = async function (id) {
  var device = await this.resolveDevice(id);
  var result = await this._bus(['call', 'org.bluez', device.adapterPath, 'org.bluez.Adapter1', 'RemoveDevice', 'o', device.objectPath], 20000);
  result.device = device;
  return result;
};

BluetoothAdapter.prototype.getStatus = async function (preferredId) {
  var adapters = await this._ctl(['list']).catch(function (error) { return { stdout: '', error: error.message }; });
  var status = {
    backend: 'bluetooth', available: !adapters.error,
    // Keep the original singular field for diagnostic-export compatibility.
    adapter: adapters.stdout, adapters: adapters.stdout,
    preferred: null, lastError: this.lastError
  };
  if (preferredId && MAC_RE.test(preferredId)) {
    status.preferred = await this.getDeviceInfo(preferredId).catch(function () { return null; });
  }
  return status;
};

module.exports = BluetoothAdapter;
module.exports.MAC_RE = MAC_RE;
