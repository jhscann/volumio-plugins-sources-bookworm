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
  var amplitude = Math.max(0.001, Math.min(0.1, Number(options.amplitude) || 0.01));
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

function ffmpegFileArgs(filePath, seconds, seek) {
  var args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (seek > 0) args.push('-ss', String(seek));
  return args.concat([
    '-i', filePath,
    '-t', String(seconds),
    '-vn', '-sn', '-dn',
    '-f', 's16le', '-acodec', 'pcm_s16le',
    '-ar', '44100', '-ac', '2', 'pipe:1'
  ]);
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

AirPlayPrototype.prototype._decodeAudioFile = function (filePath, seconds, seek) {
  var self = this;
  return new Promise(function (resolve, reject) {
    var child = self.spawn('ffmpeg', ffmpegFileArgs(filePath, seconds, seek), {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    var chunks = [];
    var size = 0;
    var errorOutput = '';
    var settled = false;
    var maximumBytes = Math.ceil(seconds * 44100 * 4) + 4096;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      reject(new Error('FFmpeg timed out while decoding the AirPlay test excerpt'));
    }, 30000);
    child.stdout.on('data', function (chunk) {
      if (settled) return;
      size += chunk.length;
      if (size > maximumBytes) {
        settled = true;
        clearTimeout(timer);
        child.kill('SIGTERM');
        reject(new Error('FFmpeg produced more audio than the bounded test allows'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', function (chunk) {
      errorOutput = (errorOutput + chunk.toString('utf8')).slice(-8192);
    });
    child.once('error', function (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Could not start FFmpeg: ' + error.message));
    });
    child.once('close', function (code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error('FFmpeg could not decode the selected file' +
          (errorOutput.trim() ? ': ' + errorOutput.trim() : '')));
        return;
      }
      var pcm = Buffer.concat(chunks);
      if (!pcm.length) {
        reject(new Error('FFmpeg decoded no audio from the selected file'));
        return;
      }
      resolve({ pcm: pcm, seconds: pcm.length / (44100 * 4), sampleRate: 44100 });
    });
  });
};

AirPlayPrototype.prototype._playPcm = async function (receiver, audio, options) {
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
  var child;
  var commandWriter;
  var output = '';
  var connectedResolve;
  var audioReadyResolve;
  var startedResolve;
  var connected = new Promise(function (resolve) { connectedResolve = resolve; });
  var audioReady = new Promise(function (resolve) { audioReadyResolve = resolve; });
  var started = new Promise(function (resolve) { startedResolve = resolve; });

  function inspect(chunk) {
    var text = chunk.toString('utf8');
    output = (output + text).slice(-64 * 1024);
    if (/\[STATUS\]\s+connected/i.test(text)) connectedResolve();
    if (/\[STATUS\]\s+audio\b/i.test(text)) audioReadyResolve();
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
    commandWriter.write('TITLE=' + (options.title || 'Wireless Output Manager test') + '\n');
    commandWriter.write('ARTIST=' + (options.artist || 'Volumio prototype') + '\n');
    commandWriter.write('DURATION=' + Math.ceil(audio.seconds) + '\n');
    commandWriter.write('ACTION=SENDMETA\n');
    if (!child.stdin.write(audio.pcm)) {
      await new Promise(function (resolve) { child.stdin.once('drain', resolve); });
    }
    await waitFor(audioReady, 5000, 'The sender connected but did not accept test audio');
    commandWriter.write('START_UNIX_MS=0\nACTION=START\n');
    await waitFor(started, 10000, 'The receiver did not acknowledge the test start');
    await delay(audio.seconds * 1000 + 1000);
    commandWriter.write('ACTION=STOP\n');
    child.stdin.end();
    var stopped = await withTimeout(exit, 5000, 'The sender did not stop cleanly');
    if (stopped.error) throw stopped.error;
    return {
      receiver: receiver.name,
      id: receiver.id,
      address: receiver.address,
      volume: Math.round(volume),
      seconds: audio.seconds,
      output: output.trim()
    };
  } finally {
    if (commandWriter) commandWriter.end();
    if (child && child.exitCode === null && !child.killed) child.kill('SIGTERM');
    await fs.remove(temporaryDirectory);
  }
};

AirPlayPrototype.prototype.playTestTone = async function (receiver, options) {
  options = options || {};
  var amplitude = Number(options.amplitude === undefined ? 0.01 : options.amplitude);
  if (!Number.isFinite(amplitude) || amplitude < 0.001 || amplitude > 0.1) {
    throw new Error('Prototype test-signal amplitude must be between 0.001 and 0.1');
  }
  var tone = generateTone(Object.assign({}, options, { amplitude: amplitude }));
  var result = await this._playPcm(receiver, tone, options);
  result.amplitude = tone.amplitude;
  return result;
};

AirPlayPrototype.prototype.playAudioFile = async function (receiver, filePath, options) {
  options = options || {};
  var seconds = Number(options.seconds === undefined ? 5 : options.seconds);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) {
    throw new Error('Prototype file excerpt must be between 1 and 10 seconds');
  }
  var seek = Number(options.seek === undefined ? 0 : options.seek);
  if (!Number.isFinite(seek) || seek < 0 || seek > 3600) {
    throw new Error('Prototype file start position must be between 0 and 3600 seconds');
  }
  var resolvedPath = path.resolve(String(filePath || ''));
  var details;
  try {
    details = await fs.stat(resolvedPath);
  } catch (error) {
    throw new Error('Selected audio file was not found: ' + resolvedPath);
  }
  if (!details.isFile()) throw new Error('Selected audio source is not a regular file');
  var audio = await this._decodeAudioFile(resolvedPath, seconds, seek);
  return this._playPcm(receiver, audio, Object.assign({}, options, {
    title: path.basename(resolvedPath),
    artist: 'Volumio AirPlay file test'
  }));
};

module.exports = {
  AirPlayPrototype: AirPlayPrototype,
  ffmpegFileArgs: ffmpegFileArgs,
  generateTone: generateTone
};
