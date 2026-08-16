'use strict';

var assert = require('assert');
var BluetoothAdapter = require('../lib/adapters/bluetooth');
var CodecManager = require('../lib/codecManager');
var CommandRunner = require('../lib/commandRunner').CommandRunner;
var VolumioApi = require('../lib/volumioApi');
var WirelessOutputManager = require('../index');

async function main() {
  var uiConfig = require('../UIConfig.json');
  var uiIds = uiConfig.sections.reduce(function (ids, section) {
    return ids.concat(section.content.map(function (item) { return item.id; }));
  }, []);
  assert(uiIds.indexOf('scanDevices') !== -1 && uiIds.indexOf('preferredDevice') !== -1, 'onboarding must expose discovery and speaker selection');
  assert(uiIds.indexOf('pairDevice') === -1 && uiIds.indexOf('trustDevice') === -1, 'low-level pairing controls must stay out of the main UI');
  assert(uiIds.indexOf('createOutput') !== -1 && uiIds.indexOf('removeOutput') !== -1, 'manual audio destination controls must remain available');
  assert(uiIds.indexOf('pairedDeviceToForget') !== -1, 'paired-device selection must be available for pairing removal');
  assert(uiIds.indexOf('resetSpeakerSetup') !== -1, 'safe plugin-only reset must remain available');

  var adapter = new BluetoothAdapter({
    runner: { run: function () { return Promise.resolve({ stdout: '' }); } },
    logger: { info: function () {}, warn: function () {}, error: function () {} }
  });
  assert.deepStrictEqual(adapter._parseDeviceLines('Device AA:BB:CC:DD:EE:FF Living Room\nnoise'), [
    { id: 'AA:BB:CC:DD:EE:FF', name: 'Living Room' }
  ]);
  assert.throws(function () { adapter._mac('not-a-mac'); }, /valid Bluetooth device/);

  var codecCommands = [];
  var codecSelected = 'SBC';
  var codecPcm = '/org/bluealsa/hci1/dev_34_0E_22_54_16_73/a2dpsrc/sink';
  var codecManager = new CodecManager({
    runner: { run: async function (command, args) {
      codecCommands.push({ command: command, args: args });
      if (args[0] === 'status') return { stdout: 'Profiles:\n  A2DP-source : SBC AAC aptX aptX-HD LDAC\n', exitCode: 0 };
      if (args[0] === 'list-pcms') return { stdout: codecPcm + '\n', exitCode: 0 };
      if (args[0] === 'info') return {
        stdout: 'Available codecs: SBC AAC aptX aptX-HD LDAC\nSelected codec: ' + codecSelected + '\n', exitCode: 0
      };
      if (args[0] === 'codec') {
        codecSelected = args[2];
        return { stdout: '', exitCode: 0 };
      }
      throw new Error('Unexpected codec command');
    } },
    logger: { info: function () {} }
  });
  var codecStatus = await codecManager.getStatus('34:0E:22:54:16:73');
  assert.strictEqual(codecStatus.pcmPath, codecPcm, 'codec lookup must resolve the current hci path by MAC');
  assert.deepStrictEqual(codecStatus.systemCodecs, ['SBC', 'AAC', 'APTX', 'APTX-HD', 'LDAC']);
  assert.deepStrictEqual(codecStatus.availableCodecs, ['SBC', 'AAC', 'APTX', 'APTX-HD', 'LDAC']);
  assert.strictEqual(codecStatus.activeCodec, 'SBC');
  assert.strictEqual(codecManager.normalize('aptX'), 'APTX');
  assert.strictEqual(codecManager.normalize('aptX-HD'), 'APTX-HD');
  assert.strictEqual(codecManager.displayName('APTX-HD'), 'aptX HD');
  await codecManager.select('34:0E:22:54:16:73', 'ldac');
  assert.strictEqual(codecSelected, 'LDAC', 'explicit codec selection must be verified after applying it');
  assert(codecCommands.some(function (call) {
    return call.args[0] === 'codec' && call.args[1] === codecPcm && call.args[2] === 'LDAC';
  }), 'codec command must target the resolved speaker PCM');

  codecSelected = 'SBC';
  codecCommands = [];
  await codecManager.select('34:0E:22:54:16:73', 'aptX-HD');
  assert.strictEqual(codecSelected, 'aptX-HD', 'aptX HD must use BlueALSA\'s exact mixed-case codec name');
  assert(codecCommands.some(function (call) {
    return call.args[0] === 'codec' && call.args[2] === 'aptX-HD';
  }), 'aptX HD selection must be sent using the BlueALSA codec spelling');

  codecSelected = 'SBC';
  codecCommands = [];
  await codecManager.select('34:0E:22:54:16:73', 'aptX');
  assert.strictEqual(codecSelected, 'aptX', 'standard aptX must use BlueALSA\'s exact mixed-case codec name');

  codecSelected = 'SBC';
  codecCommands = [];
  await codecManager.select('34:0E:22:54:16:73', 'auto');
  assert.strictEqual(codecSelected, 'LDAC', 'automatic codec mode must choose the best mutually available codec');
  assert(codecCommands.some(function (call) {
    return call.args[0] === 'codec' && call.args[2] === 'LDAC';
  }), 'automatic codec mode must explicitly select and verify LDAC when available');

  var aptxSelected = 'SBC';
  var aptxAutoManager = new CodecManager({
    runner: { run: async function (command, args) {
      if (args[0] === 'status') return { stdout: 'Profiles:\n  A2DP-source : SBC aptX aptX-HD\n', exitCode: 0 };
      if (args[0] === 'list-pcms') return { stdout: codecPcm + '\n', exitCode: 0 };
      if (args[0] === 'info') return { stdout: 'Available codecs: SBC aptX aptX-HD\nSelected codec: ' + aptxSelected + '\n', exitCode: 0 };
      if (args[0] === 'codec') {
        aptxSelected = args[2];
        return { stdout: '', exitCode: 0 };
      }
      throw new Error('Unexpected aptX codec command');
    } },
    logger: { info: function () {} }
  });
  await aptxAutoManager.select('34:0E:22:54:16:73', 'AUTO');
  assert.strictEqual(aptxSelected, 'aptX-HD', 'automatic mode must prefer aptX HD when LDAC is unavailable');

  var unavailableCodecManager = new CodecManager({
    runner: { run: async function (command, args) {
      if (args[0] === 'status') return { stdout: 'Profiles:\n  A2DP-source : SBC LDAC\n', exitCode: 0 };
      if (args[0] === 'list-pcms') return { stdout: codecPcm + '\n', exitCode: 0 };
      if (args[0] === 'info') return { stdout: 'Available codecs: SBC LDAC\nSelected codec: SBC\n', exitCode: 0 };
      throw new Error('AAC selection must fail before a codec command is issued');
    } },
    logger: { info: function () {} }
  });
  await assert.rejects(unavailableCodecManager.select('34:0E:22:54:16:73', 'AAC'),
    /AAC is not enabled by the installed BlueALSA service/,
    'missing AAC builds must produce a clear capability error');
  adapter._bus = async function () {
    return { stdout: '└─/org/bluez\n  ├─/org/bluez/hci0\n  │ └─/org/bluez/hci0/dev_A0_4A_5E_D9_98_F5\n  └─/org/bluez/hci1/dev_C4_30_18_EA_9D_EC', exitCode: 0 };
  };
  assert.deepStrictEqual(await adapter._listDevicePaths(), [
    '/org/bluez/hci0/dev_A0_4A_5E_D9_98_F5',
    '/org/bluez/hci1/dev_C4_30_18_EA_9D_EC'
  ], 'BlueZ tree parsing must find device objects on every controller');

  var speakerMac = 'C4:30:18:EA:9D:EC';
  var dialMac = 'A0:4A:5E:D9:98:F5';
  var builtInPath = '/org/bluez/hci1/dev_C4_30_18_EA_9D_EC';
  var usbDialPath = '/org/bluez/hci0/dev_A0_4A_5E_D9_98_F5';
  var busCalls = [];
  var multiAdapter = new BluetoothAdapter({
    runner: { run: function (command, args) {
      busCalls.push({ command: command, args: args });
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
    } },
    logger: { info: function () {}, warn: function () {}, error: function () {} }
  });
  multiAdapter._listDevicePaths = async function () { return [usbDialPath, builtInPath]; };
  multiAdapter._deviceFromPath = async function (path) {
    if (path === builtInPath) {
      return {
        id: speakerMac, name: 'JBL PartyBox 100', paired: true, bonded: true,
        trusted: true, connected: false, audioCapable: true, objectPath: path,
        adapterPath: '/org/bluez/hci1', adapterAddress: '2C:CF:67:19:A4:42'
      };
    }
    return {
      id: dialMac, name: 'Surface Dial', paired: true, bonded: true,
      trusted: true, connected: true, audioCapable: false, objectPath: path,
      adapterPath: '/org/bluez/hci0', adapterAddress: '3C:78:95:C9:CC:29'
    };
  };
  multiAdapter._getProperty = async function () { return true; };
  var resolvedSpeaker = await multiAdapter.resolveDevice(speakerMac);
  assert.strictEqual(resolvedSpeaker.objectPath, builtInPath, 'speaker lookup must cross all adapters rather than use the default adapter');
  await multiAdapter.connect(speakerMac);
  var connectCall = busCalls.find(function (call) { return call.args.indexOf('Connect') !== -1; });
  assert(connectCall, 'disconnected speaker must receive a Device1.Connect call');
  assert.strictEqual(connectCall.args[3], builtInPath, 'connect must target the resolved speaker object after hci numbering changes');
  assert.strictEqual(busCalls.some(function (call) { return call.args.indexOf(usbDialPath) !== -1; }), false,
    'speaker connection must not operate on the Surface Dial object');

  busCalls = [];
  await multiAdapter.forget(speakerMac);
  var forgetCall = busCalls.find(function (call) { return call.args.indexOf('RemoveDevice') !== -1; });
  assert(forgetCall, 'forget must call Adapter1.RemoveDevice');
  assert.strictEqual(forgetCall.args[3], '/org/bluez/hci1', 'forget must target the speaker owning adapter');
  assert.strictEqual(forgetCall.args[7], builtInPath, 'forget must remove only the resolved speaker object');
  assert.strictEqual(forgetCall.args.indexOf(usbDialPath), -1, 'forget must not operate on the Surface Dial object');

  busCalls = [];
  await Promise.all([multiAdapter.connect(speakerMac), multiAdapter.connect(speakerMac)]);
  assert.strictEqual(busCalls.filter(function (call) { return call.args.indexOf('Connect') !== -1; }).length, 1,
    'overlapping requests must share one bounded Device1.Connect attempt');

  busCalls = [];
  multiAdapter._deviceFromPath = async function (path) {
    var pairedOwner = path.indexOf('hci1') !== -1;
    return {
      id: speakerMac, name: 'JBL PartyBox 100', paired: pairedOwner, bonded: pairedOwner,
      trusted: pairedOwner, connected: !pairedOwner, audioCapable: true, objectPath: path,
      adapterPath: pairedOwner ? '/org/bluez/hci1' : '/org/bluez/hci0',
      adapterAddress: pairedOwner ? '2C:CF:67:19:A4:42' : '3C:78:95:C9:CC:29'
    };
  };
  multiAdapter._listDevicePaths = async function () {
    return ['/org/bluez/hci0/dev_C4_30_18_EA_9D_EC', builtInPath];
  };
  resolvedSpeaker = await multiAdapter.resolveDevice(speakerMac);
  assert.strictEqual(resolvedSpeaker.objectPath, builtInPath,
    'paired and bonded device object must win over an unpaired connected duplicate');

  multiAdapter._deviceFromPath = async function (path) {
    return {
      id: speakerMac, name: 'JBL PartyBox 100', paired: true, bonded: true,
      trusted: true, connected: true, audioCapable: true, objectPath: path,
      adapterPath: '/org/bluez/hci1', adapterAddress: '2C:CF:67:19:A4:42'
    };
  };
  busCalls = [];
  await multiAdapter.connect(speakerMac);
  assert.strictEqual(busCalls.length, 0, 'already-connected speaker must not be reconnected');

  multiAdapter._listDevicePaths = async function () { return [usbDialPath]; };
  await assert.rejects(multiAdapter.resolveDevice(speakerMac), /not available on any Bluetooth adapter/,
    'missing speaker object must produce a clear bounded failure');

  multiAdapter._listDevicePaths = async function () { return [builtInPath]; };
  multiAdapter._deviceFromPath = async function () {
    return {
      id: speakerMac, name: 'JBL PartyBox 100', paired: true, bonded: true,
      trusted: true, connected: false, audioCapable: true, objectPath: builtInPath,
      adapterPath: '/org/bluez/hci1', adapterAddress: '2C:CF:67:19:A4:42'
    };
  };
  var failedConnects = 0;
  multiAdapter._bus = async function (args) {
    if (args.indexOf('Connect') !== -1) {
      failedConnects += 1;
      throw new Error('connection failed');
    }
    return { stdout: 'b true', exitCode: 0 };
  };
  await assert.rejects(Promise.all([multiAdapter.connect(speakerMac), multiAdapter.connect(speakerMac)]), /connection failed/);
  assert.strictEqual(failedConnects, 1, 'a failed overlapping connection must still make only one attempt');
  await assert.rejects(multiAdapter.connect(speakerMac), /connection failed/);
  assert.strictEqual(failedConnects, 2, 'connection lock must clear after failure so a later bounded retry can run');

  var optionPlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  optionPlugin.log = { warn: function () {} };
  optionPlugin.codecManager = codecManager;
  var optionConfig = { preferredDeviceName: 'Living Room', codecPreferences: '{}' };
  optionPlugin.config = {
    get: function (key) { return optionConfig[key]; },
    set: function (key, value) { optionConfig[key] = value; }
  };
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
  optionPlugin._setPreferredCodecFor('AA:BB:CC:DD:EE:01', 'LDAC');
  optionPlugin._setPreferredCodecFor('AA:BB:CC:DD:EE:02', 'SBC');
  assert.strictEqual(optionPlugin._preferredCodecFor('AA:BB:CC:DD:EE:01'), 'LDAC',
    'codec preference must be saved independently for the first audio device');
  assert.strictEqual(optionPlugin._preferredCodecFor('AA:BB:CC:DD:EE:02'), 'SBC',
    'codec preference must be saved independently for the second audio device');
  optionPlugin._removeCodecPreferenceFor('AA:BB:CC:DD:EE:01');
  assert.strictEqual(optionPlugin._preferredCodecFor('AA:BB:CC:DD:EE:01'), 'AUTO',
    'forgetting a device must remove only its saved codec preference');
  assert.strictEqual(optionPlugin._preferredCodecFor('AA:BB:CC:DD:EE:02'), 'SBC');

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

  var apiPaths = [];
  var api = new VolumioApi({ request: async function (requestPath) {
    apiPaths.push(requestPath);
    return requestPath === '/api/v1/getState' ? '{"volume":27,"mute":false}' : '';
  } });
  assert.strictEqual((await api.getState()).volume, 27, 'Volumio API client must parse the player state');
  await api.setVolume(31);
  await api.setVolume('mute');
  assert.deepStrictEqual(apiPaths, [
    '/api/v1/getState',
    '/api/v1/commands/?cmd=volume&volume=31',
    '/api/v1/commands/?cmd=volume&volume=mute'
  ], 'Volumio API client must use the documented state and volume endpoints');
  var invalidApi = new VolumioApi({ request: async function () { return 'not-json'; } });
  await assert.rejects(invalidApi.getState(), /invalid player state/,
    'invalid Volumio player state must be rejected');

  var softwareVolume = 27;
  var softwareMuted = false;
  var volumeSetCalls = [];
  var volumePlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  volumePlugin.log = { info: function () {}, warn: function () {} };
  volumePlugin.volumioApi = {
    getState: async function () {
      return { volume: softwareVolume, mute: softwareMuted, disableVolumeControl: false };
    },
    setVolume: async function (value) {
      volumeSetCalls.push(value);
      if (value === 'mute') softwareMuted = true;
      else if (value === 'unmute') softwareMuted = false;
      else softwareVolume = Number(value);
    }
  };
  await volumePlugin._withPreservedSoftwareVolume(async function () {
    softwareVolume = 100; // Simulate Volumio resetting its volume during the ALSA rebuild.
  });
  assert.strictEqual(softwareVolume, 27, 'manual routing must restore the previous Volumio volume');
  assert.strictEqual(softwareMuted, false, 'manual routing must preserve an unmuted state');
  assert.deepStrictEqual(volumeSetCalls, [27, 'unmute'], 'volume and mute state must both be restored');

  softwareVolume = 18;
  softwareMuted = true;
  volumeSetCalls = [];
  await volumePlugin._withPreservedSoftwareVolume(async function () {
    softwareVolume = 100;
    softwareMuted = false;
  });
  assert.strictEqual(softwareVolume, 18, 'manual routing must restore volume while muted');
  assert.strictEqual(softwareMuted, true, 'manual routing must restore a muted state');
  assert.deepStrictEqual(volumeSetCalls, [18, 'mute'], 'muted state must be restored after numeric volume');

  var hardwareSetCalls = 0;
  volumePlugin.volumioApi = {
    getState: async function () { return { volume: 100, mute: false, disableVolumeControl: true }; },
    setVolume: async function () { hardwareSetCalls += 1; }
  };
  await volumePlugin._withPreservedSoftwareVolume(async function () {});
  assert.strictEqual(hardwareSetCalls, 0, 'disabled volume control must not trigger a volume write');

  var unsafeOperationRan = false;
  volumePlugin.volumioApi = {
    getState: async function () { throw new Error('Volumio API unavailable'); },
    setVolume: async function () {}
  };
  await assert.rejects(volumePlugin._withPreservedSoftwareVolume(async function () { unsafeOperationRan = true; }),
    /no routing change was made/,
    'routing must not start when the current volume cannot be determined');
  assert.strictEqual(unsafeOperationRan, false, 'an unreadable volume must stop the routing operation before it starts');

  volumePlugin.volumioApi = {
    getState: async function () { return { volume: 32, mute: false, disableVolumeControl: false }; },
    setVolume: async function () { throw new Error('set volume failed'); }
  };
  await assert.rejects(volumePlugin._withPreservedSoftwareVolume(async function () {}),
    /playback remains stopped/,
    'a failed Volumio-volume restoration must produce a clear safety error');

  var verificationReads = 0;
  volumePlugin.volumioApi = {
    getState: async function () {
      verificationReads += 1;
      return { volume: verificationReads === 1 ? 32 : 100, mute: false, disableVolumeControl: false };
    },
    setVolume: async function () {}
  };
  await assert.rejects(volumePlugin._withPreservedSoftwareVolume(async function () {}),
    /could not be verified.*playback remains stopped/,
    'a restoration that cannot be verified must keep playback stopped');

  var recoveryMac = '34:09:C9:B0:39:B6';
  var recoveryCalls = [];
  var recoveryChecks = 0;
  var recoveryPlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  recoveryPlugin.transportPollDelayMs = 1;
  recoveryPlugin.transportPollAttempts = 3;
  recoveryPlugin.btLog = { info: function () {}, warn: function () {} };
  recoveryPlugin.codecManager = {
    getStatus: async function (id) {
      recoveryCalls.push('status-' + id);
      recoveryChecks += 1;
      return recoveryChecks < 3
        ? { available: true, deviceConnected: false, pcmPath: '' }
        : { available: true, deviceConnected: true, pcmPath: '/org/bluealsa/hci0/dev_34_09_C9_B0_39_B6/a2dpsrc/sink' };
    }
  };
  recoveryPlugin.bluetooth = {
    getDeviceInfo: async function (id) {
      recoveryCalls.push('info-' + id);
      return { id: id, connected: true, adapterAddress: '3C:78:95:C9:CC:29' };
    },
    disconnect: async function (id) { recoveryCalls.push('disconnect-' + id); },
    connect: async function (id) { recoveryCalls.push('connect-' + id); }
  };
  var recovered = await Promise.all([
    recoveryPlugin._ensureBluetoothAudioTransport(recoveryMac),
    recoveryPlugin._ensureBluetoothAudioTransport(recoveryMac)
  ]);
  assert.strictEqual(recovered[0].deviceConnected, true, 'stale connected devices must recover a BlueALSA PCM');
  assert.strictEqual(recoveryCalls.filter(function (call) { return call === 'disconnect-' + recoveryMac; }).length, 1,
    'concurrent stale-transport recovery must disconnect only the selected device once');
  assert.strictEqual(recoveryCalls.filter(function (call) { return call === 'connect-' + recoveryMac; }).length, 1,
    'concurrent stale-transport recovery must reconnect only the selected device once');
  assert.strictEqual(recoveryCalls.some(function (call) { return call.indexOf('A0:4A:5E:D9:98:F5') !== -1; }), false,
    'stale-transport recovery must not operate on an unrelated Surface Dial');

  recoveryCalls = [];
  recoveryPlugin.codecManager.getStatus = async function () {
    return { available: true, deviceConnected: true, pcmPath: '/org/bluealsa/hci1/dev_34_09_C9_B0_39_B6/a2dpsrc/sink' };
  };
  await recoveryPlugin._ensureBluetoothAudioTransport(recoveryMac);
  assert.deepStrictEqual(recoveryCalls, [], 'a healthy BlueALSA transport must not trigger any Bluetooth operation');

  recoveryPlugin.transportPollAttempts = 2;
  recoveryPlugin.codecManager.getStatus = async function () {
    return { available: true, deviceConnected: false, pcmPath: '' };
  };
  recoveryPlugin.bluetooth.getDeviceInfo = async function () {
    return { id: recoveryMac, connected: false, adapterAddress: '3C:78:95:C9:CC:29' };
  };
  recoveryPlugin.bluetooth.connect = async function (id) { recoveryCalls.push('connect-' + id); };
  await assert.rejects(recoveryPlugin._ensureBluetoothAudioTransport(recoveryMac),
    /audio stream did not become available/,
    'transport recovery must stop after a bounded number of checks');

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
  assert(switchCalls.indexOf('connect-' + newId) < switchCalls.indexOf('default-output'), 'new speaker must connect before the working route changes');
  assert(switchCalls.indexOf('default-output') < switchCalls.indexOf('disconnect-' + oldId), 'speaker switching must return to default before disconnecting the old speaker');
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
  var failedResult = await switchPlugin.pairAndConnectDevice({ preferredDevice: [{ value: newId, label: 'Speaker B' }] });
  assert.strictEqual(failedResult.success, false, 'unavailable speakers must return a handled failure result');
  assert(/current speaker and audio route were not changed/.test(failedResult.error), 'failed preflight must explain that the working route is preserved');
  assert.strictEqual(switchState.preferredDeviceMac, oldId, 'failed speaker switch must preserve the previous preference');
  assert.strictEqual(switchCalls.indexOf('default-output'), -1, 'failed preflight must not change the working route');
  assert.strictEqual(switchCalls.indexOf('disconnect-' + oldId), -1, 'failed preflight must not disconnect the working speaker');
  assert.strictEqual(switchState.outputEnabled, true, 'failed preflight must preserve active Bluetooth routing');

  var removedOutput = false;
  onboardingSaved.outputEnabled = true;
  plugin._stopPlaybackForRouting = function () { return Promise.resolve(); };
  plugin._withPreservedSoftwareVolume = function (operation) { return Promise.resolve().then(operation); };
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
  await plugin.forgetDevice({ pairedDeviceToForget: [{ value: forgottenId, label: 'JBL PartyBox 100' }] });
  assert.deepStrictEqual(forgottenCalls, ['clear-reconnect', 'default-output', 'forget-' + forgottenId, 'refresh']);
  assert.strictEqual(onboardingSaved.preferredDeviceMac, '');
  assert.strictEqual(onboardingSaved.enabled, false);
  assert.deepStrictEqual(plugin.devices, [{ id: 'C0:38:96:A0:39:98', name: 'Sony' }], 'forget must remove only the selected device from plugin state');

  var disconnectedId = 'C0:38:96:A0:39:98';
  forgottenCalls = [];
  onboardingSaved.preferredDeviceMac = forgottenId;
  onboardingSaved.preferredDeviceName = 'JBL PartyBox 100';
  onboardingSaved.enabled = true;
  plugin.devices = [{ id: disconnectedId, name: 'Sony', paired: true, connected: false, audioCapable: true }];
  await plugin.forgetDevice({ pairedDeviceToForget: [{ value: disconnectedId, label: 'Sony' }] });
  assert.deepStrictEqual(forgottenCalls, ['forget-' + disconnectedId, 'refresh'], 'forgetting a disconnected non-selected device must not change routing or reconnect state');
  assert.strictEqual(onboardingSaved.preferredDeviceMac, forgottenId, 'forgetting another device must preserve the selected speaker');

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
    debugLogging: false,
    codecPreferences: '{"C4:30:18:EA:9D:EC":"AUTO"}'
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
  plugin.codecManager = {
    normalize: function (value) { return value || 'AUTO'; },
    displayName: function (value) { return value === 'APTX-HD' ? 'aptX HD' : (value === 'APTX' ? 'aptX' : (value || 'unknown')); },
    getStatus: async function () {
      return { available: true, systemCodecs: ['SBC', 'APTX', 'APTX-HD', 'LDAC'], availableCodecs: ['SBC', 'APTX', 'APTX-HD', 'LDAC'], activeCodec: 'APTX-HD' };
    }
  };
  plugin.bluetooth = { getStatus: async function () { return { preferred: { paired: true, connected: true } }; } };
  plugin.devices = [];
  await plugin.getUIConfig();
  assert.strictEqual(uiWrites['sections[1].hidden'], false, 'audio destination must appear for a saved speaker');
  assert.strictEqual(uiWrites['sections[1].content[0].hidden'], false, 'wireless destination must appear for a connected speaker');
  assert.strictEqual(uiWrites['sections[2].content[0].hidden'], true, 'reconnect must hide while connected');
  assert.strictEqual(uiWrites['sections[2].content[1].hidden'], false, 'disconnect must show while connected');
  assert(uiWrites['sections[3].content[2].options'].some(function (option) {
    return option.value === 'APTX' && option.label === 'aptX';
  }), 'codec selector must expose standard aptX with a human-readable label');
  assert(uiWrites['sections[3].content[2].options'].some(function (option) {
    return option.value === 'APTX-HD' && option.label === 'aptX HD — high quality';
  }), 'codec selector must expose aptX HD with a human-readable label');

  uiWrites = {};
  uiValues.preferredDeviceMac = '';
  uiValues.preferredDeviceName = '';
  plugin.bluetooth.getStatus = async function () { return { preferred: null }; };
  plugin.devices = [];
  await plugin.getUIConfig();
  assert.strictEqual(uiWrites['sections[1].hidden'], true, 'audio destination must hide until a speaker is saved');
  assert.strictEqual(uiWrites['sections[2].hidden'], true, 'speaker management must hide until a speaker is saved');

  uiWrites = {};
  plugin.devices = [{ id: 'AA:BB:CC:DD:EE:02', name: 'Kitchen', paired: true, connected: false, audioCapable: true }];
  await plugin.getUIConfig();
  assert.strictEqual(uiWrites['sections[2].hidden'], false, 'paired-device management must remain visible without a preferred speaker');
  assert.strictEqual(uiWrites['sections[2].content[2].hidden'], false, 'paired audio selector must show for disconnected paired devices');
  assert.strictEqual(uiWrites['sections[2].content[3].hidden'], true, 'plugin-only reset must hide when no speaker is selected');
  console.log('All tests passed');
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
