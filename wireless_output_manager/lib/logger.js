'use strict';

module.exports = function createLogger(logger, scope, debugEnabled) {
  var prefix = '[Wireless Output Manager]' + (scope ? '[' + scope + ']' : '') + ' ';
  return {
    info: function (message) { logger.info(prefix + message); },
    warn: function (message) { logger.warn(prefix + message); },
    error: function (message) { logger.error(prefix + message); },
    debug: function (message) { if (debugEnabled()) logger.info(prefix + '[debug] ' + message); }
  };
};
