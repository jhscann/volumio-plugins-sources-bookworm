'use strict';

var http = require('http');

function VolumioApi(options) {
  options = options || {};
  this.host = options.host || '127.0.0.1';
  this.port = options.port || 3000;
  this.timeoutMs = options.timeoutMs || 5000;
  this.request = options.request || this._request.bind(this);
}

VolumioApi.prototype._request = function (requestPath) {
  var self = this;
  return new Promise(function (resolve, reject) {
    var body = '';
    var finished = false;
    var request = http.get({ host: self.host, port: self.port, path: requestPath }, function (response) {
      response.setEncoding('utf8');
      response.on('data', function (chunk) {
        body += chunk;
        if (body.length > 128 * 1024) request.destroy(new Error('Volumio API response was too large'));
      });
      response.on('end', function () {
        if (finished) return;
        finished = true;
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error('Volumio API returned HTTP ' + response.statusCode));
          return;
        }
        resolve(body);
      });
    });
    request.setTimeout(self.timeoutMs, function () {
      request.destroy(new Error('Volumio API request timed out'));
    });
    request.on('error', function (error) {
      if (finished) return;
      finished = true;
      reject(error);
    });
  });
};

VolumioApi.prototype.getState = async function () {
  var body = await this.request('/api/v1/getState');
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error('Volumio returned an invalid player state: ' + error.message);
  }
};

VolumioApi.prototype.setVolume = function (volume) {
  return this.request('/api/v1/commands/?cmd=volume&volume=' + encodeURIComponent(String(volume)));
};

module.exports = VolumioApi;
