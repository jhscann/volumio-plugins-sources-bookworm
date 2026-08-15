'use strict';

function Diagnostics(options) {
  this.runner = options.runner;
  this.logger = options.logger;
}

Diagnostics.prototype._collect = async function (commands) {
  var self = this;
  var sections = [];
  for (var i = 0; i < commands.length; i += 1) {
    var item = commands[i];
    var result;
    try {
      result = await self.runner.run(item[0], item.slice(1), { timeoutMs: 15000, allowFailure: true });
    } catch (error) {
      result = error.result || { stdout: '', stderr: error.message, exitCode: null, timedOut: false };
    }
    sections.push({
      command: [item[0]].concat(item.slice(1)).join(' '),
      exitCode: result.exitCode,
      timedOut: Boolean(result.timedOut),
      stdout: result.stdout || '',
      stderr: result.stderr || ''
    });
  }
  return sections;
};

Diagnostics.prototype.environment = function () {
  return this._collect([
    ['cat', '/etc/os-release'], ['uname', '-a'], ['node', '--version'],
    ['bluetoothctl', '--version'], ['systemctl', 'list-unit-files', '--no-pager'],
    ['dpkg-query', '-W', '-f=${binary:Package}\t${Version}\n', 'bluez', 'bluealsa', 'bluealsa-utils', 'pulseaudio', 'pipewire']
  ]);
};
Diagnostics.prototype.bluetooth = function () {
  return this._collect([
    ['rfkill', 'list', 'bluetooth'], ['bluetoothctl', 'list'], ['bluetoothctl', 'show'], ['bluetoothctl', 'devices'],
    ['bluetoothctl', 'devices', 'Paired'], ['systemctl', 'status', 'bluetooth', '--no-pager'],
    ['busctl', '--system', 'tree', 'org.bluez'],
    ['journalctl', '-u', 'bluetooth', '--since', '30 minutes ago', '--no-pager']
  ]);
};
Diagnostics.prototype.audio = function () {
  return this._collect([
    ['aplay', '-L'], ['aplay', '-l'], ['cat', '/proc/asound/cards'],
    ['systemctl', 'status', 'bluealsa', '--no-pager'], ['systemctl', 'cat', 'bluealsa', '--no-pager'],
    ['bluealsa-cli', 'status'], ['bluealsa-cli', 'list-pcms'], ['bluealsa-aplay', '-L'],
    ['pactl', 'info'], ['pactl', 'list', 'short', 'sinks'], ['pw-cli', 'info', 'all']
  ]);
};
Diagnostics.prototype.mpd = function () {
  return this._collect([
    ['mpc', 'outputs'], ['systemctl', 'status', 'mpd', '--no-pager'],
    ['grep', '-nE', '^(audio_output|[[:space:]]*(name|type|device|mixer_type))', '/etc/mpd.conf']
  ]);
};
Diagnostics.prototype.all = async function () {
  this.logger.info('Collecting read-only diagnostics');
  return {
    generatedAt: new Date().toISOString(),
    environment: await this.environment(),
    bluetooth: await this.bluetooth(),
    audio: await this.audio(),
    mpd: await this.mpd()
  };
};

module.exports = Diagnostics;
