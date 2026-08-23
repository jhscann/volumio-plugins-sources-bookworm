'use strict';

function identity(state) {
  if (!state) return '';
  if (state.uri) {
    // Volumio can expose the same MPD file as either NAS/... or mnt/NAS/...
    // in consecutive state pushes. Treat those as one track so a metadata
    // refinement cannot trigger a second AirPlay flush.
    return String(state.uri).replace(/^\/+/, '').replace(/^mnt\//i, '');
  }
  return [state.service, state.position, state.artist, state.album, state.title]
    .map(function (value) { return String(value === undefined ? '' : value); }).join('|');
}

function metadata(state) {
  return {
    title: state && state.title,
    artist: state && state.artist,
    album: state && state.album,
    duration: state && state.duration
  };
}

function AirPlayPlaybackController(options) {
  options = options || {};
  this.bridge = options.bridge;
  this.logger = options.logger || { info: function () {}, warn: function () {} };
  this.isActive = options.isActive || function () { return false; };
  this.now = options.now || Date.now;
  this.seekThresholdMs = Number(options.seekThresholdMs) || 4000;
  this.previous = null;
  this.queue = Promise.resolve();
}

AirPlayPlaybackController.prototype.reset = function () {
  this.previous = null;
  this.queue = Promise.resolve();
};

AirPlayPlaybackController.prototype._snapshot = function (state) {
  return {
    status: String(state.status || '').toLowerCase(),
    identity: identity(state),
    seek: Number(state.seek),
    observedAt: this.now(),
    metadata: metadata(state)
  };
};

AirPlayPlaybackController.prototype._actionFor = function (previous, current) {
  if (!previous) return null;
  if (current.status === 'pause' && previous.status === 'play') return 'pause';
  if (current.status === 'play' && previous.status === 'pause' && current.identity === previous.identity) {
    return 'resume';
  }
  // Never put the sender into standby when Volumio stops. MPD must be able to
  // close its ALSA/FIFO output while the sender continues consuming it;
  // otherwise MPD can block until its watchdog terminates it.
  if (current.status === 'stop') return null;
  if (current.status !== 'play') return null;
  if (current.identity && previous.identity && current.identity !== previous.identity) return 'transition';
  if (previous.status === 'stop') {
    var bridgeStatus = this.bridge && typeof this.bridge.getStatus === 'function'
      ? this.bridge.getStatus() : { audioStarted: true };
    return bridgeStatus.audioStarted ? 'transition' : null;
  }
  if (current.identity === previous.identity && Number.isFinite(current.seek) && Number.isFinite(previous.seek)) {
    var elapsed = previous.status === 'play' ? current.observedAt - previous.observedAt : 0;
    if (Math.abs(current.seek - (previous.seek + elapsed)) > this.seekThresholdMs) return 'transition';
  }
  return null;
};

AirPlayPlaybackController.prototype.handle = function (state) {
  var self = this;
  if (!state || !self.isActive()) {
    self.previous = null;
    return Promise.resolve();
  }
  var current = self._snapshot(state);
  var action = self._actionFor(self.previous, current);
  self.previous = current;
  if (!action) return Promise.resolve();
  self.queue = self.queue.catch(function () {}).then(function () {
    if (!self.isActive()) return;
    self.logger.info('AirPlay playback state action: ' + action);
    if (action === 'pause') return self.bridge.pause();
    if (action === 'resume') return self.bridge.resume();
    return self.bridge.transition(current.metadata);
  }).catch(function (error) {
    self.logger.warn('AirPlay playback state action failed: ' + error.message);
  });
  return self.queue;
};

module.exports = AirPlayPlaybackController;
