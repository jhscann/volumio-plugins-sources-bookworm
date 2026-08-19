'use strict';

var assert = require('assert');
var AirPlayAdapter = require('../lib/adapters/airplay');
var AirPlayPrototype = require('../lib/airplayPrototype').AirPlayPrototype;
var generateTone = require('../lib/airplayPrototype').generateTone;

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

  var args = adapter.buildSenderArgs(receivers[0], '/tmp/wom-airplay-test', 5, '192.168.1.10');
  assert.strictEqual(args[args.indexOf('--protocol') + 1], 'auto');
  assert.strictEqual(args[args.indexOf('--port') + 1], '7000');
  assert.strictEqual(args[args.indexOf('--volume') + 1], '5');
  assert(args.indexOf('--txt') !== -1 && args[args.indexOf('--txt') + 1].indexOf('features=0x1') !== -1,
    'AirPlay TXT capabilities must be passed to automatic route selection');
  assert.strictEqual(args[args.indexOf('--if') + 1], '192.168.1.10',
    'the sender must bind the interface that routes to the receiver');
  assert.strictEqual(args[args.length - 1], '192.168.1.50');

  var prototype = new AirPlayPrototype({ adapter: adapter, runner: runner });
  assert.strictEqual(prototype.findReceiver(receivers, 'living room').id, 'AA:BB:CC:DD:EE:FF');
  assert.strictEqual(prototype.findReceiver(receivers, 'AA:BB').name, 'Living Room');
  assert.throws(function () { prototype.findReceiver(receivers, 'Kitchen'); }, /not found/);

  var tone = generateTone({ seconds: 2, frequency: 440, amplitude: 0.01 });
  assert.strictEqual(tone.pcm.length, 44100 * 2 * 4, 'tone must be 44.1 kHz, 16-bit stereo');
  var maximum = 0;
  for (var offset = 0; offset < tone.pcm.length; offset += 2) {
    maximum = Math.max(maximum, Math.abs(tone.pcm.readInt16LE(offset)));
  }
  assert(maximum <= Math.ceil(32767 * 0.01), 'test tone amplitude must remain bounded');

  await assert.rejects(prototype.playTestTone(receivers[0], { volume: 16 }), /between 0 and 15%/,
    'the prototype must reject unsafe receiver volume before starting a process');

  responses['avahi-browse -rtp _airplay._tcp'] = { exitCode: 0, stdout: output.split('\n')[0], stderr: '' };
  responses['avahi-browse -rtp _raop._tcp'] = { exitCode: 0, stdout: output.split('\n')[1], stderr: '' };
  receivers = await adapter.discover();
  assert.strictEqual(receivers.length, 1, 'discovery must combine both service types');

  console.log('AirPlay prototype tests passed');
}

main().catch(function (error) {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
