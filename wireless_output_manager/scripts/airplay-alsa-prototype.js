#!/usr/bin/env node
'use strict';

var childProcess = require('child_process');
var fs = require('fs-extra');
var path = require('path');
var CommandRunner = require('../lib/commandRunner').CommandRunner;
var AirPlayAdapter = require('../lib/adapters/airplay');
var AirPlayPrototype = require('../lib/airplayPrototype').AirPlayPrototype;
var AirPlayLiveBridge = require('../lib/airplayLiveBridge');

function option(name, fallback) {
  var index = process.argv.indexOf(name);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

function waitForChild(child, label) {
  var errorOutput = '';
  if (child.stderr) child.stderr.on('data', function (chunk) {
    errorOutput = (errorOutput + chunk.toString('utf8')).slice(-8192);
  });
  return new Promise(function (resolve, reject) {
    child.once('error', function (error) { reject(new Error(label + ' failed to start: ' + error.message)); });
    child.once('close', function (code, signal) {
      if (code === 0) resolve();
      else reject(new Error(label + ' exited with code ' + code +
        (signal ? ' (' + signal + ')' : '') + (errorOutput.trim() ? ': ' + errorOutput.trim() : '')));
    });
  });
}

async function main() {
  var runner = new CommandRunner({ defaultTimeoutMs: 15000 });
  var adapter = new AirPlayAdapter({ runner: runner, pluginDir: path.resolve(__dirname, '..') });
  var selector = option('--device', '');
  var sourceFile = path.resolve(option('--file', ''));
  var volume = Number(option('--volume', 5));
  var seconds = Number(option('--seconds', 5));
  var seek = Number(option('--seek', 0));
  if (!selector) throw new Error('Choose a receiver with --device');
  var sourceStat = await fs.stat(sourceFile).catch(function () { return null; });
  if (!sourceStat || !sourceStat.isFile()) throw new Error('Choose a readable audio file with --file');
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 10) {
    throw new Error('The ALSA test excerpt must be between 1 and 10 seconds');
  }
  if (!Number.isFinite(seek) || seek < 0 || seek > 3600) {
    throw new Error('The ALSA test seek position must be between 0 and 3600 seconds');
  }
  var receivers = await adapter.discover();
  var helper = new AirPlayPrototype({ adapter: adapter, runner: runner });
  var receiver = helper.findReceiver(receivers, selector);
  var bridge = new AirPlayLiveBridge({
    adapter: adapter,
    runner: runner,
    spawn: childProcess.spawn,
    runtimeDir: path.join('/tmp', 'wom-airplay-alsa-prototype')
  });
  var ffmpeg;
  var aplay;
  try {
    var ready = await bridge.start(receiver, { volume: volume, address: option('--address', '') });
    console.error('AirPlay receiver prepared. Sending a bounded excerpt through the ALSA file PCM.');
    var ffmpegArgs = require('../lib/airplayPrototype').ffmpegFileArgs(sourceFile, seconds, seek);
    ffmpeg = childProcess.spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    aplay = childProcess.spawn('aplay', [
      '-q', '-D', 'file:' + ready.fifo + ',raw', '-t', 'raw',
      '-f', 'S16_LE', '-r', '44100', '-c', '2'
    ], { stdio: ['pipe', 'ignore', 'pipe'] });
    ffmpeg.stdout.pipe(aplay.stdin);
    await Promise.all([waitForChild(ffmpeg, 'FFmpeg'), waitForChild(aplay, 'aplay')]);
    await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    var status = bridge.getStatus();
    if (!status.audioStarted) throw new Error('ALSA wrote the excerpt, but the AirPlay sender did not report audio');
    console.log(JSON.stringify({
      receiver: ready.receiver,
      address: ready.address,
      volume: ready.volume,
      seconds: seconds,
      seek: seek,
      alsaDevice: 'file:' + ready.fifo + ',raw',
      audioStarted: status.audioStarted
    }, null, 2));
  } finally {
    if (ffmpeg && ffmpeg.exitCode === null) ffmpeg.kill('SIGTERM');
    if (aplay && aplay.exitCode === null) aplay.kill('SIGTERM');
    await bridge.stop();
  }
}

main().catch(function (error) {
  console.error('AirPlay ALSA prototype failed: ' + error.message);
  process.exitCode = 1;
});
