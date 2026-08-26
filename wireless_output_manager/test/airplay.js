'use strict';

var assert = require('assert');
var EventEmitter = require('events');
var fs = require('fs-extra');
var os = require('os');
var path = require('path');
var AirPlayAdapter = require('../lib/adapters/airplay');
var AirPlayLiveBridge = require('../lib/airplayLiveBridge');
var AirPlayPairingManager = require('../lib/airplayPairingManager');
var AirPlayPlaybackController = require('../lib/airplayPlaybackController');
var AirPlayPrototype = require('../lib/airplayPrototype').AirPlayPrototype;
var generateTone = require('../lib/airplayPrototype').generateTone;
var ffmpegFileArgs = require('../lib/airplayPrototype').ffmpegFileArgs;
var MdnsDiscovery = require('../lib/mdnsDiscovery').MdnsDiscovery;
var encodeName = require('../lib/mdnsDiscovery').encodeName;
var parsePacket = require('../lib/mdnsDiscovery').parsePacket;
var OutputManager = require('../lib/outputManager');

function dnsRecord(name, type, data) {
  var header = Buffer.alloc(10);
  header.writeUInt16BE(type, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt32BE(120, 4);
  header.writeUInt16BE(data.length, 8);
  return Buffer.concat([encodeName(name), header, data]);
}

function txtData(values) {
  return Buffer.concat(values.map(function (value) {
    var item = Buffer.from(value, 'utf8');
    return Buffer.concat([Buffer.from([item.length]), item]);
  }));
}

async function main() {
  var responses = {};
  var runner = {
    run: async function (command, args) {
      var key = command + ' ' + args.join(' ');
      return responses[key] || { exitCode: 0, stdout: '', stderr: '' };
    }
  };
  var adapter = new AirPlayAdapter({ runner: runner, pluginDir: '/tmp/no-airplay-binary' });
  var output = [
    '=;eth0;IPv4;Living\\032Room;_airplay._tcp;local;living.local;192.168.1.50;7000;"deviceid=AA:BB:CC:DD:EE:FF";"features=0x1";"model=Speaker1,1"',
    '=;eth0;IPv4;AABBCCDDEEFF@Living\\032Room;_raop._tcp;local;living.local;192.168.1.50;5000;"am=Speaker1,1";"cn=0,1";"et=0,4"'
  ].join('\n');
  var records = adapter.parseBrowseOutput(output);
  assert.strictEqual(records.length, 2);
  assert.strictEqual(records[0].serviceName, 'Living Room', 'Avahi decimal escapes must be decoded');
  assert.strictEqual(records[0].txt.deviceid, 'AA:BB:CC:DD:EE:FF');
  var receivers = adapter.mergeRecords(records);
  assert.strictEqual(receivers.length, 1, 'AirPlay and RAOP records for one device must merge');
  assert.deepStrictEqual(receivers[0].protocols, ['airplay2', 'raop']);
  assert.strictEqual(receivers[0].name, 'Living Room');
  assert.strictEqual(receivers[0].model, 'Speaker1,1',
    'receiver model must be retained so Apple TV pairing can be identified');
  assert.deepStrictEqual(receivers[0].addresses, ['192.168.1.50']);

  var alternateRecord = Object.assign({}, records[0], { address: '192.168.1.51' });
  var multihomed = adapter.mergeRecords(records.concat([alternateRecord]));
  assert.deepStrictEqual(multihomed[0].addresses, ['192.168.1.50', '192.168.1.51'],
    'all advertised addresses for a multi-homed receiver must be retained');

  var args = adapter.buildSenderArgs(receivers[0], '/tmp/wom-airplay-test', 5, '192.168.1.10');
  assert.strictEqual(args[args.indexOf('--protocol') + 1], 'auto');
  assert.strictEqual(args[args.indexOf('--port') + 1], '7000');
  assert.strictEqual(args[args.indexOf('--volume') + 1], '5');
  assert(args.indexOf('--txt') !== -1 && args[args.indexOf('--txt') + 1].indexOf('features=0x1') !== -1,
    'AirPlay TXT capabilities must be passed to automatic route selection');
  assert.strictEqual(args[args.indexOf('--if') + 1], '192.168.1.10',
    'the sender must bind the interface that routes to the receiver');
  assert.strictEqual(args[args.length - 1], '192.168.1.50');
  var credentials = 'ab'.repeat(96);
  var authenticatedArgs = adapter.buildSenderArgs(
    receivers[0], '/tmp/wom-airplay-test', 5, '192.168.1.10', { auth: credentials });
  assert.strictEqual(authenticatedArgs[authenticatedArgs.indexOf('--auth') + 1], credentials,
    'saved Apple TV credentials must be supplied to the sender');
  assert.throws(function () {
    adapter.buildSenderArgs(receivers[0], '/tmp/wom-airplay-test', 5, '', { auth: 'invalid' });
  }, /credentials are invalid/);
  var legacySecret = 'cd'.repeat(32);
  var legacyArgs = adapter.buildSenderArgs(
    receivers[0], '/tmp/wom-airplay-test', 5, '192.168.1.10', { secret: legacySecret });
  assert.strictEqual(legacyArgs[legacyArgs.indexOf('--secret') + 1], legacySecret,
    'legacy Apple TV pairing secrets must be supplied separately from AirPlay 2 credentials');
  assert.throws(function () {
    adapter.buildSenderArgs(receivers[0], '/tmp/wom-airplay-test', 5, '', { secret: 'invalid' });
  }, /legacy Apple TV pairing secret is invalid/);

  var readinessAttempts = 0;
  var readinessAdapter = new AirPlayAdapter({
    runner: runner,
    probeInfo: async function () {
      readinessAttempts += 1;
      return readinessAttempts === 2;
    },
    delay: async function () {}
  });
  var readiness = await readinessAdapter.prepareReceiver(receivers[0], {
    attempts: 3, timeoutMs: 1, retryDelayMs: 1, settleDelayMs: 0
  });
  assert.deepStrictEqual(readiness, { ready: true, attempts: 2 },
    'a sleeping AirPlay receiver must be probed again before routing changes');
  var unavailableAdapter = new AirPlayAdapter({
    runner: runner,
    probeInfo: async function () { return false; },
    delay: async function () {}
  });
  await assert.rejects(unavailableAdapter.prepareReceiver(receivers[0], {
    attempts: 3, timeoutMs: 1, retryDelayMs: 1, settleDelayMs: 0
  }), /did not make its AirPlay service ready after 3 attempts/,
  'an unavailable receiver must fail after bounded readiness attempts');

  var pairingArgs;
  var pairingChild = new EventEmitter();
  pairingChild.stdout = new EventEmitter();
  pairingChild.stderr = new EventEmitter();
  pairingChild.killed = false;
  pairingChild.stdin = {
    destroyed: false,
    write: function (pin) {
      assert.strictEqual(pin, '1234\n');
      setImmediate(function () {
        pairingChild.stdout.emit('data', Buffer.from('CREDENTIALS: ' + credentials + '\n'));
        pairingChild.emit('close', 0, null);
      });
      return true;
    }
  };
  pairingChild.kill = function () {
    pairingChild.killed = true;
    pairingChild.emit('close', null, 'SIGTERM');
  };
  var pairing = new AirPlayPairingManager({
    adapter: { checkSender: async function () { return { binary: '/test/cliairplay' }; } },
    spawn: function (binary, childArgs) {
      assert.strictEqual(binary, '/test/cliairplay');
      pairingArgs = childArgs;
      return pairingChild;
    },
    startSettleMs: 1,
    sessionTimeoutMs: 5000
  });
  var appleTv = Object.assign({}, receivers[0], { model: 'AppleTV5,3' });
  await pairing.start(appleTv);
  assert.deepStrictEqual(pairingArgs.slice(0, 5), [
    '--pair-setup', '--port', '7000', '--dacp', AirPlayPairingManager.DACP_ID
  ], 'Apple TV pairing must use HAP pair-setup and the persistent streaming DACP identity');
  await assert.rejects(pairing.finish(appleTv.id, '12'), /four-digit PIN/);
  assert.deepStrictEqual(await pairing.finish(appleTv.id, '1234'), {
    mode: 'hap', credentials: credentials
  },
    'valid pair-setup credentials must be returned without being logged');
  assert.strictEqual(pairing.getStatus().active, false);
  assert.match(pairing._friendlyFailure('Device error in M4: 02').message, /rejected that PIN/,
    'Apple TV wrong-PIN responses must be translated into a useful instruction');
  assert.match(pairing._friendlyFailure('HAP-ERROR: 05').message, /temporarily limiting/,
    'Apple TV pairing backoff responses must be translated into a bounded retry instruction');

  var legacyWrites = [];
  var legacyPairingChild = new EventEmitter();
  legacyPairingChild.stdout = new EventEmitter();
  legacyPairingChild.stderr = new EventEmitter();
  legacyPairingChild.killed = false;
  legacyPairingChild.stdin = {
    destroyed: false,
    write: function (value) {
      legacyWrites.push(value);
      if (legacyWrites.length === 2) {
        setImmediate(function () {
          legacyPairingChild.stdout.emit('data', Buffer.from(
            'step1 ... verifying pin\nstep2 ... verifying M1\nsuccess!\nsecret is ' + legacySecret + '\n'));
          legacyPairingChild.stderr.emit('data', Buffer.from(
            'Pairing successful!\nUDN: AABBCCDDEEFF@Living Room\nSecret: ' + legacySecret + '\n'));
          legacyPairingChild.emit('close', 0, null);
        });
      }
      return true;
    }
  };
  legacyPairingChild.kill = function () {
    legacyPairingChild.killed = true;
    legacyPairingChild.emit('close', null, 'SIGTERM');
  };
  var legacyPairingArgs;
  var legacyPairing = new AirPlayPairingManager({
    adapter: { checkSender: async function () { return { binary: '/test/cliairplay' }; } },
    spawn: function (binary, childArgs) {
      assert.strictEqual(binary, '/test/cliairplay');
      legacyPairingArgs = childArgs;
      return legacyPairingChild;
    },
    legacyStartSettleMs: 1,
    sessionTimeoutMs: 5000
  });
  var legacyAppleTv = Object.assign({}, receivers[0], { model: 'AppleTV3,2' });
  var legacyStarted = await legacyPairing.start(legacyAppleTv, { mode: 'legacy' });
  assert.deepStrictEqual(legacyPairingArgs, ['--pair'],
    'an older Apple TV must use the sender legacy RAOP pairing mode');
  assert.strictEqual(legacyStarted.mode, 'legacy');
  assert.deepStrictEqual(legacyWrites, ['192.168.1.50\n'],
    'legacy pairing must target the selected receiver address before requesting its PIN');
  assert.deepStrictEqual(await legacyPairing.finish(legacyAppleTv.id, '1234'), {
    mode: 'legacy', credentials: legacySecret
  }, 'legacy pairing must return only the bounded RAOP secret');
  assert.deepStrictEqual(legacyWrites, ['192.168.1.50\n', '1234\n']);

  var instance = 'Living Room._airplay._tcp.local';
  var target = 'living.local';
  var srvData = Buffer.concat([Buffer.alloc(4), Buffer.from([0x1b, 0x58]), encodeName(target)]);
  var addressData = Buffer.from([192, 168, 1, 50]);
  var responseHeader = Buffer.alloc(12);
  responseHeader.writeUInt16BE(0x8400, 2);
  responseHeader.writeUInt16BE(4, 6);
  var packet = Buffer.concat([
    responseHeader,
    dnsRecord('_airplay._tcp.local', 12, encodeName(instance)),
    dnsRecord(instance, 33, srvData),
    dnsRecord(instance, 16, txtData(['deviceid=AA:BB:CC:DD:EE:FF', 'features=0x1'])),
    dnsRecord(target, 1, addressData)
  ]);
  var parsedPacket = parsePacket(packet);
  assert.strictEqual(parsedPacket.length, 4, 'built-in mDNS must parse PTR, SRV, TXT and A records');
  var mdns = new MdnsDiscovery();
  var nativeServices = mdns._recordsToServices(parsedPacket, ['_airplay._tcp']);
  assert.strictEqual(nativeServices.length, 1);
  assert.strictEqual(nativeServices[0].serviceName, 'Living Room');
  assert.strictEqual(nativeServices[0].address, '192.168.1.50');
  assert.strictEqual(nativeServices[0].port, 7000);

  var prototype = new AirPlayPrototype({ adapter: adapter, runner: runner });
  assert.strictEqual(prototype.findReceiver(receivers, 'living room').id, 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(prototype.findReceiver(receivers, 'AA:BB').name, 'Living Room');
  assert.throws(function () { prototype.findReceiver(receivers, 'Kitchen'); }, /not found/);
  assert.strictEqual(prototype.selectReceiverAddress(multihomed[0], '192.168.1.51').address,
    '192.168.1.51');
  assert.throws(function () {
    prototype.selectReceiverAddress(multihomed[0], '192.168.1.99');
  }, /was not advertised/);

  var tone = generateTone({ seconds: 2, frequency: 440, amplitude: 0.01 });
  assert.strictEqual(tone.pcm.length, 44100 * 2 * 4, 'tone must be 44.1 kHz, 16-bit stereo');
  var maximum = 0;
  for (var offset = 0; offset < tone.pcm.length; offset += 2) {
    maximum = Math.max(maximum, Math.abs(tone.pcm.readInt16LE(offset)));
  }
  assert(maximum <= Math.ceil(32767 * 0.01), 'test tone amplitude must remain bounded');

  var decodeArgs = ffmpegFileArgs('/music/test.flac', 5, 60);
  assert.strictEqual(decodeArgs[decodeArgs.indexOf('-i') + 1], '/music/test.flac');
  assert.strictEqual(decodeArgs[decodeArgs.indexOf('-t') + 1], '5');
  assert.strictEqual(decodeArgs[decodeArgs.indexOf('-ss') + 1], '60');
  assert.strictEqual(decodeArgs[decodeArgs.indexOf('-f') + 1], 's16le');
  assert.strictEqual(decodeArgs[decodeArgs.indexOf('-ar') + 1], '44100');
  assert.strictEqual(decodeArgs[decodeArgs.indexOf('-ac') + 1], '2');

  await assert.rejects(prototype.playTestTone(receivers[0], { volume: 16 }), /between 0 and 15%/,
    'the prototype must reject unsafe receiver volume before starting a process');
  await assert.rejects(prototype.playTestTone(receivers[0], { amplitude: 0.11 }),
    /amplitude must be between 0.001 and 0.1/,
    'the prototype must reject unsafe test-signal amplitude before starting a process');

  responses['avahi-browse -rtp _airplay._tcp'] = { exitCode: 0, stdout: output.split('\n')[0], stderr: '' };
  responses['avahi-browse -rtp _raop._tcp'] = { exitCode: 0, stdout: output.split('\n')[1], stderr: '' };
  receivers = await adapter.discover();
  assert.strictEqual(receivers.length, 1, 'discovery must combine both service types');

  responses['which avahi-browse'] = { exitCode: 1, stdout: '', stderr: '' };
  var fallbackAdapter = new AirPlayAdapter({
    runner: runner,
    pluginDir: '/tmp/no-airplay-binary',
    mdns: { discover: async function () { return nativeServices; } }
  });
  receivers = await fallbackAdapter.discover();
  assert.strictEqual(receivers.length, 1, 'built-in mDNS must be used when avahi-browse is absent');
  assert.strictEqual(receivers[0].name, 'Living Room');

  var temporaryPlugin = await fs.mkdtemp(path.join(os.tmpdir(), 'wom-output-manager-'));
  var advertisedPcms = 'womAirPlay\nwomBluetooth\n';
  var rebuilds = 0;
  var outputRunner = {
    run: async function (command, commandArgs) {
      if (command === 'which') {
        return { exitCode: commandArgs[0] === 'bluealsa' ? 0 : 1, stdout: '', stderr: '' };
      }
      if (command === 'aplay') {
        return { exitCode: 0, stdout: advertisedPcms, stderr: '' };
      }
      throw new Error('Unexpected command in output-manager test: ' + command);
    }
  };
  var outputManager = new OutputManager({
    pluginDir: temporaryPlugin,
    runner: outputRunner,
    commandRouter: {
      executeOnPlugin: function () { rebuilds += 1; return Promise.resolve(); }
    }
  });
  try {
    await outputManager.createAirPlayOutput('/tmp/wom-airplay-test/audio.pcm');
    var airplayContribution = path.join(temporaryPlugin, 'asound',
      'womAirPlay.womAirPlayOut.-1.conf');
    var bluetoothContribution = path.join(temporaryPlugin, 'asound',
      'womBluetooth.womBluetoothOut.-1.conf');
    assert(await fs.pathExists(airplayContribution), 'AirPlay must use an AirPlay-named contribution');
    assert(!(await fs.pathExists(bluetoothContribution)), 'AirPlay must not leave Bluetooth routing active');
    var airplayConfig = await fs.readFile(airplayContribution, 'utf8');
    assert(airplayConfig.indexOf('format S16_LE') !== -1 &&
      airplayConfig.indexOf('rate 44100') !== -1 && airplayConfig.indexOf('channels 2') !== -1,
    'the AirPlay bridge must normalise Volumio audio to its fixed PCM format');
    var routeStatus = await outputManager.getStatus();
    assert.strictEqual(routeStatus.backend, 'airplay');

    await outputManager.createOutput('AA:BB:CC:DD:EE:FF');
    assert(await fs.pathExists(bluetoothContribution), 'Bluetooth routing must remain supported');
    assert(!(await fs.pathExists(airplayContribution)), 'switching to Bluetooth must remove AirPlay routing');

    advertisedPcms = 'womBluetooth\n';
    await assert.rejects(outputManager.createAirPlayOutput('/tmp/wom-airplay-test/audio.pcm'),
      /did not expose womAirPlay/, 'failed AirPlay validation must be reported');
    assert(await fs.pathExists(bluetoothContribution), 'failed AirPlay setup must restore Bluetooth routing');
    assert(!(await fs.pathExists(airplayContribution)), 'failed AirPlay setup must remove its partial route');

    await outputManager.removeOutput();
    assert(!(await fs.pathExists(bluetoothContribution)) && !(await fs.pathExists(airplayContribution)),
      'returning to the default output must remove every owned wireless contribution');
    assert(rebuilds >= 5, 'each route change and rollback must rebuild Volumio ALSA configuration');
    await assert.rejects(outputManager.createAirPlayOutput('relative/audio.pcm'), /safe absolute/);
  } finally {
    await fs.remove(temporaryPlugin);
  }

  var unsafeRuntime = await fs.mkdtemp(path.join(os.tmpdir(), 'wom-live-bridge-'));
  var regularPath = path.join(unsafeRuntime, 'audio.pcm');
  await fs.writeFile(regularPath, 'do not replace');
  var bridge = new AirPlayLiveBridge({
    runtimeDir: unsafeRuntime,
    runner: { run: async function () { throw new Error('mkfifo must not run'); } }
  });
  try {
    await assert.rejects(bridge._replaceFifo(regularPath), /Refusing to replace non-FIFO/,
      'the bridge must never replace an unexpected runtime file');
  } finally {
    await fs.remove(unsafeRuntime);
  }

  var permissionRuntime = await fs.mkdtemp(path.join(os.tmpdir(), 'wom-live-permissions-'));
  var permissionCalls = [];
  var permissionBridge = new AirPlayLiveBridge({
    runtimeDir: permissionRuntime,
    runner: {
      run: async function (command, commandArgs) {
        permissionCalls.push([command].concat(commandArgs).join(' '));
        return { exitCode: 0, stdout: '', stderr: '' };
      }
    }
  });
  try {
    await permissionBridge._prepareRuntime();
    assert(permissionCalls.indexOf('chgrp audio ' + permissionRuntime) !== -1,
      'the AirPlay runtime directory must be traversable by Volumio audio processes');
    assert(permissionCalls.indexOf('mkfifo -m 660 ' + permissionBridge.audioFifo) !== -1 &&
      permissionCalls.indexOf('chgrp audio ' + permissionBridge.audioFifo) !== -1,
    'the PCM pipe must be writable by MPD through the audio group');
    assert(permissionCalls.indexOf('mkfifo -m 600 ' + permissionBridge.commandFifo) !== -1,
      'the AirPlay command pipe must remain private to the plugin');
  } finally {
    await fs.remove(permissionRuntime);
  }

  var warnings = [];
  var brokenPipeBridge = new AirPlayLiveBridge({
    logger: {
      info: function () {},
      warn: function (message) { warnings.push(message); },
      error: function () {}
    }
  });
  var brokenWriter = new EventEmitter();
  brokenWriter.destroyed = false;
  brokenWriter.write = function () { return true; };
  brokenPipeBridge._setCommandWriter(brokenWriter);
  var pipeError = new Error('broken pipe');
  pipeError.code = 'EPIPE';
  brokenWriter.emit('error', pipeError);
  assert.strictEqual(brokenPipeBridge.commandWriter, null,
    'a broken AirPlay command pipe must be detached without terminating Volumio');
  assert(warnings.some(function (message) { return message.indexOf('broken pipe') !== -1; }),
    'a broken AirPlay command pipe must leave a concise diagnostic warning');

  var lossBridge = new AirPlayLiveBridge();
  lossBridge.session = {
    receiver: 'Test receiver', id: 'AA:BB', address: '192.168.1.50', sourceAddress: '192.168.1.10'
  };
  lossBridge._consumeStatus('stderr', Buffer.from(
    '[AP2] retransmit: 1536 requested, 1536 resent, 0 already retired\n' +
    '[AP2] RTSP channel failed during POST /feedback read after 0ms: Connection reset by peer; terminating native session\n' +
    '[ERROR] AirPlay 2 control channel failed\n'));
  var lossDiagnostic = lossBridge._recordUnexpectedFailure({ error: new Error('cliairplay exited with code 1') });
  assert.strictEqual(lossDiagnostic.kind, 'receiver-control-reset');
  assert.strictEqual(lossDiagnostic.retransmitRequested, 1536);
  assert.strictEqual(lossDiagnostic.retransmitResent, 1536);
  assert.strictEqual(lossDiagnostic.receiver, 'Test receiver');
  assert(/Connection reset by peer/.test(lossDiagnostic.controlFailure),
    'receiver loss diagnostics must retain the concise control-channel cause');
  assert.strictEqual(lossBridge.getStatus().lastFailure, lossDiagnostic,
    'the most recent sender failure must remain available to exported diagnostics');

  var commandWrites = [];
  var transitionBridge = new AirPlayLiveBridge();
  transitionBridge.ready = true;
  transitionBridge.commandWriter = {
    destroyed: false,
    write: function (command) { commandWrites.push(command); return true; }
  };
  var transition = transitionBridge.transition({
    title: 'Next\nTrack', artist: 'Artist', album: 'Album', duration: 180.4
  });
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.deepStrictEqual(commandWrites, ['ACTION=FLUSH\n'],
    'a track transition must clear stale receiver audio before starting new audio');
  transitionBridge._consumeStatus('stderr', Buffer.from('[STATUS] audio buffered_ms=500\n'));
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert.deepStrictEqual(commandWrites, ['ACTION=FLUSH\n'],
    'buffered audio reported before flush completes must not start the new position');
  transitionBridge._consumeStatus('stderr', Buffer.from('[STATUS] flu'));
  transitionBridge._consumeStatus('stderr', Buffer.from('shed\n[STATUS] audio buffered_ms=92\n'));
  await new Promise(function (resolve) { setImmediate(resolve); });
  assert(commandWrites[1].indexOf('TITLE=Next Track\n') === 0 &&
    commandWrites[1].indexOf('DURATION=180\nACTION=SENDMETA\n') !== -1,
  'a track transition must send sanitised metadata after the fresh audio is buffered');
  assert.strictEqual(commandWrites[2], 'START_UNIX_MS=0\nACTION=START\n');
  transitionBridge._consumeStatus('stdout', Buffer.from('[STATUS] started requested_unix_ms=0\n'));
  await transition;
  await transitionBridge.updateMetadata({ title: 'Metadata only', artist: 'Artist' });
  await transitionBridge.pause();
  await transitionBridge.resume();
  await transitionBridge.releasePause();
  await transitionBridge.setVolume(12);
  assert(commandWrites[3].indexOf('TITLE=Metadata only\n') === 0 &&
    commandWrites[3].indexOf('ACTION=SENDMETA\n') !== -1,
  'a metadata-only track change must not flush or restart the AirPlay stream');
  assert.deepStrictEqual(commandWrites.slice(-4), [
    'ACTION=PAUSE\n', 'ACTION=PLAY\n', 'ACTION=PLAY\n', 'VOLUME=12\n'
  ], 'pause, resume and paused-track hand-off must control the live sender safely');
  assert.throws(function () { transitionBridge.setVolume(101); }, /between 0 and 15%/,
    'live AirPlay volume must remain bounded');
  var now = 1000;
  var stateActions = [];
  var playbackController = new AirPlayPlaybackController({
    bridge: {
      transition: async function (meta) { stateActions.push('transition:' + meta.title); },
      updateMetadata: async function (meta) { stateActions.push('metadata:' + meta.title); },
      pause: async function () { stateActions.push('pause'); },
      resume: async function () { stateActions.push('resume'); },
      releasePause: async function () { stateActions.push('release-pause'); },
      getStatus: function () { return { audioStarted: true }; }
    },
    isActive: function () { return true; },
    now: function () { return now; }
  });
  await playbackController.handle({ status: 'play', uri: 'one.flac', seek: 1000, title: 'One' });
  now += 1000;
  await playbackController.handle({ status: 'play', uri: 'one.flac', seek: 2000, title: 'One' });
  now += 100;
  await playbackController.handle({
    status: 'play', uri: 'mnt/one.flac', seek: 2100, title: 'One', artist: 'Refined artist'
  });
  await playbackController.handle({
    status: 'play', uri: 'music-library/one.flac', seek: 2100, title: 'One', artist: 'Refined artist'
  });
  await playbackController.handle({ status: 'pause', uri: 'one.flac', seek: 2000, title: 'One' });
  await playbackController.handle({ status: 'play', uri: 'one.flac', seek: 2000, title: 'One' });
  now += 100;
  await playbackController.handle({ status: 'play', uri: 'two.flac', seek: 0, title: 'Two' });
  now += 100;
  await playbackController.handle({ status: 'play', uri: 'two.flac', seek: 30000, title: 'Two' });
  await playbackController.handle({ status: 'stop', uri: 'two.flac', seek: 30000, title: 'Two' });
  await playbackController.handle({ status: 'play', uri: 'three.flac', seek: 0, title: 'Three' });
  await playbackController.handle({ status: 'pause', uri: 'three.flac', seek: 1000, title: 'Three' });
  await playbackController.handle({ status: 'stop', uri: 'three.flac', seek: 1000, title: 'Three' });
  await playbackController.handle({ status: 'play', uri: 'four.flac', seek: 0, title: 'Four' });
  assert.deepStrictEqual(stateActions, [
    'pause', 'resume', 'metadata:Two', 'transition:Two', 'metadata:Three',
    'pause', 'release-pause', 'transition:Four'
  ], 'natural track changes must remain continuous while paused track replacement is re-anchored');

  console.log('AirPlay prototype tests passed');
}

main().catch(function (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
