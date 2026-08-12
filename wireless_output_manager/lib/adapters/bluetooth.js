'use strict';

var MAC_RE = /^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/i;
var AUDIO_UUIDS = [
  '0000110b-0000-1000-8000-00805f9b34fb',
  '0000110d-0000-1000-8000-00805f9b34fb',
  '0000110e-0000-1000-8000-00805f9b34fb'
];

function BluetoothAdapter(options) {
  this.runner = options.runner;
  this.logger = options.logger;
  this.lastError = '';
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

BluetoothAdapter.prototype.getDeviceInfo = async function (deviceId) {
  var mac = this._mac(deviceId);
  var result = await this._ctl(['info', mac]);
  var info = { id: mac, name: '', paired: false, trusted: false, connected: false, audioCapable: null, uuids: [] };
  result.stdout.split(/\r?\n/).forEach(function (line) {
    var match = line.match(/^\s*([^:]+):\s*(.*)$/);
    if (!match) return;
    var key = match[1].trim().toLowerCase();
    var value = match[2].trim();
    if (key === 'name') info.name = value;
    if (key === 'alias' && !info.name) info.name = value;
    if (key === 'paired') info.paired = value === 'yes';
    if (key === 'trusted') info.trusted = value === 'yes';
    if (key === 'connected') info.connected = value === 'yes';
    if (key === 'uuid') {
      var uuid = (value.match(/\(([0-9a-f-]+)\)/i) || [])[1];
      if (uuid) info.uuids.push(uuid.toLowerCase());
    }
  });
  if (info.uuids.length) {
    info.audioCapable = info.uuids.some(function (uuid) { return AUDIO_UUIDS.indexOf(uuid) !== -1; });
  }
  return info;
};

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
  var result = await this._ctl(['devices']);
  var devices = await this._enrich(this._parseDeviceLines(result.stdout));
  return devices.sort(function (a, b) {
    return Number(b.audioCapable === true) - Number(a.audioCapable === true) || a.name.localeCompare(b.name);
  });
};

BluetoothAdapter.prototype.listPairedDevices = async function () {
  var result = await this._ctl(['devices', 'Paired']).catch(this._legacyPaired.bind(this));
  return this._enrich(this._parseDeviceLines(result.stdout));
};
BluetoothAdapter.prototype._legacyPaired = function () { return this._ctl(['paired-devices']); };
BluetoothAdapter.prototype.pair = async function (id) {
  var mac = this._mac(id);
  var existing = await this.getDeviceInfo(mac).catch(function () { return null; });
  if (existing && existing.paired) return { stdout: 'Device is already paired', exitCode: 0 };
  try {
    return await this._ctl(['pair', mac], 60000);
  } catch (error) {
    var after = await this.getDeviceInfo(mac).catch(function () { return null; });
    if (after && after.paired) return { stdout: 'Pairing completed', exitCode: 0 };
    var detail = error.result && (error.result.stderr || error.result.stdout);
    if (detail) error.message += ': ' + detail;
    throw error;
  }
};
BluetoothAdapter.prototype.trust = function (id) { return this._ctl(['trust', this._mac(id)]); };
BluetoothAdapter.prototype.connect = function (id) { return this._ctl(['connect', this._mac(id)], 30000); };
BluetoothAdapter.prototype.disconnect = function (id) { return this._ctl(['disconnect', this._mac(id)], 20000); };
BluetoothAdapter.prototype.forget = function (id) { return this._ctl(['remove', this._mac(id)], 20000); };

BluetoothAdapter.prototype.getStatus = async function (preferredId) {
  var show = await this._ctl(['show']).catch(function (error) { return { stdout: '', error: error.message }; });
  var status = {
    backend: 'bluetooth', available: !show.error, adapter: show.stdout,
    preferred: null, lastError: this.lastError
  };
  if (preferredId && MAC_RE.test(preferredId)) {
    status.preferred = await this.getDeviceInfo(preferredId).catch(function () { return null; });
  }
  return status;
};

module.exports = BluetoothAdapter;
module.exports.MAC_RE = MAC_RE;
