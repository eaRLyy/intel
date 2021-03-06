/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const path = require('path');
const util = require('util');

const chalk = require('chalk');
const dbug = require('dbug');
const stack = require('stack-trace');
const utc = require('utcstring');

const intel = require('./');

const ALIASES = [
  'trace',
  'debug',
  'info',
  'warn',
  'error'
];

function copyProperties(source, target, props) {
  props.forEach(function(prop) {
    target[prop] = source[prop];
  });
}

var ORIGINAL_METHODS = {};
const METHOD_NAMES = [
  'trace',
  'debug',
  'dir',
  'error',
  'info',
  'log',
  'warn'
];

function endsWith(str, suffix) {
  return str.indexOf(suffix, str.length - suffix.length) !== -1;
}

var root;
var ignore;


function getLoggerName(debugName) {
  var trace = stack.get();
  // walk up the stack until we find a function that isn't from this
  // module. that's the calling module.
  // ALSO: 'console.js' could be on the stack if console.trace() or
  // something similar was called, cause we don't modify those, since
  // they internally call console.log(), which is us!
  var filename;
  var debug = [];
  if (debugName) {
    debug = [
      path.join('node_modules', 'debug', 'lib', 'debug.js'),
      path.join('node_modules', 'dbug', 'lib', 'dbug.js')
    ];
  }

  function skip(name) {
    if (name === __filename || name === 'console.js') {
      return true;
    }
    return debug.some(function(d) {
      return endsWith(name, d);
    });
  }

  for (var i = 0, len = trace.length; i < len; i++) {
    filename = trace[i].getFileName();
    if (!skip(filename)) {
      break;
    }
  }
  var topName = path.basename(root);
  topName = topName.replace(path.extname(topName), '');

  var moduleName = path.join(topName, path.relative(root, filename));
  moduleName = moduleName.replace(path.extname(moduleName), '');
  moduleName = moduleName.replace(/[\\\/]/g, '.');

  // lib is the defacto place to store js files, but removing lib looks
  // better: connect.lib.session -> connect.session
  moduleName = moduleName.replace(/\.lib\./g, '.');


  if (debugName) {
    // clean up duplicated parts of the name
    // ex: node_modules.intel.logger.intel.logger =>
    // node_modules.intel.logger
    var suffix = debugName;
    if (endsWith(moduleName, suffix)) {
      // just drop the suffix;
      return moduleName;
    }
    moduleName += '.' + debugName;
  }

  return moduleName;
}

function setRoot(r) {
  root = r;
}

function setIgnore(i) {
  ignore = i;
}

const DEBUG_COLORED_RE = new RegExp([
  '^',
  '  ', // starts with 2 spaces. yea really
  '\\u001b\\[9\\dm', // colored debug has colors
  '(.+)', // logger name
  '\\u001b\\[90m', // color end
  '(.+)', // message
  '$'
].join(''));

const DBUG_LEVELS = ['debug', 'info', 'warn', 'error'];


function getLoggerLevel(name) {
  var i = DBUG_LEVELS.length;
  while (i--) {
    var level = DBUG_LEVELS[i];
    if (endsWith(name, '.' + level)) {
      return level;
    }
  }
  return 'debug';
}

function dbugName(name) {
  if (!name) {
    return;
  }
  if (name.indexOf('.') === -1) {
    return name;
  }
  var level = getLoggerLevel(name);
  return name.replace('.' + level, '');
}


function parseDebug(args) {
  // O_O
  // Dear reader: I'm so sorry.
  var str = String(args[0]);

  // is it colored debug() ?
  var match = str.match(DEBUG_COLORED_RE);
  if (match) {
    var logger = chalk.stripColor(match[1]).trim();
    var msg = chalk.stripColor(match[2]).trim();
    args[0] = msg; // overwrite the message portion
    return logger.replace(/:/g, '.');
  } else if (utc.has(str)) {
    str = str.replace(utc.get(str), '').trim();
    var logger = str.split(' ').shift();
    var msg = str.replace(logger, '').trim();
    args[0] = msg;
    return logger.replace(/:/g, '.');
  }
}

// cached loggers that hook into dbug.__log
// this way, we don't format a level message, and then parse it with
// regex, just to format a new message in intel
// ALSO: we only get a stacktrace once, and then save the name, so
// PERFORMANCE WIN!
var dbugLoggers = {};
function dbugHook(name, level, args) {
  var logger = dbugLoggers[name];
  if (!logger) {
    logger = dbugLoggers[name] =
      intel.getLogger(getLoggerName(name.replace(/:/g, '.')));
  }
  logger[level].apply(logger, args);
}

var isDebugging = false;
var __log = dbug.__log;
function setDebug(debug) {
  if (debug === true) {
    process.env.DEBUG = '*';
  } else if (String(debug)) {
    if (process.env.DEBUG) {
      process.env.DEBUG += ',' + debug;
    } else {
      process.env.DEBUG = debug;
    }
  }
  isDebugging = !!debug;
  dbug.__log = dbugHook;
}

function deliver(method, args) {
  var debugged = isDebugging && parseDebug(args);
  var name = getLoggerName(dbugName(debugged));
  var i = ignore.length;
  var logger = intel.getLogger(name);
  name = logger._name;
  while (i--) {
    if (name.indexOf(ignore[i]) === 0) {
      ORIGINAL_METHODS[method].apply(console, args);
      return;
    }
  }
  if (debugged) {
    method = getLoggerLevel(debugged);
  }
  var level = ALIASES.indexOf(method) !== -1 ? method : 'debug';
  logger[level].apply(logger, args);
}


function overrideConsole(options) {
  options = options || {};
  setRoot(options.root || path.join(stack.get()[1].getFileName(), '..'));
  setIgnore(options.ignore || []);

  setDebug(options.debug);


  if (!ORIGINAL_METHODS.log) {
    copyProperties(console, ORIGINAL_METHODS, METHOD_NAMES);
  }

  ALIASES.forEach(function(method) {
    console[method] = function alias(){
      deliver(method, arguments);
    };
  });

  console.log = function log() {
    deliver('log', arguments);
  };

  console.dir = function dir(obj) {
    deliver('dir', [util.inspect(obj)]);
  };
}

function restoreConsole() {
  for (var name in ORIGINAL_METHODS) {
    if (ORIGINAL_METHODS.hasOwnProperty(name) && ORIGINAL_METHODS[name]) {
      console[name] = ORIGINAL_METHODS[name];
    }
  }
  copyProperties({}, ORIGINAL_METHODS, METHOD_NAMES);
  dbug.__log = __log;
}

module.exports = exports = overrideConsole;
exports.restore = restoreConsole;
