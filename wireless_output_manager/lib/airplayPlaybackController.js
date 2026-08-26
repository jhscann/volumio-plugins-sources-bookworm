'use strict';

function identity(state) {
  if (!state) return '';
  if (state.uri) {
    // Volumio can expose the same MPD file with mnt/ or music-library/
    // prefixes in consecutive state pushes. Treat those as one track so a
    // state refinement cannot trigger a second AirPlay flush.
    return String(state.uri).replace(/^\/+/, '').replace(/^(?:mnt|music-library)\//i, '');
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
  this.pausedTrackHandoff = false;
  this.queue = Promise.resolve();
}

AirPlayPlaybackController.prototype.reset = function () {
  this.previous = null;
  this.pausedTrackHandoff = false;
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
  if (current.status === 'stop') {
    // Next/Previous first publishes stop. Release a paused sender immediately
    // so MPD cannot block while opening the FIFO for the replacement track.
    // releasePause also flushes stale receiver audio, so an explicit Stop from
    // Pause remains silent.
    if (previous.status === 'pause') {
      this.pausedTrackHandoff = true;
      return 'release-pause';
    }
    return null;
  }
  if (current.status !== 'play') return null;
  // A replacement track following Pause -> Stop needs a fresh AirPlay anchor.
  // PLAY at Stop releases the PCM reader; transition now flushes any old
  // receiver audio, waits for the new PCM and issues START for its timeline.
  if (this.pausedTrackHandoff) {
    this.pausedTrackHandoff = false;
    return 'transition';
  }
  // Keep ordinary track changes continuous. Flushing here can discard the
  // receiver's unplayed tail at a natural track ending, and Volumio may emit
  // more than one identity representation during a single hand-off. Metadata
  // updates are harmless if repeated and do not interrupt the PCM stream.
  if (current.identity && previous.identity && current.identity !== previous.identity) return 'metadata';
  if (previous.status === 'stop') {
    var bridgeStatus = this.bridge && typeof this.bridge.getStatus === 'function'
      ? this.bridge.getStatus() : { audioStarted: true };
    return bridgeStatus.audioStarted ? 'metadata' : null;
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
    var actionStartedAt = self.now();
    self.logger.info('AirPlay playback state action: ' + action);
    var operation;
    if (action === 'pause') operation = self.bridge.pause();
    else if (action === 'resume') operation = self.bridge.resume();
    else if (action === 'release-pause') operation = self.bridge.releasePause();
    else if (action === 'metadata') operation = self.bridge.updateMetadata(current.metadata);
    else operation = self.bridge.transition(current.metadata);
    return Promise.resolve(operation).then(function () {
      self.logger.info('AirPlay playback action completed: ' + action + ' (' +
        Math.max(0, self.now() - actionStartedAt) + ' ms)');
    });
  }).catch(function (error) {
    self.logger.warn('AirPlay playback state action failed: ' + error.message);
  });
  return self.queue;
};

module.exports = AirPlayPlaybackController;
