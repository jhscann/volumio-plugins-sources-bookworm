'use strict';

var spawn = require('child_process').spawn;

function CommandError(message, result) {
  Error.call(this, message);
  this.name = 'CommandError';
  this.message = message;
  this.result = result;
  if (Error.captureStackTrace) Error.captureStackTrace(this, CommandError);
}
CommandError.prototype = Object.create(Error.prototype);
CommandError.prototype.constructor = CommandError;

function CommandRunner(options) {
  options = options || {};
  this.defaultTimeoutMs = options.defaultTimeoutMs || 15000;
  this.maxOutputBytes = options.maxOutputBytes || 256 * 1024;
  this.logger = options.logger;
}

CommandRunner.prototype.run = function (command, args, options) {
  var self = this;
  args = Array.isArray(args) ? args : [];
  options = options || {};
  var timeoutMs = options.timeoutMs || self.defaultTimeoutMs;

  return new Promise(function (resolve, reject) {
    var stdout = '';
    var stderr = '';
    var finished = false;
    var timedOut = false;
    var child;

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        env: options.env || process.env,
        uid: options.uid,
        gid: options.gid,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(new CommandError('Unable to start ' + command + ': ' + error.message, {
        command: command, args: args, exitCode: null, stdout: '', stderr: '', timedOut: false
      }));
      return;
    }

    function append(current, chunk) {
      current += chunk.toString('utf8');
      if (Buffer.byteLength(current, 'utf8') > self.maxOutputBytes) {
        current = current.slice(-self.maxOutputBytes);
      }
      return current;
    }

    child.stdout.on('data', function (chunk) { stdout = append(stdout, chunk); });
    child.stderr.on('data', function (chunk) { stderr = append(stderr, chunk); });

    var timer = setTimeout(function () {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(function () { if (!finished) child.kill('SIGKILL'); }, 1000).unref();
    }, timeoutMs);

    child.on('error', function (error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(new CommandError('Command failed to start: ' + error.message, {
        command: command, args: args, exitCode: null, stdout: stdout.trim(),
        stderr: stderr.trim(), timedOut: false
      }));
    });

    child.on('close', function (code, signal) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      var result = {
        command: command, args: args.slice(), exitCode: code, signal: signal,
        stdout: stdout.trim(), stderr: stderr.trim(), timedOut: timedOut
      };
      if (timedOut) {
        reject(new CommandError(command + ' timed out after ' + timeoutMs + ' ms', result));
      } else if (code !== 0 && !options.allowFailure) {
        reject(new CommandError(command + ' exited with code ' + code, result));
      } else {
        resolve(result);
      }
    });

    if (options.input) child.stdin.write(options.input);
    child.stdin.end();
  });
};

module.exports = { CommandRunner: CommandRunner, CommandError: CommandError };
