'use strict';

var assert = require('assert');
var BluetoothAdapter = require('../lib/adapters/bluetooth');
var CommandRunner = require('../lib/commandRunner').CommandRunner;
var WirelessOutputManager = require('../index');

async function main() {
  var uiConfig = require('../UIConfig.json');
  var uiIds = uiConfig.sections.reduce(function (ids, section) {
    return ids.concat(section.content.map(function (item) { return item.id; }));
  }, []);
  assert(uiIds.indexOf('scanDevices') !== -1 && uiIds.indexOf('preferredDevice') !== -1, 'onboarding must expose discovery and speaker selection');
  assert(uiIds.indexOf('pairDevice') === -1 && uiIds.indexOf('trustDevice') === -1, 'low-level pairing controls must stay out of the main UI');
  assert(uiIds.indexOf('createOutput') !== -1 && uiIds.indexOf('removeOutput') !== -1, 'manual audio destination controls must remain available');
  assert(uiIds.indexOf('resetSpeakerSetup') !== -1, 'safe plugin-only reset must remain available');

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

  plugin.log = { info: function () {} };
  plugin.outputManager = { getStatus: function () { return Promise.resolve({ configured: false }); } };
  plugin.config = { get: function () { return false; }, set: function () {} };
  var startPromise = plugin.onStart();
  assert.strictEqual(typeof startPromise.fail, 'function', 'onStart must return a Volumio-compatible Kew promise');
  await startPromise;

  var saved = {};
  plugin.devices = [{ id: 'C4:30:18:EA:9D:EC', name: 'JBL PartyBox 100' }];
  plugin.config = {
    set: function (key, value) { saved[key] = value; }
  };
  plugin._toast = function () {};
  await plugin.savePreferredDevice({ preferredDevice: [{ value: 'c4:30:18:ea:9d:ec', label: 'JBL PartyBox 100 (audio)' }] });
  assert.strictEqual(saved.preferredDeviceMac, 'C4:30:18:EA:9D:EC', 'preferred-device arrays must save a plain normalized MAC');
  assert.strictEqual(saved.preferredDeviceName, 'JBL PartyBox 100');

  var onboardingCalls = [];
  var onboardingSaved = {};
  plugin.btLog = { info: function () {}, error: function () {} };
  plugin.config = {
    get: function (key) { return key === 'autoReconnect' ? false : onboardingSaved[key]; },
    set: function (key, value) { onboardingSaved[key] = value; }
  };
  plugin.bluetooth = {
    powerOn: async function () { onboardingCalls.push('power'); },
    pair: async function () { onboardingCalls.push('pair'); },
    trust: async function () { onboardingCalls.push('trust'); },
    connect: async function () { onboardingCalls.push('connect'); },
    getDeviceInfo: async function () {
      return { id: 'C4:30:18:EA:9D:EC', name: 'JBL PartyBox 100', connected: onboardingCalls.indexOf('connect') !== -1 };
    }
  };
  plugin.refreshUI = function () { onboardingCalls.push('refresh'); return Promise.resolve(); };
  await plugin.pairAndConnectDevice({ preferredDevice: [{ value: 'C4:30:18:EA:9D:EC', label: 'JBL PartyBox 100' }] });
  assert.deepStrictEqual(onboardingCalls, ['power', 'pair', 'trust', 'connect', 'refresh']);
  assert.strictEqual(onboardingSaved.preferredDeviceName, 'JBL PartyBox 100');
  assert.strictEqual(onboardingSaved.enabled, true, 'successful onboarding must enable reconnect management');

  var removedOutput = false;
  onboardingSaved.outputEnabled = true;
  plugin._stopPlaybackForRouting = function () { return Promise.resolve(); };
  plugin.outputManager = { removeOutput: async function () { removedOutput = true; } };
  await plugin._returnToDefaultIfWireless();
  assert.strictEqual(removedOutput, true, 'speaker removal must return active wireless routing to default');
  assert.strictEqual(onboardingSaved.outputEnabled, false);

  onboardingSaved.preferredDeviceMac = 'C4:30:18:EA:9D:EC';
  onboardingSaved.preferredDeviceName = 'JBL PartyBox 100';
  plugin.devices = [{ id: 'C4:30:18:EA:9D:EC', name: 'JBL PartyBox 100' }];
  plugin._returnToDefaultIfWireless = async function () {};
  plugin._clearReconnect = function () {};
  plugin.refreshUI = function () { return Promise.resolve(); };
  plugin.bluetooth.forget = function () { throw new Error('reset must preserve system pairings'); };
  await plugin.resetSpeakerSetup();
  assert.strictEqual(onboardingSaved.preferredDeviceMac, '');
  assert.strictEqual(onboardingSaved.enabled, false);
  assert.deepStrictEqual(plugin.devices, []);

  var uiWrites = {};
  var uiValues = {
    preferredDeviceMac: 'C4:30:18:EA:9D:EC',
    preferredDeviceName: 'JBL PartyBox 100',
    outputEnabled: false,
    autoReconnect: true,
    debugLogging: false
  };
  plugin.commandRouter = {
    sharedVars: { get: function () { return 'en'; } },
    i18nJson: function () { return Promise.resolve(JSON.parse(JSON.stringify(uiConfig))); }
  };
  plugin.configManager = {
    setUIConfigParam: function (ui, path, value) { uiWrites[path] = value; },
    pushUIConfigParam: function () {}
  };
  plugin.config = { get: function (key) { return uiValues[key]; } };
  plugin.bluetooth = { getStatus: async function () { return { preferred: { paired: true, connected: true } }; } };
  plugin.devices = [];
  await plugin.getUIConfig();
  assert.strictEqual(uiWrites['sections[1].hidden'], false, 'audio destination must appear for a saved speaker');
  assert.strictEqual(uiWrites['sections[1].content[0].hidden'], false, 'wireless destination must appear for a connected speaker');
  assert.strictEqual(uiWrites['sections[2].content[0].hidden'], true, 'reconnect must hide while connected');
  assert.strictEqual(uiWrites['sections[2].content[1].hidden'], false, 'disconnect must show while connected');

  uiWrites = {};
  uiValues.preferredDeviceMac = '';
  uiValues.preferredDeviceName = '';
  plugin.bluetooth.getStatus = async function () { return { preferred: null }; };
  await plugin.getUIConfig();
  assert.strictEqual(uiWrites['sections[1].hidden'], true, 'audio destination must hide until a speaker is saved');
  assert.strictEqual(uiWrites['sections[2].hidden'], true, 'speaker management must hide until a speaker is saved');
  console.log('All tests passed');
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
