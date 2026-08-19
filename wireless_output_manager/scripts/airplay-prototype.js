#!/usr/bin/env node
'use strict';

var path = require('path');
var CommandRunner = require('../lib/commandRunner').CommandRunner;
var AirPlayAdapter = require('../lib/adapters/airplay');
var AirPlayPrototype = require('../lib/airplayPrototype').AirPlayPrototype;

function option(name, fallback) {
  var index = process.argv.indexOf(name);
  return index === -1 || process.argv[index + 1] === undefined ? fallback : process.argv[index + 1];
}

function printable(receiver) {
  return {
    id: receiver.id,
    name: receiver.name,
    address: receiver.address,
    addresses: receiver.addresses,
    protocols: receiver.protocols,
    airplayPort: receiver.airplay ? receiver.airplay.port : null,
    raopPort: receiver.raop ? receiver.raop.port : null,
    model: (receiver.airplay && (receiver.airplay.txt.model || receiver.airplay.txt.am)) ||
      (receiver.raop && receiver.raop.txt.am) || ''
  };
}

async function main() {
  var command = process.argv[2] || 'discover';
  var runner = new CommandRunner({ defaultTimeoutMs: 15000 });
  var adapter = new AirPlayAdapter({
    runner: runner,
    pluginDir: path.resolve(__dirname, '..'),
    binaryPath: option('--binary', '')
  });
  var prototype = new AirPlayPrototype({ adapter: adapter, runner: runner });

  if (command === 'check') {
    console.log(JSON.stringify(await adapter.checkSender(), null, 2));
    return;
  }
  var receivers = await adapter.discover();
  if (command === 'discover') {
    console.log(JSON.stringify(receivers.map(printable), null, 2));
    return;
  }
  if (command === 'tone') {
    var receiver = prototype.findReceiver(receivers, option('--device', ''));
    console.error('Sending a quiet test tone to ' + receiver.name +
      '. Keep headphones off until its level is confirmed.');
    var result = await prototype.playTestTone(receiver, {
      address: option('--address', ''),
      volume: option('--volume', 5),
      seconds: option('--seconds', 3),
      frequency: option('--frequency', 440)
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  throw new Error('Usage: airplay-prototype.js discover|check|tone --device <name-or-id> ' +
    '[--address <advertised-ip>] [--volume 0-15] [--seconds 1-10]');
}

main().catch(function (error) {
  console.error('AirPlay prototype failed: ' + error.message);
  process.exitCode = 1;
});
