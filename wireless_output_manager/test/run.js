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
  assert(uiIds.indexOf('forgetDevice') !== -1, 'selected-device pairing removal must be available');
  assert(uiIds.indexOf('resetSpeakerSetup') !== -1, 'safe plugin-only reset must remain available');

  var adapter = new BluetoothAdapter({
    runner: { run: function () { return Promise.resolve({ stdout: '' }); } },
    logger: { info: function () {}, warn: function () {}, error: function () {} }
  });
  assert.deepStrictEqual(adapter._parseDeviceLines('Device AA:BB:CC:DD:EE:FF Living Room\nnoise'), [
    { id: 'AA:BB:CC:DD:EE:FF', name: 'Living Room' }
  ]);
  assert.throws(function () { adapter._mac('not-a-mac'); }, /valid Bluetooth device/);

  var optionPlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  optionPlugin.config = { get: function () { return 'Living Room'; } };
  optionPlugin.devices = [
    { id: 'AA:BB:CC:DD:EE:04', name: 'Keyboard', connected: true, paired: true, audioCapable: false },
    { id: 'AA:BB:CC:DD:EE:03', name: '', connected: false, paired: false, audioCapable: null },
    { id: 'AA:BB:CC:DD:EE:02', name: 'Kitchen', connected: true, paired: true, audioCapable: true },
    { id: 'AA:BB:CC:DD:EE:01', name: 'Living Room', connected: false, paired: true, audioCapable: true }
  ];
  var speakerOptions = optionPlugin._speakerOptions('AA:BB:CC:DD:EE:01');
  assert.deepStrictEqual(speakerOptions.map(function (device) { return device.id; }), [
    'AA:BB:CC:DD:EE:01', 'AA:BB:CC:DD:EE:02', 'AA:BB:CC:DD:EE:03'
  ], 'speaker options must prioritize selected and connected audio devices, retain unidentified devices and hide known non-audio devices');
  assert.strictEqual(optionPlugin._speakerOptionLabel(speakerOptions[0], 'AA:BB:CC:DD:EE:01'), 'Living Room — selected, paired, audio');
  assert.strictEqual(optionPlugin._speakerOptionLabel(speakerOptions[2], 'AA:BB:CC:DD:EE:01'), 'AA:BB:CC:DD:EE:03 — unidentified device');

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

  var oldId = 'AA:BB:CC:DD:EE:01';
  var newId = 'AA:BB:CC:DD:EE:02';
  var switchState = {
    preferredDeviceMac: oldId,
    preferredDeviceName: 'Speaker A',
    outputEnabled: true,
    enabled: true,
    autoReconnect: true
  };
  var switchCalls = [];
  var switchPlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  switchPlugin.btLog = { info: function () {}, warn: function () {}, error: function () {} };
  switchPlugin._toast = function () {};
  switchPlugin.config = {
    get: function (key) { return switchState[key]; },
    set: function (key, value) { switchState[key] = value; }
  };
  switchPlugin._clearReconnect = function () { switchCalls.push('clear-reconnect'); };
  switchPlugin._scheduleReconnect = function () { switchCalls.push('schedule-reconnect'); };
  switchPlugin._returnToDefaultIfWireless = async function () {
    switchCalls.push('default-output');
    switchState.outputEnabled = false;
  };
  switchPlugin.refreshUI = function () { switchCalls.push('refresh'); return Promise.resolve(); };
  switchPlugin.bluetooth = {
    powerOn: async function () { switchCalls.push('power'); },
    pair: async function (id) { switchCalls.push('pair-' + id); },
    trust: async function (id) { switchCalls.push('trust-' + id); },
    connect: async function (id) { switchCalls.push('connect-' + id); },
    disconnect: async function (id) { switchCalls.push('disconnect-' + id); },
    getDeviceInfo: async function (id) {
      switchCalls.push('info-' + id);
      return id === oldId
        ? { id: id, name: 'Speaker A', connected: true }
        : { id: id, name: 'Speaker B', connected: switchCalls.indexOf('connect-' + newId) !== -1 };
    }
  };
  await switchPlugin.pairAndConnectDevice({ preferredDevice: [{ value: newId, label: 'Speaker B' }] });
  assert(switchCalls.indexOf('default-output') < switchCalls.indexOf('disconnect-' + oldId), 'speaker switching must return to default before disconnecting the old speaker');
  assert(switchCalls.indexOf('disconnect-' + oldId) < switchCalls.indexOf('connect-' + newId), 'old speaker must disconnect before the new speaker connects');
  assert.strictEqual(switchState.preferredDeviceMac, newId, 'new speaker must be saved only after it connects');
  assert.strictEqual(switchState.preferredDeviceName, 'Speaker B');
  assert.strictEqual(switchState.outputEnabled, false, 'speaker switching must leave routing on the default output');

  switchState.preferredDeviceMac = newId;
  switchState.preferredDeviceName = 'Speaker B';
  switchState.outputEnabled = true;
  switchCalls = [];
  var extraAudioId = 'AA:BB:CC:DD:EE:03';
  var nonAudioId = 'AA:BB:CC:DD:EE:04';
  switchPlugin.bluetooth.listDevices = async function () {
    return [
      { id: newId, name: 'Speaker B', connected: true, paired: true, audioCapable: true },
      { id: extraAudioId, name: 'Speaker C', connected: true, paired: true, audioCapable: true },
      { id: nonAudioId, name: 'Keyboard', connected: true, paired: true, audioCapable: false }
    ];
  };
  await switchPlugin.pairAndConnectDevice({ preferredDevice: [{ value: newId, label: 'Speaker B' }] });
  assert(switchCalls.indexOf('default-output') !== -1, 'selecting the current speaker must return to default when another audio speaker is connected');
  assert(switchCalls.indexOf('disconnect-' + extraAudioId) !== -1, 'other connected audio speakers must be disconnected');
  assert.strictEqual(switchCalls.indexOf('disconnect-' + nonAudioId), -1, 'known non-audio Bluetooth devices must not be disconnected');

  switchState.preferredDeviceMac = oldId;
  switchState.preferredDeviceName = 'Speaker A';
  switchState.outputEnabled = true;
  switchCalls = [];
  delete switchPlugin.bluetooth.listDevices;
  switchPlugin.bluetooth.connect = async function (id) {
    switchCalls.push('connect-' + id);
    if (id === newId) throw new Error('connection refused');
  };
  var switchFailed = false;
  try {
    await switchPlugin.pairAndConnectDevice({ preferredDevice: [{ value: newId, label: 'Speaker B' }] });
  } catch (error) {
    switchFailed = /previous speaker remains selected/.test(error.message);
  }
  assert.strictEqual(switchFailed, true, 'failed speaker switches must explain the retained selection');
  assert.strictEqual(switchState.preferredDeviceMac, oldId, 'failed speaker switch must preserve the previous preference');
  assert(switchCalls.indexOf('connect-' + oldId) !== -1, 'failed speaker switch must attempt to reconnect the old speaker');
  assert.strictEqual(switchState.outputEnabled, false, 'failed speaker switch must remain safely on the default output');

  var removedOutput = false;
  onboardingSaved.outputEnabled = true;
  plugin._stopPlaybackForRouting = function () { return Promise.resolve(); };
  plugin.outputManager = { removeOutput: async function () { removedOutput = true; } };
  await plugin._returnToDefaultIfWireless();
  assert.strictEqual(removedOutput, true, 'speaker removal must return active wireless routing to default');
  assert.strictEqual(onboardingSaved.outputEnabled, false);

  var forgottenId = 'C4:30:18:EA:9D:EC';
  var forgottenCalls = [];
  onboardingSaved.preferredDeviceMac = forgottenId;
  onboardingSaved.preferredDeviceName = 'JBL PartyBox 100';
  onboardingSaved.enabled = true;
  onboardingSaved.outputEnabled = true;
  plugin.devices = [
    { id: forgottenId, name: 'JBL PartyBox 100' },
    { id: 'C0:38:96:A0:39:98', name: 'Sony' }
  ];
  plugin._clearReconnect = function () { forgottenCalls.push('clear-reconnect'); };
  plugin._returnToDefaultIfWireless = async function () {
    forgottenCalls.push('default-output');
    onboardingSaved.outputEnabled = false;
  };
  plugin.bluetooth.forget = async function (id) { forgottenCalls.push('forget-' + id); };
  plugin.refreshUI = function () { forgottenCalls.push('refresh'); return Promise.resolve(); };
  await plugin.forgetDevice();
  assert.deepStrictEqual(forgottenCalls, ['clear-reconnect', 'default-output', 'forget-' + forgottenId, 'refresh']);
  assert.strictEqual(onboardingSaved.preferredDeviceMac, '');
  assert.strictEqual(onboardingSaved.enabled, false);
  assert.deepStrictEqual(plugin.devices, [{ id: 'C0:38:96:A0:39:98', name: 'Sony' }], 'forget must remove only the selected device from plugin state');

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
