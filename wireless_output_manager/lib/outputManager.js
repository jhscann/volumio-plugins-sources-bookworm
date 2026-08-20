'use strict';

var fs = require('fs-extra');
var path = require('path');
var MAC_RE = require('./adapters/bluetooth').MAC_RE;

function OutputManager(options) {
  this.pluginDir = options.pluginDir;
  this.runner = options.runner;
  this.logger = options.logger;
  this.commandRouter = options.commandRouter;
  this.bluetoothFilename = 'womBluetooth.womBluetoothOut.-1.conf';
  this.airplayFilename = 'womAirPlay.womAirPlayOut.-1.conf';
  this.filename = this.bluetoothFilename;
}

OutputManager.prototype.detectStack = async function () {
  var checks = await Promise.all([
    this.runner.run('which', ['bluealsa'], { allowFailure: true }),
    this.runner.run('which', ['pactl'], { allowFailure: true }),
    this.runner.run('which', ['pw-cli'], { allowFailure: true })
  ]);
  return {
    bluealsa: checks[0].exitCode === 0,
    pulseaudio: checks[1].exitCode === 0,
    pipewire: checks[2].exitCode === 0,
    recommended: checks[0].exitCode === 0 ? 'bluealsa' : 'unsupported'
  };
};

OutputManager.prototype._rebuild = function () {
  try {
    return Promise.resolve(this.commandRouter.executeOnPlugin(
      'audio_interface', 'alsa_controller', 'updateALSAConfigFile'));
  } catch (error) {
    return Promise.reject(error);
  }
};

OutputManager.prototype._contributionPath = function (filename) {
  return path.join(this.pluginDir, 'asound', filename);
};

OutputManager.prototype._snapshotContributions = async function () {
  var self = this;
  var snapshots = {};
  await Promise.all([self.bluetoothFilename, self.airplayFilename].map(async function (filename) {
    var target = self._contributionPath(filename);
    snapshots[filename] = await fs.pathExists(target) ? await fs.readFile(target) : null;
  }));
  return snapshots;
};

OutputManager.prototype._restoreContributions = async function (snapshots) {
  var self = this;
  await Promise.all([self.bluetoothFilename, self.airplayFilename].map(async function (filename) {
    var target = self._contributionPath(filename);
    if (snapshots[filename] === null) await fs.remove(target);
    else await fs.writeFile(target, snapshots[filename], { mode: 0o644 });
  }));
};

OutputManager.prototype._installContribution = async function (filename, content, expectedPcm) {
  var asoundDir = path.join(this.pluginDir, 'asound');
  var target = this._contributionPath(filename);
  var alternateFilename = filename === this.bluetoothFilename
    ? this.airplayFilename : this.bluetoothFilename;
  var snapshots;
  await fs.ensureDir(asoundDir);
  snapshots = await this._snapshotContributions();
  try {
    await fs.remove(this._contributionPath(alternateFilename));
    await fs.writeFile(target, content, { encoding: 'utf8', mode: 0o644 });
    await this._rebuild();
    var verify = await this.runner.run('aplay', ['-L'], { allowFailure: true });
    if (verify.stdout.split(/\r?\n/).indexOf(expectedPcm) === -1) {
      throw new Error('ALSA did not expose ' + expectedPcm + ' after rebuilding its configuration');
    }
  } catch (error) {
    await this._restoreContributions(snapshots);
    await this._rebuild().catch(function () {});
    throw error;
  }
};

OutputManager.prototype.createOutput = async function (deviceId) {
  var mac = String(deviceId || '').toUpperCase();
  if (!MAC_RE.test(mac)) throw new Error('A valid preferred Bluetooth device is required');
  var stack = await this.detectStack();
  if (!stack.bluealsa) {
    throw new Error('No supported Bluetooth audio sender is installed. Diagnostics found no BlueALSA service; no audio configuration was changed.');
  }
  var content = [
    '# Managed by Wireless Output Manager. Remove via the plugin, not by editing this file.',
    'pcm.womBluetooth {',
    '  type plug',
    '  slave.pcm {',
    '    type bluealsa',
    '    device "' + mac + '"',
    '    profile "a2dp"',
    '  }',
    '}',
    ''
  ].join('\n');
  await this._installContribution(this.bluetoothFilename, content, 'womBluetooth');
  return {
    pcm: 'womBluetooth', stack: stack,
    selectable: false,
    message: 'The BlueALSA PCM is available. Volumio 4 enumerates hardware cards for Playback Options, so this virtual PCM is not automatically selected; use diagnostics to validate device integration.'
  };
};

OutputManager.prototype.createAirPlayOutput = async function (fifoPath) {
  fifoPath = String(fifoPath || '');
  if (!path.isAbsolute(fifoPath) || /["\r\n]/.test(fifoPath)) {
    throw new Error('A safe absolute AirPlay FIFO path is required');
  }
  var content = [
    '# Managed by Wireless Output Manager. Remove via the plugin, not by editing this file.',
    'pcm.womAirPlayFile {',
    '  type file',
    '  slave.pcm "null"',
    '  file "' + fifoPath + '"',
    '  format "raw"',
    '}',
    '',
    'pcm.womAirPlay {',
    '  type plug',
    '  slave {',
    '    pcm "womAirPlayFile"',
    '    format S16_LE',
    '    rate 44100',
    '    channels 2',
    '  }',
    '}',
    ''
  ].join('\n');
  await this._installContribution(this.airplayFilename, content, 'womAirPlay');
  return {
    pcm: 'womAirPlay', fifo: fifoPath, stack: 'airplay', selectable: false,
    message: 'The AirPlay PCM bridge is active through Volumio\'s modular ALSA pipeline.'
  };
};

OutputManager.prototype.removeOutput = async function () {
  await fs.remove(this._contributionPath(this.bluetoothFilename));
  await fs.remove(this._contributionPath(this.airplayFilename));
  await this._rebuild().catch(function (error) {
    throw new Error('Removed the plugin contribution but ALSA rebuild failed: ' + error.message);
  });
};

OutputManager.prototype.getStatus = async function () {
  var bluetoothConfigured = await fs.pathExists(this._contributionPath(this.bluetoothFilename));
  var airplayConfigured = await fs.pathExists(this._contributionPath(this.airplayFilename));
  var backend = bluetoothConfigured && airplayConfigured ? 'conflict'
    : (airplayConfigured ? 'airplay' : (bluetoothConfigured ? 'bluetooth' : ''));
  return {
    configured: bluetoothConfigured || airplayConfigured,
    backend: backend,
    conflict: bluetoothConfigured && airplayConfigured,
    stack: await this.detectStack()
  };
};

module.exports = OutputManager;
