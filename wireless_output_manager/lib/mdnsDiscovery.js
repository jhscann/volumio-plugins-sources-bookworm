'use strict';

var dgram = require('dgram');

var MDNS_ADDRESS = '224.0.0.251';
var MDNS_PORT = 5353;

function encodeName(name) {
  var parts = String(name || '').replace(/\.$/, '').split('.');
  var chunks = [];
  parts.forEach(function (part) {
    var value = Buffer.from(part, 'utf8');
    if (value.length > 63) throw new Error('Invalid mDNS label');
    chunks.push(Buffer.from([value.length]), value);
  });
  chunks.push(Buffer.from([0]));
  return Buffer.concat(chunks);
}

function readName(buffer, offset, seen) {
  var labels = [];
  var cursor = offset;
  var nextOffset = null;
  seen = seen || {};
  while (cursor < buffer.length) {
    var length = buffer[cursor];
    if ((length & 0xc0) === 0xc0) {
      if (cursor + 1 >= buffer.length) throw new Error('Truncated DNS pointer');
      var pointer = ((length & 0x3f) << 8) | buffer[cursor + 1];
      if (seen[pointer]) throw new Error('Recursive DNS pointer');
      seen[pointer] = true;
      var pointed = readName(buffer, pointer, seen);
      if (pointed.name) labels.push(pointed.name);
      nextOffset = nextOffset === null ? cursor + 2 : nextOffset;
      break;
    }
    cursor += 1;
    if (length === 0) {
      nextOffset = nextOffset === null ? cursor : nextOffset;
      break;
    }
    if (cursor + length > buffer.length) throw new Error('Truncated DNS label');
    labels.push(buffer.slice(cursor, cursor + length).toString('utf8'));
    cursor += length;
  }
  if (nextOffset === null) throw new Error('Unterminated DNS name');
  return { name: labels.join('.'), nextOffset: nextOffset };
}

function buildQuery(serviceTypes) {
  var questions = serviceTypes.map(function (serviceType) {
    var name = encodeName(serviceType + '.local');
    var tail = Buffer.alloc(4);
    tail.writeUInt16BE(12, 0); // PTR
    tail.writeUInt16BE(1, 2); // IN, multicast response
    return Buffer.concat([name, tail]);
  });
  var header = Buffer.alloc(12);
  header.writeUInt16BE(serviceTypes.length, 4);
  return Buffer.concat([header].concat(questions));
}

function parseTxt(buffer, offset, length) {
  var result = {};
  var end = offset + length;
  while (offset < end) {
    var itemLength = buffer[offset];
    offset += 1;
    if (offset + itemLength > end) break;
    var item = buffer.slice(offset, offset + itemLength).toString('utf8');
    var separator = item.indexOf('=');
    if (separator === -1) result[item.toLowerCase()] = '';
    else result[item.slice(0, separator).toLowerCase()] = item.slice(separator + 1);
    offset += itemLength;
  }
  return result;
}

function parsePacket(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) throw new Error('Invalid DNS packet');
  var questionCount = buffer.readUInt16BE(4);
  var recordCount = buffer.readUInt16BE(6) + buffer.readUInt16BE(8) + buffer.readUInt16BE(10);
  var offset = 12;
  for (var question = 0; question < questionCount; question += 1) {
    var questionName = readName(buffer, offset);
    offset = questionName.nextOffset + 4;
    if (offset > buffer.length) throw new Error('Truncated DNS question');
  }
  var records = [];
  for (var index = 0; index < recordCount; index += 1) {
    var owner = readName(buffer, offset);
    offset = owner.nextOffset;
    if (offset + 10 > buffer.length) throw new Error('Truncated DNS record');
    var type = buffer.readUInt16BE(offset);
    var recordClass = buffer.readUInt16BE(offset + 2) & 0x7fff;
    var length = buffer.readUInt16BE(offset + 8);
    var dataOffset = offset + 10;
    var dataEnd = dataOffset + length;
    if (dataEnd > buffer.length) throw new Error('Truncated DNS record data');
    var data = null;
    if (type === 12) data = readName(buffer, dataOffset).name;
    else if (type === 33 && length >= 6) {
      data = { port: buffer.readUInt16BE(dataOffset + 4), target: readName(buffer, dataOffset + 6).name };
    } else if (type === 16) data = parseTxt(buffer, dataOffset, length);
    else if (type === 1 && length === 4) {
      data = Array.prototype.join.call(buffer.slice(dataOffset, dataEnd), '.');
    }
    if (data !== null && recordClass === 1) {
      records.push({ name: owner.name, type: type, data: data });
    }
    offset = dataEnd;
  }
  return records;
}

function MdnsDiscovery(options) {
  options = options || {};
  this.timeoutMs = options.timeoutMs || 3500;
  this.socketFactory = options.socketFactory || function () {
    return dgram.createSocket({ type: 'udp4', reuseAddr: true });
  };
}

MdnsDiscovery.prototype._recordsToServices = function (records, serviceTypes) {
  function key(value) { return String(value || '').replace(/\.$/, '').toLowerCase(); }
  var ptr = {};
  var srv = {};
  var txt = {};
  var addresses = {};
  records.forEach(function (record) {
    var name = key(record.name);
    if (record.type === 12) {
      if (!ptr[name]) ptr[name] = [];
      if (ptr[name].indexOf(record.data) === -1) ptr[name].push(record.data);
    } else if (record.type === 33) srv[name] = record.data;
    else if (record.type === 16) txt[name] = record.data;
    else if (record.type === 1) {
      if (!addresses[name]) addresses[name] = [];
      if (addresses[name].indexOf(record.data) === -1) addresses[name].push(record.data);
    }
  });
  var services = [];
  serviceTypes.forEach(function (serviceType) {
    var fullType = key(serviceType + '.local');
    (ptr[fullType] || []).forEach(function (instance) {
      var instanceKey = key(instance);
      var endpoint = srv[instanceKey];
      if (!endpoint) return;
      var targetKey = key(endpoint.target);
      var suffix = '.' + fullType;
      var serviceName = instanceKey.endsWith(suffix)
        ? instance.slice(0, instance.length - suffix.length)
        : instance;
      (addresses[targetKey] || []).forEach(function (address) {
        services.push({
          interface: 'mdns',
          family: 'IPv4',
          serviceName: serviceName,
          serviceType: serviceType,
          domain: 'local',
          hostname: endpoint.target,
          address: address,
          port: endpoint.port,
          txt: txt[instanceKey] || {}
        });
      });
    });
  });
  return services.filter(function (service) { return service.address && service.port; });
};

MdnsDiscovery.prototype.discover = function (serviceTypes) {
  var self = this;
  var socket = self.socketFactory();
  var query = buildQuery(serviceTypes);
  var records = [];
  return new Promise(function (resolve, reject) {
    var finished = false;
    var resend;
    function finish(error) {
      if (finished) return;
      finished = true;
      clearTimeout(resend);
      clearTimeout(timer);
      try { socket.close(); } catch (closeError) {}
      if (error) reject(error);
      else resolve(self._recordsToServices(records, serviceTypes));
    }
    socket.on('error', finish);
    socket.on('message', function (message) {
      try { records = records.concat(parsePacket(message)); } catch (error) {}
    });
    socket.bind(MDNS_PORT, function () {
      try {
        socket.addMembership(MDNS_ADDRESS);
        socket.setMulticastTTL(255);
        socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDRESS);
        resend = setTimeout(function () {
          if (!finished) socket.send(query, 0, query.length, MDNS_PORT, MDNS_ADDRESS);
        }, 1000);
      } catch (error) {
        finish(error);
      }
    });
    var timer = setTimeout(function () { finish(); }, self.timeoutMs);
  });
};

module.exports = {
  MdnsDiscovery: MdnsDiscovery,
  buildQuery: buildQuery,
  encodeName: encodeName,
  parsePacket: parsePacket,
  readName: readName
};
