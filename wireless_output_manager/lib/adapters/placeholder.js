'use strict';

module.exports = function PlaceholderAdapter(name) {
  function unavailable() { return Promise.reject(new Error(name + ' output is not implemented')); }
  this.start = unavailable;
  this.stop = function () { return Promise.resolve(); };
  this.scan = unavailable;
  this.listDevices = unavailable;
  this.listPairedDevices = unavailable;
  this.pair = unavailable;
  this.trust = unavailable;
  this.connect = unavailable;
  this.disconnect = unavailable;
  this.forget = unavailable;
  this.getStatus = function () { return Promise.resolve({ backend: name, implemented: false }); };
  this.getDiagnostics = this.getStatus;
  this.createOutput = unavailable;
  this.removeOutput = function () { return Promise.resolve(); };
};
