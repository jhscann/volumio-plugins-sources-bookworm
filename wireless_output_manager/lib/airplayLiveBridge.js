'use strict';

var fs = require('fs-extra');
var path = require('path');
var spawn = require('child_process').spawn;

function delay(milliseconds) {
  return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
}

function withTimeout(promise, milliseconds, message) {
  var timer;
  return Promise.race([
    promise,
    new Promise(function (_, reject) {
      timer = setTimeout(function () { reject(new Error(message)); }, milliseconds);
    })
  ]).finally(function () { clearTimeout(timer); });
}

function openFifoReadWrite(fifoPath) {
  return new Promise(function (resolve, reject) {
    fs.open(fifoPath, fs.constants.O_RDWR, function (error, descriptor) {
      if (error) reject(error);
      else resolve(descriptor);
    });
  });
}

function openFifoWriter(fifoPath) {
  return new Promise(function (resolve, reject) {
    fs.open(fifoPath, 'w', function (error, descriptor) {
      if (error) reject(error);
      else resolve(fs.createWriteStream(null, { fd: descriptor, autoClose: true }));
    });
  });
}

function AirPlayLiveBridge(options) {
  options = options || {};
  this.adapter = options.adapter;
  this.runner = options.runner;
  this.spawn = options.spawn || spawn;
  this.logger = options.logger || { info: function () {}, warn: function () {}, error: function () {} };
  this.maximumVolume = options.maximumVolume === undefined ? 15 : Number(options.maximumVolume);
  this.onUnexpectedExit = options.onUnexpectedExit || function () {};
  this.runtimeDir = options.runtimeDir || path.join('/tmp', 'wireless-output-manager-airplay');
  this.audioFifo = path.join(this.runtimeDir, 'audio.pcm');
  this.commandFifo = path.join(this.runtimeDir, 'commands');
  this.child = null;
  this.commandWriter = null;
  this.exitPromise = null;
  this.output = '';
  this.ready = false;
  this.audioStarted = false;
  this.stopping = false;
}

AirPlayLiveBridge.prototype._setCommandWriter = function (writer) {
  var self = this;
  self.commandWriter = writer;
  writer.on('error', function (error) {
    if (self.commandWriter === writer) self.commandWriter = null;
    self.logger.warn('AirPlay command pipe closed: ' + error.message);
  });
};

AirPlayLiveBridge.prototype._writeCommand = function (command) {
  if (!this.commandWriter || this.commandWriter.destroyed) return false;
  try {
    return this.commandWriter.write(command);
  } catch (error) {
    this.logger.warn('Unable to write to AirPlay command pipe: ' + error.message);
    return false;
  }
};

AirPlayLiveBridge.prototype._safeDirectory = async function () {
  var existing = await fs.lstat(this.runtimeDir).catch(function () { return null; });
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink())) {
    throw new Error('AirPlay runtime path exists but is not a safe directory');
  }
  if (existing && typeof process.getuid === 'function' && existing.uid !== process.getuid()) {
    throw new Error('AirPlay runtime directory is owned by another user');
  }
  await fs.ensureDir(this.runtimeDir);
  await fs.chmod(this.runtimeDir, 0o750);
  await this.runner.run('chgrp', ['audio', this.runtimeDir], { timeoutMs: 3000 });
};

AirPlayLiveBridge.prototype._replaceFifo = async function (fifoPath, mode, group) {
  var existing = await fs.lstat(fifoPath).catch(function () { return null; });
  if (existing) {
    if (!existing.isFIFO() || existing.isSymbolicLink()) {
      throw new Error('Refusing to replace non-FIFO AirPlay runtime path: ' + fifoPath);
    }
    await fs.unlink(fifoPath);
  }
  await this.runner.run('mkfifo', ['-m', mode, fifoPath], { timeoutMs: 3000 });
  if (group) await this.runner.run('chgrp', [group, fifoPath], { timeoutMs: 3000 });
};

AirPlayLiveBridge.prototype._prepareRuntime = async function () {
  await this._safeDirectory();
  // MPD runs as a separate user in Volumio but belongs to the audio group.
  // Permit that group to traverse the private runtime directory and write
  // PCM, while keeping the sender command channel private to the plugin.
  await this._replaceFifo(this.audioFifo, '660', 'audio');
  await this._replaceFifo(this.commandFifo, '600');
};

AirPlayLiveBridge.prototype._removeFifo = async function (fifoPath) {
  var existing = await fs.lstat(fifoPath).catch(function () { return null; });
  if (existing && existing.isFIFO() && !existing.isSymbolicLink()) await fs.unlink(fifoPath);
};

AirPlayLiveBridge.prototype._cleanRuntime = async function () {
  await this._removeFifo(this.audioFifo).catch(function () {});
  await this._removeFifo(this.commandFifo).catch(function () {});
  await fs.rmdir(this.runtimeDir).catch(function () {});
};

AirPlayLiveBridge.prototype.start = async function (receiver, options) {
  var self = this;
  options = options || {};
  if (self.child) throw new Error('An AirPlay bridge is already running');
  var volume = Number(options.volume === undefined ? 5 : options.volume);
  if (!Number.isFinite(volume) || volume < 0 || volume > self.maximumVolume) {
    throw new Error('AirPlay receiver volume must be between 0 and ' + self.maximumVolume + '%');
  }
  if (options.address) {
    var advertised = receiver.addresses && receiver.addresses.length
      ? receiver.addresses : [receiver.address];
    if (advertised.indexOf(options.address) === -1) {
      throw new Error('Address ' + options.address + ' was not advertised by ' + receiver.name);
    }
    receiver = Object.assign({}, receiver, { address: options.address });
  }
  await self._prepareRuntime();
  var descriptor;
  try {
    var sender = await self.adapter.checkSender();
    var sourceAddress = await self.adapter.getSourceAddress(receiver.address);
    var args = self.adapter.buildSenderArgs(receiver, self.commandFifo, Math.round(volume), sourceAddress);
    descriptor = await openFifoReadWrite(self.audioFifo);
    var connectedResolve;
    var audioResolve;
    var connected = new Promise(function (resolve) { connectedResolve = resolve; });
    var audioReady = new Promise(function (resolve) { audioResolve = resolve; });
    self.output = '';
    self.audioStarted = false;
    self.child = self.spawn(sender.binary, args, { stdio: [descriptor, 'pipe', 'pipe'] });
    fs.close(descriptor, function () {});
    descriptor = null;

    function inspect(chunk) {
      var text = chunk.toString('utf8');
      self.output = (self.output + text).slice(-128 * 1024);
      if (/\[STATUS\]\s+connected/i.test(text)) connectedResolve();
      if (/\[STATUS\]\s+audio\b/i.test(text)) audioResolve();
    }
    self.child.stdout.on('data', inspect);
    self.child.stderr.on('data', inspect);
    self.exitPromise = new Promise(function (resolve) {
      self.child.once('error', function (error) { resolve({ error: error }); });
      self.child.once('close', function (code, signal) {
        var outcome = code === 0 ? { code: code, signal: signal } : {
          error: new Error('cliairplay exited with code ' + code +
            (signal ? ' (' + signal + ')' : '') + (self.output.trim() ? ': ' + self.output.trim() : ''))
        };
        var unexpected = self.ready && !self.stopping;
        self.ready = false;
        resolve(outcome);
        if (unexpected) {
          Promise.resolve().then(function () { return self.onUnexpectedExit(outcome); })
            .catch(function (error) {
              self.logger.error('AirPlay exit recovery failed: ' + error.message);
            });
        }
      });
    });
    var outcome = await withTimeout(Promise.race([
      connected.then(function () { return { connected: true }; }),
      self.exitPromise
    ]), 15000, 'Timed out preparing AirPlay receiver ' + receiver.name);
    if (outcome.error) throw outcome.error;
    if (!outcome.connected) throw new Error('AirPlay sender stopped before becoming ready');
    self._setCommandWriter(await withTimeout(openFifoWriter(self.commandFifo), 3000,
      'cliairplay did not open its command pipe'));
    self.ready = true;
    audioReady.then(function () {
      if (!self.commandWriter || self.audioStarted) return;
      self.audioStarted = true;
      self._writeCommand('TITLE=Volumio playback\n');
      self._writeCommand('ARTIST=Wireless Output Manager\n');
      self._writeCommand('DURATION=0\nACTION=SENDMETA\n');
      self._writeCommand('START_UNIX_MS=0\nACTION=START\n');
    });
    return {
      receiver: receiver.name,
      address: receiver.address,
      volume: Math.round(volume),
      fifo: self.audioFifo
    };
  } catch (error) {
    if (descriptor !== undefined && descriptor !== null) fs.close(descriptor, function () {});
    await self.stop().catch(function () {});
    throw error;
  }
};

AirPlayLiveBridge.prototype.stop = async function () {
  var self = this;
  self.stopping = true;
  try {
    self.ready = false;
    if (self.commandWriter) {
      var commandWriter = self.commandWriter;
      self.commandWriter = null;
      try {
        commandWriter.write('ACTION=STOP\n');
        commandWriter.end();
      } catch (error) {
        self.logger.warn('Unable to close AirPlay command pipe cleanly: ' + error.message);
      }
    }
    if (self.child && self.child.exitCode === null && !self.child.killed) self.child.kill('SIGTERM');
    if (self.exitPromise) {
      await withTimeout(self.exitPromise, 5000, 'AirPlay sender did not stop cleanly').catch(async function () {
        if (self.child && self.child.exitCode === null) {
          self.child.kill('SIGKILL');
          await delay(100);
        }
      });
    }
    self.child = null;
    self.exitPromise = null;
    self.audioStarted = false;
    await self._cleanRuntime();
  } finally {
    self.stopping = false;
  }
};

AirPlayLiveBridge.prototype.getStatus = function () {
  return {
    running: Boolean(this.child && this.child.exitCode === null),
    ready: this.ready,
    audioStarted: this.audioStarted,
    fifo: this.audioFifo,
    output: this.output
  };
};

module.exports = AirPlayLiveBridge;
