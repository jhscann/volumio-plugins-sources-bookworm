'use strict';

var fs = require('fs-extra');
var path = require('path');
var MAC_RE = require('./adapters/bluetooth').MAC_RE;

function OutputManager(options) {
  this.pluginDir = options.pluginDir;
  this.runner = options.runner;
  this.logger = options.logger;
  this.commandRouter = options.commandRouter;
  this.filename = 'womBluetooth.womBluetoothOut.-1.conf';
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

OutputManager.prototype.createOutput = async function (deviceId) {
  var mac = String(deviceId || '').toUpperCase();
  if (!MAC_RE.test(mac)) throw new Error('A valid preferred Bluetooth device is required');
  var stack = await this.detectStack();
  if (!stack.bluealsa) {
    throw new Error('No supported Bluetooth audio sender is installed. Diagnostics found no BlueALSA service; no audio configuration was changed.');
  }
  var asoundDir = path.join(this.pluginDir, 'asound');
  var target = path.join(asoundDir, this.filename);
  var backup = target + '.bak';
  await fs.ensureDir(asoundDir);
  if (await fs.pathExists(target)) await fs.copy(target, backup, { overwrite: false, errorOnExist: false });
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
  await fs.writeFile(target, content, { encoding: 'utf8', mode: 0o644 });
  try {
    await this._rebuild();
    var verify = await this.runner.run('aplay', ['-L'], { allowFailure: true });
    if (verify.stdout.split(/\r?\n/).indexOf('womBluetooth') === -1) {
      throw new Error('ALSA did not expose womBluetooth after rebuilding its configuration');
    }
  } catch (error) {
    if (await fs.pathExists(backup)) await fs.move(backup, target, { overwrite: true });
    else await fs.remove(target);
    await this._rebuild().catch(function () {});
    throw error;
  }
  return {
    pcm: 'womBluetooth', stack: stack,
    selectable: false,
    message: 'The BlueALSA PCM is available. Volumio 4 enumerates hardware cards for Playback Options, so this virtual PCM is not automatically selected; use diagnostics to validate device integration.'
  };
};

OutputManager.prototype.removeOutput = async function () {
  var target = path.join(this.pluginDir, 'asound', this.filename);
  await fs.remove(target);
  await this._rebuild().catch(function (error) {
    throw new Error('Removed the plugin contribution but ALSA rebuild failed: ' + error.message);
  });
};

OutputManager.prototype.getStatus = async function () {
  var target = path.join(this.pluginDir, 'asound', this.filename);
  return { configured: await fs.pathExists(target), stack: await this.detectStack() };
};

module.exports = OutputManager;
