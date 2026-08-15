'use strict';

var MAC_RE = require('./adapters/bluetooth').MAC_RE;
var USER_CODECS = ['SBC', 'AAC', 'LDAC'];
var AUTO_PRIORITY = ['LDAC', 'AAC', 'SBC'];

function CodecManager(options) {
  this.runner = options.runner;
  this.logger = options.logger;
  this.selections = {};
}

CodecManager.prototype.normalize = function (value) {
  var codec = String(value || 'AUTO').trim().toUpperCase();
  if (codec === 'AUTO') return 'AUTO';
  if (USER_CODECS.indexOf(codec) === -1) throw new Error('Unsupported codec preference: ' + codec);
  return codec;
};

CodecManager.prototype._mac = function (value) {
  var mac = String(value || '').toUpperCase();
  if (!MAC_RE.test(mac)) throw new Error('A valid Bluetooth device is required for codec selection');
  return mac;
};

CodecManager.prototype._parseCodecs = function (value) {
  return String(value || '').trim().split(/[\s,]+/).map(function (codec) {
    return codec.replace(/[^A-Za-z0-9+_-]/g, '').toUpperCase();
  }).filter(Boolean);
};

CodecManager.prototype._systemCodecs = function (text) {
  var match = String(text || '').match(/^\s*A2DP-source\s*:\s*(.*)$/mi);
  return match ? this._parseCodecs(match[1]) : [];
};

CodecManager.prototype._info = function (text) {
  var available = String(text || '').match(/^Available codecs:\s*(.*)$/mi);
  var selected = String(text || '').match(/^Selected codec:\s*(.*)$/mi);
  return {
    availableCodecs: available ? this._parseCodecs(available[1]) : [],
    activeCodec: selected ? String(selected[1]).trim().toUpperCase() : ''
  };
};

CodecManager.prototype._findPcm = function (text, mac) {
  var token = 'dev_' + mac.replace(/:/g, '_');
  return String(text || '').split(/\r?\n/).map(function (line) { return line.trim(); })
    .find(function (line) {
      return line.indexOf('/org/bluealsa/') === 0 && line.indexOf('/' + token + '/') !== -1 && /\/a2dpsrc\/sink$/.test(line);
    }) || '';
};

CodecManager.prototype.getStatus = async function (deviceId) {
  var mac = deviceId ? this._mac(deviceId) : '';
  var daemon = await this.runner.run('bluealsa-cli', ['status'], { timeoutMs: 10000, allowFailure: true });
  var status = {
    available: daemon.exitCode === 0,
    systemCodecs: daemon.exitCode === 0 ? this._systemCodecs(daemon.stdout) : [],
    deviceConnected: false,
    pcmPath: '',
    availableCodecs: [],
    activeCodec: '',
    error: daemon.exitCode === 0 ? '' : (daemon.stderr || 'bluealsa-cli status failed')
  };
  if (!mac || daemon.exitCode !== 0) return status;

  var pcms = await this.runner.run('bluealsa-cli', ['list-pcms'], { timeoutMs: 10000, allowFailure: true });
  if (pcms.exitCode !== 0) {
    status.error = pcms.stderr || 'Unable to list BlueALSA audio streams';
    return status;
  }
  status.pcmPath = this._findPcm(pcms.stdout, mac);
  if (!status.pcmPath) return status;
  status.deviceConnected = true;

  var info = await this.runner.run('bluealsa-cli', ['info', status.pcmPath], { timeoutMs: 10000, allowFailure: true });
  if (info.exitCode !== 0) {
    status.error = info.stderr || 'Unable to inspect the Bluetooth audio stream';
    return status;
  }
  var parsed = this._info(info.stdout);
  status.availableCodecs = parsed.availableCodecs;
  status.activeCodec = parsed.activeCodec;
  return status;
};

CodecManager.prototype.select = function (deviceId, preference) {
  var self = this;
  var mac = self._mac(deviceId);
  var codec = self.normalize(preference);
  if (self.selections[mac]) return self.selections[mac];
  self.selections[mac] = Promise.resolve().then(async function () {
    var before = await self.getStatus(mac);
    if (!before.available) throw new Error('BlueALSA codec control is unavailable: ' + before.error);
    if (!before.deviceConnected) throw new Error('The selected Bluetooth device has no active BlueALSA audio stream');
    var selectedCodec = codec;
    if (codec === 'AUTO') {
      selectedCodec = AUTO_PRIORITY.find(function (candidate) {
        return before.systemCodecs.indexOf(candidate) !== -1 && before.availableCodecs.indexOf(candidate) !== -1;
      });
      if (!selectedCodec) throw new Error('No mutually supported Bluetooth audio codec was reported');
    }
    if (before.systemCodecs.indexOf(selectedCodec) === -1) {
      throw new Error(selectedCodec + ' is not enabled by the installed BlueALSA service');
    }
    if (before.availableCodecs.indexOf(selectedCodec) === -1) {
      throw new Error(selectedCodec + ' is not offered by both BlueALSA and the selected Bluetooth device');
    }
    if (before.activeCodec !== selectedCodec) {
      await self.runner.run('bluealsa-cli', ['codec', before.pcmPath, selectedCodec], { timeoutMs: 20000 });
    }
    var after = await self.getStatus(mac);
    if (after.activeCodec !== selectedCodec) {
      throw new Error('BlueALSA did not confirm the requested ' + selectedCodec + ' codec');
    }
    after.preference = codec;
    self.logger.info('Selected ' + selectedCodec + ' for ' + mac + ' using ' + after.pcmPath +
      (codec === 'AUTO' ? ' (automatic best available)' : ''));
    return after;
  }).finally(function () { delete self.selections[mac]; });
  return self.selections[mac];
};

module.exports = CodecManager;
module.exports.USER_CODECS = USER_CODECS;
