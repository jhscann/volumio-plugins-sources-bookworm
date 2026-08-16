'use strict';

var BluetoothAdapter = require('./adapters/bluetooth');

function BluetoothVolumeManager(options) {
  options = options || {};
  this.runner = options.runner;
  this.logger = options.logger || { info: function () {}, warn: function () {} };
  this.safeMaximumPercent = options.safeMaximumPercent === undefined ? 10 : Number(options.safeMaximumPercent);
}

BluetoothVolumeManager.prototype._device = function (deviceId) {
  var mac = String(deviceId || '').toUpperCase();
  if (!BluetoothAdapter.MAC_RE.test(mac)) throw new Error('A valid Bluetooth audio device is required');
  return 'bluealsa:DEV=' + mac;
};

BluetoothVolumeManager.prototype._parsePlaybackPercentages = function (output) {
  var percentages = [];
  var pattern = /Playback\s+\d+\s+\[(\d+)%\]/g;
  var match;
  while ((match = pattern.exec(String(output || ''))) !== null) percentages.push(Number(match[1]));
  if (!percentages.length) throw new Error('BlueALSA did not report an A2DP playback volume');
  return percentages;
};

BluetoothVolumeManager.prototype.getVolume = async function (deviceId) {
  var result = await this.runner.run('amixer', ['-D', this._device(deviceId), 'scontents'], { timeoutMs: 5000 });
  var percentages = this._parsePlaybackPercentages(result.stdout);
  return { channels: percentages, maximum: Math.max.apply(Math, percentages) };
};

BluetoothVolumeManager.prototype.applySafetyCap = async function (deviceId) {
  var current = await this.getVolume(deviceId);
  if (current.maximum <= this.safeMaximumPercent) {
    this.logger.info('Bluetooth device volume already within the ' + this.safeMaximumPercent + '% safety cap');
    return { changed: false, volume: current };
  }

  await this.runner.run('amixer', [
    '-D', this._device(deviceId), 'sset', 'A2DP', this.safeMaximumPercent + '%'
  ], { timeoutMs: 5000 });
  var verified = await this.getVolume(deviceId);
  if (verified.maximum > this.safeMaximumPercent) {
    throw new Error('Bluetooth device volume remained above the safety cap');
  }
  this.logger.info('Capped selected Bluetooth device volume at ' + verified.maximum + '% before playback');
  return { changed: true, volume: verified };
};

BluetoothVolumeManager.prototype.setVolume = async function (deviceId, percentage) {
  if (percentage === '' || percentage === null || percentage === undefined) {
    throw new Error('Bluetooth device volume must be between 0 and 100');
  }
  var requested = Number(percentage);
  if (!Number.isFinite(requested) || requested < 0 || requested > 100) {
    throw new Error('Bluetooth device volume must be between 0 and 100');
  }
  requested = Math.round(requested);
  await this.runner.run('amixer', [
    '-D', this._device(deviceId), 'sset', 'A2DP', requested + '%'
  ], { timeoutMs: 5000 });
  var verified = await this.getVolume(deviceId);
  if (Math.abs(verified.maximum - requested) > 1) {
    throw new Error('Bluetooth device volume could not be verified');
  }
  this.logger.info('Set selected Bluetooth device volume to ' + verified.maximum + '%');
  return verified;
};

module.exports = BluetoothVolumeManager;
