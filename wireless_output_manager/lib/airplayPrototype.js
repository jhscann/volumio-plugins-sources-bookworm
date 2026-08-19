'use strict';

var childProcess = require('child_process');
var fs = require('fs-extra');
var os = require('os');
var path = require('path');

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

function generateTone(options) {
  options = options || {};
  var sampleRate = 44100;
  var seconds = Math.max(1, Math.min(10, Number(options.seconds) || 3));
  var frequency = Math.max(100, Math.min(2000, Number(options.frequency) || 440));
  var amplitude = Math.max(0.001, Math.min(0.03, Number(options.amplitude) || 0.01));
  var frames = Math.floor(sampleRate * seconds);
  var output = Buffer.alloc(frames * 4);
  for (var frame = 0; frame < frames; frame += 1) {
    var ramp = Math.min(1, frame / 2205, (frames - frame - 1) / 2205);
    var sample = Math.round(Math.sin(2 * Math.PI * frequency * frame / sampleRate) *
      amplitude * ramp * 32767);
    output.writeInt16LE(sample, frame * 4);
    output.writeInt16LE(sample, frame * 4 + 2);
  }
  return { pcm: output, seconds: seconds, sampleRate: sampleRate, amplitude: amplitude };
}

function AirPlayPrototype(options) {
  options = options || {};
  this.adapter = options.adapter;
  this.runner = options.runner;
  this.logger = options.logger || { info: function () {}, warn: function () {}, error: function () {} };
  this.spawn = options.spawn || childProcess.spawn;
}

AirPlayPrototype.prototype.findReceiver = function (receivers, selector) {
  var wanted = String(selector || '').trim().toLowerCase();
  if (!wanted) throw new Error('Choose a receiver by its name or id');
  var exact = receivers.filter(function (receiver) {
    return receiver.id.toLowerCase() === wanted || receiver.name.toLowerCase() === wanted;
  });
  if (exact.length === 1) return exact[0];
  var partial = receivers.filter(function (receiver) {
    return receiver.id.toLowerCase().indexOf(wanted) !== -1 ||
      receiver.name.toLowerCase().indexOf(wanted) !== -1;
  });
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error('Receiver name is ambiguous; use its full id');
  throw new Error('AirPlay receiver not found: ' + selector);
};

AirPlayPrototype.prototype.selectReceiverAddress = function (receiver, requestedAddress) {
  var requested = String(requestedAddress || '').trim();
  if (!requested) return receiver;
  var advertised = receiver.addresses && receiver.addresses.length
    ? receiver.addresses : [receiver.address];
  if (advertised.indexOf(requested) === -1) {
    throw new Error('Address ' + requested + ' was not advertised by ' + receiver.name);
  }
  return Object.assign({}, receiver, { address: requested });
};

AirPlayPrototype.prototype._openCommandPipe = function (pipePath) {
  return new Promise(function (resolve, reject) {
    fs.open(pipePath, 'w', function (error, descriptor) {
      if (error) reject(error);
      else resolve(fs.createWriteStream(null, { fd: descriptor, autoClose: true }));
    });
  });
};

AirPlayPrototype.prototype.playTestTone = async function (receiver, options) {
  var self = this;
  options = options || {};
  receiver = self.selectReceiverAddress(receiver, options.address);
  var volume = Number(options.volume === undefined ? 5 : options.volume);
  if (!Number.isFinite(volume) || volume < 0 || volume > 15) {
    throw new Error('Prototype receiver volume must be between 0 and 15%');
  }
  var sender = await self.adapter.checkSender();
  var temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'wom-airplay-'));
  var commandPipe = path.join(temporaryDirectory, 'commands');
  await self.runner.run('mkfifo', [commandPipe], { timeoutMs: 3000 });
  var sourceAddress = await self.adapter.getSourceAddress(receiver.address);
  var args = self.adapter.buildSenderArgs(receiver, commandPipe, Math.round(volume), sourceAddress);
  var tone = generateTone(options);
  var child;
  var commandWriter;
  var output = '';
  var connectedResolve;
  var audioResolve;
  var startedResolve;
  var connected = new Promise(function (resolve) { connectedResolve = resolve; });
  var audio = new Promise(function (resolve) { audioResolve = resolve; });
  var started = new Promise(function (resolve) { startedResolve = resolve; });

  function inspect(chunk) {
    var text = chunk.toString('utf8');
    output = (output + text).slice(-64 * 1024);
    if (/\[STATUS\]\s+connected/i.test(text)) connectedResolve();
    if (/\[STATUS\]\s+audio\b/i.test(text)) audioResolve();
    if (/\[STATUS\]\s+started\b/i.test(text)) startedResolve();
  }

  try {
    child = self.spawn(sender.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    var exit = new Promise(function (resolve) {
      child.once('error', function (error) { resolve({ error: error }); });
      child.once('close', function (code, signal) {
        if (code === 0) resolve({ code: code, signal: signal });
        else resolve({ error: new Error('cliairplay exited with code ' + code +
          (signal ? ' (' + signal + ')' : '') + (output.trim() ? ': ' + output.trim() : '')) });
      });
    });
    async function waitFor(signal, milliseconds, message) {
      var outcome = await withTimeout(Promise.race([
        signal.then(function () { return { signalled: true }; }),
        exit
      ]), milliseconds, message);
      if (outcome.error) throw outcome.error;
      if (!outcome.signalled) throw new Error(message);
    }
    await waitFor(connected, 15000, 'Timed out connecting to ' + receiver.name);
    commandWriter = await withTimeout(self._openCommandPipe(commandPipe), 3000,
      'cliairplay did not open its command pipe');
    commandWriter.write('TITLE=Wireless Output Manager test\n');
    commandWriter.write('ARTIST=Volumio prototype\n');
    commandWriter.write('DURATION=' + tone.seconds + '\n');
    commandWriter.write('ACTION=SENDMETA\n');
    if (!child.stdin.write(tone.pcm)) {
      await new Promise(function (resolve) { child.stdin.once('drain', resolve); });
    }
    await waitFor(audio, 5000, 'The sender connected but did not accept test audio');
    commandWriter.write('START_UNIX_MS=0\nACTION=START\n');
    await waitFor(started, 10000, 'The receiver did not acknowledge the test start');
    await delay(tone.seconds * 1000 + 1000);
    commandWriter.write('ACTION=STOP\n');
    child.stdin.end();
    var stopped = await withTimeout(exit, 5000, 'The sender did not stop cleanly');
    if (stopped.error) throw stopped.error;
    return {
      receiver: receiver.name,
      id: receiver.id,
      address: receiver.address,
      volume: Math.round(volume),
      seconds: tone.seconds,
      output: output.trim()
    };
  } finally {
    if (commandWriter) commandWriter.end();
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
    await fs.remove(temporaryDirectory);
  }
};

module.exports = { AirPlayPrototype: AirPlayPrototype, generateTone: generateTone };
