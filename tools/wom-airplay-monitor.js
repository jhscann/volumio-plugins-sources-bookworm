#!/usr/bin/env node
'use strict';

// Standalone incident monitor for Wireless Output Manager AirPlay testing.
// It observes public APIs, process state and existing logs. It does not write
// plugin configuration, touch the audio route or consume either plugin FIFO.

var childProcess = require('child_process');
var fs = require('fs');
var http = require('http');
var path = require('path');
var readline = require('readline');

var REPORT_DIR = '/data/INTERNAL/wireless-output-manager';
var PLUGIN_DIR = '/data/plugins/system_hardware/wireless_output_manager';
var CONFIG_PATH = '/data/configuration/system_hardware/wireless_output_manager/config.json';
var AUDIO_FIFO = '/tmp/wireless-output-manager-airplay/audio.pcm';
var POLL_MS = 750;
var PROCESS_MS = 1000;
var NETWORK_MS = 5000;
var HEARTBEAT_MS = 5000;
var MAX_RUNTIME_MS = 30 * 60 * 1000;

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

fs.mkdirSync(REPORT_DIR, { recursive: true });
var reportPath = process.argv[2] || path.join(REPORT_DIR, 'airplay-monitor-' + stamp() + '.txt');
var report = fs.createWriteStream(reportPath, { flags: 'wx', mode: 0o640 });
var started = process.hrtime.bigint();
var stopping = false;
var children = [];
var timers = [];
var lastApiSignature = '';
var lastApiLogAt = 0;
var lastProcessSignature = '';
var lastProcessLogAt = 0;
var lastNetworkSignature = '';
var selectedAddress = '';

function elapsedMs() {
  return Number((process.hrtime.bigint() - started) / 1000000n);
}

function oneLine(value) {
  return String(value === undefined || value === null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
}

function write(kind, message) {
  report.write(new Date().toISOString() + ' +' + elapsedMs() + 'ms [' + kind + '] ' + oneLine(message) + '\n');
}

function configValue(config, key) {
  return config && config[key] && Object.prototype.hasOwnProperty.call(config[key], 'value')
    ? config[key].value : undefined;
}

function readSafeConfiguration() {
  try {
    var config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    selectedAddress = oneLine(configValue(config, 'preferredAirPlayAddress'));
    return {
      activeBackend: configValue(config, 'activeBackend'),
      outputEnabled: configValue(config, 'outputEnabled'),
      preferredAirPlayId: configValue(config, 'preferredAirPlayId'),
      preferredAirPlayName: configValue(config, 'preferredAirPlayName'),
      preferredAirPlayAddress: selectedAddress,
      preferredAirPlayModel: configValue(config, 'preferredAirPlayModel')
    };
  } catch (error) {
    return { error: error.message };
  }
}

function captureOnce(label, command, args) {
  try {
    var result = childProcess.spawnSync(command, args || [], {
      encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024
    });
    write(label, 'exit=' + (result.status === null ? 'null' : result.status));
    String(result.stdout || '').split(/\r?\n/).filter(Boolean).forEach(function (line) {
      write(label, line);
    });
    String(result.stderr || '').split(/\r?\n/).filter(Boolean).forEach(function (line) {
      write(label + '-stderr', line);
    });
  } catch (error) {
    write(label + '-error', error.message);
  }
}

function follow(label, command, args) {
  try {
    var child = childProcess.spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(child);
    [child.stdout, child.stderr].forEach(function (stream, streamIndex) {
      var remainder = '';
      stream.on('data', function (chunk) {
        var lines = (remainder + chunk.toString('utf8')).split(/\r?\n/);
        remainder = lines.pop();
        lines.forEach(function (line) {
          if (line) write(streamIndex ? label + '-stderr' : label, line);
        });
      });
    });
    child.on('error', function (error) { write(label + '-error', error.message); });
    child.on('close', function (code, signal) {
      if (!stopping) write(label + '-exit', 'code=' + code + ' signal=' + signal);
    });
  } catch (error) {
    write(label + '-error', error.message);
  }
}

function apiSnapshot() {
  if (stopping) return;
  var began = process.hrtime.bigint();
  var request = http.get({ hostname: '127.0.0.1', port: 3000, path: '/api/v1/getState', timeout: 2000 },
    function (response) {
      var body = '';
      response.on('data', function (chunk) {
        if (body.length < 1024 * 1024) body += chunk.toString('utf8');
      });
      response.on('end', function () {
        var duration = Number((process.hrtime.bigint() - began) / 1000000n);
        try {
          var state = JSON.parse(body);
          var snapshot = {
            http: response.statusCode,
            responseMs: duration,
            status: state.status,
            position: state.position,
            uri: state.uri,
            seek: state.seek,
            duration: state.duration,
            title: state.title,
            volume: state.volume,
            mute: state.mute,
            service: state.service
          };
          var signature = JSON.stringify(Object.assign({}, snapshot, { responseMs: 0, seek: 0 }));
          var now = Date.now();
          if (signature !== lastApiSignature || duration >= 500 || now - lastApiLogAt >= HEARTBEAT_MS) {
            write('api', JSON.stringify(snapshot));
            lastApiSignature = signature;
            lastApiLogAt = now;
          }
        } catch (error) {
          write('api-error', 'responseMs=' + duration + ' status=' + response.statusCode + ' ' + error.message);
        }
      });
    });
  request.on('timeout', function () { request.destroy(new Error('request timed out after 2000 ms')); });
  request.on('error', function (error) {
    var duration = Number((process.hrtime.bigint() - began) / 1000000n);
    write('api-error', 'responseMs=' + duration + ' ' + error.message);
  });
}

function processCandidates() {
  var found = [];
  var entries;
  try { entries = fs.readdirSync('/proc'); } catch (error) { return found; }
  entries.filter(function (entry) { return /^\d+$/.test(entry); }).forEach(function (pid) {
    try {
      var command = fs.readFileSync('/proc/' + pid + '/cmdline').toString('utf8').replace(/\0/g, ' ').trim();
      var comm = fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim();
      if (comm === 'mpd' || /cliairplay/i.test(command) || /wireless_output_manager/i.test(command)) {
        found.push({ pid: pid, command: command || comm });
      }
    } catch (error) {}
  });
  return found.sort(function (left, right) { return Number(left.pid) - Number(right.pid); });
}

function fifoHeldBy(pid) {
  try {
    return fs.readdirSync('/proc/' + pid + '/fd').some(function (fd) {
      try { return fs.readlinkSync('/proc/' + pid + '/fd/' + fd) === AUDIO_FIFO; } catch (error) { return false; }
    });
  } catch (error) { return false; }
}

function readProcess(candidate) {
  var base = '/proc/' + candidate.pid;
  var state = '?';
  var wchan = '?';
  var io = {};
  try {
    var stat = fs.readFileSync(base + '/stat', 'utf8');
    state = stat.slice(stat.lastIndexOf(') ') + 2).split(' ')[0];
  } catch (error) {}
  try { wchan = fs.readFileSync(base + '/wchan', 'utf8').trim(); } catch (error) {}
  try {
    fs.readFileSync(base + '/io', 'utf8').split(/\r?\n/).forEach(function (line) {
      var match = line.match(/^([^:]+):\s*(\d+)/);
      if (match && ['rchar', 'wchar', 'syscr', 'syscw'].indexOf(match[1]) !== -1) io[match[1]] = match[2];
    });
  } catch (error) {}
  return {
    pid: Number(candidate.pid),
    command: candidate.command,
    state: state,
    wchan: wchan,
    fifo: fifoHeldBy(candidate.pid),
    io: io
  };
}

function processSnapshot() {
  if (stopping) return;
  var snapshot = processCandidates().map(readProcess);
  var signature = JSON.stringify(snapshot.map(function (item) {
    return { pid: item.pid, command: item.command, state: item.state, wchan: item.wchan, fifo: item.fifo };
  }));
  var now = Date.now();
  if (signature !== lastProcessSignature || now - lastProcessLogAt >= HEARTBEAT_MS) {
    write('processes', JSON.stringify(snapshot));
    lastProcessSignature = signature;
    lastProcessLogAt = now;
  }
}

function networkSnapshot() {
  if (stopping || !selectedAddress) return;
  childProcess.execFile('ss', ['-tn'], { timeout: 3000, maxBuffer: 1024 * 1024 }, function (error, stdout) {
    if (stopping) return;
    if (error && error.code === 'ENOENT') {
      if (lastNetworkSignature !== 'unavailable') write('network', 'ss is unavailable');
      lastNetworkSignature = 'unavailable';
      return;
    }
    var lines = String(stdout || '').split(/\r?\n/).filter(function (line) {
      return line.indexOf(selectedAddress) !== -1;
    });
    var signature = lines.join(' | ');
    if (signature !== lastNetworkSignature) {
      write('network', signature || 'no TCP connection shown for ' + selectedAddress);
      lastNetworkSignature = signature;
    }
  });
}

function finish(reason) {
  if (stopping) return;
  stopping = true;
  timers.forEach(clearInterval);
  children.forEach(function (child) { try { child.kill('SIGTERM'); } catch (error) {} });
  write('monitor', 'stopping: ' + reason);
  captureOnce('final-systemctl', 'systemctl', ['show', 'volumio', '-p', 'ActiveState', '-p', 'NRestarts']);
  report.end(function () {
    try {
      var uid = Number(process.env.SUDO_UID);
      var gid = Number(process.env.SUDO_GID);
      if (Number.isInteger(uid) && Number.isInteger(gid)) fs.chownSync(reportPath, uid, gid);
      fs.chmodSync(reportPath, 0o640);
    } catch (error) {}
    process.stdout.write('\nReport saved to:\n' + reportPath + '\n');
    process.exit(0);
  });
}

write('monitor', 'started pollMs=' + POLL_MS + ' processMs=' + PROCESS_MS + ' maxRuntimeMs=' + MAX_RUNTIME_MS);
write('configuration', JSON.stringify(readSafeConfiguration()));
try {
  var packageJson = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'package.json'), 'utf8'));
  write('plugin', 'version=' + packageJson.version);
} catch (error) { write('plugin-error', error.message); }
captureOnce('uname', 'uname', ['-a']);
captureOnce('systemctl', 'systemctl', ['show', 'volumio', '-p', 'ActiveState', '-p', 'NRestarts']);
captureOnce('mpc-outputs', 'mpc', ['outputs']);

follow('journal', 'journalctl', [
  '-f', '--since', 'now', '-o', 'short-iso-precise', '--no-pager',
  '-u', 'volumio', '-u', 'mpd', '-u', 'bluealsa', '-u', 'bluetooth'
]);
if (fs.existsSync('/var/log/mpd.log')) follow('mpd-log', 'tail', ['-n', '0', '-F', '/var/log/mpd.log']);

apiSnapshot();
processSnapshot();
networkSnapshot();
timers.push(setInterval(apiSnapshot, POLL_MS));
timers.push(setInterval(processSnapshot, PROCESS_MS));
timers.push(setInterval(networkSnapshot, NETWORK_MS));
timers.push(setTimeout(function () { finish('30-minute safety limit'); }, MAX_RUNTIME_MS));

var input = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
input.setPrompt('marker> ');
input.on('line', function (line) {
  line = oneLine(line);
  if (line) {
    write('USER-MARKER', line);
    process.stdout.write('Marked: ' + line + '\n');
  }
  input.prompt();
});
input.on('close', function () { if (!stopping) finish('input closed'); });
process.on('SIGINT', function () { finish('Ctrl-C'); });
process.on('SIGTERM', function () { finish('SIGTERM'); });

process.stdout.write('AirPlay monitor is running. Type a short marker whenever you act or notice a problem.\n');
process.stdout.write('Examples: pressed Next | controls froze | audio stopped | audio recovered\n');
process.stdout.write('Press Ctrl-C when finished.\n');
input.prompt();
