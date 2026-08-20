'use strict';

var assert = require('assert');
var fs = require('fs-extra');
var os = require('os');
var path = require('path');
var AirPlayAdapter = require('../lib/adapters/airplay');
var AirPlayLiveBridge = require('../lib/airplayLiveBridge');
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

  console.log('AirPlay prototype tests passed');
}

main().catch(function (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
