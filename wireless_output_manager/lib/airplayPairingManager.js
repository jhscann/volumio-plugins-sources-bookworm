'use strict';

var spawn = require('child_process').spawn;

var DACP_ID = '574F4D50524F544F';
var HAP_CREDENTIALS_RE = /(?:^|\n)CREDENTIALS:\s*([0-9a-f]{192})(?:\r?\n|$)/i;
var LEGACY_SECRET_RE = /(?:^|\n)(?:Secret:\s*|secret is\s*)([0-9a-f]{1,64})(?:\r?\n|$)/i;

function delay(milliseconds) {
  return new Promise(function (resolve) { setTimeout(resolve, milliseconds); });
}

function withTimeout(promise, milliseconds, timeoutValue) {
  return new Promise(function (resolve) {
    var settled = false;
    var timer = setTimeout(function () {
      if (settled) return;
      settled = true;
      resolve(timeoutValue);
    }, milliseconds);
    promise.then(function (value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    });
  });
}

function AirPlayPairingManager(options) {
  options = options || {};
  this.adapter = options.adapter;
  this.logger = options.logger || { info: function () {}, warn: function () {} };
  this.spawn = options.spawn || spawn;
  this.sessionTimeoutMs = options.sessionTimeoutMs || 120000;
  this.startSettleMs = options.startSettleMs === undefined ? 750 : options.startSettleMs;
  this.legacyStartSettleMs = options.legacyStartSettleMs === undefined ? 7000 : options.legacyStartSettleMs;
  this.session = null;
}

AirPlayPairingManager.prototype._endpoint = function (receiver, mode) {
  var service = receiver && (mode === 'legacy' ? (receiver.raop || receiver.airplay) : receiver.airplay);
  if (!receiver || !receiver.address || !service || !service.port) {
    throw new Error(mode === 'legacy'
      ? 'The selected receiver does not expose a legacy AirPlay pairing endpoint'
      : 'The selected receiver does not expose an AirPlay 2 pairing endpoint');
  }
  return { address: receiver.address, port: service.port };
};

AirPlayPairingManager.prototype._append = function (session, chunk) {
  session.output = (session.output + chunk.toString('utf8')).slice(-64 * 1024);
};

AirPlayPairingManager.prototype._friendlyFailure = function (output, fallback) {
  var text = String(output || '');
  if (/HAP(?:[_ -]?ERROR)?\s*[:=]?\s*0?2|Device error in M4:\s*0?2|wrong.*pin|authentication/i.test(text)) {
    return new Error('The Apple TV rejected that PIN. Start pairing again and enter the new code shown on the television.');
  }
  if (/HAP(?:[_ -]?ERROR)?\s*[:=]?\s*0?(?:3|5)|Device error in M4:\s*0?(?:3|5)|backoff|max.*tries|rate.?limit/i.test(text)) {
    return new Error('The Apple TV is temporarily limiting pairing attempts. Wait a minute, then start pairing again.');
  }
  return new Error(fallback || 'Apple TV pairing did not complete');
};

AirPlayPairingManager.prototype.start = async function (receiver, options) {
  var self = this;
  options = options || {};
  await self.cancel();
  var mode = options.mode === 'legacy' ? 'legacy' : 'hap';
  var endpoint = self._endpoint(receiver, mode);
  var sender = await self.adapter.checkSender();
  var args = mode === 'legacy' ? ['--pair'] : [
    '--pair-setup', '--port', String(endpoint.port), '--dacp', DACP_ID, endpoint.address
  ];
  var child = self.spawn(sender.binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  var session = {
    receiverId: String(receiver.id || ''),
    receiverName: String(receiver.name || receiver.id || 'Apple TV'),
    address: endpoint.address,
    mode: mode,
    child: child,
    output: '',
    startedAt: Date.now(),
    settled: false,
    exit: null,
    timer: null
  };
  self.session = session;
  if (child.stdout) child.stdout.on('data', function (chunk) { self._append(session, chunk); });
  if (child.stderr) child.stderr.on('data', function (chunk) { self._append(session, chunk); });
  session.exit = new Promise(function (resolve) {
    var done = false;
    function finish(outcome) {
      if (done) return;
      done = true;
      if (session.timer) clearTimeout(session.timer);
      resolve(outcome);
    }
    child.once('error', function (error) { finish({ error: error }); });
    child.once('close', function (code, signal) { finish({ code: code, signal: signal }); });
  });
  session.timer = setTimeout(function () {
    if (self.session !== session) return;
    self.logger.warn('Apple TV pairing session expired for ' + session.receiverName);
    self.cancel().catch(function () {});
  }, self.sessionTimeoutMs);
  if (session.timer.unref) session.timer.unref();

  if (mode === 'legacy') {
    if (!child.stdin || child.stdin.destroyed) {
      await self.cancel();
      throw new Error('The legacy Apple TV pairing process did not accept the selected receiver');
    }
    child.stdin.write(endpoint.address + '\n');
  }

  var early = await Promise.race([
    session.exit.then(function (outcome) { return { exited: true, outcome: outcome }; }),
    delay(mode === 'legacy' ? self.legacyStartSettleMs : self.startSettleMs)
      .then(function () { return { exited: false }; })
  ]);
  if (early.exited) {
    if (self.session === session) self.session = null;
    throw self._friendlyFailure(session.output,
      'The Apple TV did not start pairing. Check its AirPlay access settings and try again.');
  }
  session.settled = true;
  self.logger.info((mode === 'legacy' ? 'Legacy Apple TV' : 'Apple TV') +
    ' pairing request started for ' + session.receiverName);
  return {
    receiverId: session.receiverId,
    receiverName: session.receiverName,
    mode: mode,
    expiresInSeconds: Math.round(self.sessionTimeoutMs / 1000)
  };
};

AirPlayPairingManager.prototype.finish = async function (receiverId, pin) {
  var self = this;
  var session = self.session;
  pin = String(pin || '').trim();
  if (!/^\d{4}$/.test(pin)) throw new Error('Enter the four-digit PIN shown on the Apple TV');
  if (!session || session.receiverId !== String(receiverId || '')) {
    throw new Error('The Apple TV pairing session has expired. Start pairing again.');
  }
  if (!session.child.stdin || session.child.stdin.destroyed) {
    await self.cancel();
    throw new Error('The Apple TV pairing session ended. Start pairing again.');
  }
  try {
    session.child.stdin.write(pin + '\n');
  } catch (error) {
    await self.cancel();
    throw new Error('The Apple TV pairing session ended. Start pairing again.');
  }
  var outcome = await withTimeout(session.exit, 30000, { timedOut: true });
  var credentials = (session.output.match(session.mode === 'legacy'
    ? LEGACY_SECRET_RE : HAP_CREDENTIALS_RE) || [])[1] || '';
  self.session = null;
  if (session.timer) clearTimeout(session.timer);
  if (outcome.timedOut) {
    if (!session.child.killed) session.child.kill('SIGTERM');
    throw new Error('Apple TV pairing timed out. Start pairing again and enter the displayed PIN promptly.');
  }
  var validCredentials = session.mode === 'legacy'
    ? /^[0-9a-f]{1,64}$/i.test(credentials)
    : credentials.length === 192;
  if (outcome.error || outcome.code !== 0 || !validCredentials) {
    throw self._friendlyFailure(session.output, 'Apple TV pairing failed. Start pairing again and use the new PIN.');
  }
  self.logger.info((session.mode === 'legacy' ? 'Legacy Apple TV' : 'Apple TV') +
    ' pairing completed for ' + session.receiverName);
  return { mode: session.mode, credentials: credentials.toLowerCase() };
};

AirPlayPairingManager.prototype.cancel = async function () {
  var session = this.session;
  this.session = null;
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  if (session.child && !session.child.killed) session.child.kill('SIGTERM');
};

AirPlayPairingManager.prototype.getStatus = function () {
  if (!this.session) return { active: false };
  return {
    active: true,
    receiverId: this.session.receiverId,
    receiverName: this.session.receiverName,
    mode: this.session.mode,
    startedAt: this.session.startedAt
  };
};

AirPlayPairingManager.DACP_ID = DACP_ID;
module.exports = AirPlayPairingManager;
