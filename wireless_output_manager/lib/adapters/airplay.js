'use strict';

var fs = require('fs-extra');
var path = require('path');
var MdnsDiscovery = require('../mdnsDiscovery').MdnsDiscovery;

var RAOP_FIELDS = ['et', 'md', 'am', 'pk', 'pw', 'cn'];

function AirPlayAdapter(options) {
  options = options || {};
  this.runner = options.runner;
  this.logger = options.logger || { info: function () {}, warn: function () {}, error: function () {} };
  this.pluginDir = options.pluginDir || path.resolve(__dirname, '..', '..');
  this.binaryPath = options.binaryPath || '';
  this.mdns = options.mdns || new MdnsDiscovery();
}

AirPlayAdapter.prototype._decodeAvahi = function (value) {
  return String(value || '').replace(/\\(\d{3})/g, function (_, code) {
    return String.fromCharCode(Number(code));
  }).replace(/\\([\\;])/g, '$1');
};

AirPlayAdapter.prototype._splitAvahi = function (line) {
  var fields = [];
  var current = '';
  var escaped = false;
  for (var index = 0; index < line.length; index += 1) {
    var character = line[index];
    if (escaped) {
      current += '\\' + character;
      escaped = false;
    } else if (character === '\\') {
      escaped = true;
    } else if (character === ';') {
      fields.push(this._decodeAvahi(current));
      current = '';
    } else {
      current += character;
    }
  }
  if (escaped) current += '\\';
  fields.push(this._decodeAvahi(current));
  return fields;
};

AirPlayAdapter.prototype._txt = function (fields) {
  var result = {};
  fields.forEach(function (field) {
    var value = String(field || '').replace(/^"|"$/g, '');
    var separator = value.indexOf('=');
    if (separator === -1) result[value.toLowerCase()] = '';
    else result[value.slice(0, separator).toLowerCase()] = value.slice(separator + 1);
  });
  return result;
};

AirPlayAdapter.prototype.parseBrowseOutput = function (output) {
  var self = this;
  return String(output || '').split(/\r?\n/).filter(function (line) {
    return line[0] === '=';
  }).map(function (line) {
    var fields = self._splitAvahi(line);
    if (fields.length < 9) return null;
    var serviceType = fields[4];
    if (serviceType !== '_airplay._tcp' && serviceType !== '_raop._tcp') return null;
    return {
      interface: fields[1],
      family: fields[2],
      serviceName: fields[3],
      serviceType: serviceType,
      domain: fields[5],
      hostname: fields[6],
      address: fields[7],
      port: Number(fields[8]),
      txt: self._txt(fields.slice(9))
    };
  }).filter(Boolean);
};

AirPlayAdapter.prototype._deviceId = function (record) {
  var advertised = record.txt.deviceid || record.txt.device_id || '';
  var raopPrefix = record.serviceType === '_raop._tcp'
    ? String(record.serviceName || '').split('@')[0]
    : '';
  var candidate = advertised || raopPrefix;
  var normalized = candidate.replace(/[^0-9a-f]/gi, '').toUpperCase();
  if (normalized.length === 12) return normalized.match(/.{2}/g).join(':');
  return (record.address + '|' + record.hostname).toLowerCase();
};

AirPlayAdapter.prototype.mergeRecords = function (records) {
  var self = this;
  var devices = [];
  records.forEach(function (record) {
    var id = self._deviceId(record);
    var device = devices.find(function (candidate) {
      return candidate.id === id || candidate.address === record.address ||
        (candidate.hostname && candidate.hostname === record.hostname);
    });
    if (!device) {
      device = {
        id: id,
        name: record.txt.name || String(record.serviceName || '').replace(/^[^@]+@/, ''),
        address: record.address,
        addresses: [],
        hostname: record.hostname,
        interface: record.interface,
        protocols: [],
        airplay: null,
        raop: null
      };
      devices.push(device);
    } else if (id.indexOf(':') !== -1 && device.id.indexOf(':') === -1) {
      device.id = id;
    }
    if (record.address && device.addresses.indexOf(record.address) === -1) {
      device.addresses.push(record.address);
    }
    if (record.serviceType === '_airplay._tcp') {
      if (!device.airplay || record.family === 'IPv4') device.airplay = record;
      if (device.protocols.indexOf('airplay2') === -1) device.protocols.push('airplay2');
      if (record.txt.name) device.name = record.txt.name;
    } else {
      if (!device.raop || record.family === 'IPv4') device.raop = record;
      if (device.protocols.indexOf('raop') === -1) device.protocols.push('raop');
    }
    if (!device.address) device.address = record.address;
  });
  return devices.sort(function (left, right) {
    return left.name.localeCompare(right.name);
  });
};

AirPlayAdapter.prototype.discover = async function () {
  var browse = await this.runner.run('which', ['avahi-browse'], {
    allowFailure: true,
    timeoutMs: 3000
  }).catch(function () { return { exitCode: 1 }; });
  if (browse.exitCode !== 0) {
    this.logger.info('avahi-browse is unavailable; using the built-in mDNS discovery client');
    return this.mergeRecords(await this.mdns.discover(['_airplay._tcp', '_raop._tcp']));
  }
  var checks = await Promise.all(['_airplay._tcp', '_raop._tcp'].map(function (serviceType) {
    return this.runner.run('avahi-browse', ['-rtp', serviceType], {
      allowFailure: true,
      timeoutMs: 8000
    });
  }, this));
  if (checks.every(function (result) { return result.exitCode !== 0; })) {
    var detail = checks.map(function (result) { return result.stderr; }).filter(Boolean).join('; ');
    throw new Error('AirPlay discovery is unavailable. Check avahi-daemon and avahi-browse' +
      (detail ? ': ' + detail : ''));
  }
  var records = [];
  checks.forEach(function (result) {
    records = records.concat(this.parseBrowseOutput(result.stdout));
  }, this);
  return this.mergeRecords(records);
};

AirPlayAdapter.prototype._platformName = function () {
  var platform = process.platform === 'darwin' ? 'macos' : process.platform;
  var architecture = process.arch === 'arm64' && platform === 'linux' ? 'aarch64' :
    (process.arch === 'x64' ? 'x86_64' : process.arch);
  return platform + '-' + architecture;
};

AirPlayAdapter.prototype.findBinary = async function () {
  var candidates = [
    this.binaryPath,
    process.env.WOM_AIRPLAY_BINARY,
    path.join(this.pluginDir, 'bin', 'airplay', 'cliairplay-' + this._platformName())
  ].filter(Boolean);
  for (var index = 0; index < candidates.length; index += 1) {
    if (await fs.pathExists(candidates[index])) return candidates[index];
  }
  var located = await this.runner.run('which', ['cliairplay'], { allowFailure: true, timeoutMs: 3000 });
  if (located.exitCode === 0 && located.stdout) return located.stdout.split(/\r?\n/)[0];
  throw new Error('cliairplay is not installed for ' + this._platformName() +
    '. Run scripts/install-airplay-prototype-sender.sh first');
};

AirPlayAdapter.prototype.checkSender = async function () {
  var binary = await this.findBinary();
  var result = await this.runner.run(binary, ['--check'], { allowFailure: true, timeoutMs: 5000 });
  if (result.exitCode !== 0 || !/cliairplay.*check/i.test(result.stdout + ' ' + result.stderr)) {
    throw new Error('The AirPlay sender binary failed its self-check');
  }
  return { available: true, binary: binary, output: result.stdout || result.stderr };
};

AirPlayAdapter.prototype.getSourceAddress = async function (targetAddress) {
  if (process.platform !== 'linux') return '';
  var route = await this.runner.run('ip', ['route', 'get', targetAddress], {
    allowFailure: true,
    timeoutMs: 3000
  });
  if (route.exitCode !== 0) return '';
  var match = route.stdout.match(/\bsrc\s+(\S+)/);
  return match ? match[1] : '';
};

AirPlayAdapter.prototype.buildSenderArgs = function (receiver, commandPipe, volume, sourceAddress) {
  if (!receiver || !receiver.address) throw new Error('A resolved AirPlay receiver is required');
  var airplay = receiver.airplay;
  var raop = receiver.raop;
  var protocol = airplay ? (raop ? 'auto' : 'airplay2') : 'raop';
  var endpoint = airplay || raop;
  var args = [
    '--protocol', protocol,
    '--volume', String(volume),
    '--dacp', '574F4D50524F544F',
    '--activeremote', '1464814928',
    '--cmdpipe', commandPipe,
    '--samplerate', '44100',
    '--bitdepth', '16',
    '--channels', '2',
    '--port', String(endpoint.port),
    '--debug', '4'
  ];
  if (sourceAddress) args.push('--if', sourceAddress);
  if (airplay) {
    args.push('--name', receiver.name, '--hostname', airplay.hostname);
    var txt = Object.keys(airplay.txt).sort().map(function (key) {
      return key + (airplay.txt[key] === '' ? '' : '=' + airplay.txt[key]);
    });
    if (!airplay.txt.features && !airplay.txt.ft && raop && raop.txt.ft) txt.push('ft=' + raop.txt.ft);
    if (txt.length) args.push('--txt', txt.join(' '));
  }
  if (raop) {
    args.push('--udn', raop.serviceName);
    RAOP_FIELDS.forEach(function (field) {
      if (raop.txt[field]) args.push('--' + field, raop.txt[field]);
    });
  }
  args.push(receiver.address);
  return args;
};

module.exports = AirPlayAdapter;
