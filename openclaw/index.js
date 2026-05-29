import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
function __accessProp(key) {
  return this[key];
}
var __toESMCache_node;
var __toESMCache_esm;
var __toESM = (mod, isNodeMode, target) => {
  var canCache = mod != null && typeof mod === "object";
  if (canCache) {
    var cache = isNodeMode ? __toESMCache_node ??= new WeakMap : __toESMCache_esm ??= new WeakMap;
    var cached = cache.get(mod);
    if (cached)
      return cached;
  }
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: __accessProp.bind(mod, key),
        enumerable: true
      });
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS((exports, module) => {
  var constants = __require("constants");
  var origCwd = process.cwd;
  var cwd = null;
  var platform = process.env.GRACEFUL_FS_PLATFORM || process.platform;
  process.cwd = function() {
    if (!cwd)
      cwd = origCwd.call(process);
    return cwd;
  };
  try {
    process.cwd();
  } catch (er) {}
  if (typeof process.chdir === "function") {
    chdir = process.chdir;
    process.chdir = function(d) {
      cwd = null;
      chdir.call(process, d);
    };
    if (Object.setPrototypeOf)
      Object.setPrototypeOf(process.chdir, chdir);
  }
  var chdir;
  module.exports = patch;
  function patch(fs) {
    if (constants.hasOwnProperty("O_SYMLINK") && process.version.match(/^v0\.6\.[0-2]|^v0\.5\./)) {
      patchLchmod(fs);
    }
    if (!fs.lutimes) {
      patchLutimes(fs);
    }
    fs.chown = chownFix(fs.chown);
    fs.fchown = chownFix(fs.fchown);
    fs.lchown = chownFix(fs.lchown);
    fs.chmod = chmodFix(fs.chmod);
    fs.fchmod = chmodFix(fs.fchmod);
    fs.lchmod = chmodFix(fs.lchmod);
    fs.chownSync = chownFixSync(fs.chownSync);
    fs.fchownSync = chownFixSync(fs.fchownSync);
    fs.lchownSync = chownFixSync(fs.lchownSync);
    fs.chmodSync = chmodFixSync(fs.chmodSync);
    fs.fchmodSync = chmodFixSync(fs.fchmodSync);
    fs.lchmodSync = chmodFixSync(fs.lchmodSync);
    fs.stat = statFix(fs.stat);
    fs.fstat = statFix(fs.fstat);
    fs.lstat = statFix(fs.lstat);
    fs.statSync = statFixSync(fs.statSync);
    fs.fstatSync = statFixSync(fs.fstatSync);
    fs.lstatSync = statFixSync(fs.lstatSync);
    if (fs.chmod && !fs.lchmod) {
      fs.lchmod = function(path, mode, cb) {
        if (cb)
          process.nextTick(cb);
      };
      fs.lchmodSync = function() {};
    }
    if (fs.chown && !fs.lchown) {
      fs.lchown = function(path, uid, gid, cb) {
        if (cb)
          process.nextTick(cb);
      };
      fs.lchownSync = function() {};
    }
    if (platform === "win32") {
      fs.rename = typeof fs.rename !== "function" ? fs.rename : function(fs$rename) {
        function rename(from, to, cb) {
          var start = Date.now();
          var backoff = 0;
          fs$rename(from, to, function CB(er) {
            if (er && (er.code === "EACCES" || er.code === "EPERM" || er.code === "EBUSY") && Date.now() - start < 60000) {
              setTimeout(function() {
                fs.stat(to, function(stater, st) {
                  if (stater && stater.code === "ENOENT")
                    fs$rename(from, to, CB);
                  else
                    cb(er);
                });
              }, backoff);
              if (backoff < 100)
                backoff += 10;
              return;
            }
            if (cb)
              cb(er);
          });
        }
        if (Object.setPrototypeOf)
          Object.setPrototypeOf(rename, fs$rename);
        return rename;
      }(fs.rename);
    }
    fs.read = typeof fs.read !== "function" ? fs.read : function(fs$read) {
      function read(fd, buffer, offset, length, position, callback_) {
        var callback;
        if (callback_ && typeof callback_ === "function") {
          var eagCounter = 0;
          callback = function(er, _, __) {
            if (er && er.code === "EAGAIN" && eagCounter < 10) {
              eagCounter++;
              return fs$read.call(fs, fd, buffer, offset, length, position, callback);
            }
            callback_.apply(this, arguments);
          };
        }
        return fs$read.call(fs, fd, buffer, offset, length, position, callback);
      }
      if (Object.setPrototypeOf)
        Object.setPrototypeOf(read, fs$read);
      return read;
    }(fs.read);
    fs.readSync = typeof fs.readSync !== "function" ? fs.readSync : function(fs$readSync) {
      return function(fd, buffer, offset, length, position) {
        var eagCounter = 0;
        while (true) {
          try {
            return fs$readSync.call(fs, fd, buffer, offset, length, position);
          } catch (er) {
            if (er.code === "EAGAIN" && eagCounter < 10) {
              eagCounter++;
              continue;
            }
            throw er;
          }
        }
      };
    }(fs.readSync);
    function patchLchmod(fs2) {
      fs2.lchmod = function(path, mode, callback) {
        fs2.open(path, constants.O_WRONLY | constants.O_SYMLINK, mode, function(err, fd) {
          if (err) {
            if (callback)
              callback(err);
            return;
          }
          fs2.fchmod(fd, mode, function(err2) {
            fs2.close(fd, function(err22) {
              if (callback)
                callback(err2 || err22);
            });
          });
        });
      };
      fs2.lchmodSync = function(path, mode) {
        var fd = fs2.openSync(path, constants.O_WRONLY | constants.O_SYMLINK, mode);
        var threw = true;
        var ret;
        try {
          ret = fs2.fchmodSync(fd, mode);
          threw = false;
        } finally {
          if (threw) {
            try {
              fs2.closeSync(fd);
            } catch (er) {}
          } else {
            fs2.closeSync(fd);
          }
        }
        return ret;
      };
    }
    function patchLutimes(fs2) {
      if (constants.hasOwnProperty("O_SYMLINK") && fs2.futimes) {
        fs2.lutimes = function(path, at, mt, cb) {
          fs2.open(path, constants.O_SYMLINK, function(er, fd) {
            if (er) {
              if (cb)
                cb(er);
              return;
            }
            fs2.futimes(fd, at, mt, function(er2) {
              fs2.close(fd, function(er22) {
                if (cb)
                  cb(er2 || er22);
              });
            });
          });
        };
        fs2.lutimesSync = function(path, at, mt) {
          var fd = fs2.openSync(path, constants.O_SYMLINK);
          var ret;
          var threw = true;
          try {
            ret = fs2.futimesSync(fd, at, mt);
            threw = false;
          } finally {
            if (threw) {
              try {
                fs2.closeSync(fd);
              } catch (er) {}
            } else {
              fs2.closeSync(fd);
            }
          }
          return ret;
        };
      } else if (fs2.futimes) {
        fs2.lutimes = function(_a, _b, _c, cb) {
          if (cb)
            process.nextTick(cb);
        };
        fs2.lutimesSync = function() {};
      }
    }
    function chmodFix(orig) {
      if (!orig)
        return orig;
      return function(target, mode, cb) {
        return orig.call(fs, target, mode, function(er) {
          if (chownErOk(er))
            er = null;
          if (cb)
            cb.apply(this, arguments);
        });
      };
    }
    function chmodFixSync(orig) {
      if (!orig)
        return orig;
      return function(target, mode) {
        try {
          return orig.call(fs, target, mode);
        } catch (er) {
          if (!chownErOk(er))
            throw er;
        }
      };
    }
    function chownFix(orig) {
      if (!orig)
        return orig;
      return function(target, uid, gid, cb) {
        return orig.call(fs, target, uid, gid, function(er) {
          if (chownErOk(er))
            er = null;
          if (cb)
            cb.apply(this, arguments);
        });
      };
    }
    function chownFixSync(orig) {
      if (!orig)
        return orig;
      return function(target, uid, gid) {
        try {
          return orig.call(fs, target, uid, gid);
        } catch (er) {
          if (!chownErOk(er))
            throw er;
        }
      };
    }
    function statFix(orig) {
      if (!orig)
        return orig;
      return function(target, options, cb) {
        if (typeof options === "function") {
          cb = options;
          options = null;
        }
        function callback(er, stats) {
          if (stats) {
            if (stats.uid < 0)
              stats.uid += 4294967296;
            if (stats.gid < 0)
              stats.gid += 4294967296;
          }
          if (cb)
            cb.apply(this, arguments);
        }
        return options ? orig.call(fs, target, options, callback) : orig.call(fs, target, callback);
      };
    }
    function statFixSync(orig) {
      if (!orig)
        return orig;
      return function(target, options) {
        var stats = options ? orig.call(fs, target, options) : orig.call(fs, target);
        if (stats) {
          if (stats.uid < 0)
            stats.uid += 4294967296;
          if (stats.gid < 0)
            stats.gid += 4294967296;
        }
        return stats;
      };
    }
    function chownErOk(er) {
      if (!er)
        return true;
      if (er.code === "ENOSYS")
        return true;
      var nonroot = !process.getuid || process.getuid() !== 0;
      if (nonroot) {
        if (er.code === "EINVAL" || er.code === "EPERM")
          return true;
      }
      return false;
    }
  }
});

// node_modules/graceful-fs/legacy-streams.js
var require_legacy_streams = __commonJS((exports, module) => {
  var Stream = __require("stream").Stream;
  module.exports = legacy;
  function legacy(fs) {
    return {
      ReadStream,
      WriteStream
    };
    function ReadStream(path, options) {
      if (!(this instanceof ReadStream))
        return new ReadStream(path, options);
      Stream.call(this);
      var self = this;
      this.path = path;
      this.fd = null;
      this.readable = true;
      this.paused = false;
      this.flags = "r";
      this.mode = 438;
      this.bufferSize = 64 * 1024;
      options = options || {};
      var keys = Object.keys(options);
      for (var index = 0, length = keys.length;index < length; index++) {
        var key = keys[index];
        this[key] = options[key];
      }
      if (this.encoding)
        this.setEncoding(this.encoding);
      if (this.start !== undefined) {
        if (typeof this.start !== "number") {
          throw TypeError("start must be a Number");
        }
        if (this.end === undefined) {
          this.end = Infinity;
        } else if (typeof this.end !== "number") {
          throw TypeError("end must be a Number");
        }
        if (this.start > this.end) {
          throw new Error("start must be <= end");
        }
        this.pos = this.start;
      }
      if (this.fd !== null) {
        process.nextTick(function() {
          self._read();
        });
        return;
      }
      fs.open(this.path, this.flags, this.mode, function(err, fd) {
        if (err) {
          self.emit("error", err);
          self.readable = false;
          return;
        }
        self.fd = fd;
        self.emit("open", fd);
        self._read();
      });
    }
    function WriteStream(path, options) {
      if (!(this instanceof WriteStream))
        return new WriteStream(path, options);
      Stream.call(this);
      this.path = path;
      this.fd = null;
      this.writable = true;
      this.flags = "w";
      this.encoding = "binary";
      this.mode = 438;
      this.bytesWritten = 0;
      options = options || {};
      var keys = Object.keys(options);
      for (var index = 0, length = keys.length;index < length; index++) {
        var key = keys[index];
        this[key] = options[key];
      }
      if (this.start !== undefined) {
        if (typeof this.start !== "number") {
          throw TypeError("start must be a Number");
        }
        if (this.start < 0) {
          throw new Error("start must be >= zero");
        }
        this.pos = this.start;
      }
      this.busy = false;
      this._queue = [];
      if (this.fd === null) {
        this._open = fs.open;
        this._queue.push([this._open, this.path, this.flags, this.mode, undefined]);
        this.flush();
      }
    }
  }
});

// node_modules/graceful-fs/clone.js
var require_clone = __commonJS((exports, module) => {
  module.exports = clone;
  var getPrototypeOf = Object.getPrototypeOf || function(obj) {
    return obj.__proto__;
  };
  function clone(obj) {
    if (obj === null || typeof obj !== "object")
      return obj;
    if (obj instanceof Object)
      var copy = { __proto__: getPrototypeOf(obj) };
    else
      var copy = Object.create(null);
    Object.getOwnPropertyNames(obj).forEach(function(key) {
      Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(obj, key));
    });
    return copy;
  }
});

// node_modules/graceful-fs/graceful-fs.js
var require_graceful_fs = __commonJS((exports, module) => {
  var fs = __require("fs");
  var polyfills = require_polyfills();
  var legacy = require_legacy_streams();
  var clone = require_clone();
  var util = __require("util");
  var gracefulQueue;
  var previousSymbol;
  if (typeof Symbol === "function" && typeof Symbol.for === "function") {
    gracefulQueue = Symbol.for("graceful-fs.queue");
    previousSymbol = Symbol.for("graceful-fs.previous");
  } else {
    gracefulQueue = "___graceful-fs.queue";
    previousSymbol = "___graceful-fs.previous";
  }
  function noop() {}
  function publishQueue(context, queue2) {
    Object.defineProperty(context, gracefulQueue, {
      get: function() {
        return queue2;
      }
    });
  }
  var debug = noop;
  if (util.debuglog)
    debug = util.debuglog("gfs4");
  else if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || ""))
    debug = function() {
      var m = util.format.apply(util, arguments);
      m = "GFS4: " + m.split(/\n/).join(`
GFS4: `);
      console.error(m);
    };
  if (!fs[gracefulQueue]) {
    queue = global[gracefulQueue] || [];
    publishQueue(fs, queue);
    fs.close = function(fs$close) {
      function close(fd, cb) {
        return fs$close.call(fs, fd, function(err) {
          if (!err) {
            resetQueue();
          }
          if (typeof cb === "function")
            cb.apply(this, arguments);
        });
      }
      Object.defineProperty(close, previousSymbol, {
        value: fs$close
      });
      return close;
    }(fs.close);
    fs.closeSync = function(fs$closeSync) {
      function closeSync3(fd) {
        fs$closeSync.apply(fs, arguments);
        resetQueue();
      }
      Object.defineProperty(closeSync3, previousSymbol, {
        value: fs$closeSync
      });
      return closeSync3;
    }(fs.closeSync);
    if (/\bgfs4\b/i.test(process.env.NODE_DEBUG || "")) {
      process.on("exit", function() {
        debug(fs[gracefulQueue]);
        __require("assert").equal(fs[gracefulQueue].length, 0);
      });
    }
  }
  var queue;
  if (!global[gracefulQueue]) {
    publishQueue(global, fs[gracefulQueue]);
  }
  module.exports = patch(clone(fs));
  if (process.env.TEST_GRACEFUL_FS_GLOBAL_PATCH && !fs.__patched) {
    module.exports = patch(fs);
    fs.__patched = true;
  }
  function patch(fs2) {
    polyfills(fs2);
    fs2.gracefulify = patch;
    fs2.createReadStream = createReadStream;
    fs2.createWriteStream = createWriteStream;
    var fs$readFile = fs2.readFile;
    fs2.readFile = readFile;
    function readFile(path, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      return go$readFile(path, options, cb);
      function go$readFile(path2, options2, cb2, startTime) {
        return fs$readFile(path2, options2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$readFile, [path2, options2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$writeFile = fs2.writeFile;
    fs2.writeFile = writeFile;
    function writeFile(path, data, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      return go$writeFile(path, data, options, cb);
      function go$writeFile(path2, data2, options2, cb2, startTime) {
        return fs$writeFile(path2, data2, options2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$writeFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$appendFile = fs2.appendFile;
    if (fs$appendFile)
      fs2.appendFile = appendFile;
    function appendFile(path, data, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      return go$appendFile(path, data, options, cb);
      function go$appendFile(path2, data2, options2, cb2, startTime) {
        return fs$appendFile(path2, data2, options2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$appendFile, [path2, data2, options2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$copyFile = fs2.copyFile;
    if (fs$copyFile)
      fs2.copyFile = copyFile;
    function copyFile(src, dest, flags, cb) {
      if (typeof flags === "function") {
        cb = flags;
        flags = 0;
      }
      return go$copyFile(src, dest, flags, cb);
      function go$copyFile(src2, dest2, flags2, cb2, startTime) {
        return fs$copyFile(src2, dest2, flags2, function(err) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$copyFile, [src2, dest2, flags2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    var fs$readdir = fs2.readdir;
    fs2.readdir = readdir;
    var noReaddirOptionVersions = /^v[0-5]\./;
    function readdir(path, options, cb) {
      if (typeof options === "function")
        cb = options, options = null;
      var go$readdir = noReaddirOptionVersions.test(process.version) ? function go$readdir2(path2, options2, cb2, startTime) {
        return fs$readdir(path2, fs$readdirCallback(path2, options2, cb2, startTime));
      } : function go$readdir2(path2, options2, cb2, startTime) {
        return fs$readdir(path2, options2, fs$readdirCallback(path2, options2, cb2, startTime));
      };
      return go$readdir(path, options, cb);
      function fs$readdirCallback(path2, options2, cb2, startTime) {
        return function(err, files) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([
              go$readdir,
              [path2, options2, cb2],
              err,
              startTime || Date.now(),
              Date.now()
            ]);
          else {
            if (files && files.sort)
              files.sort();
            if (typeof cb2 === "function")
              cb2.call(this, err, files);
          }
        };
      }
    }
    if (process.version.substr(0, 4) === "v0.8") {
      var legStreams = legacy(fs2);
      ReadStream = legStreams.ReadStream;
      WriteStream = legStreams.WriteStream;
    }
    var fs$ReadStream = fs2.ReadStream;
    if (fs$ReadStream) {
      ReadStream.prototype = Object.create(fs$ReadStream.prototype);
      ReadStream.prototype.open = ReadStream$open;
    }
    var fs$WriteStream = fs2.WriteStream;
    if (fs$WriteStream) {
      WriteStream.prototype = Object.create(fs$WriteStream.prototype);
      WriteStream.prototype.open = WriteStream$open;
    }
    Object.defineProperty(fs2, "ReadStream", {
      get: function() {
        return ReadStream;
      },
      set: function(val) {
        ReadStream = val;
      },
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(fs2, "WriteStream", {
      get: function() {
        return WriteStream;
      },
      set: function(val) {
        WriteStream = val;
      },
      enumerable: true,
      configurable: true
    });
    var FileReadStream = ReadStream;
    Object.defineProperty(fs2, "FileReadStream", {
      get: function() {
        return FileReadStream;
      },
      set: function(val) {
        FileReadStream = val;
      },
      enumerable: true,
      configurable: true
    });
    var FileWriteStream = WriteStream;
    Object.defineProperty(fs2, "FileWriteStream", {
      get: function() {
        return FileWriteStream;
      },
      set: function(val) {
        FileWriteStream = val;
      },
      enumerable: true,
      configurable: true
    });
    function ReadStream(path, options) {
      if (this instanceof ReadStream)
        return fs$ReadStream.apply(this, arguments), this;
      else
        return ReadStream.apply(Object.create(ReadStream.prototype), arguments);
    }
    function ReadStream$open() {
      var that = this;
      open(that.path, that.flags, that.mode, function(err, fd) {
        if (err) {
          if (that.autoClose)
            that.destroy();
          that.emit("error", err);
        } else {
          that.fd = fd;
          that.emit("open", fd);
          that.read();
        }
      });
    }
    function WriteStream(path, options) {
      if (this instanceof WriteStream)
        return fs$WriteStream.apply(this, arguments), this;
      else
        return WriteStream.apply(Object.create(WriteStream.prototype), arguments);
    }
    function WriteStream$open() {
      var that = this;
      open(that.path, that.flags, that.mode, function(err, fd) {
        if (err) {
          that.destroy();
          that.emit("error", err);
        } else {
          that.fd = fd;
          that.emit("open", fd);
        }
      });
    }
    function createReadStream(path, options) {
      return new fs2.ReadStream(path, options);
    }
    function createWriteStream(path, options) {
      return new fs2.WriteStream(path, options);
    }
    var fs$open = fs2.open;
    fs2.open = open;
    function open(path, flags, mode, cb) {
      if (typeof mode === "function")
        cb = mode, mode = null;
      return go$open(path, flags, mode, cb);
      function go$open(path2, flags2, mode2, cb2, startTime) {
        return fs$open(path2, flags2, mode2, function(err, fd) {
          if (err && (err.code === "EMFILE" || err.code === "ENFILE"))
            enqueue([go$open, [path2, flags2, mode2, cb2], err, startTime || Date.now(), Date.now()]);
          else {
            if (typeof cb2 === "function")
              cb2.apply(this, arguments);
          }
        });
      }
    }
    return fs2;
  }
  function enqueue(elem) {
    debug("ENQUEUE", elem[0].name, elem[1]);
    fs[gracefulQueue].push(elem);
    retry();
  }
  var retryTimer;
  function resetQueue() {
    var now = Date.now();
    for (var i = 0;i < fs[gracefulQueue].length; ++i) {
      if (fs[gracefulQueue][i].length > 2) {
        fs[gracefulQueue][i][3] = now;
        fs[gracefulQueue][i][4] = now;
      }
    }
    retry();
  }
  function retry() {
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (fs[gracefulQueue].length === 0)
      return;
    var elem = fs[gracefulQueue].shift();
    var fn = elem[0];
    var args = elem[1];
    var err = elem[2];
    var startTime = elem[3];
    var lastTime = elem[4];
    if (startTime === undefined) {
      debug("RETRY", fn.name, args);
      fn.apply(null, args);
    } else if (Date.now() - startTime >= 60000) {
      debug("TIMEOUT", fn.name, args);
      var cb = args.pop();
      if (typeof cb === "function")
        cb.call(null, err);
    } else {
      var sinceAttempt = Date.now() - lastTime;
      var sinceStart = Math.max(lastTime - startTime, 1);
      var desiredDelay = Math.min(sinceStart * 1.2, 100);
      if (sinceAttempt >= desiredDelay) {
        debug("RETRY", fn.name, args);
        fn.apply(null, args.concat([startTime]));
      } else {
        fs[gracefulQueue].push(elem);
      }
    }
    if (retryTimer === undefined) {
      retryTimer = setTimeout(retry, 0);
    }
  }
});

// node_modules/retry/lib/retry_operation.js
var require_retry_operation = __commonJS((exports, module) => {
  function RetryOperation(timeouts, options) {
    if (typeof options === "boolean") {
      options = { forever: options };
    }
    this._originalTimeouts = JSON.parse(JSON.stringify(timeouts));
    this._timeouts = timeouts;
    this._options = options || {};
    this._maxRetryTime = options && options.maxRetryTime || Infinity;
    this._fn = null;
    this._errors = [];
    this._attempts = 1;
    this._operationTimeout = null;
    this._operationTimeoutCb = null;
    this._timeout = null;
    this._operationStart = null;
    if (this._options.forever) {
      this._cachedTimeouts = this._timeouts.slice(0);
    }
  }
  module.exports = RetryOperation;
  RetryOperation.prototype.reset = function() {
    this._attempts = 1;
    this._timeouts = this._originalTimeouts;
  };
  RetryOperation.prototype.stop = function() {
    if (this._timeout) {
      clearTimeout(this._timeout);
    }
    this._timeouts = [];
    this._cachedTimeouts = null;
  };
  RetryOperation.prototype.retry = function(err) {
    if (this._timeout) {
      clearTimeout(this._timeout);
    }
    if (!err) {
      return false;
    }
    var currentTime = new Date().getTime();
    if (err && currentTime - this._operationStart >= this._maxRetryTime) {
      this._errors.unshift(new Error("RetryOperation timeout occurred"));
      return false;
    }
    this._errors.push(err);
    var timeout = this._timeouts.shift();
    if (timeout === undefined) {
      if (this._cachedTimeouts) {
        this._errors.splice(this._errors.length - 1, this._errors.length);
        this._timeouts = this._cachedTimeouts.slice(0);
        timeout = this._timeouts.shift();
      } else {
        return false;
      }
    }
    var self = this;
    var timer = setTimeout(function() {
      self._attempts++;
      if (self._operationTimeoutCb) {
        self._timeout = setTimeout(function() {
          self._operationTimeoutCb(self._attempts);
        }, self._operationTimeout);
        if (self._options.unref) {
          self._timeout.unref();
        }
      }
      self._fn(self._attempts);
    }, timeout);
    if (this._options.unref) {
      timer.unref();
    }
    return true;
  };
  RetryOperation.prototype.attempt = function(fn, timeoutOps) {
    this._fn = fn;
    if (timeoutOps) {
      if (timeoutOps.timeout) {
        this._operationTimeout = timeoutOps.timeout;
      }
      if (timeoutOps.cb) {
        this._operationTimeoutCb = timeoutOps.cb;
      }
    }
    var self = this;
    if (this._operationTimeoutCb) {
      this._timeout = setTimeout(function() {
        self._operationTimeoutCb();
      }, self._operationTimeout);
    }
    this._operationStart = new Date().getTime();
    this._fn(this._attempts);
  };
  RetryOperation.prototype.try = function(fn) {
    console.log("Using RetryOperation.try() is deprecated");
    this.attempt(fn);
  };
  RetryOperation.prototype.start = function(fn) {
    console.log("Using RetryOperation.start() is deprecated");
    this.attempt(fn);
  };
  RetryOperation.prototype.start = RetryOperation.prototype.try;
  RetryOperation.prototype.errors = function() {
    return this._errors;
  };
  RetryOperation.prototype.attempts = function() {
    return this._attempts;
  };
  RetryOperation.prototype.mainError = function() {
    if (this._errors.length === 0) {
      return null;
    }
    var counts = {};
    var mainError = null;
    var mainErrorCount = 0;
    for (var i = 0;i < this._errors.length; i++) {
      var error = this._errors[i];
      var message = error.message;
      var count = (counts[message] || 0) + 1;
      counts[message] = count;
      if (count >= mainErrorCount) {
        mainError = error;
        mainErrorCount = count;
      }
    }
    return mainError;
  };
});

// node_modules/retry/lib/retry.js
var require_retry = __commonJS((exports) => {
  var RetryOperation = require_retry_operation();
  exports.operation = function(options) {
    var timeouts = exports.timeouts(options);
    return new RetryOperation(timeouts, {
      forever: options && options.forever,
      unref: options && options.unref,
      maxRetryTime: options && options.maxRetryTime
    });
  };
  exports.timeouts = function(options) {
    if (options instanceof Array) {
      return [].concat(options);
    }
    var opts = {
      retries: 10,
      factor: 2,
      minTimeout: 1 * 1000,
      maxTimeout: Infinity,
      randomize: false
    };
    for (var key in options) {
      opts[key] = options[key];
    }
    if (opts.minTimeout > opts.maxTimeout) {
      throw new Error("minTimeout is greater than maxTimeout");
    }
    var timeouts = [];
    for (var i = 0;i < opts.retries; i++) {
      timeouts.push(this.createTimeout(i, opts));
    }
    if (options && options.forever && !timeouts.length) {
      timeouts.push(this.createTimeout(i, opts));
    }
    timeouts.sort(function(a, b) {
      return a - b;
    });
    return timeouts;
  };
  exports.createTimeout = function(attempt, opts) {
    var random = opts.randomize ? Math.random() + 1 : 1;
    var timeout = Math.round(random * opts.minTimeout * Math.pow(opts.factor, attempt));
    timeout = Math.min(timeout, opts.maxTimeout);
    return timeout;
  };
  exports.wrap = function(obj, options, methods) {
    if (options instanceof Array) {
      methods = options;
      options = null;
    }
    if (!methods) {
      methods = [];
      for (var key in obj) {
        if (typeof obj[key] === "function") {
          methods.push(key);
        }
      }
    }
    for (var i = 0;i < methods.length; i++) {
      var method = methods[i];
      var original = obj[method];
      obj[method] = function retryWrapper(original2) {
        var op = exports.operation(options);
        var args = Array.prototype.slice.call(arguments, 1);
        var callback = args.pop();
        args.push(function(err) {
          if (op.retry(err)) {
            return;
          }
          if (err) {
            arguments[0] = op.mainError();
          }
          callback.apply(this, arguments);
        });
        op.attempt(function() {
          original2.apply(obj, args);
        });
      }.bind(obj, original);
      obj[method].options = options;
    }
  };
});

// node_modules/signal-exit/signals.js
var require_signals = __commonJS((exports, module) => {
  module.exports = [
    "SIGABRT",
    "SIGALRM",
    "SIGHUP",
    "SIGINT",
    "SIGTERM"
  ];
  if (process.platform !== "win32") {
    module.exports.push("SIGVTALRM", "SIGXCPU", "SIGXFSZ", "SIGUSR2", "SIGTRAP", "SIGSYS", "SIGQUIT", "SIGIOT");
  }
  if (process.platform === "linux") {
    module.exports.push("SIGIO", "SIGPOLL", "SIGPWR", "SIGSTKFLT", "SIGUNUSED");
  }
});

// node_modules/signal-exit/index.js
var require_signal_exit = __commonJS((exports, module) => {
  var process2 = global.process;
  var processOk = function(process3) {
    return process3 && typeof process3 === "object" && typeof process3.removeListener === "function" && typeof process3.emit === "function" && typeof process3.reallyExit === "function" && typeof process3.listeners === "function" && typeof process3.kill === "function" && typeof process3.pid === "number" && typeof process3.on === "function";
  };
  if (!processOk(process2)) {
    module.exports = function() {
      return function() {};
    };
  } else {
    assert = __require("assert");
    signals = require_signals();
    isWin = /^win/i.test(process2.platform);
    EE = __require("events");
    if (typeof EE !== "function") {
      EE = EE.EventEmitter;
    }
    if (process2.__signal_exit_emitter__) {
      emitter = process2.__signal_exit_emitter__;
    } else {
      emitter = process2.__signal_exit_emitter__ = new EE;
      emitter.count = 0;
      emitter.emitted = {};
    }
    if (!emitter.infinite) {
      emitter.setMaxListeners(Infinity);
      emitter.infinite = true;
    }
    module.exports = function(cb, opts) {
      if (!processOk(global.process)) {
        return function() {};
      }
      assert.equal(typeof cb, "function", "a callback must be provided for exit handler");
      if (loaded === false) {
        load();
      }
      var ev = "exit";
      if (opts && opts.alwaysLast) {
        ev = "afterexit";
      }
      var remove = function() {
        emitter.removeListener(ev, cb);
        if (emitter.listeners("exit").length === 0 && emitter.listeners("afterexit").length === 0) {
          unload();
        }
      };
      emitter.on(ev, cb);
      return remove;
    };
    unload = function unload2() {
      if (!loaded || !processOk(global.process)) {
        return;
      }
      loaded = false;
      signals.forEach(function(sig) {
        try {
          process2.removeListener(sig, sigListeners[sig]);
        } catch (er) {}
      });
      process2.emit = originalProcessEmit;
      process2.reallyExit = originalProcessReallyExit;
      emitter.count -= 1;
    };
    module.exports.unload = unload;
    emit = function emit2(event, code, signal) {
      if (emitter.emitted[event]) {
        return;
      }
      emitter.emitted[event] = true;
      emitter.emit(event, code, signal);
    };
    sigListeners = {};
    signals.forEach(function(sig) {
      sigListeners[sig] = function listener() {
        if (!processOk(global.process)) {
          return;
        }
        var listeners = process2.listeners(sig);
        if (listeners.length === emitter.count) {
          unload();
          emit("exit", null, sig);
          emit("afterexit", null, sig);
          if (isWin && sig === "SIGHUP") {
            sig = "SIGINT";
          }
          process2.kill(process2.pid, sig);
        }
      };
    });
    module.exports.signals = function() {
      return signals;
    };
    loaded = false;
    load = function load2() {
      if (loaded || !processOk(global.process)) {
        return;
      }
      loaded = true;
      emitter.count += 1;
      signals = signals.filter(function(sig) {
        try {
          process2.on(sig, sigListeners[sig]);
          return true;
        } catch (er) {
          return false;
        }
      });
      process2.emit = processEmit;
      process2.reallyExit = processReallyExit;
    };
    module.exports.load = load;
    originalProcessReallyExit = process2.reallyExit;
    processReallyExit = function processReallyExit2(code) {
      if (!processOk(global.process)) {
        return;
      }
      process2.exitCode = code || 0;
      emit("exit", process2.exitCode, null);
      emit("afterexit", process2.exitCode, null);
      originalProcessReallyExit.call(process2, process2.exitCode);
    };
    originalProcessEmit = process2.emit;
    processEmit = function processEmit2(ev, arg) {
      if (ev === "exit" && processOk(global.process)) {
        if (arg !== undefined) {
          process2.exitCode = arg;
        }
        var ret = originalProcessEmit.apply(this, arguments);
        emit("exit", process2.exitCode, null);
        emit("afterexit", process2.exitCode, null);
        return ret;
      } else {
        return originalProcessEmit.apply(this, arguments);
      }
    };
  }
  var assert;
  var signals;
  var isWin;
  var EE;
  var emitter;
  var unload;
  var emit;
  var sigListeners;
  var loaded;
  var load;
  var originalProcessReallyExit;
  var processReallyExit;
  var originalProcessEmit;
  var processEmit;
});

// node_modules/proper-lockfile/lib/mtime-precision.js
var require_mtime_precision = __commonJS((exports, module) => {
  var cacheSymbol = Symbol();
  function probe(file, fs, callback) {
    const cachedPrecision = fs[cacheSymbol];
    if (cachedPrecision) {
      return fs.stat(file, (err, stat) => {
        if (err) {
          return callback(err);
        }
        callback(null, stat.mtime, cachedPrecision);
      });
    }
    const mtime = new Date(Math.ceil(Date.now() / 1000) * 1000 + 5);
    fs.utimes(file, mtime, mtime, (err) => {
      if (err) {
        return callback(err);
      }
      fs.stat(file, (err2, stat) => {
        if (err2) {
          return callback(err2);
        }
        const precision = stat.mtime.getTime() % 1000 === 0 ? "s" : "ms";
        Object.defineProperty(fs, cacheSymbol, { value: precision });
        callback(null, stat.mtime, precision);
      });
    });
  }
  function getMtime(precision) {
    let now = Date.now();
    if (precision === "s") {
      now = Math.ceil(now / 1000) * 1000;
    }
    return new Date(now);
  }
  exports.probe = probe;
  exports.getMtime = getMtime;
});

// node_modules/proper-lockfile/lib/lockfile.js
var require_lockfile = __commonJS((exports, module) => {
  var path = __require("path");
  var fs = require_graceful_fs();
  var retry = require_retry();
  var onExit = require_signal_exit();
  var mtimePrecision = require_mtime_precision();
  var locks = {};
  function getLockFile(file, options) {
    return options.lockfilePath || `${file}.lock`;
  }
  function resolveCanonicalPath(file, options, callback) {
    if (!options.realpath) {
      return callback(null, path.resolve(file));
    }
    options.fs.realpath(file, callback);
  }
  function acquireLock(file, options, callback) {
    const lockfilePath = getLockFile(file, options);
    options.fs.mkdir(lockfilePath, (err) => {
      if (!err) {
        return mtimePrecision.probe(lockfilePath, options.fs, (err2, mtime, mtimePrecision2) => {
          if (err2) {
            options.fs.rmdir(lockfilePath, () => {});
            return callback(err2);
          }
          callback(null, mtime, mtimePrecision2);
        });
      }
      if (err.code !== "EEXIST") {
        return callback(err);
      }
      if (options.stale <= 0) {
        return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
      }
      options.fs.stat(lockfilePath, (err2, stat) => {
        if (err2) {
          if (err2.code === "ENOENT") {
            return acquireLock(file, { ...options, stale: 0 }, callback);
          }
          return callback(err2);
        }
        if (!isLockStale(stat, options)) {
          return callback(Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file }));
        }
        removeLock(file, options, (err3) => {
          if (err3) {
            return callback(err3);
          }
          acquireLock(file, { ...options, stale: 0 }, callback);
        });
      });
    });
  }
  function isLockStale(stat, options) {
    return stat.mtime.getTime() < Date.now() - options.stale;
  }
  function removeLock(file, options, callback) {
    options.fs.rmdir(getLockFile(file, options), (err) => {
      if (err && err.code !== "ENOENT") {
        return callback(err);
      }
      callback();
    });
  }
  function updateLock(file, options) {
    const lock2 = locks[file];
    if (lock2.updateTimeout) {
      return;
    }
    lock2.updateDelay = lock2.updateDelay || options.update;
    lock2.updateTimeout = setTimeout(() => {
      lock2.updateTimeout = null;
      options.fs.stat(lock2.lockfilePath, (err, stat) => {
        const isOverThreshold = lock2.lastUpdate + options.stale < Date.now();
        if (err) {
          if (err.code === "ENOENT" || isOverThreshold) {
            return setLockAsCompromised(file, lock2, Object.assign(err, { code: "ECOMPROMISED" }));
          }
          lock2.updateDelay = 1000;
          return updateLock(file, options);
        }
        const isMtimeOurs = lock2.mtime.getTime() === stat.mtime.getTime();
        if (!isMtimeOurs) {
          return setLockAsCompromised(file, lock2, Object.assign(new Error("Unable to update lock within the stale threshold"), { code: "ECOMPROMISED" }));
        }
        const mtime = mtimePrecision.getMtime(lock2.mtimePrecision);
        options.fs.utimes(lock2.lockfilePath, mtime, mtime, (err2) => {
          const isOverThreshold2 = lock2.lastUpdate + options.stale < Date.now();
          if (lock2.released) {
            return;
          }
          if (err2) {
            if (err2.code === "ENOENT" || isOverThreshold2) {
              return setLockAsCompromised(file, lock2, Object.assign(err2, { code: "ECOMPROMISED" }));
            }
            lock2.updateDelay = 1000;
            return updateLock(file, options);
          }
          lock2.mtime = mtime;
          lock2.lastUpdate = Date.now();
          lock2.updateDelay = null;
          updateLock(file, options);
        });
      });
    }, lock2.updateDelay);
    if (lock2.updateTimeout.unref) {
      lock2.updateTimeout.unref();
    }
  }
  function setLockAsCompromised(file, lock2, err) {
    lock2.released = true;
    if (lock2.updateTimeout) {
      clearTimeout(lock2.updateTimeout);
    }
    if (locks[file] === lock2) {
      delete locks[file];
    }
    lock2.options.onCompromised(err);
  }
  function lock(file, options, callback) {
    options = {
      stale: 1e4,
      update: null,
      realpath: true,
      retries: 0,
      fs,
      onCompromised: (err) => {
        throw err;
      },
      ...options
    };
    options.retries = options.retries || 0;
    options.retries = typeof options.retries === "number" ? { retries: options.retries } : options.retries;
    options.stale = Math.max(options.stale || 0, 2000);
    options.update = options.update == null ? options.stale / 2 : options.update || 0;
    options.update = Math.max(Math.min(options.update, options.stale / 2), 1000);
    resolveCanonicalPath(file, options, (err, file2) => {
      if (err) {
        return callback(err);
      }
      const operation = retry.operation(options.retries);
      operation.attempt(() => {
        acquireLock(file2, options, (err2, mtime, mtimePrecision2) => {
          if (operation.retry(err2)) {
            return;
          }
          if (err2) {
            return callback(operation.mainError());
          }
          const lock2 = locks[file2] = {
            lockfilePath: getLockFile(file2, options),
            mtime,
            mtimePrecision: mtimePrecision2,
            options,
            lastUpdate: Date.now()
          };
          updateLock(file2, options);
          callback(null, (releasedCallback) => {
            if (lock2.released) {
              return releasedCallback && releasedCallback(Object.assign(new Error("Lock is already released"), { code: "ERELEASED" }));
            }
            unlock(file2, { ...options, realpath: false }, releasedCallback);
          });
        });
      });
    });
  }
  function unlock(file, options, callback) {
    options = {
      fs,
      realpath: true,
      ...options
    };
    resolveCanonicalPath(file, options, (err, file2) => {
      if (err) {
        return callback(err);
      }
      const lock2 = locks[file2];
      if (!lock2) {
        return callback(Object.assign(new Error("Lock is not acquired/owned by you"), { code: "ENOTACQUIRED" }));
      }
      lock2.updateTimeout && clearTimeout(lock2.updateTimeout);
      lock2.released = true;
      delete locks[file2];
      removeLock(file2, options, callback);
    });
  }
  function check(file, options, callback) {
    options = {
      stale: 1e4,
      realpath: true,
      fs,
      ...options
    };
    options.stale = Math.max(options.stale || 0, 2000);
    resolveCanonicalPath(file, options, (err, file2) => {
      if (err) {
        return callback(err);
      }
      options.fs.stat(getLockFile(file2, options), (err2, stat) => {
        if (err2) {
          return err2.code === "ENOENT" ? callback(null, false) : callback(err2);
        }
        return callback(null, !isLockStale(stat, options));
      });
    });
  }
  function getLocks() {
    return locks;
  }
  onExit(() => {
    for (const file in locks) {
      const options = locks[file].options;
      try {
        options.fs.rmdirSync(getLockFile(file, options));
      } catch (e) {}
    }
  });
  exports.lock = lock;
  exports.unlock = unlock;
  exports.check = check;
  exports.getLocks = getLocks;
});

// node_modules/proper-lockfile/lib/adapter.js
var require_adapter = __commonJS((exports, module) => {
  var fs = require_graceful_fs();
  function createSyncFs(fs2) {
    const methods = ["mkdir", "realpath", "stat", "rmdir", "utimes"];
    const newFs = { ...fs2 };
    methods.forEach((method) => {
      newFs[method] = (...args) => {
        const callback = args.pop();
        let ret;
        try {
          ret = fs2[`${method}Sync`](...args);
        } catch (err) {
          return callback(err);
        }
        callback(null, ret);
      };
    });
    return newFs;
  }
  function toPromise(method) {
    return (...args) => new Promise((resolve4, reject) => {
      args.push((err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve4(result);
        }
      });
      method(...args);
    });
  }
  function toSync(method) {
    return (...args) => {
      let err;
      let result;
      args.push((_err, _result) => {
        err = _err;
        result = _result;
      });
      method(...args);
      if (err) {
        throw err;
      }
      return result;
    };
  }
  function toSyncOptions(options) {
    options = { ...options };
    options.fs = createSyncFs(options.fs || fs);
    if (typeof options.retries === "number" && options.retries > 0 || options.retries && typeof options.retries.retries === "number" && options.retries.retries > 0) {
      throw Object.assign(new Error("Cannot use retries with the sync api"), { code: "ESYNC" });
    }
    return options;
  }
  module.exports = {
    toPromise,
    toSync,
    toSyncOptions
  };
});

// node_modules/proper-lockfile/index.js
var require_proper_lockfile = __commonJS((exports, module) => {
  var lockfile = require_lockfile();
  var { toPromise, toSync, toSyncOptions } = require_adapter();
  async function lock(file, options) {
    const release = await toPromise(lockfile.lock)(file, options);
    return toPromise(release);
  }
  function lockSync(file, options) {
    const release = toSync(lockfile.lock)(file, toSyncOptions(options));
    return toSync(release);
  }
  function unlock(file, options) {
    return toPromise(lockfile.unlock)(file, options);
  }
  function unlockSync(file, options) {
    return toSync(lockfile.unlock)(file, toSyncOptions(options));
  }
  function check(file, options) {
    return toPromise(lockfile.check)(file, options);
  }
  function checkSync(file, options) {
    return toSync(lockfile.check)(file, toSyncOptions(options));
  }
  module.exports = lock;
  module.exports.lock = lock;
  module.exports.unlock = unlock;
  module.exports.lockSync = lockSync;
  module.exports.unlockSync = unlockSync;
  module.exports.check = check;
  module.exports.checkSync = checkSync;
});

// src/openclaw/index.ts
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { existsSync as existsSync6 } from "node:fs";
import { resolve as resolvePath } from "node:path";

// src/core/config.ts
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// src/core/fs-atomic.ts
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
function atomicWriteFileSync(target, contents) {
  withTempFile(target, contents, (tmpPath) => {
    renameSync(tmpPath, target);
  });
}
function atomicCreateFileSyncExclusive(target, contents) {
  withTempFile(target, contents, (tmpPath) => {
    try {
      linkSync(tmpPath, target);
    } finally {
      try {
        unlinkSync(tmpPath);
      } catch {}
    }
  });
}
function withTempFile(target, contents, commit) {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmpName = `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const tmpPath = join(dir, tmpName);
  let fd = null;
  let committed = false;
  try {
    fd = openSync(tmpPath, "wx", 420);
    const buf = Buffer.from(contents, "utf8");
    let written = 0;
    while (written < buf.byteLength) {
      written += writeSync(fd, buf, written, buf.byteLength - written);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    commit(tmpPath);
    committed = true;
    try {
      const dfd = openSync(dir, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {}
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {}
    }
    if (!committed) {
      try {
        unlinkSync(tmpPath);
      } catch {}
    }
    throw err;
  }
}

// src/core/fs-utils.ts
import { existsSync, statSync } from "node:fs";
function isFile(p) {
  if (!existsSync(p))
    return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function stem(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

// src/core/config.ts
var SECRET_KEY_PARTS = [
  "key",
  "token",
  "secret",
  "password",
  "credential"
];
function defaultConfigPath() {
  const override = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  if (override)
    return expandTilde(override);
  const xdg = process.env["XDG_CONFIG_HOME"];
  if (xdg)
    return join2(expandTilde(xdg), "open-second-brain", "config.yaml");
  return join2(homedir(), ".config", "open-second-brain", "config.yaml");
}
function parseSimpleYaml(text) {
  const data = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#"))
      continue;
    const idx = line.indexOf(":");
    if (idx === -1)
      continue;
    const key = line.slice(0, idx).trim();
    if (!key)
      continue;
    let value = line.slice(idx + 1).trim();
    if (value.length >= 2 && (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }
  return data;
}
function discoverConfig(path) {
  const resolved = path ?? defaultConfigPath();
  if (!isFile(resolved)) {
    return { path: resolved, exists: false, data: {} };
  }
  try {
    const text = readFileSync(resolved, "utf8");
    return { path: resolved, exists: true, data: parseSimpleYaml(text) };
  } catch {
    return { path: resolved, exists: false, data: {} };
  }
}
function validateTimezoneName(name) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return { ok: true, error: null };
  } catch (exc) {
    return { ok: false, error: exc.message ?? String(exc) };
  }
}
function resolveTimezone(configPath) {
  let name = process.env["VAULT_TIMEZONE"];
  if (!name) {
    name = discoverConfig(configPath).data["timezone"];
  }
  if (!name)
    return null;
  return validateTimezoneName(name).ok ? name : null;
}
function resolveAgentName(configPath) {
  const env = process.env["VAULT_AGENT_NAME"];
  if (env)
    return env;
  const data = discoverConfig(configPath).data;
  const value = data["agent_name"] ?? data["agentName"];
  if (value)
    return value;
  return "agent";
}
function redactMapping(data) {
  const redacted = {};
  for (const [key, value] of Object.entries(data)) {
    const lowered = key.toLowerCase();
    if (SECRET_KEY_PARTS.some((part) => lowered.includes(part))) {
      redacted[key] = "[REDACTED]";
    } else {
      redacted[key] = value;
    }
  }
  return redacted;
}
function expandTilde(p) {
  if (p === "~")
    return homedir();
  if (p.startsWith("~/"))
    return join2(homedir(), p.slice(2));
  return p;
}

// src/core/doctor.ts
import {
  existsSync as existsSync3,
  mkdirSync as mkdirSync2,
  openSync as openSync2,
  readFileSync as readFileSync2,
  rmSync,
  writeSync as writeSync2,
  closeSync as closeSync2
} from "node:fs";
import { dirname as dirname3, join as join4 } from "node:path";

// src/core/partner/codegraph.ts
import { existsSync as existsSync2, readdirSync, statSync as statSync2 } from "node:fs";
import { dirname as dirname2, join as join3, resolve } from "node:path";
var CODE_MANIFESTS = [
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "tsconfig.json",
  "Gemfile",
  "composer.json",
  "build.gradle",
  "pom.xml"
];
var DEFAULT_LIMIT = 50;
var CODEGRAPH_REPO = "https://github.com/colbymchenry/codegraph";
function isDir(path) {
  try {
    return statSync2(path).isDirectory();
  } catch {
    return false;
  }
}
function isCodeProject(dir) {
  try {
    if (!existsSync2(dir))
      return false;
    if (!isDir(join3(dir, ".git")))
      return false;
    return CODE_MANIFESTS.some((m) => existsSync2(join3(dir, m)));
  } catch {
    return false;
  }
}
function findCodeProjects(opts) {
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const seen = new Set;
  const found = [];
  let scanned = 0;
  const consider = (raw) => {
    if (scanned >= limit)
      return;
    const path = resolve(raw);
    if (seen.has(path))
      return;
    seen.add(path);
    if (!isDir(path))
      return;
    scanned += 1;
    if (isCodeProject(path))
      found.push(path);
  };
  consider(opts.cwd);
  const vaultParent = dirname2(resolve(opts.vault));
  if (isDir(vaultParent)) {
    let entries = [];
    try {
      entries = readdirSync(vaultParent);
    } catch {
      entries = [];
    }
    entries.sort((a, b) => a.localeCompare(b));
    for (const name of entries) {
      if (scanned >= limit)
        break;
      consider(join3(vaultParent, name));
    }
  }
  for (const extra of opts.scanExtraPaths ?? []) {
    if (scanned >= limit)
      break;
    consider(extra);
  }
  return found;
}
function defaultWhichCodegraph() {
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    const found = Bun.which("codegraph");
    return found ?? null;
  }
  return null;
}
function defaultRunStatusJson(projectPath) {
  try {
    const proc = Bun.spawnSync({
      cmd: ["codegraph", "status", "-j", projectPath],
      stdout: "pipe",
      stderr: "pipe"
    });
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    if (!proc.success) {
      if (stdout) {
        try {
          const parsed2 = JSON.parse(stdout);
          return { ok: true, data: parsed2 };
        } catch {}
      }
      return { ok: false, error: stderr || `codegraph status exited ${proc.exitCode}` };
    }
    if (!stdout) {
      return { ok: false, error: stderr || "empty status output" };
    }
    const parsed = JSON.parse(stdout);
    return { ok: true, data: parsed };
  } catch (exc) {
    return { ok: false, error: exc.message ?? String(exc) };
  }
}
function checkCodegraph(opts, deps) {
  if (opts.disabled)
    return null;
  const projects = findCodeProjects(opts);
  if (projects.length === 0)
    return null;
  const project = projects[0];
  const whichFn = deps?.whichCodegraph ?? defaultWhichCodegraph;
  const cliPath = whichFn();
  if (!cliPath) {
    return {
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: codegraph not installed (install: ${CODEGRAPH_REPO})`
    };
  }
  const indexDir = join3(project, ".codegraph");
  if (!isDir(indexDir)) {
    return {
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: not indexed (run: codegraph init ${project})`
    };
  }
  const runFn = deps?.runStatusJson ?? defaultRunStatusJson;
  const status = runFn(project);
  if (!status.ok) {
    return {
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: codegraph status failed: ${status.error}`
    };
  }
  if (!status.data.initialized) {
    return {
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: not indexed (run: codegraph init ${project})`
    };
  }
  const nodes = status.data.nodeCount ?? 0;
  const files = status.data.fileCount ?? 0;
  return {
    name: "code_graph",
    ok: true,
    message: `code project at ${project}: indexed (${nodes} nodes, ${files} files)`
  };
}

// src/core/doctor.ts
function checkVaultWriteable(vault) {
  if (!existsSync3(vault)) {
    return { name: "vault_writeable", ok: false, message: `vault directory missing: ${vault}` };
  }
  const probe = join4(vault, ".open-second-brain-doctor-test");
  try {
    const fd = openSync2(probe, "w");
    closeSync2(fd);
    rmSync(probe);
  } catch (exc) {
    return {
      name: "vault_writeable",
      ok: false,
      message: `cannot write to vault: ${exc.message ?? exc}`
    };
  }
  return { name: "vault_writeable", ok: true, message: `vault exists and is writable: ${vault}` };
}
function checkConfigWriteable(config) {
  let createdForCheck = false;
  try {
    mkdirSync2(dirname3(config), { recursive: true });
    if (!existsSync3(config))
      createdForCheck = true;
    const fd = openSync2(config, "a");
    writeSync2(fd, "");
    closeSync2(fd);
    if (createdForCheck)
      rmSync(config);
  } catch (exc) {
    return {
      name: "config_writeable",
      ok: false,
      message: `cannot write config ${config}: ${exc.message ?? exc}`
    };
  }
  return { name: "config_writeable", ok: true, message: `config writable: ${config}` };
}
function loadJsonManifest(path, name) {
  if (!isFile(path)) {
    return {
      result: { name, ok: false, message: `missing: ${path}` },
      data: null
    };
  }
  let data;
  try {
    data = JSON.parse(readFileSync2(path, "utf8"));
  } catch (exc) {
    return {
      result: { name, ok: false, message: `invalid JSON: ${path} (${exc.message})` },
      data: null
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      result: { name, ok: false, message: `invalid manifest object: ${path}` },
      data: null
    };
  }
  return {
    result: { name, ok: true, message: `valid: ${path}` },
    data
  };
}
function validateRequired(data, required) {
  const problems = [];
  for (const [field, expected] of required) {
    if (!(field in data)) {
      problems.push(`missing ${field}`);
      continue;
    }
    const v = data[field];
    const ok = isOfType(v, expected);
    if (!ok) {
      problems.push(`${field} must be ${typeName(expected)}`);
      continue;
    }
    if (typeof v === "string" && v.trim() === "") {
      problems.push(`${field} must not be empty`);
    } else if (Array.isArray(v) && v.length === 0) {
      problems.push(`${field} must not be empty`);
    }
  }
  return problems;
}
function isOfType(v, expected) {
  if (expected === "string")
    return typeof v === "string";
  if (expected === "list")
    return Array.isArray(v);
  return typeof v === "string" || Array.isArray(v);
}
function typeName(expected) {
  if (expected === "string")
    return "str";
  if (expected === "list")
    return "list";
  return expected.map((t) => t === "string" ? "str" : "list").join("/");
}
function checkCodexManifest(path) {
  const { result, data } = loadJsonManifest(path, "codex_manifest");
  if (!data)
    return result;
  const problems = validateRequired(data, [
    ["name", "string"],
    ["version", "string"],
    ["description", "string"],
    ["skills", "string"],
    ["keywords", "list"]
  ]);
  if (problems.length > 0) {
    return {
      name: "codex_manifest",
      ok: false,
      message: `schema invalid: ${path} (${problems.join("; ")})`
    };
  }
  return { name: "codex_manifest", ok: true, message: `valid Codex manifest: ${path}` };
}
function checkClaudeManifest(path) {
  const { result, data } = loadJsonManifest(path, "claude_manifest");
  if (!data)
    return result;
  const problems = validateRequired(data, [
    ["name", "string"],
    ["version", "string"],
    ["description", "string"]
  ]);
  for (const field of ["license", "repository", "homepage"]) {
    if (field in data && typeof data[field] !== "string") {
      problems.push(`${field} must be string`);
    }
  }
  if ("keywords" in data) {
    const kw = data["keywords"];
    if (!Array.isArray(kw) || !kw.every((k) => typeof k === "string")) {
      problems.push("keywords must be list of strings");
    }
  }
  if ("author" in data) {
    const author = data["author"];
    const authorName = typeof author === "object" && author !== null ? author["name"] : null;
    if (typeof author !== "object" || author === null || typeof authorName !== "string" || authorName.trim() === "") {
      problems.push("author must be an object with a non-empty 'name' field " + "(legacy string form is rejected by Claude 2.x)");
    }
  }
  if ("commands" in data) {
    problems.push("embedded 'commands' array is deprecated — author slash commands " + "as Markdown files under commands/ at plugin root instead");
  }
  if (problems.length > 0) {
    return {
      name: "claude_manifest",
      ok: false,
      message: `schema invalid: ${path} (${problems.join("; ")})`
    };
  }
  return { name: "claude_manifest", ok: true, message: `valid Claude manifest: ${path}` };
}
function checkHermesManifest(path) {
  if (!isFile(path)) {
    return { name: "hermes_manifest", ok: false, message: `missing: ${path}` };
  }
  let text;
  try {
    text = readFileSync2(path, "utf8");
  } catch (exc) {
    return {
      name: "hermes_manifest",
      ok: false,
      message: `invalid text: ${path} (${exc.message ?? exc})`
    };
  }
  const required = ["name", "version", "description"];
  const missing = [];
  for (const field of required) {
    if (!new RegExp(`^${field}\\s*:`, "m").test(text))
      missing.push(field);
  }
  if (missing.length > 0) {
    return {
      name: "hermes_manifest",
      ok: false,
      message: `schema invalid: ${path} (missing ${missing.join(", ")})`
    };
  }
  return { name: "hermes_manifest", ok: true, message: `readable Hermes manifest: ${path}` };
}
function checkOpenclawManifest(path) {
  const { result, data } = loadJsonManifest(path, "openclaw_manifest");
  if (!data)
    return result;
  const problems = [];
  if (typeof data["id"] !== "string" || data["id"].trim() === "") {
    problems.push("missing or empty field 'id'");
  }
  const schema = data["configSchema"];
  if (typeof schema !== "object" || schema === null || Object.keys(schema).length === 0) {
    problems.push("missing or empty field 'configSchema'");
  }
  if (problems.length > 0) {
    return {
      name: "openclaw_manifest",
      ok: false,
      message: `schema invalid: ${path} (${problems.join("; ")})`
    };
  }
  return { name: "openclaw_manifest", ok: true, message: `valid OpenClaw manifest: ${path}` };
}
function checkOpenclawInstallability(repoRoot) {
  const results = [];
  const pkgPath = join4(repoRoot, "package.json");
  const { result, data } = loadJsonManifest(pkgPath, "openclaw_package_json");
  results.push(result);
  if (!data)
    return results;
  const oc = data["openclaw"] ?? {};
  const extensions = oc["extensions"];
  if (!Array.isArray(extensions) || extensions.length === 0) {
    results.push({
      name: "openclaw_package_json_extensions",
      ok: false,
      message: "package.json missing or empty openclaw.extensions array"
    });
    return results;
  }
  results.push({
    name: "openclaw_package_json_extensions",
    ok: true,
    message: `package.json declares ${extensions.length} extension(s)`
  });
  for (const entry of extensions) {
    if (typeof entry !== "string") {
      results.push({
        name: `openclaw_entry_invalid_${typeof entry}`,
        ok: false,
        message: `extension entry must be a string, got: ${typeof entry}`
      });
      continue;
    }
    const entryPath = join4(repoRoot, entry);
    if (isFile(entryPath)) {
      results.push({
        name: `openclaw_entry_${entry}`,
        ok: true,
        message: `extension entry exists: ${entry}`
      });
    } else {
      results.push({
        name: `openclaw_entry_${entry}`,
        ok: false,
        message: `missing extension entry: ${entry}`
      });
    }
  }
  return results;
}
function doctor(opts) {
  const results = [];
  results.push(checkVaultWriteable(opts.vault));
  if (opts.config)
    results.push(checkConfigWriteable(opts.config));
  if (opts.repoRoot) {
    const root = opts.repoRoot;
    results.push(checkClaudeManifest(join4(root, ".claude-plugin", "plugin.json")));
    results.push(checkCodexManifest(join4(root, ".codex-plugin", "plugin.json")));
    results.push(checkHermesManifest(join4(root, "plugins", "hermes", "plugin.yaml")));
    results.push(checkOpenclawManifest(join4(root, "openclaw.plugin.json")));
    results.push(...checkOpenclawInstallability(root));
  }
  const cg = checkCodegraph({
    cwd: opts.cwd ?? process.cwd(),
    vault: opts.vault,
    scanExtraPaths: opts.partner?.codegraph?.scanExtraPaths,
    disabled: opts.partner?.codegraph?.disabled
  });
  if (cg)
    results.push(cg);
  return results;
}

// src/core/identity-reminder.ts
import { readFileSync as readFileSync3 } from "node:fs";
import { dirname as dirname4, resolve as resolve2 } from "node:path";
import { fileURLToPath } from "node:url";
var TEMPLATE_PATH = resolve2(dirname4(fileURLToPath(import.meta.url)), "..", "..", "templates", "identity-reminder.txt");
var KNOWN_RUNTIME_TARGETS = ["hermes", "openclaw"];
function isRuntimeTarget(value) {
  return typeof value === "string" && KNOWN_RUNTIME_TARGETS.includes(value);
}
var commonTemplateCache;
function loadReminderTemplate() {
  if (commonTemplateCache !== undefined)
    return commonTemplateCache;
  try {
    commonTemplateCache = readFileSync3(TEMPLATE_PATH, "utf8").trimEnd();
    return commonTemplateCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load identity reminder template from ${TEMPLATE_PATH}: ${message}`, {
      cause: err
    });
  }
}
var TEMPLATES_DIR = resolve2(dirname4(fileURLToPath(import.meta.url)), "..", "..", "templates");
var PER_TARGET_PATHS = Object.freeze(Object.fromEntries(KNOWN_RUNTIME_TARGETS.map((t) => [t, resolve2(TEMPLATES_DIR, `identity-reminder.${t}.txt`)])));
var TEMPLATE_CACHE = new Map;
function tryReadTargetTemplate(target) {
  const cached = TEMPLATE_CACHE.get(target);
  if (cached !== undefined)
    return cached;
  let body;
  try {
    body = readFileSync3(PER_TARGET_PATHS[target], "utf8").trimEnd();
  } catch (err) {
    if (err.code !== "ENOENT")
      throw err;
    body = null;
  }
  TEMPLATE_CACHE.set(target, body);
  return body;
}
var envWarnedOnce = false;
function resolveTargetFromEnv() {
  const raw = process.env.O2B_TARGET;
  if (raw === undefined || raw === "")
    return;
  if (isRuntimeTarget(raw))
    return raw;
  if (!envWarnedOnce) {
    envWarnedOnce = true;
    process.stderr.write(`open-second-brain: unknown O2B_TARGET='${raw}', using common identity template
`);
  }
  return;
}
function buildReminder(agent, target) {
  const effective = target ?? resolveTargetFromEnv();
  if (effective !== undefined) {
    const tpl = tryReadTargetTemplate(effective);
    if (tpl !== null)
      return tpl.replace(/\{agent\}/g, agent);
  }
  return loadReminderTemplate().replace(/\{agent\}/g, agent);
}

// src/core/pay-memory/paths.ts
import { join as join6, posix as posix3 } from "node:path";

// src/core/brain/paths.ts
import { join as join5, posix as posix2 } from "node:path";

// src/core/path-safety.ts
import { existsSync as existsSync4, realpathSync } from "node:fs";
import { dirname as dirname5, posix, relative, resolve as resolve3, sep } from "node:path";
function ensureInsideVault(target, vault) {
  const resolvedTarget = resolve3(target);
  const resolvedVault = resolve3(vault);
  if (!isLexicallyInside(resolvedTarget, resolvedVault)) {
    throw new Error(`path escapes vault: ${target}`);
  }
  if (existsSync4(resolvedVault)) {
    const realVault = safeRealpath(resolvedVault);
    const realAncestor = safeRealpath(deepestExistingAncestor(resolvedTarget));
    if (!isLexicallyInside(realAncestor, realVault)) {
      throw new Error(`path escapes vault via symlink: ${target}`);
    }
  }
  return resolvedTarget;
}
function isLexicallyInside(target, root) {
  const t = process.platform === "win32" ? target.toLowerCase() : target;
  const r = process.platform === "win32" ? root.toLowerCase() : root;
  return t === r || t.startsWith(r + sep);
}
function deepestExistingAncestor(target) {
  let cur = target;
  while (!existsSync4(cur)) {
    const parent = dirname5(cur);
    if (parent === cur)
      return cur;
    cur = parent;
  }
  return cur;
}
function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch (err) {
    if (err?.code === "ENOENT")
      return p;
    throw err;
  }
}
function vaultRelative(target, vault) {
  const rel = relative(resolve3(vault), resolve3(target));
  return rel.split(/[\\/]/).filter((p) => p.length > 0).join(posix.sep);
}

// src/core/brain/paths.ts
var BRAIN_ROOT_REL = "Brain";
var BRAIN_INBOX_REL = posix2.join(BRAIN_ROOT_REL, "inbox");
var BRAIN_PROCESSED_REL = posix2.join(BRAIN_INBOX_REL, "processed");
var BRAIN_PREFERENCES_REL = posix2.join(BRAIN_ROOT_REL, "preferences");
var BRAIN_RETIRED_REL = posix2.join(BRAIN_ROOT_REL, "retired");
var BRAIN_LOG_REL = posix2.join(BRAIN_ROOT_REL, "log");
var BRAIN_SNAPSHOTS_REL = posix2.join(BRAIN_ROOT_REL, ".snapshots");
var BRAIN_ARTIFACTS_REL = posix2.join(BRAIN_ROOT_REL, ".artifacts");
var BRAIN_INDEX_FILE = "_INDEX.md";
var BRAIN_INDEX_REL = posix2.join(BRAIN_ROOT_REL, BRAIN_INDEX_FILE);

// src/core/pay-memory/paths.ts
var PAY_MEMORY_ROOT_REL = posix3.join(BRAIN_ROOT_REL, "payments");
var PAY_MEMORY_POLICIES_REL = posix3.join(PAY_MEMORY_ROOT_REL, "policies");
var PAY_MEMORY_ASSETS_REL = posix3.join(PAY_MEMORY_ROOT_REL, "assets");
var PAY_MEMORY_DRAFTS_REL = posix3.join(PAY_MEMORY_ROOT_REL, "drafts");
var PAY_MEMORY_REPORTS_REL = posix3.join(PAY_MEMORY_ROOT_REL, "reports");
var PAY_MEMORY_PENDING_REL = posix3.join(PAY_MEMORY_ROOT_REL, "_pending");
var PAY_MEMORY_SPENDING_MD_REL = posix3.join(PAY_MEMORY_POLICIES_REL, "spending.md");
var PAY_MEMORY_SPENDING_JSON_REL = posix3.join(PAY_MEMORY_POLICIES_REL, "spending.json");
var ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
var HHMM_RE = /^(\d{2}):(\d{2})$/;
function payMemoryDirs(vault) {
  return {
    policies: join6(vault, PAY_MEMORY_POLICIES_REL),
    payments: join6(vault, PAY_MEMORY_ROOT_REL),
    assets: join6(vault, PAY_MEMORY_ASSETS_REL),
    drafts: join6(vault, PAY_MEMORY_DRAFTS_REL),
    reports: join6(vault, PAY_MEMORY_REPORTS_REL),
    pending: join6(vault, PAY_MEMORY_PENDING_REL)
  };
}
function policyPath(vault) {
  return join6(vault, PAY_MEMORY_SPENDING_MD_REL);
}
function paymentsDateDir(vault, date) {
  return join6(payMemoryDirs(vault).payments, validateIsoDate(date));
}
function receiptPath(vault, date, slug) {
  return join6(paymentsDateDir(vault, date), `${validateSlug(slug)}.md`);
}
function assetPath(vault, slug) {
  return join6(payMemoryDirs(vault).assets, `${validateSlug(slug)}.md`);
}
function reportPath(vault, slug) {
  return join6(payMemoryDirs(vault).reports, `${validateSlug(slug)}.md`);
}
var WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
function validateSlug(slug) {
  const trimmed = slug.trim();
  if (!trimmed)
    throw new Error("slug must not be empty");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`slug must not contain path separators: ${slug}`);
  }
  if (trimmed === ".." || trimmed === "." || /(?:^|[^\w])\.\.(?:$|[^\w])/.test(trimmed)) {
    throw new Error(`slug must not contain '..' traversal: ${slug}`);
  }
  if (/[. ]$/.test(trimmed)) {
    throw new Error(`slug must not end with '.' or whitespace (Windows-incompatible): ${slug}`);
  }
  if (WINDOWS_RESERVED_BASENAME_RE.test(trimmed)) {
    throw new Error(`slug uses a Windows-reserved filename: ${slug}`);
  }
  return trimmed;
}
function validateIsoDate(value) {
  const m = ISO_DATE_RE.exec(value);
  if (!m) {
    throw new Error("payment date must use YYYY-MM-DD format");
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error(`payment date is not a valid calendar date: ${value}`);
  }
  return value;
}
function validateIsoTime(value) {
  const m = HHMM_RE.exec(value);
  if (!m) {
    throw new Error("payment time must use HH:MM 24-hour format");
  }
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour > 23 || minute > 59) {
    throw new Error(`payment time out of range: ${value} (hour must be 0-23, minute 0-59)`);
  }
  return value;
}
function isoDateNow(tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date);
}
function isoTimeNow(tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz ?? undefined,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("hour")}:${get("minute")}`;
}
function isoTimestampZ(date, time, tz) {
  validateIsoDate(date);
  validateIsoTime(time);
  if (!tz) {
    return `${date}T${time}:00Z`;
  }
  const utcMillis = utcMillisForLocalWallClock(date, time, tz);
  return new Date(utcMillis).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function utcMillisForLocalWallClock(date, time, tz) {
  const naiveUtc = Date.parse(`${date}T${time}:00Z`);
  const offsetMinutes = tzOffsetMinutes(naiveUtc, tz);
  return naiveUtc - offsetMinutes * 60000;
}
function tzOffsetMinutes(instantMs, tz) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  });
  const parts = fmt.formatToParts(new Date(instantMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  const localUtcMs = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((localUtcMs - instantMs) / 60000);
}
// src/core/redactor.ts
var PLACEHOLDER = "***REDACTED***";
var PRIVATE_REGION_PLACEHOLDER = "***PRIVATE***";
var MAX_REDACTOR_INPUT = 256 * 1024;
var TRUNCATION_MARKER = `

[…truncated for size; original exceeded 256 KB. Inspect raw output before sharing.]
`;
var PRIVATE_OPEN_TAG_RE = /<private\b[^>]*>/gi;
var PRIVATE_CLOSE_TAG_RE = /<\/private>/gi;
var SECRET_KEYS = [
  "api_key",
  "token",
  "access_token",
  "refresh_token",
  "bearer",
  "secret",
  "client_secret",
  "authorization",
  "private_key",
  "password",
  "passwd",
  "pwd",
  "credential",
  "credentials",
  "session_token"
];
var KEY_PATTERN = SECRET_KEYS.map((k) => k.replace(/[-_]/g, "[-_]?")).join("|");
var ENV_RE = new RegExp(`\\b(${KEY_PATTERN})(\\s*=\\s*)([^\\s\\r\\n]+)`, "gi");
var COLON_VALUE_RE = new RegExp(`(?<!")\\b(${KEY_PATTERN})(\\s*:\\s*)("[^"]*"|'[^']*'|[^\\r\\n]+)`, "gi");
var JSON_ENTRY_RE = new RegExp(`("(?:${KEY_PATTERN})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|true|false|null|-?\\d+(?:\\.\\d+)?)`, "gi");
var BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._\-+/=]+)/gi;
function stripPrivateRegions(text) {
  if (!text)
    return text;
  let output = "";
  let cursor = 0;
  PRIVATE_OPEN_TAG_RE.lastIndex = 0;
  PRIVATE_CLOSE_TAG_RE.lastIndex = 0;
  while (cursor < text.length) {
    PRIVATE_OPEN_TAG_RE.lastIndex = cursor;
    const openMatch = PRIVATE_OPEN_TAG_RE.exec(text);
    if (!openMatch) {
      output += text.slice(cursor);
      break;
    }
    output += text.slice(cursor, openMatch.index);
    output += PRIVATE_REGION_PLACEHOLDER;
    let depth = 1;
    let scan = PRIVATE_OPEN_TAG_RE.lastIndex;
    while (depth > 0) {
      PRIVATE_OPEN_TAG_RE.lastIndex = scan;
      PRIVATE_CLOSE_TAG_RE.lastIndex = scan;
      const nextOpen = PRIVATE_OPEN_TAG_RE.exec(text);
      const nextClose = PRIVATE_CLOSE_TAG_RE.exec(text);
      if (!nextClose)
        return output;
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth += 1;
        scan = PRIVATE_OPEN_TAG_RE.lastIndex;
      } else {
        depth -= 1;
        scan = PRIVATE_CLOSE_TAG_RE.lastIndex;
      }
    }
    cursor = scan;
  }
  return output;
}
function redactRawOutput(text, opts = {}) {
  if (!text)
    return text;
  const maxInput = opts.maxInput ?? MAX_REDACTOR_INPUT;
  let out = text.length > maxInput ? text.slice(0, maxInput) + TRUNCATION_MARKER : text;
  out = stripPrivateRegions(out);
  out = out.replace(JSON_ENTRY_RE, (_match, keyPart, value) => {
    if (value.startsWith('"'))
      return `${keyPart}"${PLACEHOLDER}"`;
    return `${keyPart}${PLACEHOLDER}`;
  });
  out = out.replace(ENV_RE, (_match, key, sep2) => {
    return `${key}${sep2}${PLACEHOLDER}`;
  });
  out = out.replace(BEARER_RE, (_match, prefix) => `${prefix}${PLACEHOLDER}`);
  out = out.replace(COLON_VALUE_RE, (match, key, sep2, value) => {
    if (value.includes(PLACEHOLDER))
      return match;
    if (value.startsWith('"') && value.endsWith('"')) {
      return `${key}${sep2}"${PLACEHOLDER}"`;
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return `${key}${sep2}'${PLACEHOLDER}'`;
    }
    return `${key}${sep2}${PLACEHOLDER}`;
  });
  return out;
}
// src/core/pay-memory/policy.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync3, readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname6 } from "node:path";
var DEFAULT_POLICY_TEMPLATE = `# Agent Spending Policy

This file is read by the agent before any paid action. The agent MUST cite
this policy in the resulting payment receipt.

This MVP does not enforce limits at the payment layer. The policy exists so
that a human reviewer can see, after the fact, which rules the agent agreed
to follow.

## Budget

- Max total spend for the current task: TODO (e.g. $0.10)
- Max single paid call: TODO (e.g. $0.07)
- Max paid generations per task: TODO (e.g. 1)
- Approve repeats: false
- Approve dynamic pricing: false

## Allowed services

List the services the agent is allowed to call. One per line. Edit before
running a paid task.

- TODO

<!--
Example for the OpenSecondBrain hackathon demo:

- paysponge/fal
-->

## Required before each paid call

The agent must state:

- service name
- expected price range
- reason for payment
- expected output
- which vault files will be created or updated

## Required after each paid call

The agent must save:

- raw payment-tool output (after redaction)
- payment amount, if available
- service endpoint, if available
- generated asset URL or response identifier
- payment receipt note in \`${PAY_MEMORY_ROOT_REL}/<date>/\`
- daily event log entry referencing the receipt
`;
function writePolicyIfMissing(vault, opts = {}) {
  const target = policyPath(vault);
  const overwrite = opts.overwrite ?? false;
  mkdirSync3(dirname6(target), { recursive: true });
  if (overwrite) {
    const existed = existsSync5(target);
    atomicWriteFileSync(target, DEFAULT_POLICY_TEMPLATE);
    return existed ? buildPolicyResult(target, "overwritten") : buildPolicyResult(target, "created");
  }
  try {
    atomicCreateFileSyncExclusive(target, DEFAULT_POLICY_TEMPLATE);
    return buildPolicyResult(target, "created");
  } catch (err) {
    if (err?.code === "EEXIST") {
      return buildPolicyResult(target, "skipped");
    }
    throw err;
  }
}
function buildPolicyResult(path, status) {
  return {
    path,
    status,
    created: status === "created",
    overwritten: status === "overwritten",
    skipped: status === "skipped"
  };
}
// src/core/vault.ts
import { mkdirSync as mkdirSync4, readFileSync as readFileSync5, readdirSync as readdirSync2, writeFileSync } from "node:fs";
import { dirname as dirname7, join as join7, relative as relative2 } from "node:path";
var FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n?/;
var KEY_VALUE_RE = /^([a-zA-Z_][a-zA-Z0-9_-]*)\s*:\s*(.*?)\s*$/;
var PLAIN_SCALAR_RE = /^[A-Za-z0-9_./-](?:[A-Za-z0-9_./ -]*[A-Za-z0-9_./-])?$/;
var SLUG_INVALID_RE = /[^a-z0-9]+/g;
var SLUG_MAX_LEN = 64;
var MEDIA_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bmp",
  ".tiff",
  ".avif",
  ".mp4",
  ".webm",
  ".ogv",
  ".mov",
  ".mkv",
  ".avi",
  ".mp3",
  ".wav",
  ".ogg",
  ".flac",
  ".m4a",
  ".pdf"
]);
var DEFAULT_SKIP_DIRS = [".git", ".obsidian", ".trash", ".stversions"];
var DEFAULT_SKIP_FILES = ["index.md", "log.md"];
function parseFrontmatter(path) {
  let text;
  try {
    text = readFileSync5(path, "utf8");
  } catch {
    return [{}, ""];
  }
  return parseFrontmatterText(text);
}
function parseFrontmatterText(text) {
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return [{}, text.trim()];
  }
  const fmBlock = match[1];
  const body = text.slice(match[0].length).trim();
  const metadata = {};
  for (const rawLine of fmBlock.split(`
`)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#"))
      continue;
    const kv = KEY_VALUE_RE.exec(line);
    if (!kv)
      continue;
    const key = kv[1];
    let value = kv[2].trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      metadata[key] = inner ? splitInlineArray(inner) : [];
      continue;
    }
    metadata[key] = stripQuotes(value);
  }
  return [metadata, body];
}
function formatFrontmatter(metadata, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(metadata)) {
    lines.push(`${key}: ${formatYamlValue(value)}`);
  }
  lines.push("---");
  if (body) {
    lines.push("");
    lines.push(body);
  }
  return lines.join(`
`) + `
`;
}
function writeFrontmatterAtomic(path, metadata, body, opts = {}) {
  const contents = formatFrontmatter(metadata, body);
  if (opts.overwrite) {
    atomicWriteFileSync(path, contents);
    return;
  }
  try {
    atomicCreateFileSyncExclusive(path, contents);
  } catch (err) {
    if (opts.existsErrorKind && err?.code === "EEXIST") {
      const rel = opts.vaultForRelativePath ? path.startsWith(opts.vaultForRelativePath + "/") ? path.slice(opts.vaultForRelativePath.length + 1) : path : path;
      throw new Error(`${opts.existsErrorKind} already exists: ${rel}`, { cause: err });
    }
    throw err;
  }
}
function slugify(value) {
  const lowered = value.trim().toLowerCase();
  let slug = lowered.replace(SLUG_INVALID_RE, "-").replace(/^-+|-+$/g, "");
  if (!slug)
    slug = "note";
  slug = slug.slice(0, SLUG_MAX_LEN).replace(/-+$/, "");
  return slug || "note";
}
function listVaultPages(vaultDir, opts = {}) {
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);
  const skipFiles = new Set((opts.skipFiles ?? DEFAULT_SKIP_FILES).map((f) => f.toLowerCase()));
  const pages = [];
  walk(vaultDir, vaultDir, skipDirs, skipFiles, pages);
  pages.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  return pages;
}
function walk(root, dir, skipDirs, skipFiles, out) {
  let entries;
  try {
    entries = readdirSync2(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join7(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name))
        continue;
      walk(root, full, skipDirs, skipFiles, out);
      continue;
    }
    if (!entry.isFile())
      continue;
    if (!entry.name.toLowerCase().endsWith(".md"))
      continue;
    if (skipFiles.has(entry.name.toLowerCase()))
      continue;
    const rel = relative2(root, full);
    const parts = rel.split(/[\\/]/);
    if (parts.some((p) => skipDirs.has(p)))
      continue;
    let meta;
    try {
      [meta] = parseFrontmatter(full);
    } catch {
      continue;
    }
    const titleVal = meta["title"];
    const title = typeof titleVal === "string" && titleVal ? titleVal : stem(entry.name);
    out.push({ title, path: full, metadata: meta });
  }
}
function stripQuotes(s) {
  if (s.length >= 2 && (s.startsWith('"') && s.endsWith('"') || s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
function splitInlineArray(inner) {
  const out = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0;i < inner.length; i++) {
    const ch = inner[i];
    if (inQuote) {
      current += ch;
      if (ch === quoteChar && inner[i - 1] !== "\\") {
        inQuote = false;
        quoteChar = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = true;
      quoteChar = ch;
      current += ch;
      continue;
    }
    if (ch === ",") {
      out.push(stripQuotes(current.trim()));
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") {
    out.push(stripQuotes(current.trim()));
  }
  return out;
}
function formatYamlScalar(value) {
  const text = typeof value === "string" ? value : String(value);
  if (text && PLAIN_SCALAR_RE.test(text) && !text.includes(": ") && !text.includes(" #")) {
    return text;
  }
  const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t");
  return `"${escaped}"`;
}
function formatYamlValue(value) {
  if (Array.isArray(value)) {
    return "[" + value.map((item) => formatYamlScalar(item)).join(", ") + "]";
  }
  return formatYamlScalar(value);
}

// src/core/pay-memory/_md.ts
var NOT_PROVIDED = "_(not provided)_";
function stripMarkdownExt(target) {
  return target.replace(/\.md$/i, "");
}
function sanitizeWikilinkTarget(target) {
  return target.replace(/[[\]]/g, "");
}
function wikiLink(target) {
  return `[[${stripMarkdownExt(sanitizeWikilinkTarget(target.trim()))}]]`;
}
function formatCode(value) {
  const trimmed = (value ?? "").trim();
  if (!trimmed)
    return NOT_PROVIDED;
  return `\`${trimmed.replace(/`/g, "ˋ")}\``;
}
function nowIsoZ() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
function putIfPresent(meta, key, value) {
  if (value === null || value === undefined)
    return;
  const trimmed = String(value).trim();
  if (!trimmed)
    return;
  meta[key] = trimmed;
}
function frontmatterStr(value) {
  if (value === undefined || value === null)
    return "";
  if (Array.isArray(value))
    return value.join(", ");
  return String(value);
}

// src/core/pay-memory/receipt.ts
var RECEIPT_FRONTMATTER_TYPE = "agent-payment-receipt";
function writeReceipt(vault, input) {
  if (!input.service?.trim())
    throw new Error("receipt requires a service");
  if (!input.status?.trim())
    throw new Error("receipt requires a status");
  if (!input.reason?.trim())
    throw new Error("receipt requires a reason");
  if (!input.agent?.trim())
    throw new Error("receipt requires an agent");
  const tz = input.tz ?? null;
  const date = validateIsoDate(input.date ?? isoDateNow(tz));
  const time = validateIsoTime(input.time ?? isoTimeNow(tz));
  const slug = input.slug && input.slug.trim() || defaultReceiptSlug(input.service, input.reason);
  const target = receiptPath(vault, date, slug);
  ensureInsideVault(target, vault);
  const created = isoTimestampZ(date, time, tz);
  const paymentLayer = input.paymentLayer?.trim() || "pay.sh";
  const network = input.network?.trim() || "solana";
  const metadata = {
    type: RECEIPT_FRONTMATTER_TYPE,
    agent: input.agent.trim(),
    payment_layer: paymentLayer,
    network,
    service: input.service.trim(),
    status: input.status.trim(),
    reason: input.reason.trim(),
    created
  };
  if (tz)
    metadata["timezone"] = tz;
  putIfPresent(metadata, "category", input.category);
  putIfPresent(metadata, "endpoint", input.endpoint);
  putIfPresent(metadata, "expected_cost", input.expectedCost);
  putIfPresent(metadata, "actual_amount", input.actualAmount);
  putIfPresent(metadata, "currency", input.currency);
  putIfPresent(metadata, "payment_proof", input.paymentProof);
  putIfPresent(metadata, "result_ref", input.resultRef);
  putIfPresent(metadata, "result_note", input.resultNote);
  metadata["policy_status"] = input.policyStatus ?? "not_checked";
  putIfPresent(metadata, "policy_rule", input.policyRule);
  if (input.policyReasons && input.policyReasons.length > 0) {
    metadata["policy_reasons"] = [...input.policyReasons];
  }
  putIfPresent(metadata, "policy_checked_at", input.policyCheckedAt);
  putIfPresent(metadata, "approval_request", input.approvalRequestId);
  putIfPresent(metadata, "approval_status", input.approvalStatus);
  putIfPresent(metadata, "approved_by", input.approvedBy);
  putIfPresent(metadata, "approved_at", input.approvedAt);
  const body = renderReceiptBody(input);
  writeFrontmatterAtomic(target, metadata, body, {
    overwrite: input.overwrite,
    existsErrorKind: "receipt",
    vaultForRelativePath: vault
  });
  return {
    path: target,
    relativePath: vaultRelative(target, vault),
    slug,
    date,
    created
  };
}
function defaultReceiptSlug(service, reason) {
  const tail = service.split("/").pop() ?? service;
  return slugify(`${tail}-${reason}`);
}
function renderPolicySection(input) {
  const status = input.policyStatus ?? "not_checked";
  const out = ["Decision:", ""];
  switch (status) {
    case "allowed":
      out.push("Allowed by the configured spending policy. The agent ran a policy", "check before initiating this paid call.");
      break;
    case "approval_required":
      out.push("Policy returned `approval_required` — a human approval was needed", "before initiating this paid call.");
      break;
    case "denied":
      out.push("Policy returned `denied` — this receipt records a paid call that", "the policy did not approve. If the call still proceeded, a human", "explicitly waved the policy aside; check the approval section", "below for who and why.");
      break;
    case "not_checked":
    default:
      out.push("Not checked. The receipt was created without a policy decision —", `either no \`${PAY_MEMORY_SPENDING_JSON_REL}\` is configured, or the`, "caller chose not to evaluate the policy. This is *not* a claim", "that the call was allowed.");
      break;
  }
  if (input.policyRule?.trim()) {
    out.push("", `Rule fired: \`${input.policyRule.trim()}\``);
  }
  if (input.policyReasons && input.policyReasons.length > 0) {
    out.push("", "Reasons:", "");
    for (const r of input.policyReasons)
      out.push(`- ${r}`);
  }
  if (input.policyCheckedAt?.trim()) {
    out.push("", `Policy checked at: \`${input.policyCheckedAt.trim()}\``);
  }
  if (input.approvalRequestId?.trim() || input.approvalStatus?.trim() || input.approvedBy?.trim()) {
    out.push("", "Approval:");
    if (input.approvalRequestId?.trim()) {
      out.push("", `Request: [[${PAY_MEMORY_PENDING_REL}/${input.approvalRequestId.trim()}]]`);
    }
    if (input.approvalStatus?.trim()) {
      out.push(`Status: \`${input.approvalStatus.trim()}\``);
    }
    if (input.approvedBy?.trim()) {
      out.push(`Approved by: ${input.approvedBy.trim()}`);
    }
    if (input.approvedAt?.trim()) {
      out.push(`Approved at: \`${input.approvedAt.trim()}\``);
    }
  }
  out.push("");
  return out;
}
function fieldOrPlaceholder(value) {
  if (value === null || value === undefined)
    return NOT_PROVIDED;
  const trimmed = String(value).trim();
  return trimmed || NOT_PROVIDED;
}
function renderReceiptBody(input) {
  const reason = input.reason.trim();
  const title = `Payment Receipt: ${reason}`;
  const resultNote = input.resultNote?.trim();
  const resultNoteLine = resultNote ? `[[${stripMarkdownExt(sanitizeWikilinkTarget(resultNote))}]]` : NOT_PROVIDED;
  const rawOutput = input.rawOutput ? redactRawOutput(input.rawOutput) : null;
  const lines = [
    `# ${title}`,
    "",
    "## Why this paid call was made",
    "",
    reason,
    "",
    "## Spending policy check",
    "",
    "Policy file:",
    "",
    `[[${stripMarkdownExt(PAY_MEMORY_SPENDING_MD_REL)}]]`,
    "",
    ...renderPolicySection(input),
    "## Expected cost",
    "",
    fieldOrPlaceholder(input.expectedCost),
    "",
    "## Request",
    "",
    "Service:",
    "",
    formatCode(input.service),
    "",
    "Endpoint:",
    "",
    formatCode(input.endpoint),
    "",
    "Reason:",
    "",
    reason,
    "",
    "## Payment",
    "",
    "Amount:",
    "",
    formatCode(input.actualAmount),
    "",
    "Currency:",
    "",
    formatCode(input.currency),
    "",
    "Payment proof / transaction / receipt:",
    "",
    formatCode(input.paymentProof),
    "",
    "## Result",
    "",
    "Generated asset:",
    "",
    formatCode(input.resultRef),
    "",
    "Asset note:",
    "",
    resultNoteLine,
    "",
    "## Raw pay.sh output",
    ""
  ];
  if (rawOutput) {
    lines.push("```text", rawOutput.replace(/\r\n?/g, `
`).replace(/\s+$/g, ""), "```");
  } else {
    lines.push(NOT_PROVIDED);
  }
  lines.push("", "> Verify raw output above does not contain credentials before sharing this", "> receipt outside the vault. Best-effort redaction has been applied.");
  return lines.join(`
`);
}
// src/core/pay-memory/asset.ts
var ASSET_FRONTMATTER_TYPE = "generated-asset";
function writeAsset(vault, input) {
  if (!input.title?.trim())
    throw new Error("asset requires a title");
  if (!input.service?.trim())
    throw new Error("asset requires a service");
  if (!input.resultUrl?.trim())
    throw new Error("asset requires a result_url");
  const slug = input.slug && input.slug.trim() || slugify(input.title);
  const target = assetPath(vault, slug);
  ensureInsideVault(target, vault);
  const created = nowIsoZ();
  const metadata = {
    type: ASSET_FRONTMATTER_TYPE,
    title: input.title.trim(),
    source: input.service.trim(),
    result_url: input.resultUrl.trim(),
    created
  };
  if (input.sourceReceipt?.trim()) {
    metadata["source_receipt"] = wikiLink(input.sourceReceipt);
  }
  if (input.usedIn?.trim()) {
    metadata["used_in"] = wikiLink(input.usedIn);
  }
  writeFrontmatterAtomic(target, metadata, renderAssetBody(input), {
    overwrite: input.overwrite,
    existsErrorKind: "asset",
    vaultForRelativePath: vault
  });
  return {
    path: target,
    relativePath: vaultRelative(target, vault),
    slug,
    created
  };
}
function renderAssetBody(input) {
  const title = input.title.trim();
  const usedIn = input.usedIn?.trim();
  const sourceReceipt = input.sourceReceipt?.trim();
  const prompt = input.prompt?.trim();
  const lines = [`# ${title}`, ""];
  lines.push("## Purpose", "");
  if (usedIn) {
    lines.push(`Used in: ${wikiLink(usedIn)}`);
  } else {
    lines.push(NOT_PROVIDED);
  }
  lines.push("");
  lines.push("## Prompt", "");
  if (prompt) {
    lines.push(...prompt.split(/\r?\n/).map((line) => line ? `> ${line}` : ">"));
  } else {
    lines.push(NOT_PROVIDED);
  }
  lines.push("");
  lines.push("## Result", "", `${input.resultUrl.trim()}`, "");
  lines.push("## Source", "");
  lines.push(`Service: \`${input.service.trim().replace(/`/g, "ˋ")}\``);
  if (sourceReceipt) {
    lines.push(`Receipt: ${wikiLink(sourceReceipt)}`);
  } else {
    lines.push(`Receipt: ${NOT_PROVIDED}`);
  }
  lines.push("");
  lines.push("## Notes", "", "Generated through a paid API call recorded in the linked receipt.");
  return lines.join(`
`);
}
// src/core/pay-memory/report.ts
import { readdirSync as readdirSync3 } from "node:fs";
import { join as join8 } from "node:path";
var REPORT_FRONTMATTER_TYPE = "payment-report";
function aggregateReceipts(vault, date) {
  const dir = paymentsDateDir(vault, date);
  let entries;
  try {
    entries = readdirSync3(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT")
      return [];
    throw err;
  }
  const summaries = [];
  for (const entry of entries) {
    if (!entry.isFile())
      continue;
    if (!entry.name.toLowerCase().endsWith(".md"))
      continue;
    const full = join8(dir, entry.name);
    let meta;
    try {
      [meta] = parseFrontmatter(full);
    } catch {
      continue;
    }
    if (frontmatterStr(meta["type"]) !== RECEIPT_FRONTMATTER_TYPE)
      continue;
    const service = frontmatterStr(meta["service"]);
    const status = frontmatterStr(meta["status"]);
    if (!service || !status)
      continue;
    summaries.push({
      path: vaultRelative(full, vault),
      service,
      status,
      category: frontmatterStr(meta["category"]) || null,
      actualAmount: frontmatterStr(meta["actual_amount"]) || null,
      currency: frontmatterStr(meta["currency"]) || null,
      resultRef: frontmatterStr(meta["result_ref"]) || null,
      resultNote: frontmatterStr(meta["result_note"]) || null,
      reason: frontmatterStr(meta["reason"]) || null
    });
  }
  summaries.sort((a, b) => {
    const s = a.service.localeCompare(b.service);
    return s !== 0 ? s : a.path.localeCompare(b.path);
  });
  return summaries;
}
function writeReport(vault, input) {
  const date = validateIsoDate(input.date);
  const title = input.title && input.title.trim() || `Payment Report ${date}`;
  const slug = input.slug && input.slug.trim() || slugify(`payment-report-${date}`);
  const target = reportPath(vault, slug);
  ensureInsideVault(target, vault);
  const summaries = aggregateReceipts(vault, date);
  const created = nowIsoZ();
  const metadata = {
    type: REPORT_FRONTMATTER_TYPE,
    title,
    date,
    created,
    receipts_used: summaries.length
  };
  if (input.task?.trim())
    metadata["task"] = input.task.trim();
  writeFrontmatterAtomic(target, metadata, renderReportBody(date, title, input.task ?? null, summaries), {
    overwrite: input.overwrite,
    existsErrorKind: "report",
    vaultForRelativePath: vault
  });
  return {
    path: target,
    relativePath: vaultRelative(target, vault),
    slug,
    receiptsUsed: summaries.length
  };
}
function renderReportBody(date, title, task, summaries) {
  const lines = [`# ${title}`, "", `Date: ${date}`, ""];
  lines.push("## Task", "");
  lines.push(task && task.trim() ? task.trim() : NOT_PROVIDED);
  lines.push("");
  lines.push("## Paid services used", "");
  if (summaries.length === 0) {
    lines.push("No receipts found for this date.");
  } else {
    for (const s of summaries) {
      lines.push(`### ${s.service}`, "");
      lines.push(`Status: \`${s.status}\``);
      if (s.reason)
        lines.push(`Reason: ${s.reason}`);
      lines.push(`Receipt: [[${stripMarkdownExt(s.path)}]]`);
      if (s.actualAmount) {
        const amount = s.currency ? `${s.actualAmount} ${s.currency}` : s.actualAmount;
        lines.push(`Amount: \`${amount}\``);
      }
      if (s.resultRef)
        lines.push(`Result: \`${s.resultRef}\``);
      if (s.resultNote)
        lines.push(`Asset: [[${stripMarkdownExt(s.resultNote)}]]`);
      lines.push("");
    }
  }
  lines.push("## Files", "");
  if (summaries.length === 0) {
    lines.push(NOT_PROVIDED);
  } else {
    for (const s of summaries) {
      lines.push(`- [[${stripMarkdownExt(s.path)}]]`);
      if (s.resultNote)
        lines.push(`- [[${stripMarkdownExt(s.resultNote)}]]`);
    }
  }
  return lines.join(`
`);
}
// src/core/pay-memory/policy-rules.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join9 } from "node:path";
var POLICY_SCHEMA_VERSION = 1;
function policyJsonPath(vault) {
  return join9(payMemoryDirs(vault).policies, "spending.json");
}
function loadPolicyRules(vault) {
  const target = policyJsonPath(vault);
  let text;
  try {
    text = readFileSync6(target, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT")
      return null;
    throw new Error(`failed to read ${target}: ${err.message ?? String(err)}`, {
      cause: err
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${target} is not valid JSON: ${err.message ?? String(err)}`, {
      cause: err
    });
  }
  return validatePolicyRules(parsed, target);
}
function validatePolicyRules(value, source) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${source} must be a JSON object at the root`);
  }
  const obj = value;
  const out = {};
  if ("schema_version" in obj) {
    const v = obj["schema_version"];
    if (typeof v !== "number") {
      throw new Error(`${source}: schema_version must be a number`);
    }
    if (v !== POLICY_SCHEMA_VERSION) {
      throw new Error(`${source}: unsupported schema_version ${v}; expected ${POLICY_SCHEMA_VERSION}. ` + "Upgrade Open Second Brain or roll the policy back to the matching schema.");
    }
    out["schema_version"] = v;
  }
  if ("currency" in obj) {
    if (typeof obj["currency"] !== "string") {
      throw new Error(`${source}: currency must be a string`);
    }
    out["currency"] = obj["currency"];
  }
  for (const k of ["max_total_per_day", "max_single_call", "require_approval_above"]) {
    if (k in obj) {
      const v = obj[k];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`${source}: ${k} must be a non-negative finite number`);
      }
      out[k] = v;
    }
  }
  if ("allowed_services" in obj) {
    const v = obj["allowed_services"];
    if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
      throw new Error(`${source}: allowed_services must be an array of strings`);
    }
    out["allowed_services"] = [...v];
  }
  if ("max_per_category" in obj) {
    const v = obj["max_per_category"];
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new Error(`${source}: max_per_category must be an object`);
    }
    const map = {};
    for (const [k, n] of Object.entries(v)) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        throw new Error(`${source}: max_per_category.${k} must be a non-negative integer`);
      }
      map[k] = n;
    }
    out["max_per_category"] = map;
  }
  return out;
}
function evaluatePolicy(rules, request, context) {
  if (!rules) {
    return {
      status: "allowed",
      allowed: true,
      approvalRequired: false,
      reasons: [],
      rule: null,
      hasPolicy: false,
      policyPath: null,
      currency: null
    };
  }
  const reasons = [];
  let denyRule = null;
  let approvalRule = null;
  const policyCurrency = rules.currency ?? "USDC";
  if (rules.allowed_services && rules.allowed_services.length > 0) {
    if (!rules.allowed_services.includes(request.service)) {
      reasons.push(`service ${JSON.stringify(request.service)} is not in allowed_services`);
      denyRule ??= "allowed_services";
    }
  }
  const reqCurrency = request.currency ?? policyCurrency;
  if (request.currency && request.currency !== policyCurrency) {
    reasons.push(`request currency ${request.currency} differs from policy ${policyCurrency} — ` + "amount-based limits cannot be evaluated; please normalize before checking");
    denyRule ??= "currency_mismatch";
  }
  const amount = typeof request.expectedAmount === "number" ? request.expectedAmount : null;
  if (amount === null && (rules.max_single_call !== undefined || rules.max_total_per_day !== undefined || rules.require_approval_above !== undefined)) {
    reasons.push("expected_amount is required to evaluate amount-based policy rules; " + "request human approval explicitly");
    approvalRule ??= "missing_expected_amount";
  }
  if (rules.max_single_call !== undefined && amount !== null && amount > rules.max_single_call) {
    reasons.push(`expected amount ${amount} ${reqCurrency} exceeds max_single_call ` + `${rules.max_single_call} ${policyCurrency}`);
    denyRule ??= "max_single_call";
  }
  if (rules.max_total_per_day !== undefined && amount !== null && context.daySpend + amount > rules.max_total_per_day) {
    reasons.push(`daily spend ${context.daySpend} + ${amount} = ${context.daySpend + amount} ` + `exceeds max_total_per_day ${rules.max_total_per_day} ${policyCurrency}`);
    denyRule ??= "max_total_per_day";
  }
  if (request.category && rules.max_per_category) {
    const cap = rules.max_per_category[request.category];
    if (cap !== undefined && context.dayCategoryCount >= cap) {
      reasons.push(`category '${request.category}' already has ${context.dayCategoryCount} ` + `receipt(s) today; cap is ${cap}`);
      denyRule ??= "max_per_category";
    }
  }
  if (rules.require_approval_above !== undefined && amount !== null && amount > rules.require_approval_above) {
    approvalRule = "require_approval_above";
    reasons.push(`expected amount ${amount} ${reqCurrency} exceeds approval threshold ` + `${rules.require_approval_above} ${policyCurrency}`);
  }
  const status = denyRule ? "denied" : approvalRule ? "approval_required" : "allowed";
  return {
    status,
    allowed: status === "allowed",
    approvalRequired: status === "approval_required",
    reasons,
    rule: denyRule ?? approvalRule,
    hasPolicy: true,
    policyPath: null,
    currency: policyCurrency
  };
}
function checkPolicy(vault, request) {
  const rules = loadPolicyRules(vault);
  const date = validateIsoDate(request.date ?? isoDateNow(request.tz));
  const summaries = aggregateReceipts(vault, date);
  const policyCurrency = rules?.currency ?? "USDC";
  let daySpend = 0;
  for (const s of summaries) {
    if (!s.actualAmount)
      continue;
    if (s.currency && s.currency !== policyCurrency)
      continue;
    const n = parseFloat(s.actualAmount);
    if (Number.isFinite(n))
      daySpend += n;
  }
  const dayCategoryCount = request.category ? summaries.filter((s) => s.category === request.category).length : 0;
  const decision = evaluatePolicy(rules, request, { daySpend, dayCategoryCount });
  return {
    ...decision,
    policyPath: rules ? policyJsonPath(vault) : null
  };
}
// src/core/pay-memory/approval.ts
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import { join as join10 } from "node:path";
var PENDING_REQUEST_FRONTMATTER_TYPE = "pending-payment-request";
function pendingDir(vault) {
  return join10(vault, PAY_MEMORY_PENDING_REL);
}
function pendingRequestPath(vault, id) {
  return join10(pendingDir(vault), `${validateSlug(id)}.md`);
}
function writePendingRequest(vault, input) {
  if (!input.service?.trim())
    throw new Error("pending request requires a service");
  if (!input.reason?.trim())
    throw new Error("pending request requires a reason");
  if (!input.agent?.trim())
    throw new Error("pending request requires an agent");
  const tz = input.tz ?? null;
  const date = validateIsoDate(input.date ?? isoDateNow(tz));
  const time = validateIsoTime(input.time ?? isoTimeNow(tz));
  const id = input.slug && input.slug.trim() || defaultRequestSlug(input, date, time);
  const target = pendingRequestPath(vault, id);
  ensureInsideVault(target, vault);
  const decision = checkPolicy(vault, {
    service: input.service.trim(),
    expectedAmount: input.expectedAmount ?? null,
    currency: input.currency ?? null,
    category: input.category ?? null,
    date,
    tz
  });
  if (input.enforcePolicy && !decision.allowed && !decision.approvalRequired) {
    throw new Error(`policy denied: ${decision.reasons.join("; ") || decision.rule || "no reason given"}`);
  }
  const created = isoTimestampZ(date, time, tz);
  const metadata = {
    type: PENDING_REQUEST_FRONTMATTER_TYPE,
    id,
    agent: input.agent.trim(),
    service: input.service.trim(),
    reason: input.reason.trim(),
    status: "pending",
    created,
    policy_status: decision.status
  };
  if (tz)
    metadata["timezone"] = tz;
  if (decision.rule)
    metadata["policy_rule"] = decision.rule;
  putIfPresent(metadata, "category", input.category);
  putIfPresent(metadata, "endpoint", input.endpoint);
  putIfPresent(metadata, "currency", input.currency);
  if (typeof input.expectedAmount === "number") {
    metadata["expected_amount"] = String(input.expectedAmount);
  }
  writeFrontmatterAtomic(target, metadata, renderRequestBody(input, decision), {
    overwrite: false,
    existsErrorKind: "pending request",
    vaultForRelativePath: vault
  });
  return {
    path: target,
    relativePath: vaultRelative(target, vault),
    id,
    status: "pending",
    created,
    policyDecision: decision
  };
}
function loadPendingRequest(vault, id) {
  const target = pendingRequestPath(vault, id);
  const [metadata, body] = parseFrontmatter(target);
  if (frontmatterStr(metadata["type"]) !== PENDING_REQUEST_FRONTMATTER_TYPE)
    return null;
  const status = parseStatus(frontmatterStr(metadata["status"]));
  return {
    metadata,
    body,
    path: target,
    relativePath: vaultRelative(target, vault),
    id,
    status
  };
}
async function consumePendingRequest(vault, id, opts) {
  const receiptPath2 = opts.receiptPath?.trim();
  if (!receiptPath2) {
    throw new Error("consume-payment-request requires a non-empty receiptPath");
  }
  return transitionRequest(vault, id, "approved", "consumed", (meta) => {
    meta["receipt"] = receiptPath2;
    meta["consumed_at"] = nowIsoZ();
  });
}
async function transitionRequest(vault, id, expectedFrom, newStatus, patch) {
  const lockTarget = pendingRequestPath(vault, id);
  const initial = loadPendingRequest(vault, id);
  if (!initial) {
    throw new Error(`pending request not found: ${id}`);
  }
  const release = await import_proper_lockfile.default.lock(lockTarget, {
    retries: { retries: 30, factor: 1.2, minTimeout: 30, maxTimeout: 500 },
    stale: 1e4,
    realpath: false
  });
  try {
    const loaded = loadPendingRequest(vault, id);
    if (!loaded) {
      throw new Error(`pending request not found: ${id}`);
    }
    if (loaded.status !== expectedFrom) {
      throw new Error(`cannot transition request ${id} from ${loaded.status} to ${newStatus} ` + `(expected ${expectedFrom})`);
    }
    const newMeta = { ...loaded.metadata };
    newMeta["status"] = newStatus;
    patch(newMeta);
    writeFrontmatterAtomic(loaded.path, newMeta, loaded.body, { overwrite: true });
    return {
      path: loaded.path,
      relativePath: loaded.relativePath,
      id,
      status: newStatus,
      created: frontmatterStr(loaded.metadata["created"]),
      policyDecision: {
        status: parseDecisionStatus(frontmatterStr(loaded.metadata["policy_status"])),
        allowed: frontmatterStr(loaded.metadata["policy_status"]) === "allowed",
        approvalRequired: frontmatterStr(loaded.metadata["policy_status"]) === "approval_required",
        reasons: [],
        rule: frontmatterStr(loaded.metadata["policy_rule"]) || null,
        hasPolicy: Boolean(frontmatterStr(loaded.metadata["policy_status"])),
        policyPath: null,
        currency: frontmatterStr(loaded.metadata["currency"]) || null
      }
    };
  } finally {
    await release();
  }
}
function defaultRequestSlug(input, date, time) {
  const tail = input.service.split("/").pop() ?? input.service;
  return slugify(`req-${date}-${time.replace(":", "")}-${tail}-${input.reason}`);
}
function renderRequestBody(input, decision) {
  const reason = input.reason.trim();
  const lines = [
    `# Pending Payment Request: ${reason}`,
    "",
    "## Service",
    "",
    formatCode(input.service),
    "",
    "## Reason",
    "",
    reason,
    "",
    "## Expected cost",
    "",
    typeof input.expectedAmount === "number" ? `\`${input.expectedAmount}\`${input.currency ? ` ${input.currency}` : ""}` : NOT_PROVIDED,
    "",
    "## Endpoint",
    "",
    formatCode(input.endpoint),
    "",
    "## Expected output",
    "",
    input.expectedOutput?.trim() ?? NOT_PROVIDED,
    "",
    "## Vault files that will change",
    ""
  ];
  if (input.vaultFiles && input.vaultFiles.length > 0) {
    for (const f of input.vaultFiles)
      lines.push(`- \`${f}\``);
  } else {
    lines.push(NOT_PROVIDED);
  }
  lines.push("", "## Policy check", "", `Status: \`${decision.status}\``);
  if (decision.rule)
    lines.push(`Rule fired: \`${decision.rule}\``);
  if (decision.reasons.length > 0) {
    lines.push("", "Reasons:", "");
    for (const r of decision.reasons)
      lines.push(`- ${r}`);
  }
  lines.push("", "## How to approve / reject", "", "Use the `o2b` CLI:", "", "```bash", `o2b approve-payment-request --vault <vault> --id <id> --approved-by <name>`, `o2b reject-payment-request --vault <vault> --id <id> --rejected-by <name> [--reason "..."]`, "```", "", "Once approved, the agent will execute the paid call and call", "`o2b consume-payment-request` to link the resulting receipt back here.");
  return lines.join(`
`);
}
function parseStatus(raw) {
  if (raw === "pending" || raw === "approved" || raw === "rejected" || raw === "consumed") {
    return raw;
  }
  throw new Error(`invalid payment-request status: ${JSON.stringify(raw)}`);
}
function parseDecisionStatus(raw) {
  if (raw === "denied" || raw === "approval_required")
    return raw;
  return "allowed";
}
// src/openclaw/index.ts
import { mkdirSync as mkdirSync5 } from "node:fs";

// src/core/agent-identity.ts
var PLACEHOLDER_AGENT_VALUES = new Set([
  "agent",
  "assistant",
  "ai",
  "ai-assistant",
  "bot",
  "chatbot",
  "claude",
  "claude-code",
  "codex",
  "codex-cli",
  "codex-exec",
  "copilot",
  "gemini",
  "gpt",
  "gpt-4",
  "gpt-5",
  "hermes",
  "llm",
  "model",
  "openai",
  "openclaw",
  "user"
]);
function normalizeAgentArgument(value) {
  if (value === null || value === undefined)
    return null;
  const cleaned = String(value).trim().replace(/^@+/, "").trim();
  if (!cleaned)
    return null;
  const canonical = cleaned.toLowerCase().replace(/_/g, "-");
  if (PLACEHOLDER_AGENT_VALUES.has(canonical))
    return null;
  return cleaned;
}

// src/core/validate.ts
function parseOptionalFiniteNumberInput(raw) {
  if (raw === undefined || raw === null)
    return { value: null, error: null };
  if (typeof raw === "number") {
    if (!Number.isFinite(raw))
      return { value: null, error: "finite-number" };
    return { value: raw, error: null };
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "")
      return { value: null, error: null };
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed))
      return { value: null, error: "number-or-numeric-string" };
    return { value: parsed, error: null };
  }
  return { value: null, error: "number-or-numeric-string" };
}

// src/openclaw/index.ts
function resolveVaultPath(api) {
  const cfg = api.pluginConfig ?? {};
  return cfg.vault || process.env["VAULT_DIR"] || ".";
}
function resolveOpenclawTimezone(api) {
  const cfg = api.pluginConfig ?? {};
  const candidate = cfg.timezone || process.env["VAULT_TIMEZONE"] || null;
  if (!candidate)
    return null;
  return validateTimezoneName(candidate).ok ? candidate : null;
}
function resolveOpenclawAgent(api, argAgent) {
  const normalized = normalizeAgentArgument(argAgent);
  if (normalized)
    return normalized;
  const cfg = api.pluginConfig ?? {};
  return cfg.agentName ?? process.env["VAULT_AGENT_NAME"] ?? resolveAgentName();
}
function coerceExpectedAmount(value) {
  const parsed = parseOptionalFiniteNumberInput(value);
  if (parsed.error === "finite-number") {
    throw new Error("expected_amount must be a finite number");
  }
  if (parsed.error === "number-or-numeric-string") {
    throw new Error("expected_amount must be a number or numeric string");
  }
  return parsed.value;
}
function strOrNull(value) {
  if (value === undefined || value === null)
    return null;
  if (typeof value !== "string")
    return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}
function asJson(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }]
  };
}
var openclaw_default = definePluginEntry({
  register(api) {
    api.on("before_prompt_build", () => {
      const cfg = api.pluginConfig ?? {};
      const agent = normalizeAgentArgument(cfg.agentName ?? null) ?? process.env["VAULT_AGENT_NAME"] ?? resolveAgentName();
      if (agent === "agent")
        return;
      return { prependContext: buildReminder(agent, "openclaw") };
    });
    api.registerTool({
      name: "second_brain_status",
      description: "Report Open Second Brain configuration and vault status.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      },
      async execute() {
        const vault = resolveVaultPath(api);
        const discovery = discoverConfig();
        const result = {
          config_path: discovery.path,
          config_exists: discovery.exists,
          config_keys: Object.keys(discovery.data).toSorted(),
          config: redactMapping(discovery.data),
          vault_path: vault,
          vault_exists: existsSync6(vault)
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
    });
    api.registerTool({
      name: "second_brain_query",
      description: "List vault pages with optional title substring filter.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Optional case-insensitive substring matched against page titles."
          },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 500,
            description: "Maximum number of matched pages to return (default 50)."
          }
        },
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        if (!existsSync6(vault))
          throw new Error(`vault directory missing: ${vault}`);
        const pattern = params["pattern"] ?? null;
        const limit = typeof params["limit"] === "number" ? params["limit"] : 50;
        if (limit < 1 || limit > 500)
          throw new Error("argument 'limit' must be between 1 and 500");
        const pages = listVaultPages(vault);
        const needle = pattern ? pattern.toLowerCase() : null;
        const matched = (needle === null ? pages : pages.filter((p) => p.title.toLowerCase().includes(needle))).slice(0, limit).map((p) => ({
          title: p.title,
          path: vaultRelative(p.path, vault),
          metadata: p.metadata
        }));
        const result = {
          vault_path: vault,
          total_pages: pages.length,
          returned: matched.length,
          limit,
          pattern,
          pages: matched
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
    });
    api.registerTool({
      name: "vault_health",
      description: "Run vault, config, and plugin manifest health checks.",
      parameters: {
        type: "object",
        properties: {
          repo: {
            type: "string",
            description: "Optional repository root to validate plugin manifests."
          }
        },
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        const repoRoot = params["repo"] ?? null;
        const results = doctor({ vault, repoRoot });
        const result = {
          vault_path: vault,
          ok: results.every((r) => r.ok),
          checks: results.map((r) => ({
            name: r.name,
            ok: r.ok,
            message: r.message
          }))
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
    });
    api.registerTool({
      name: "payment_memory_init",
      description: "Bootstrap the Pay Memory layout (policies/, payments/, assets/, drafts/, reports/) and write the spending policy template.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string" },
          overwrite: { type: "boolean" }
        },
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        const overwrite = Boolean(params["overwrite"] ?? false);
        const agent = resolveOpenclawAgent(api, params["agent"] ?? null);
        const dirs = payMemoryDirs(vault);
        const created = [];
        const skipped = [];
        for (const dir of [dirs.policies, dirs.payments, dirs.assets, dirs.drafts, dirs.reports]) {
          const existed = existsSync6(dir);
          mkdirSync5(dir, { recursive: true });
          (existed ? skipped : created).push(vaultRelative(dir, vault));
        }
        const policy = writePolicyIfMissing(vault, { overwrite });
        return asJson({
          vault_path: vault,
          agent,
          created,
          skipped,
          policy_path: vaultRelative(policy.path, vault),
          policy_status: policy.status
        });
      }
    });
    api.registerTool({
      name: "payment_receipt_append",
      description: "Save a Markdown receipt for one paid API call. raw_output is run through a redactor before persisting.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string" },
          service: { type: "string" },
          status: { type: "string" },
          reason: { type: "string" },
          category: { type: "string" },
          endpoint: { type: "string" },
          expected_cost: { type: "string" },
          actual_amount: { type: "string" },
          currency: { type: "string" },
          payment_proof: { type: "string" },
          result_ref: { type: "string" },
          result_note: { type: "string" },
          raw_output: { type: "string" },
          slug: { type: "string" },
          date: { type: "string" },
          time: { type: "string" },
          overwrite: { type: "boolean" },
          policy_status: {
            type: "string",
            enum: ["allowed", "approval_required", "denied", "not_checked"]
          },
          policy_rule: { type: "string" },
          policy_reasons: { type: "array", items: { type: "string" } },
          policy_checked_at: { type: "string" },
          from_request: { type: "string" },
          payment_layer: { type: "string" },
          network: { type: "string" }
        },
        required: ["service", "status", "reason"],
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        const tz = resolveOpenclawTimezone(api) ?? resolveTimezone();
        const agent = resolveOpenclawAgent(api, params["agent"] ?? null);
        let policyStatus = strOrNull(params["policy_status"]);
        let policyRule = strOrNull(params["policy_rule"]);
        const policyReasonsRaw = params["policy_reasons"];
        let policyReasons = null;
        if (policyReasonsRaw !== undefined && policyReasonsRaw !== null) {
          if (!Array.isArray(policyReasonsRaw) || !policyReasonsRaw.every((s) => typeof s === "string")) {
            throw new Error("policy_reasons must be an array of strings");
          }
          policyReasons = [...policyReasonsRaw];
        }
        let policyCheckedAt = strOrNull(params["policy_checked_at"]);
        let approvalStatus = null;
        let approvedBy = null;
        let approvedAt = null;
        const fromRequest = strOrNull(params["from_request"]);
        if (fromRequest) {
          const loaded = loadPendingRequest(vault, fromRequest);
          if (!loaded)
            throw new Error(`pending request not found: ${fromRequest}`);
          const meta = loaded.metadata;
          const get = (k) => {
            const v = meta[k];
            if (v === undefined || v === null)
              return null;
            return Array.isArray(v) ? v.join(", ") : String(v);
          };
          policyStatus ??= get("policy_status") ?? null;
          policyRule ??= get("policy_rule");
          approvalStatus = loaded.status;
          approvedBy = get("approved_by");
          approvedAt = get("approved_at");
        }
        if (policyStatus !== null) {
          const allowed = [
            "allowed",
            "approval_required",
            "denied",
            "not_checked"
          ];
          if (!allowed.includes(policyStatus)) {
            throw new Error(`policy_status must be one of: ${allowed.join(", ")}`);
          }
        }
        const result = writeReceipt(vault, {
          agent,
          service: String(params["service"]),
          status: String(params["status"]),
          reason: String(params["reason"]),
          paymentLayer: strOrNull(params["payment_layer"]),
          network: strOrNull(params["network"]),
          category: strOrNull(params["category"]),
          endpoint: strOrNull(params["endpoint"]),
          expectedCost: strOrNull(params["expected_cost"]),
          actualAmount: strOrNull(params["actual_amount"]),
          currency: strOrNull(params["currency"]),
          paymentProof: strOrNull(params["payment_proof"]),
          resultRef: strOrNull(params["result_ref"]),
          resultNote: strOrNull(params["result_note"]),
          rawOutput: strOrNull(params["raw_output"]),
          slug: strOrNull(params["slug"]),
          date: strOrNull(params["date"]),
          time: strOrNull(params["time"]),
          overwrite: Boolean(params["overwrite"] ?? false),
          tz,
          policyStatus,
          policyRule,
          policyReasons,
          policyCheckedAt,
          approvalRequestId: fromRequest,
          approvalStatus,
          approvedBy,
          approvedAt
        });
        return asJson({
          path: result.relativePath,
          absolute_path: resolvePath(result.path),
          slug: result.slug,
          date: result.date,
          created: result.created
        });
      }
    });
    api.registerTool({
      name: "asset_capture",
      description: "Save a Markdown note for an asset produced by a paid call, linked to its receipt.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          service: { type: "string" },
          result_url: { type: "string" },
          source_receipt: { type: "string" },
          prompt: { type: "string" },
          used_in: { type: "string" },
          slug: { type: "string" },
          overwrite: { type: "boolean" }
        },
        required: ["title", "service", "result_url"],
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        const result = writeAsset(vault, {
          title: String(params["title"]),
          service: String(params["service"]),
          resultUrl: String(params["result_url"]),
          sourceReceipt: strOrNull(params["source_receipt"]),
          prompt: strOrNull(params["prompt"]),
          usedIn: strOrNull(params["used_in"]),
          slug: strOrNull(params["slug"]),
          overwrite: Boolean(params["overwrite"] ?? false)
        });
        return asJson({
          path: result.relativePath,
          absolute_path: resolvePath(result.path),
          slug: result.slug,
          created: result.created
        });
      }
    });
    api.registerTool({
      name: "payment_report_generate",
      description: `Aggregate a date's payment receipts into a Markdown report under ${PAY_MEMORY_REPORTS_REL}/.`,
      parameters: {
        type: "object",
        properties: {
          date: { type: "string" },
          title: { type: "string" },
          task: { type: "string" },
          slug: { type: "string" },
          overwrite: { type: "boolean" }
        },
        required: ["date"],
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        const result = writeReport(vault, {
          date: String(params["date"]),
          title: strOrNull(params["title"]),
          task: strOrNull(params["task"]),
          slug: strOrNull(params["slug"]),
          overwrite: Boolean(params["overwrite"] ?? false)
        });
        return asJson({
          path: result.relativePath,
          absolute_path: resolvePath(result.path),
          slug: result.slug,
          receipts_used: result.receiptsUsed
        });
      }
    });
    api.registerTool({
      name: "payment_policy_check",
      description: `Evaluate a prospective paid call against ${PAY_MEMORY_SPENDING_JSON_REL}. Returns allowed / approval_required / denied + the rule that fired.`,
      parameters: {
        type: "object",
        properties: {
          service: { type: "string" },
          expected_amount: { type: ["number", "string"] },
          currency: { type: "string" },
          category: { type: "string" },
          date: { type: "string" }
        },
        required: ["service"],
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        const tz = resolveOpenclawTimezone(api) ?? resolveTimezone();
        const decision = checkPolicy(vault, {
          service: String(params["service"]),
          expectedAmount: coerceExpectedAmount(params["expected_amount"]),
          currency: strOrNull(params["currency"]),
          category: strOrNull(params["category"]),
          date: strOrNull(params["date"]),
          tz
        });
        return asJson({
          status: decision.status,
          allowed: decision.allowed,
          approval_required: decision.approvalRequired,
          rule: decision.rule,
          reasons: decision.reasons,
          has_policy: decision.hasPolicy,
          policy_path: decision.policyPath !== null ? vaultRelative(decision.policyPath, vault) : null,
          currency: decision.currency
        });
      }
    });
    api.registerTool({
      name: "payment_request_approval",
      description: "Create a pending-payment-request that the user must approve before the agent runs `pay`. Records the policy check at request time.",
      parameters: {
        type: "object",
        properties: {
          agent: { type: "string" },
          service: { type: "string" },
          reason: { type: "string" },
          expected_amount: { type: ["number", "string"] },
          currency: { type: "string" },
          category: { type: "string" },
          endpoint: { type: "string" },
          expected_output: { type: "string" },
          vault_files: { type: "array", items: { type: "string" } },
          slug: { type: "string" },
          date: { type: "string" },
          time: { type: "string" },
          enforce_policy: { type: "boolean" }
        },
        required: ["service", "reason"],
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        const tz = resolveOpenclawTimezone(api) ?? resolveTimezone();
        const agent = resolveOpenclawAgent(api, params["agent"] ?? null);
        const vaultFilesRaw = params["vault_files"];
        let vaultFiles = null;
        if (vaultFilesRaw !== undefined && vaultFilesRaw !== null) {
          if (!Array.isArray(vaultFilesRaw) || !vaultFilesRaw.every((s) => typeof s === "string")) {
            throw new Error("vault_files must be an array of strings");
          }
          vaultFiles = [...vaultFilesRaw];
        }
        const result = writePendingRequest(vault, {
          agent,
          service: String(params["service"]),
          reason: String(params["reason"]),
          expectedAmount: coerceExpectedAmount(params["expected_amount"]),
          currency: strOrNull(params["currency"]),
          category: strOrNull(params["category"]),
          endpoint: strOrNull(params["endpoint"]),
          expectedOutput: strOrNull(params["expected_output"]),
          vaultFiles,
          slug: strOrNull(params["slug"]),
          date: strOrNull(params["date"]),
          time: strOrNull(params["time"]),
          enforcePolicy: Boolean(params["enforce_policy"] ?? false),
          tz
        });
        return asJson({
          id: result.id,
          path: result.relativePath,
          absolute_path: resolvePath(result.path),
          status: result.status,
          created: result.created,
          policy_status: result.policyDecision.status,
          policy_rule: result.policyDecision.rule
        });
      }
    });
    api.registerTool({
      name: "payment_request_status",
      description: "Look up a pending-payment-request by id and return its current status and metadata. The agent uses this to poll for human approval.",
      parameters: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        const id = String(params["id"]);
        const loaded = loadPendingRequest(vault, id);
        if (!loaded)
          throw new Error(`pending request not found: ${id}`);
        const meta = loaded.metadata;
        const get = (k) => {
          const v = meta[k];
          if (v === undefined || v === null)
            return null;
          return Array.isArray(v) ? v.join(", ") : String(v);
        };
        return asJson({
          id,
          path: loaded.relativePath,
          status: loaded.status,
          service: get("service"),
          reason: get("reason"),
          expected_amount: get("expected_amount"),
          currency: get("currency"),
          created: get("created"),
          approved_by: get("approved_by"),
          approved_at: get("approved_at"),
          rejected_by: get("rejected_by"),
          rejected_at: get("rejected_at"),
          rejection_reason: get("rejection_reason"),
          receipt: get("receipt"),
          policy_status: get("policy_status"),
          policy_rule: get("policy_rule")
        });
      }
    });
    api.registerTool({
      name: "payment_request_consume",
      description: "Mark an `approved` request as `consumed` and link the resulting receipt path. Called by the agent after the paid call succeeded.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          receipt: { type: "string" }
        },
        required: ["id", "receipt"],
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        const result = await consumePendingRequest(vault, String(params["id"]), {
          receiptPath: String(params["receipt"])
        });
        return asJson({
          id: result.id,
          path: result.relativePath,
          status: result.status
        });
      }
    });
  }
});
export {
  openclaw_default as default
};
