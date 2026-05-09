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
    return (...args) => new Promise((resolve, reject) => {
      args.push((err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
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
import { existsSync as existsSync5 } from "node:fs";
import { join as join6 } from "node:path";

// src/core/config.ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join as join2 } from "node:path";

// src/core/fs-atomic.ts
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
function atomicWriteFileSync(target, contents) {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmpName = `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const tmpPath = join(dir, tmpName);
  let fd = null;
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
    renameSync(tmpPath, target);
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
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

// src/core/config.ts
var SECRET_KEY_PARTS = ["key", "token", "secret", "password", "credential"];
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
  if (!isRegularFile(resolved)) {
    return { path: resolved, exists: false, data: {} };
  }
  try {
    const text = readFileSync(resolved, "utf8");
    return { path: resolved, exists: true, data: parseSimpleYaml(text) };
  } catch {
    return { path: resolved, exists: false, data: {} };
  }
}
function resolveTimezone(configPath) {
  let name = process.env["VAULT_TIMEZONE"];
  if (!name) {
    name = discoverConfig(configPath).data["timezone"];
  }
  if (!name)
    return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return name;
  } catch {
    return null;
  }
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
function isRegularFile(p) {
  if (!existsSync(p))
    return false;
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

// src/core/doctor.ts
import {
  existsSync as existsSync2,
  mkdirSync as mkdirSync2,
  openSync as openSync2,
  readFileSync as readFileSync2,
  rmSync,
  statSync as statSync2,
  writeSync as writeSync2,
  closeSync as closeSync2
} from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
function checkVaultWriteable(vault) {
  if (!existsSync2(vault)) {
    return { name: "vault_writeable", ok: false, message: `vault directory missing: ${vault}` };
  }
  const probe = join3(vault, ".open-second-brain-doctor-test");
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
    mkdirSync2(dirname2(config), { recursive: true });
    if (!existsSync2(config))
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
    return { name: "codex_manifest", ok: false, message: `schema invalid: ${path} (${problems.join("; ")})` };
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
    return { name: "claude_manifest", ok: false, message: `schema invalid: ${path} (${problems.join("; ")})` };
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
    return { name: "openclaw_manifest", ok: false, message: `schema invalid: ${path} (${problems.join("; ")})` };
  }
  return { name: "openclaw_manifest", ok: true, message: `valid OpenClaw manifest: ${path}` };
}
function checkOpenclawInstallability(repoRoot) {
  const results = [];
  const pkgPath = join3(repoRoot, "package.json");
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
    const entryPath = join3(repoRoot, entry);
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
    results.push(checkClaudeManifest(join3(root, ".claude-plugin", "plugin.json")));
    results.push(checkCodexManifest(join3(root, ".codex-plugin", "plugin.json")));
    results.push(checkHermesManifest(join3(root, "plugins", "hermes", "plugin.yaml")));
    results.push(checkOpenclawManifest(join3(root, "openclaw.plugin.json")));
    results.push(...checkOpenclawInstallability(root));
  }
  return results;
}
function isFile(p) {
  if (!existsSync2(p))
    return false;
  try {
    return statSync2(p).isFile();
  } catch {
    return false;
  }
}

// src/core/event-log.ts
var import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3 } from "node:fs";
import { join as join4 } from "node:path";
var SECRET_ASSIGNMENT_RE = /\b(api[_-]?key|token|secret|password|credential)(\s*[:=]\s*)\S+/gi;
var EVENT_RE = /^- (\d{2}:\d{2}) — @/;
var DATE_RE = /^(\d{4})\.(\d{2})\.(\d{2})$/;
var TIME_RE = /^(\d{2}):(\d{2})$/;
function redactText(text) {
  return text.replace(SECRET_ASSIGNMENT_RE, (_match, field, sep) => `${field}${sep}[REDACTED]`);
}
function currentDate(tz) {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz ?? undefined,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return fmt.format(new Date).replace(/-/g, ".");
}
function currentTime(tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz ?? undefined,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return `${get("hour")}:${get("minute")}`;
}
function dailyNotePath(vaultDir, date) {
  return join4(vaultDir, "Daily", `${validateEventDate(date)}.md`);
}
function newDailyNote(date) {
  return `---
formatted: false
---

# ${date}

## Raw events

`;
}
function validateEventTime(value) {
  const m = TIME_RE.exec(value);
  if (!m) {
    throw new Error("event time must use HH:MM 24-hour format");
  }
  const hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (hour > 23 || minute > 59) {
    throw new Error("event time must use HH:MM 24-hour format");
  }
  return value;
}
function validateEventDate(value) {
  const m = DATE_RE.exec(value);
  if (!m) {
    throw new Error("event date must use YYYY.MM.DD format");
  }
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (utc.getUTCFullYear() !== year || utc.getUTCMonth() !== month - 1 || utc.getUTCDate() !== day) {
    throw new Error("event date must use YYYY.MM.DD format");
  }
  return value;
}
function insertEventEntry(content, entry) {
  const marker = "## Raw events";
  const idx = content.indexOf(marker);
  if (idx === -1) {
    return content.trimEnd() + `

` + marker + `

` + entry + `
`;
  }
  const before = content.slice(0, idx);
  let after = content.slice(idx + marker.length).replace(/^\n+/, "");
  const lines = after.split(`
`).filter((line) => line.trim());
  const entryTime = entry.slice(2, 7);
  let inserted = false;
  const output = [];
  for (const line of lines) {
    const m = EVENT_RE.exec(line);
    if (!inserted && m && m[1] > entryTime) {
      output.push(entry);
      inserted = true;
    }
    output.push(line);
  }
  if (!inserted)
    output.push(entry);
  let raw = output.join(`
`);
  if (raw)
    raw += `
`;
  return before + marker + `

` + raw;
}
async function appendEvent(vaultDir, agent, message, opts = {}) {
  const tz = opts.tz ?? null;
  const eventDate = validateEventDate(opts.date ?? currentDate(tz));
  const eventTime = validateEventTime(opts.time ?? currentTime(tz));
  const path = dailyNotePath(vaultDir, eventDate);
  const cleanMessage = redactText(message).replace(/\r?\n/g, " ");
  const entry = `- ${eventTime} — @${agent} — ${cleanMessage}`;
  const dailyDir = join4(vaultDir, "Daily");
  mkdirSync3(dailyDir, { recursive: true });
  const release = await import_proper_lockfile.default.lock(dailyDir, {
    retries: { retries: 30, factor: 1.2, minTimeout: 30, maxTimeout: 500 },
    stale: 1e4,
    realpath: false
  });
  try {
    let content;
    if (existsSync3(path)) {
      content = readFileSync3(path, "utf8");
    } else {
      content = newDailyNote(eventDate);
    }
    if (!content.includes("## Raw events")) {
      content = content.trimEnd() + `

## Raw events

`;
    }
    const updated = insertEventEntry(content, entry);
    atomicWriteFileSync(path, updated);
  } finally {
    await release();
  }
  return path;
}

// src/core/identity-reminder.ts
import { readFileSync as readFileSync4 } from "node:fs";
import { dirname as dirname3, resolve } from "node:path";
import { fileURLToPath } from "node:url";
var TEMPLATE_PATH = resolve(dirname3(fileURLToPath(import.meta.url)), "..", "..", "templates", "identity-reminder.txt");
function loadReminderTemplate() {
  try {
    return readFileSync4(TEMPLATE_PATH, "utf8").trimEnd();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load identity reminder template from ${TEMPLATE_PATH}: ${message}`);
  }
}
function buildReminder(agent) {
  return loadReminderTemplate().replace(/\{agent\}/g, agent);
}

// src/core/vault.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync5, readdirSync, statSync as statSync3, writeFileSync } from "node:fs";
import { dirname as dirname4, join as join5, relative } from "node:path";
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
function writeFrontmatter(path, metadata, body) {
  mkdirSync4(dirname4(path), { recursive: true });
  const lines = ["---"];
  for (const [key, value] of Object.entries(metadata)) {
    lines.push(`${key}: ${formatYamlValue(value)}`);
  }
  lines.push("---");
  if (body) {
    lines.push("");
    lines.push(body);
  }
  writeFileSync(path, lines.join(`
`) + `
`, "utf8");
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
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join5(dir, entry.name);
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
    const rel = relative(root, full);
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
function stem(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
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
// package.json
var package_default = {
  name: "open-second-brain",
  version: "0.7.0",
  type: "module",
  private: false,
  description: "Second brain for AI agents using Obsidian-compatible Markdown vaults. Works with Hermes, Claude Code, Codex, and OpenClaw.",
  license: "MIT",
  homepage: "https://github.com/itechmeat/open-second-brain",
  repository: {
    type: "git",
    url: "https://github.com/itechmeat/open-second-brain.git"
  },
  keywords: ["second-brain", "obsidian", "agents", "openclaw-plugin", "mcp"],
  engines: {
    bun: ">=1.1.0"
  },
  bin: {
    o2b: "./scripts/o2b",
    "vault-log": "./scripts/vault-log"
  },
  scripts: {
    "build:openclaw": "bun build src/openclaw/index.ts --outfile openclaw/index.js --target=node --format=esm --external openclaw/plugin-sdk/plugin-entry",
    test: "bun test",
    typecheck: "tsc --noEmit",
    "sync-version": "bun run scripts/sync-version.ts",
    "sync-version:check": "bun run scripts/sync-version.ts --check"
  },
  files: [
    "openclaw/",
    "src/",
    "skills/",
    "scripts/",
    "plugins/",
    "openclaw.plugin.json",
    "README.md",
    "LICENSE",
    "pyproject.toml"
  ],
  dependencies: {
    "proper-lockfile": "^4.1.2"
  },
  devDependencies: {
    "@types/bun": "^1.1.0",
    "@types/node": "^22.0.0",
    "@types/proper-lockfile": "^4.1.4",
    typescript: "^5.5.0"
  },
  openclaw: {
    extensions: ["./openclaw/index.js"]
  }
};

// src/mcp/protocol.ts
var SERVER_VERSION = package_default.version;

// src/mcp/tools.ts
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
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: candidate });
    return candidate;
  } catch {
    return null;
  }
}
function resolveOpenclawAgent(api, argAgent) {
  const normalized = normalizeAgentArg(argAgent);
  if (normalized)
    return normalized;
  const cfg = api.pluginConfig ?? {};
  return cfg.agentName ?? process.env["VAULT_AGENT_NAME"] ?? resolveAgentName();
}
function normalizeAgentArg(value) {
  if (value === null || value === undefined)
    return null;
  const cleaned = String(value).trim().replace(/^@+/, "").trim();
  if (!cleaned)
    return null;
  if (PLACEHOLDER_AGENT_VALUES.has(cleaned.toLowerCase()))
    return null;
  return cleaned;
}
function vaultRel(target, vault) {
  if (target.startsWith(vault + "/"))
    return target.slice(vault.length + 1);
  return target;
}
var openclaw_default = definePluginEntry({
  register(api) {
    api.on("before_prompt_build", () => {
      const cfg = api.pluginConfig ?? {};
      const agent = normalizeAgentArg(cfg.agentName ?? null) ?? process.env["VAULT_AGENT_NAME"] ?? resolveAgentName();
      if (agent === "agent")
        return;
      return { prependContext: buildReminder(agent) };
    });
    api.registerTool({
      name: "second_brain_status",
      description: "Report Open Second Brain configuration and vault status.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        const vault = resolveVaultPath(api);
        const discovery = discoverConfig();
        const result = {
          config_path: discovery.path,
          config_exists: discovery.exists,
          config_keys: Object.keys(discovery.data).sort(),
          config: redactMapping(discovery.data),
          vault_path: vault,
          vault_exists: existsSync5(vault)
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
        if (!existsSync5(vault))
          throw new Error(`vault directory missing: ${vault}`);
        const pattern = params["pattern"] ?? null;
        const limit = typeof params["limit"] === "number" ? params["limit"] : 50;
        if (limit < 1 || limit > 500)
          throw new Error("argument 'limit' must be between 1 and 500");
        const pages = listVaultPages(vault);
        const needle = pattern ? pattern.toLowerCase() : null;
        const matched = (needle === null ? pages : pages.filter((p) => p.title.toLowerCase().includes(needle))).slice(0, limit).map((p) => ({ title: p.title, path: vaultRel(p.path, vault), metadata: p.metadata }));
        const result = {
          vault_path: vault,
          total_pages: pages.length,
          returned: matched.length,
          limit,
          pattern,
          pages: matched
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    });
    api.registerTool({
      name: "second_brain_capture",
      description: "Write a new Markdown note to AI Wiki/notes/ with frontmatter.",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string", description: "Human-readable note title." },
          content: { type: "string", description: "Markdown body of the note." },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional list of tag strings."
          },
          overwrite: {
            type: "boolean",
            description: "Allow overwriting an existing note with the same slug."
          }
        },
        required: ["title", "content"],
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        if (!existsSync5(vault))
          throw new Error(`vault directory missing: ${vault}`);
        const title = params["title"] ?? "";
        const content = params["content"] ?? "";
        const tags = params["tags"] ?? [];
        const overwrite = Boolean(params["overwrite"]);
        if (!title.trim())
          throw new Error("title must not be empty");
        if (!content.trim())
          throw new Error("content must not be empty");
        const notesDir = join6(vault, "AI Wiki", "notes");
        const slug = slugify(title);
        const target = join6(notesDir, `${slug}.md`);
        const noteExisted = existsSync5(target);
        if (noteExisted && !overwrite) {
          throw new Error(`note already exists: ${vaultRel(target, vault)}`);
        }
        const metadata = {
          title,
          type: "note",
          created: new Date().toISOString().replace(/\.\d{3}Z$/, "Z")
        };
        if (tags.length > 0)
          metadata["tags"] = tags;
        writeFrontmatter(target, metadata, content.trim());
        const result = {
          path: vaultRel(target, vault),
          absolute_path: target,
          slug,
          overwritten: noteExisted && overwrite
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    });
    api.registerTool({
      name: "event_log_append",
      description: "Append a single-line event to the daily Markdown event log.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string", description: "Single-line event message." },
          agent: { type: "string", description: "Agent name (default 'agent')." },
          date: { type: "string", description: "Optional event date in YYYY.MM.DD format." },
          time: { type: "string", description: "Optional event time in 24-hour HH:MM format." }
        },
        required: ["message"],
        additionalProperties: false
      },
      async execute(_id, params) {
        const vault = resolveVaultPath(api);
        const message = params["message"];
        if (!message || !message.trim()) {
          throw new Error("missing required argument: message");
        }
        const argAgent = params["agent"] ?? null;
        const date = params["date"] ?? null;
        const time = params["time"] ?? null;
        if (time)
          validateEventTime(time);
        const agent = resolveOpenclawAgent(api, argAgent);
        const tz = resolveOpenclawTimezone(api) ?? resolveTimezone();
        const path = await appendEvent(vault, agent, message, { date, time, tz });
        const result = {
          path: vaultRel(path, vault),
          absolute_path: path,
          agent,
          date,
          time
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
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
          checks: results.map((r) => ({ name: r.name, ok: r.ok, message: r.message }))
        };
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      }
    });
  }
});
export {
  openclaw_default as default
};
