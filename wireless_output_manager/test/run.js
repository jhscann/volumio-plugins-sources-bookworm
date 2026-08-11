'use strict';

var assert = require('assert');
var BluetoothAdapter = require('../lib/adapters/bluetooth');
var CommandRunner = require('../lib/commandRunner').CommandRunner;
var WirelessOutputManager = require('../index');

async function main() {
  var adapter = new BluetoothAdapter({
    runner: { run: function () { return Promise.resolve({ stdout: '' }); } },
    logger: { info: function () {}, warn: function () {}, error: function () {} }
  });
  assert.deepStrictEqual(adapter._parseDeviceLines('Device AA:BB:CC:DD:EE:FF Living Room\nnoise'), [
    { id: 'AA:BB:CC:DD:EE:FF', name: 'Living Room' }
  ]);
  assert.throws(function () { adapter._mac('not-a-mac'); }, /valid Bluetooth device/);

  var runner = new CommandRunner({ defaultTimeoutMs: 1000 });
  var ok = await runner.run(process.execPath, ['-e', 'process.stdout.write("ok")']);
  assert.strictEqual(ok.stdout, 'ok');
  var rejected = false;
  try { await runner.run(process.execPath, ['-e', 'setTimeout(function(){}, 5000)'], { timeoutMs: 20 }); }
  catch (error) { rejected = error.result && error.result.timedOut; }
  assert.strictEqual(rejected, true, 'command runner must reject timed-out commands');

  var stopCalls = 0;
  var plugin = new WirelessOutputManager({
    coreCommand: { volumioStop: function () { stopCalls += 1; } },
    logger: {},
    configManager: {}
  });
  var started = Date.now();
  await plugin._stopPlaybackForRouting();
  assert.strictEqual(stopCalls, 1, 'manual route switch must stop playback');
  assert(Date.now() - started >= 900, 'manual route switch must allow MPD to release the PCM');
  console.log('All tests passed');
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
