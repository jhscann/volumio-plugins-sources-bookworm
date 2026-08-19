'use strict';

var assert = require('assert');
var BluetoothAdapter = require('../lib/adapters/bluetooth');
var BluetoothVolumeManager = require('../lib/bluetoothVolumeManager');
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
  assert(uiIds.indexOf('bluetoothDeviceVolume') !== -1 && uiIds.indexOf('volumioSoftwareVolume') === -1,
    'the UI must expose Bluetooth stream volume without presenting Volumio volume as dependable Bluetooth control');
  assert.strictEqual(uiConfig.sections[2].onSave.method, 'saveBluetoothSoundSettings',
    'codec and Bluetooth stream volume must share one device-specific section save');
  assert.deepStrictEqual(uiConfig.sections[2].saveButton.data,
    ['preferredCodec', 'bluetoothDeviceVolume']);
  assert.deepStrictEqual(uiConfig.sections[2].content[1].type, { name: 'number' },
    'Bluetooth stream volume must use Volumio native number-input definitions');
  assert.strictEqual(uiConfig.sections[0].id, 'currentOutput', 'output and recovery controls must remain first');
  assert.strictEqual(uiConfig.sections[0].content[1].id, 'removeOutput', 'return-to-default recovery must always be present');
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

  var deviceVolume = 100;
  var volumeCommands = [];
  var bluetoothVolume = new BluetoothVolumeManager({
    safeMaximumPercent: 10,
    runner: { run: async function (command, args) {
      volumeCommands.push({ command: command, args: args });
      assert.strictEqual(command, 'amixer');
      assert.strictEqual(args[1], 'bluealsa:DEV=34:DF:2A:4F:74:F5',
        'the safety cap must target only the selected Bluetooth MAC');
      if (args[2] === 'sset') {
        assert.strictEqual(args[3], 'A2DP');
        deviceVolume = Number(String(args[4]).replace('%', ''));
        return { stdout: '', exitCode: 0 };
      }
      return {
        stdout: "Simple mixer control 'A2DP',0\n" +
          '  Front Left: Playback ' + Math.round(deviceVolume * 1.27) + ' [' + deviceVolume + '%] [on]\n' +
          '  Front Right: Playback ' + Math.round(deviceVolume * 1.27) + ' [' + deviceVolume + '%] [on]\n',
        exitCode: 0
      };
    } },
    logger: { info: function () {}, warn: function () {} }
  });
  var cappedVolume = await bluetoothVolume.applySafetyCap('34:df:2a:4f:74:f5');
  assert.strictEqual(cappedVolume.changed, true, 'an unsafe Bluetooth device volume must be lowered');
  assert.strictEqual(cappedVolume.volume.maximum, 10, 'the selected device safety cap must be verified');
  var setCount = volumeCommands.filter(function (call) { return call.args[2] === 'sset'; }).length;
  await bluetoothVolume.applySafetyCap('34:DF:2A:4F:74:F5');
  assert.strictEqual(volumeCommands.filter(function (call) { return call.args[2] === 'sset'; }).length, setCount,
    'a device already at or below the safety cap must never be raised or rewritten');
  var userVolume = await bluetoothVolume.setVolume('34:DF:2A:4F:74:F5', 35);
  assert.strictEqual(userVolume.maximum, 35, 'an explicit user action must be able to raise connected-device volume');
  await assert.rejects(bluetoothVolume.setVolume('34:DF:2A:4F:74:F5', 101), /between 0 and 100/);
  await assert.rejects(bluetoothVolume.setVolume('34:DF:2A:4F:74:F5', ''), /between 0 and 100/);
  assert.throws(function () { bluetoothVolume._device('not-a-mac'); }, /valid Bluetooth audio device/);
  assert.throws(function () { bluetoothVolume._parsePlaybackPercentages('no playback control'); },
    /did not report an A2DP playback volume/);

  var volumePayloadPlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  assert.strictEqual(volumePayloadPlugin._submittedNumber(
    { bluetoothDeviceVolume: { value: 20 } }, 'bluetoothDeviceVolume', 'Bluetooth device volume'), 20);
  assert.strictEqual(volumePayloadPlugin._submittedNumber(
    { bluetoothDeviceVolume: [{ value: { value: '21' } }] }, 'bluetoothDeviceVolume', 'Bluetooth device volume'), 21,
  'nested Volumio number-input payloads must be decoded');
  assert.strictEqual(volumePayloadPlugin._submittedNumber(
    [{ id: 'volumioSoftwareVolume', value: '22' }], 'volumioSoftwareVolume', 'Volumio software volume'), 22,
  'field-list payloads must be decoded by id');
  assert.strictEqual(volumePayloadPlugin._submittedNumber(
    { data: [{ id: 'bluetoothDeviceVolume', value: { value: 23 } }] },
    'bluetoothDeviceVolume', 'Bluetooth device volume'), 23,
  'wrapped field-list payloads must be decoded');
  assert.throws(function () {
    volumePayloadPlugin._submittedNumber({ value: { label: 'not a number' } },
      'bluetoothDeviceVolume', 'Bluetooth device volume');
  }, /between 0 and 100/);
  assert.throws(function () {
    volumePayloadPlugin._submittedNumber({ bluetoothDeviceVolume: { value: 101 } },
      'bluetoothDeviceVolume', 'Bluetooth device volume');
  }, /between 0 and 100/);

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
  volumePlugin.volumeRestoreTimeoutMs = 50;
  volumePlugin.volumeRestoreSettleMs = 1;
  volumePlugin.volumeRestoreVerifyMs = 1;
  volumePlugin.volumeRestoreStableMs = 1;
  volumePlugin.volumeRestoreRetryMs = 1;
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
  assert.deepStrictEqual(volumeSetCalls, ['mute', 0, 'mute', 'mute', 27, 'mute', 'unmute'],
    'routing must first enter the 0% muted safety state, then restore volume before unmuting');

  softwareVolume = 18;
  softwareMuted = true;
  volumeSetCalls = [];
  await volumePlugin._withPreservedSoftwareVolume(async function () {
    softwareVolume = 100;
    softwareMuted = false;
  });
  assert.strictEqual(softwareVolume, 18, 'manual routing must restore volume while muted');
  assert.strictEqual(softwareMuted, true, 'manual routing must restore a muted state');
  assert.deepStrictEqual(volumeSetCalls, ['mute', 0, 'mute', 'mute', 18, 'mute'],
    'an originally muted state must remain muted after restoration');

  softwareVolume = 25;
  softwareMuted = false;
  volumeSetCalls = [];
  var volumeWrites = 0;
  var overrideNextRead = false;
  volumePlugin.volumioApi = {
    getState: async function () {
      if (overrideNextRead) {
        overrideNextRead = false;
        softwareVolume = 75; // Simulate Bluetooth absolute volume overriding the first restoration.
      }
      return { volume: softwareVolume, mute: softwareMuted, disableVolumeControl: false };
    },
    setVolume: async function (value) {
      volumeSetCalls.push(value);
      if (value === 'mute') softwareMuted = true;
      else if (value === 'unmute') softwareMuted = false;
      else {
        softwareVolume = Number(value);
        if (Number(value) === 25) {
          volumeWrites += 1;
          if (volumeWrites === 1) overrideNextRead = true;
        }
      }
    }
  };
  await volumePlugin._withPreservedSoftwareVolume(async function () { softwareVolume = 75; });
  assert.strictEqual(softwareVolume, 25, 'volume restoration must recover from a transient Bluetooth override');
  assert(volumeWrites >= 2, 'volume restoration must retry after Bluetooth overrides the first write');

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

  softwareVolume = 32;
  softwareMuted = false;
  var failRestoration = false;
  volumePlugin.volumioApi = {
    getState: async function () { return { volume: softwareVolume, mute: softwareMuted, disableVolumeControl: false }; },
    setVolume: async function (value) {
      if (failRestoration) throw new Error('set volume failed');
      if (value === 'mute') softwareMuted = true;
      else if (value === 'unmute') softwareMuted = false;
      else softwareVolume = Number(value);
    }
  };
  await assert.rejects(volumePlugin._withPreservedSoftwareVolume(async function () { failRestoration = true; }),
    /playback remains stopped/,
    'a failed Volumio-volume restoration must produce a clear safety error');

  softwareVolume = 32;
  softwareMuted = false;
  var ignoreRestoration = false;
  volumePlugin.volumioApi = {
    getState: async function () { return {
      volume: softwareVolume, mute: softwareMuted, disableVolumeControl: false
    }; },
    setVolume: async function (value) {
      if (ignoreRestoration) return;
      if (value === 'mute') softwareMuted = true;
      else if (value === 'unmute') softwareMuted = false;
      else softwareVolume = Number(value);
    }
  };
  await assert.rejects(volumePlugin._withPreservedSoftwareVolume(async function () { ignoreRestoration = true; }),
    /could not be verified.*playback remains stopped/,
    'a restoration that cannot be verified must keep playback stopped');

  var failClosedPlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  var failClosedCalls = [];
  failClosedPlugin._captureVolumeState = async function () { return { volume: 25, mute: false }; };
  failClosedPlugin._forceSafeVolumeState = async function () { failClosedCalls.push('safe'); };
  failClosedPlugin._restoreVolumeState = async function () { failClosedCalls.push('restore'); };
  var failClosedError = new Error('device safety failed');
  failClosedError.keepSafeVolume = true;
  await assert.rejects(failClosedPlugin._withPreservedSoftwareVolume(async function () { throw failClosedError; }),
    /device safety failed/);
  assert.deepStrictEqual(failClosedCalls, ['safe', 'safe'],
    'device-safety failures must remain in the safe state instead of restoring and unmuting');

  var routeCalls = [];
  var routeState = { preferredDeviceMac: '34:DF:2A:4F:74:F5', outputEnabled: false };
  var routePlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  routePlugin.btLog = { info: function () {}, warn: function () {}, error: function () {} };
  routePlugin.log = { info: function () {}, warn: function () {} };
  routePlugin._toast = function () {};
  routePlugin.config = {
    get: function (key) { return routeState[key]; },
    set: function (key, value) { routeState[key] = value; }
  };
  routePlugin._preferredCodecFor = function () { return 'APTX'; };
  routePlugin._withPreservedSoftwareVolume = function (operation) { return Promise.resolve().then(operation); };
  routePlugin._stopPlaybackForRouting = async function () { routeCalls.push('stop'); };
  routePlugin._ensureBluetoothAudioTransport = async function () { routeCalls.push('transport'); };
  routePlugin.codecManager = { select: async function () { routeCalls.push('codec'); } };
  routePlugin.outputManager = {
    createOutput: async function () { routeCalls.push('output'); return { configured: true }; },
    removeOutput: async function () { routeCalls.push('rollback'); }
  };
  routePlugin.bluetoothVolume = { applySafetyCap: async function () { routeCalls.push('safety-cap'); } };
  routePlugin.refreshUI = async function () { routeCalls.push('refresh'); };
  await routePlugin.createBluetoothOutput();
  assert.deepStrictEqual(routeCalls, ['stop', 'transport', 'codec', 'output', 'safety-cap', 'refresh'],
    'selected-device safety cap must be verified after codec and output setup, before routing succeeds');
  assert.strictEqual(routeState.outputEnabled, true);

  routeCalls = [];
  routeState.outputEnabled = false;
  routePlugin.bluetoothVolume.applySafetyCap = async function () {
    routeCalls.push('safety-cap');
    throw new Error('unsafe device volume');
  };
  await assert.rejects(routePlugin.createBluetoothOutput(), /routing returned to the default output/,
    'unsafe Bluetooth device volume must fail closed');
  assert.deepStrictEqual(routeCalls, ['stop', 'transport', 'codec', 'output', 'safety-cap', 'rollback']);
  assert.strictEqual(routeState.outputEnabled, false, 'failed device-volume safety must leave default routing active');

  var uiDeviceVolume = null;
  var deviceControlPlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  deviceControlPlugin.btLog = { info: function () {}, error: function () {} };
  deviceControlPlugin._toast = function () {};
  deviceControlPlugin.config = { get: function () { return '34:DF:2A:4F:74:F5'; } };
  deviceControlPlugin.bluetooth = { getDeviceInfo: async function () { return { connected: true }; } };
  deviceControlPlugin.bluetoothVolume = {
    setVolume: async function (deviceId, value) {
      assert.strictEqual(deviceId, '34:DF:2A:4F:74:F5');
      uiDeviceVolume = value;
      return { maximum: value };
    }
  };
  deviceControlPlugin.refreshUI = async function () {};
  await deviceControlPlugin.setBluetoothDeviceVolume({
    bluetoothDeviceVolume: [{ value: { value: '20' } }]
  });
  assert.strictEqual(uiDeviceVolume, 20, 'Bluetooth UI handler must decode nested Volumio number payloads');

  var uiSoftwareVolume = 40;
  var softwareControlWrites = [];
  var softwareControlPlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  softwareControlPlugin.btLog = { info: function () {}, error: function () {} };
  softwareControlPlugin._toast = function () {};
  softwareControlPlugin.volumioApi = {
    getState: async function () {
      return { volume: uiSoftwareVolume, mute: false, disableVolumeControl: false };
    },
    setVolume: async function (value) {
      softwareControlWrites.push(value);
      uiSoftwareVolume = Number(value) - 2; // Representative Bluetooth step quantization.
    }
  };
  var softwareRefreshes = 0;
  softwareControlPlugin.refreshUI = async function () { softwareRefreshes += 1; };
  var softwareControlResult = await softwareControlPlugin.setVolumioSoftwareVolume({
    data: [{ id: 'volumioSoftwareVolume', value: { value: 25 } }]
  });
  assert.deepStrictEqual(softwareControlWrites, [25]);
  assert.strictEqual(softwareControlResult.actual, 23, 'software-volume control must accept small Bluetooth quantization');
  assert.strictEqual(softwareRefreshes, 1, 'software-volume control must refresh both displayed volume values');

  var combinedDeviceVolume = null;
  var combinedSettings = {
    preferredDeviceMac: '34:DF:2A:4F:74:F5',
    codecPreferences: '{}'
  };
  var combinedPlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  combinedPlugin.btLog = { info: function () {}, error: function () {} };
  combinedPlugin._toast = function () {};
  combinedPlugin.config = {
    get: function (key) { return combinedSettings[key]; },
    set: function (key, value) { combinedSettings[key] = value; }
  };
  combinedPlugin.bluetooth = { getDeviceInfo: async function () { return { connected: true }; } };
  combinedPlugin.bluetoothVolume = { setVolume: async function (deviceId, value) { combinedDeviceVolume = value; } };
  combinedPlugin.codecManager = {
    normalize: function (value) { return String(value).toUpperCase(); },
    displayName: function (value) { return value; }
  };
  var combinedRefreshes = 0;
  combinedPlugin.refreshUI = async function () { combinedRefreshes += 1; };
  await combinedPlugin.saveBluetoothSoundSettings({
    preferredCodec: [{ value: { value: 'aptX' } }],
    bluetoothDeviceVolume: '20'
  });
  assert.strictEqual(combinedDeviceVolume, 20, 'Bluetooth sound save must apply stream volume');
  assert.strictEqual(JSON.parse(combinedSettings.codecPreferences)['34:DF:2A:4F:74:F5'], 'APTX',
    'Bluetooth sound save must store the per-device codec preference');
  assert.strictEqual(combinedRefreshes, 1, 'Bluetooth sound save must refresh displayed device settings once');

  var activeSoundCalls = [];
  var activeSoundToast = '';
  var activeSoundSettings = {
    preferredDeviceMac: 'F4:0E:11:76:9C:D8',
    codecPreferences: '{"F4:0E:11:76:9C:D8":"APTX"}',
    outputEnabled: true
  };
  var activeSoundPlugin = new WirelessOutputManager({ coreCommand: {}, logger: {}, configManager: {} });
  activeSoundPlugin.btLog = { info: function () {}, warn: function () {}, error: function () {} };
  activeSoundPlugin.config = {
    get: function (key) { return activeSoundSettings[key]; },
    set: function (key, value) { activeSoundSettings[key] = value; }
  };
  activeSoundPlugin._toast = function (level, message) { activeSoundToast = message; };
  activeSoundPlugin._withPreservedSoftwareVolume = function (operation) {
    activeSoundCalls.push('volume-safety');
    return Promise.resolve().then(operation);
  };
  activeSoundPlugin._stopPlaybackForRouting = async function () { activeSoundCalls.push('stop'); };
  activeSoundPlugin._ensureBluetoothAudioTransport = async function () { activeSoundCalls.push('transport'); };
  activeSoundPlugin.bluetooth = { getDeviceInfo: async function () { return { connected: true }; } };
  activeSoundPlugin.codecManager = {
    normalize: function (value) { return String(value || 'AUTO').toUpperCase(); },
    displayName: function (value) { return value === 'APTX-HD' ? 'aptX HD' : value; },
    select: async function (deviceId, codec) {
      activeSoundCalls.push('codec-' + codec);
      return { activeCodec: codec };
    }
  };
  activeSoundPlugin.bluetoothVolume = {
    setVolume: async function (deviceId, value) {
      activeSoundCalls.push('volume-' + value);
      return { maximum: value };
    },
    applySafetyCap: async function () {
      activeSoundCalls.push('safety-cap');
      return { volume: { maximum: 10 } };
    }
  };
  activeSoundPlugin.refreshUI = async function () { activeSoundCalls.push('refresh'); };
  var activeSoundResult = await activeSoundPlugin.saveBluetoothSoundSettings({
    preferredCodec: [{ value: { value: 'aptX-HD' } }],
    bluetoothDeviceVolume: '35'
  });
  assert.deepStrictEqual(activeSoundCalls,
    ['volume-safety', 'stop', 'transport', 'codec-APTX-HD', 'volume-35', 'refresh'],
    'an active codec change must stop playback, switch the codec and apply the explicit stream volume without rerouting');
  assert.strictEqual(activeSoundResult.playbackStopped, true);
  assert.strictEqual(activeSoundResult.volume, 35);
  assert.strictEqual(JSON.parse(activeSoundSettings.codecPreferences)['F4:0E:11:76:9C:D8'], 'APTX-HD');
  assert(/aptX HD is active at 35%.*Press Play/.test(activeSoundToast),
    'an active codec change must explain the resulting codec, volume and playback state');

  activeSoundCalls = [];
  await activeSoundPlugin.saveBluetoothSoundSettings({
    preferredCodec: [{ value: { value: 'aptX-HD' } }],
    bluetoothDeviceVolume: '40'
  });
  assert.deepStrictEqual(activeSoundCalls, ['volume-40', 'refresh'],
    'a volume-only change must apply live without stopping playback or reselecting the codec');

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
  assert(/current device and audio route were not changed/.test(failedResult.error), 'failed preflight must explain that the working route is preserved');
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
  var uiOptionWrites = {};
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
    pushUIConfigParam: function (ui, path, value) {
      if (!uiOptionWrites[path]) uiOptionWrites[path] = [];
      uiOptionWrites[path].push(value);
    }
  };
  plugin.config = { get: function (key) { return uiValues[key]; } };
  plugin.codecManager = {
    normalize: function (value) { return value || 'AUTO'; },
    displayName: function (value) { return value === 'APTX-HD' ? 'aptX HD' : (value === 'APTX' ? 'aptX' : (value || 'unknown')); },
    getStatus: async function () {
      return { available: true, systemCodecs: ['SBC', 'APTX', 'APTX-HD', 'LDAC'], availableCodecs: ['SBC', 'APTX', 'APTX-HD', 'LDAC'], activeCodec: 'APTX-HD' };
    }
  };
  plugin.bluetooth = { getStatus: async function () {
    return {
      preferred: {
        id: 'C4:30:18:EA:9D:EC', name: 'JBL PartyBox 100',
        paired: true, connected: true, audioCapable: true
      }
    };
  } };
  plugin.devices = [];
  await plugin.getUIConfig();
  assert(/Music output: the default device/.test(uiWrites['sections[0].description']),
    'current output status must remain visible for a saved device');
  assert(/three points.*Volumio volume.*Bluetooth stream volume.*own volume/i.test(uiWrites['sections[0].description']),
    'the first section must explain all three Bluetooth loudness controls');
  assert(/Keep headphones off your head/i.test(uiWrites['sections[0].description']),
    'the first section must show the headphones setup safety warning');
  assert.strictEqual(uiWrites['sections[3].content[0].hidden'], true, 'reconnect must hide while connected');
  assert.strictEqual(uiWrites['sections[3].content[1].hidden'], false, 'disconnect must show while connected');
  assert(uiWrites['sections[2].content[0].options'].some(function (option) {
    return option.value === 'APTX' && option.label === 'aptX';
  }), 'codec selector must expose standard aptX with a human-readable label');
  assert(uiWrites['sections[2].content[0].options'].some(function (option) {
    return option.value === 'APTX-HD' && option.label === 'aptX HD — high quality';
  }), 'codec selector must expose aptX HD with a human-readable label');

  uiWrites = {};
  uiValues.outputEnabled = true;
  await plugin.getUIConfig();
  assert(/Volumio may display 100%/.test(uiWrites['sections[0].description']),
    'active Bluetooth output must explain the known Volumio volume-display behaviour');
  assert(/no automatic fallback/i.test(uiWrites['sections[0].description']),
    'active Bluetooth output must state that fallback is manual');

  uiWrites = {};
  uiOptionWrites = {};
  uiValues.outputEnabled = false;
  uiValues.preferredDeviceMac = '';
  uiValues.preferredDeviceName = '';
  plugin.bluetooth.getStatus = async function () { return { preferred: null }; };
  plugin.devices = [];
  await plugin.getUIConfig();
  assert(/Music output: the default device/.test(uiWrites['sections[0].description']),
    'default-output recovery status must remain visible without a saved device');
  assert.strictEqual(uiWrites['sections[2].content[0].hidden'], true,
    'device codec control must hide until a Bluetooth device is selected');
  assert(uiOptionWrites['sections[1].content[1].options'].some(function (option) {
    return option.value === '' && option.label === 'Choose a Bluetooth audio device';
  }), 'clean-install device selector must retain an option matching its empty current value');

  uiWrites = {};
  uiOptionWrites = {};
  plugin.devices = [{ id: 'AA:BB:CC:DD:EE:02', name: 'Kitchen', paired: true, connected: false, audioCapable: true }];
  await plugin.getUIConfig();
  assert(uiOptionWrites['sections[1].content[1].options'].some(function (option) {
    return option.value === '';
  }), 'unsaved selector must retain its placeholder when paired devices are listed');
  assert(uiOptionWrites['sections[1].content[1].options'].some(function (option) {
    return option.value === 'AA:BB:CC:DD:EE:02';
  }), 'paired audio devices must remain available beside the placeholder');
  assert.strictEqual(uiWrites['sections[3].content[2].hidden'], false, 'paired audio selector must show for disconnected paired devices');
  assert.strictEqual(uiWrites['sections[3].content[3].hidden'], true, 'plugin-only reset must hide when no device is selected');
  console.log('All tests passed');
}

main().catch(function (error) { console.error(error); process.exitCode = 1; });
