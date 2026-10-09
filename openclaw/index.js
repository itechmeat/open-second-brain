import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
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
  if (mod && typeof mod === "object" || typeof mod === "function") {
    for (let key of __getOwnPropNames(mod))
      if (!__hasOwnProp.call(to, key))
        __defProp(to, key, {
          get: __accessProp.bind(mod, key),
          enumerable: true
        });
  }
  if (canCache)
    cache.set(mod, to);
  return to;
};
var __toCommonJS = (from) => {
  var entry = (__moduleCache ??= new WeakMap).get(from), desc;
  if (entry)
    return entry;
  entry = __defProp({}, "__esModule", { value: true });
  if (from && typeof from === "object" || typeof from === "function") {
    for (var key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(entry, key))
        __defProp(entry, key, {
          get: __accessProp.bind(from, key),
          enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
  }
  __moduleCache.set(from, entry);
  return entry;
};
var __moduleCache;
var __commonJS = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res) => () => (fn && (res = fn(fn = 0)), res);
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// node_modules/graceful-fs/polyfills.js
var require_polyfills = __commonJS(function(exports, module) {
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
var require_legacy_streams = __commonJS(function(exports, module) {
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
var require_clone = __commonJS(function(exports, module) {
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
var require_graceful_fs = __commonJS(function(exports, module) {
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
      function closeSync(fd) {
        fs$closeSync.apply(fs, arguments);
        resetQueue();
      }
      Object.defineProperty(closeSync, previousSymbol, {
        value: fs$closeSync
      });
      return closeSync;
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
var require_retry_operation = __commonJS(function(exports, module) {
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
var require_retry = __commonJS(function(exports) {
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
var require_signals = __commonJS(function(exports, module) {
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
var require_signal_exit = __commonJS(function(exports, module) {
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
var require_mtime_precision = __commonJS(function(exports, module) {
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
var require_lockfile = __commonJS(function(exports, module) {
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
var require_adapter = __commonJS(function(exports, module) {
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
var require_proper_lockfile = __commonJS(function(exports, module) {
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

// src/core/fs-atomic.ts
import { isUtf8 } from "node:buffer";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function renameWithRetry(from, to, seams = {}) {
  const rename = seams.rename ?? ((a, b) => renameSync(a, b));
  withWindowsSharingRetry(() => rename(from, to), seams);
}
function withWindowsSharingRetry(op, seams) {
  if ((seams.platform ?? process.platform) !== "win32") {
    op();
    return;
  }
  const sleep = seams.sleep ?? sleepSync;
  const now = seams.now ?? Date.now;
  const deadline = now() + WINDOWS_RENAME_RETRY_BUDGET_MS;
  let delay = 10;
  for (;; ) {
    try {
      op();
      return;
    } catch (err) {
      const code = err?.code;
      if (code === undefined || !WINDOWS_TRANSIENT_RENAME_CODES.has(code))
        throw err;
      if (now() + delay > deadline)
        throw err;
      sleep(delay);
      delay = Math.min(delay * 2, 250);
    }
  }
}
function atomicWriteFileSync(target, contents, opts = {}) {
  const expected = opts.expectBefore;
  if (expected !== undefined)
    assertExpectedBefore(target, expected);
  if (opts.skipIfUnchanged && isUnchanged(target, contents))
    return false;
  withTempFile(target, contents, (tmpPath) => {
    if (expected !== undefined)
      assertExpectedBefore(target, expected);
    renameWithRetry(tmpPath, target);
  });
  return true;
}
function isUnchanged(target, contents) {
  if (!existsSync(target))
    return false;
  try {
    return readFileSync(target, "utf8") === contents;
  } catch {
    return false;
  }
}
function fileMatchesExpected(target, expected) {
  let current;
  try {
    current = readFileSync(target);
  } catch (err) {
    if (err?.code !== "ENOENT")
      throw err;
    return expected === null;
  }
  if (expected === null)
    return false;
  if (current.equals(Buffer.from(expected, "utf8")))
    return true;
  return !isUtf8(current) && current.toString("utf8") === expected;
}
function assertExpectedBefore(target, expected) {
  if (!fileMatchesExpected(target, expected))
    throw new FileDriftError(target);
}
function withTempFile(target, contents, commit, mode = 420) {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmpName = `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const tmpPath = join(dir, tmpName);
  let fd = null;
  let committed = false;
  try {
    fd = openSync(tmpPath, "wx", mode);
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
var WINDOWS_TRANSIENT_RENAME_CODES, WINDOWS_RENAME_RETRY_BUDGET_MS = 2000, FILE_DRIFT_CODE = "FILE_DRIFT", FileDriftError;
var init_fs_atomic = __esm(() => {
  WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
  FileDriftError = class FileDriftError extends Error {
    code = FILE_DRIFT_CODE;
    path;
    constructor(path) {
      super(`file changed since it was read: ${path}; the write was refused ` + "and the file left as it is. Re-read it and retry.");
      this.name = "FileDriftError";
      this.path = path;
    }
  };
});

// src/core/secret-ref.ts
function parseSecretReference(value) {
  if (typeof value !== "string")
    return null;
  const match = SECRET_REFERENCE_RE.exec(value.trim());
  if (!match)
    return null;
  return Object.freeze({ raw: value.trim(), name: match[1] });
}
function isSecretReferenceValue(value) {
  return typeof value === "string" && value.trimStart().startsWith(REFERENCE_PREFIX);
}
function resolveSecretReference(value, provider = process.env) {
  const ref = parseSecretReference(value);
  if (!ref) {
    throw new SecretReferenceError(`invalid secret reference: ${value}`, value);
  }
  const resolved = provider[ref.name];
  if (!resolved) {
    throw new SecretReferenceError(`missing secret provider value: ${ref.name}`, ref.name);
  }
  return resolved;
}
function sortedDistinctLiterals(values) {
  return [...new Set(values)].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
}
var SecretReferenceError, SECRET_REFERENCE_RE, REFERENCE_PREFIX = "$secret:";
var init_secret_ref = __esm(() => {
  SecretReferenceError = class SecretReferenceError extends Error {
    nameValue;
    constructor(message, nameValue) {
      super(message);
      this.name = "SecretReferenceError";
      this.nameValue = nameValue;
    }
  };
  SECRET_REFERENCE_RE = /^\$secret:([A-Za-z_][A-Za-z0-9_]*)$/;
});

// src/core/platform-dirs.ts
import { homedir } from "node:os";
import { join as join2, win32 } from "node:path";
function processDirsEnv() {
  return { platform: process.platform, home: homedir(), env: process.env };
}
function isWindows(source = process) {
  return source.platform === "win32";
}
function nonEmpty(value) {
  return value !== undefined && value.length > 0 ? value : null;
}
function windowsLocalAppData(source) {
  return nonEmpty(source.env["LOCALAPPDATA"]) ?? win32.join(source.home, "AppData", "Local");
}
function baseDir(kind, source) {
  const xdg = nonEmpty(source.env[XDG_VARIABLE[kind]]);
  if (xdg)
    return xdg;
  if (isWindows(source))
    return windowsLocalAppData(source);
  return join2(source.home, ...POSIX_DEFAULT[kind]);
}
function configBaseDir(source = processDirsEnv()) {
  return baseDir("config", source);
}
var APP_DIR_NAME = "open-second-brain", XDG_VARIABLE, POSIX_DEFAULT;
var init_platform_dirs = __esm(() => {
  XDG_VARIABLE = Object.freeze({
    config: "XDG_CONFIG_HOME",
    data: "XDG_DATA_HOME",
    state: "XDG_STATE_HOME",
    cache: "XDG_CACHE_HOME"
  });
  POSIX_DEFAULT = Object.freeze({
    config: [".config"],
    data: [".local", "share"],
    state: [".local", "state"],
    cache: [".cache"]
  });
});

// src/core/brain/portability/profiles.ts
var import_proper_lockfile;
var init_profiles = __esm(() => {
  init_fs_atomic();
  import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
});

// src/core/fs-utils.ts
import { statSync } from "node:fs";
function statOrAbsent(p) {
  return statSync(p, { throwIfNoEntry: false });
}
function isDir(p) {
  try {
    return statOrAbsent(p)?.isDirectory() ?? false;
  } catch {
    return false;
  }
}
function stem(filename) {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}
var init_fs_utils = () => {};

// src/core/brain/portability/pointer.ts
var init_pointer = __esm(() => {
  init_fs_atomic();
  init_fs_utils();
});

// src/core/brain/wikilink.ts
var init_wikilink = () => {};

// src/core/brain/link-graph/format-wikilink.ts
var WIKI_LINK_FORMATS, SUFFIX_INDEX_MEMO;
var init_format_wikilink = __esm(() => {
  init_wikilink();
  WIKI_LINK_FORMATS = Object.freeze([
    "preserve",
    "full",
    "short"
  ]);
  SUFFIX_INDEX_MEMO = new WeakMap;
});

// src/core/config.ts
import { mkdirSync as mkdirSync2, readFileSync as readFileSync2, statSync as statSync2 } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname2, isAbsolute, join as join3, resolve as resolve2 } from "node:path";
function installNamedSecretResolver(resolver) {
  namedSecretResolver = resolver;
}
function resolveThroughNamedSecretResolver(vault, reference) {
  const resolver = namedSecretResolver;
  if (resolver === undefined) {
    throw new SecretReferenceError("no named-secret resolver is installed in this process; the $secret: reference " + "cannot be resolved against the vault's custody store", reference);
  }
  return resolver.resolveNamedSecret(vault, reference);
}
function resolveDefaultConfigPath(source) {
  const override = source.env["OPEN_SECOND_BRAIN_CONFIG"];
  if (override)
    return expandTilde(override, source.platform, source.home);
  const xdg = source.env["XDG_CONFIG_HOME"];
  if (xdg)
    return join3(expandTilde(xdg, source.platform, source.home), APP_DIR_NAME, "config.yaml");
  if (UNSUPPORTED_CONFIG_PLATFORMS.includes(source.platform)) {
    throw new UnsupportedPlatformError(source.platform);
  }
  return join3(configBaseDir(source), APP_DIR_NAME, "config.yaml");
}
function defaultConfigPath() {
  return resolveDefaultConfigPath({
    platform: process.platform,
    home: homedir2(),
    env: process.env
  });
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
  const stat = statConfigPath(resolved);
  if (stat === undefined) {
    return { path: resolved, exists: false, data: {} };
  }
  if (!stat.isFile()) {
    throw new ConfigReadError(resolved, "path exists but is not a regular file");
  }
  return { path: resolved, exists: true, data: parseSimpleYaml(readConfigText(resolved)) };
}
function statConfigPath(resolved) {
  try {
    return statSync2(resolved, { throwIfNoEntry: false });
  } catch (err) {
    throw new ConfigReadError(resolved, err.message ?? String(err));
  }
}
function readConfigText(resolved) {
  let bytes;
  try {
    bytes = readFileSync2(resolved);
  } catch (err) {
    throw new ConfigReadError(resolved, err.message ?? String(err));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (err) {
    throw new ConfigReadError(resolved, `not valid UTF-8: ${err.message ?? String(err)}`);
  }
}
function setConfigValue(key, value, path) {
  if (typeof value !== "string") {
    throw new TypeError(`config value for ${JSON.stringify(key)} must be a string`);
  }
  for (const bad of CONFIG_VALUE_REJECTED_CHARS) {
    if (value.includes(bad)) {
      throw new Error(`config value for ${JSON.stringify(key)} contains a disallowed character ` + `(${JSON.stringify(bad)}); reject rather than silently corrupting on read-back`);
    }
  }
  const resolved = path ?? defaultConfigPath();
  const discovery = discoverConfig(resolved);
  const data = { ...discovery.data, [key]: value };
  const body = Object.entries(data).map(([k, v]) => `${k}: "${v}"`).join(`
`) + `
`;
  atomicWriteFileSync(resolved, body);
  return resolved;
}
function resolveAgentName(configPath) {
  const env = process.env["VAULT_AGENT_NAME"];
  if (env)
    return env;
  const data = discoverConfig(configPath).data;
  const value = data["agent_name"] ?? data["agentName"];
  if (value)
    return value;
  return UNCONFIGURED_AGENT_NAME;
}
function isValidDeviceId(value) {
  return DEVICE_ID_RE.test(value) && !value.startsWith("sync-conflict");
}
function resolveDeviceId(configPath) {
  const env = process.env["O2B_DEVICE_ID"];
  if (env !== undefined && (env === "" || isValidDeviceId(env)))
    return env;
  const resolved = configPath ?? defaultConfigPath();
  const read = () => {
    const value = discoverConfig(resolved).data["device_id"];
    return value && isValidDeviceId(value) ? value : null;
  };
  const existing = read();
  if (existing !== null)
    return existing;
  const dir = dirname2(resolved);
  mkdirSync2(dir, { recursive: true });
  let release;
  try {
    for (let attempt = 0;attempt < 10; attempt++) {
      try {
        release = import_proper_lockfile2.default.lockSync(dir, { stale: 1e4, realpath: false });
        break;
      } catch (err) {
        if (err.code !== "ELOCKED")
          break;
        sleepSync(50);
      }
    }
    const won = read();
    if (won !== null)
      return won;
    const generated = randomBytes(4).toString("hex");
    setConfigValue("device_id", generated, resolved);
    return generated;
  } finally {
    release?.();
  }
}
function resolveExposeHostPaths(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_EXPOSE_HOST_PATHS", "expose_host_paths", configPath);
}
function isValidInstallationSecret(value) {
  return INSTALLATION_SECRET_RE.test(value);
}
function resolveInstallationSecret(configPath, secretsVault) {
  const env = process.env[INSTALLATION_SECRET_ENV_KEY];
  if (env !== undefined && isValidInstallationSecret(env))
    return env;
  const resolved = configPath ?? defaultConfigPath();
  const read = () => {
    const raw = discoverConfig(resolved).data[INSTALLATION_SECRET_CONFIG_KEY];
    if (isSecretReferenceValue(raw)) {
      const reference = String(raw).trim();
      if (secretsVault === undefined) {
        throw new SecretReferenceError("installation_secret is a $secret: reference but no vault was passed to resolve " + "it against; pass the vault (or set O2B_INSTALLATION_SECRET to a 32-hex key)", reference);
      }
      const resolvedValue = resolveThroughNamedSecretResolver(secretsVault, reference);
      if (!isValidInstallationSecret(resolvedValue)) {
        throw new SecretReferenceError("installation_secret is a $secret: reference that resolves to a value which is " + "not a 32-hex installation key; fix the stored value - the reference in the " + "device config is never overwritten", reference);
      }
      return resolvedValue;
    }
    return raw && isValidInstallationSecret(raw) ? raw : null;
  };
  const existing = read();
  if (existing !== null)
    return existing;
  const dir = dirname2(resolved);
  mkdirSync2(dir, { recursive: true });
  let release;
  try {
    for (let attempt = 0;attempt < 10; attempt++) {
      try {
        release = import_proper_lockfile2.default.lockSync(dir, { stale: 1e4, realpath: false });
        break;
      } catch (err) {
        if (err.code !== "ELOCKED")
          break;
        sleepSync(50);
      }
    }
    const won = read();
    if (won !== null)
      return won;
    const generated = randomBytes(16).toString("hex");
    setConfigValue(INSTALLATION_SECRET_CONFIG_KEY, generated, resolved);
    return generated;
  } finally {
    release?.();
  }
}
function vaultStoreReference(vaultPath, configPath) {
  const key = resolveInstallationSecret(configPath, vaultPath);
  const digest = createHmac("sha256", key).update(resolve2(vaultPath)).digest("hex").slice(0, VAULT_STORE_REF_HEX_LEN);
  return `${VAULT_STORE_REF_PREFIX}${digest}`;
}
function readSetting(envKey, configKey, data) {
  const env = process.env[envKey]?.trim();
  if (env)
    return env;
  const raw = (typeof data === "function" ? data() : data)[configKey]?.trim();
  return raw ? raw : undefined;
}
function resolveConfigFlag(envKey, configKey, configPath) {
  return isFlagOn(readSetting(envKey, configKey, () => discoverConfig(configPath).data));
}
function isFlagOn(raw) {
  return raw === "true" || raw === "1";
}
function resolvePartnerCodegraphDisabled(configPath) {
  return resolveConfigFlag(PARTNER_CODEGRAPH_DISABLED_ENV, PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY, configPath);
}
function expandTilde(p, platform = process.platform, home = homedir2()) {
  if (p === "~")
    return home;
  if (p.startsWith("~/"))
    return join3(home, p.slice(2));
  if (platform === "win32" && p.startsWith("~\\"))
    return join3(home, p.slice(2));
  return p;
}
var import_proper_lockfile2, namedSecretResolver, CONFIG_VALUE_REJECTED_CHARS, UNSUPPORTED_CONFIG_PLATFORMS, UnsupportedPlatformError, ConfigReadError, UNCONFIGURED_AGENT_NAME = "agent", DEVICE_ID_RE, INSTALLATION_SECRET_CONFIG_KEY = "installation_secret", INSTALLATION_SECRET_ENV_KEY = "O2B_INSTALLATION_SECRET", INSTALLATION_SECRET_RE, VAULT_STORE_REF_PREFIX = "vault://", VAULT_STORE_REF_HEX_LEN = 32, PARTNER_CODEGRAPH_DISABLED_ENV = "OPEN_SECOND_BRAIN_PARTNER_CODEGRAPH_DISABLED", PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY = "partner_codegraph_disabled";
var init_config = __esm(() => {
  init_fs_atomic();
  init_secret_ref();
  init_platform_dirs();
  init_profiles();
  init_pointer();
  init_format_wikilink();
  import_proper_lockfile2 = __toESM(require_proper_lockfile(), 1);
  CONFIG_VALUE_REJECTED_CHARS = ['"', "\\", `
`, "\r"];
  UNSUPPORTED_CONFIG_PLATFORMS = Object.freeze([]);
  UnsupportedPlatformError = class UnsupportedPlatformError extends Error {
    platform;
    constructor(platform) {
      super(`open-second-brain has no configuration layout for platform '${platform}': ` + "this build does not know where per-user configuration lives there. Set " + "OPEN_SECOND_BRAIN_CONFIG to an explicit config file, or XDG_CONFIG_HOME " + "to a configuration root, to choose the location yourself.");
      this.name = "UnsupportedPlatformError";
      this.platform = platform;
    }
  };
  ConfigReadError = class ConfigReadError extends Error {
    path;
    constructor(path, reason) {
      super(`failed to read plugin config ${path}: ${reason}. The file is present, so its ` + "settings are NOT in force and are not read as absent; make it readable " + `(chmod u+r "${path}") or set OPEN_SECOND_BRAIN_CONFIG to a readable config file.`);
      this.name = "ConfigReadError";
      this.path = path;
    }
  };
  DEVICE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
  INSTALLATION_SECRET_RE = /^[0-9a-f]{32}$/;
});

// src/core/redactor.ts
function isSecretKeyName(name) {
  return typeof name === "string" && SECRET_KEY_NAME_RE.test(name);
}
function isPrivateOrReservedIPv4(ip) {
  const octets = ip.split(".");
  const a = Number.parseInt(octets[0] ?? "", 10);
  const b = Number.parseInt(octets[1] ?? "", 10);
  if (a === 0 || a === 10 || a === 127)
    return true;
  if (a === 172 && b >= 16 && b <= 31)
    return true;
  if (a === 192 && b === 168)
    return true;
  if (a === 169 && b === 254)
    return true;
  if (a === 100 && b >= 64 && b <= 127)
    return true;
  if (a >= 224)
    return true;
  return false;
}
function isPrivateOrReservedIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === "::" || lower === "::1")
    return true;
  if (/^fe[89ab]/.test(lower))
    return true;
  if (/^f[cd]/.test(lower))
    return true;
  return false;
}
function isContentAddress(run) {
  return CONTENT_ADDRESS_RE.test(run);
}
function isSignalId(run) {
  return SIGNAL_ID_RE.test(run);
}
function isPreservedIdentifier(run) {
  return isContentAddress(run) || isSignalId(run);
}
function redactBareTokens(text) {
  return text.replace(VENDOR_TOKEN_RE, PLACEHOLDER).replace(BASE64_SECRET_RE, PLACEHOLDER).replace(HIGH_ENTROPY_TOKEN_RE, (run) => isPreservedIdentifier(run) ? run : PLACEHOLDER);
}
function redactUrlCredentials(text) {
  return text.replace(BASIC_AUTH_URL_RE, (_m, scheme) => `${scheme}${PLACEHOLDER}@`);
}
function redactInfraTopology(text) {
  let out = redactUrlCredentials(text);
  out = out.replace(IPV4_PORT_RE, PLACEHOLDER);
  out = out.replace(FQDN_PORT_RE, PLACEHOLDER);
  out = out.replace(INTERNAL_HOST_RE, PLACEHOLDER);
  out = out.replace(IPV6_RE, (match) => isPrivateOrReservedIPv6(match) ? match : PLACEHOLDER);
  out = out.replace(IPV4_BARE_RE, (match) => isPrivateOrReservedIPv4(match) ? match : PLACEHOLDER);
  return out;
}
function quoteYamlScalar(value) {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
function quoteRedactedFrontmatter(text) {
  if (!text.startsWith("---"))
    return text;
  return text.replace(FRONTMATTER_BLOCK_RE, (_match, open, body, close) => open + body.replace(FRONTMATTER_SCALAR_RE, (_m, prefix, value) => value.startsWith('"') ? `${prefix}${value}` : `${prefix}${quoteYamlScalar(value)}`).replace(FRONTMATTER_ITEM_RE, (_m, prefix, value) => value.startsWith('"') ? `${prefix}${value}` : `${prefix}${quoteYamlScalar(value)}`).replace(FRONTMATTER_FLOW_ITEM_RE, (_m, prefix, value) => `${prefix}${quoteYamlScalar(value)}`) + close);
}
function privateRegionSpans(text) {
  const spans = [];
  const open = new RegExp(PRIVATE_OPEN_TAG_RE.source, "gi");
  const close = new RegExp(PRIVATE_CLOSE_TAG_RE.source, "gi");
  const nextAt = (re, from) => {
    re.lastIndex = from;
    return re.exec(text);
  };
  let cursor = 0;
  while (cursor < text.length) {
    const first = nextAt(open, cursor);
    if (!first)
      break;
    let depth = 1;
    let scan = first.index + first[0].length;
    let nextOpen = nextAt(open, scan);
    let nextClose = nextAt(close, scan);
    while (depth > 0) {
      if (!nextClose) {
        spans.push({ start: first.index, end: text.length });
        return spans;
      }
      if (nextOpen && nextOpen.index < nextClose.index) {
        depth += 1;
        scan = nextOpen.index + nextOpen[0].length;
      } else {
        depth -= 1;
        scan = nextClose.index + nextClose[0].length;
      }
      if (nextOpen && nextOpen.index < scan)
        nextOpen = nextAt(open, scan);
      if (nextClose.index < scan)
        nextClose = nextAt(close, scan);
    }
    spans.push({ start: first.index, end: scan });
    cursor = scan;
  }
  return spans;
}
function stripPrivateRegions(text) {
  if (!text)
    return text;
  let output = "";
  let cursor = 0;
  for (const span of privateRegionSpans(text)) {
    output += text.slice(cursor, span.start) + PRIVATE_REGION_PLACEHOLDER;
    cursor = span.end;
  }
  return output + text.slice(cursor);
}
function scanRawOutput(text, opts = {}) {
  if (!text)
    return { text, truncated: false };
  let out = text;
  for (const literal of opts.literals ?? []) {
    if (literal.length === 0)
      continue;
    out = out.split(literal).join(PLACEHOLDER);
  }
  const maxInput = opts.maxInput ?? MAX_REDACTOR_INPUT;
  const truncated = out.length > maxInput;
  if (truncated)
    out = out.slice(0, maxInput) + SCAN_TRUNCATED_MARKER;
  out = stripPrivateRegions(out);
  out = out.replace(JSON_ENTRY_RE, (_match, keyPart, value) => {
    if (value.startsWith('"'))
      return `${keyPart}"${PLACEHOLDER}"`;
    return `${keyPart}${PLACEHOLDER}`;
  });
  out = out.replace(ENV_RE, (_match, key, sep) => {
    return `${key}${sep}${PLACEHOLDER}`;
  });
  out = out.replace(BEARER_RE, (_match, prefix) => `${prefix}${PLACEHOLDER}`);
  out = out.replace(JWT_RE, PLACEHOLDER);
  out = out.replace(YAML_SECRET_BLOCK_RE, (_match, indent, key) => `${indent}${key}: "${PLACEHOLDER}"
`);
  out = out.replace(COLON_VALUE_RE, (match, key, sep, value) => {
    if (value.includes(PLACEHOLDER))
      return match;
    if (value.startsWith('"') && value.endsWith('"')) {
      return `${key}${sep}"${PLACEHOLDER}"`;
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return `${key}${sep}'${PLACEHOLDER}'`;
    }
    return `${key}${sep}"${PLACEHOLDER}"`;
  });
  if (opts.redactTokens)
    out = redactBareTokens(out);
  if (opts.redactInfra)
    out = redactInfraTopology(out);
  else if (opts.redactUrlCredentials)
    out = redactUrlCredentials(out);
  out = quoteRedactedFrontmatter(out);
  return { text: out, truncated };
}
function redactRawOutput(text, opts = {}) {
  return scanRawOutput(text, opts).text;
}
function isIdentifierKeyName(name) {
  return typeof name === "string" && IDENTIFIER_KEY_RE.test(name);
}
function isPathLikeValue(value) {
  if (value.length === 0 || value.length > 4096)
    return false;
  if (value.includes("@") || value.includes("://"))
    return false;
  if (!value.includes("/") && !value.includes("\\"))
    return false;
  return PATH_ANCHOR_RE.test(value) || !/\s/.test(value);
}
function identifierCarriesSecret(value) {
  return VENDOR_TOKEN_TEST_RE.test(value);
}
function carriesBareCredential(value) {
  if (identifierCarriesSecret(value))
    return true;
  for (const match of value.matchAll(HIGH_ENTROPY_TOKEN_RE)) {
    if (!isPreservedIdentifier(match[0]))
      return true;
  }
  return false;
}
function keyNameCarriesSecret(name) {
  return carriesBareCredential(name);
}
function foreignIdentifierCarriesSecret(value) {
  return carriesBareCredential(value);
}
function isPlainContainer(value) {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function siblingPairDeclaresSecret(item) {
  if (typeof item !== "object" || item === null)
    return false;
  if (!isPlainContainer(item))
    return false;
  const record = item;
  return "value" in record && isSecretKeyName(record["name"]);
}
function redactStructured(input, opts = {}) {
  let redacted = false;
  let truncated = false;
  const secretIdentifiers = new Set;
  const record = (location) => {
    if (secretIdentifiers.size < MAX_REPORTED_IDENTIFIERS)
      secretIdentifiers.add(location);
  };
  const walkEntries = (source, location, secretKey) => {
    const out = {};
    let index = 0;
    for (const [key, child] of Object.entries(source)) {
      if (keyNameCarriesSecret(key))
        record(`${location === "" ? "" : location}#${index}`);
      const childLocation = location === "" ? key : `${location}.${key}`;
      out[key] = walk(child, childLocation, secretKey(key), isIdentifierKeyName(key));
      index += 1;
    }
    return out;
  };
  const walk = (value, location, underSecretKey, underIdentifierKey) => {
    if (underSecretKey) {
      if (value === null || value === undefined)
        return value;
      redacted = true;
      return PLACEHOLDER;
    }
    if (typeof value === "string" && (underIdentifierKey || isPathLikeValue(value))) {
      const secretShaped = opts.foreignIdentifiers === true && underIdentifierKey ? foreignIdentifierCarriesSecret(value) : identifierCarriesSecret(value);
      if (secretShaped)
        record(location);
      const cleaned = opts.redactInfra === true || opts.redactUrlCredentials === true ? redactUrlCredentials(value) : value;
      if (cleaned !== value)
        redacted = true;
      return cleaned;
    }
    if (typeof value === "string") {
      const scan = scanRawOutput(value, opts);
      if (scan.text !== value)
        redacted = true;
      if (scan.truncated)
        truncated = true;
      return scan.text;
    }
    if (Array.isArray(value)) {
      return value.map((item, index) => {
        const itemLocation = `${location}[${index}]`;
        if (!siblingPairDeclaresSecret(item)) {
          return walk(item, itemLocation, false, underIdentifierKey);
        }
        return walkEntries(item, itemLocation, (key) => key === "value" ? true : isSecretKeyName(key));
      });
    }
    if (typeof value === "object" && value !== null) {
      if (!isPlainContainer(value))
        return value;
      return walkEntries(value, location, isSecretKeyName);
    }
    return value;
  };
  return {
    value: walk(input, "", false, false),
    redacted,
    truncated,
    secretIdentifiers: Object.freeze([...secretIdentifiers].toSorted())
  };
}
var REDACTION_PLACEHOLDER = "***REDACTED***", PLACEHOLDER, PRIVATE_REGION_PLACEHOLDER = "***PRIVATE***", MAX_REDACTOR_INPUT, SCAN_TRUNCATED_SENTINEL = "***SCAN_TRUNCATED***", SCAN_TRUNCATED_MARKER, PRIVATE_OPEN_TAG_RE, PRIVATE_CLOSE_TAG_RE, SECRET_KEYS, KEY_PATTERN, SECRET_KEY_NAME_FRAGMENTS, SECRET_KEY_NAME_RE, ENV_RE, COLON_VALUE_RE, YAML_SECRET_BLOCK_RE, JSON_ENTRY_RE, BEARER_RE, JWT_RE, IPV4_OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)", IPV4, BASIC_AUTH_URL_RE, IPV4_PORT_RE, FQDN_PORT_SOURCE_EXTS, FQDN_PORT_RE, INTERNAL_HOST_RE, IPV6_RE, IPV4_BARE_RE, VENDOR_TOKEN_RE, HIGH_ENTROPY_TOKEN_RE, CONTENT_ADDRESS_RE, SIGNAL_ID_RE, BASE64_SECRET_RE, CREDENTIAL_QUERY_KEYS, CREDENTIAL_QUERY_KEY_SET, TOKEN_USERINFO_SCHEMES, PLACEHOLDER_PATTERN, FRONTMATTER_BLOCK_RE, FRONTMATTER_SCALAR_RE, FRONTMATTER_ITEM_RE, FRONTMATTER_FLOW_ITEM_RE, IDENTIFIER_KEY_RE, PATH_ANCHOR_RE, VENDOR_TOKEN_TEST_RE, MAX_REPORTED_IDENTIFIERS = 12;
var init_redactor = __esm(() => {
  PLACEHOLDER = REDACTION_PLACEHOLDER;
  MAX_REDACTOR_INPUT = 1024 * 1024;
  SCAN_TRUNCATED_MARKER = `

${SCAN_TRUNCATED_SENTINEL} [redactor scan window exceeded (> 1 MiB); the unscanned tail was dropped. ` + `This payload was only partially scanned — treat it as unverified and inspect the raw source before sharing.]
`;
  PRIVATE_OPEN_TAG_RE = /<private\b[^<>]*(?:>|(?=<)|$)/gi;
  PRIVATE_CLOSE_TAG_RE = /<\/private>/gi;
  SECRET_KEYS = [
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
  KEY_PATTERN = SECRET_KEYS.map((k) => k.replace(/[-_]/g, "[-_]?")).join("|");
  SECRET_KEY_NAME_FRAGMENTS = ["key"];
  SECRET_KEY_NAME_RE = new RegExp(`(?:${KEY_PATTERN}|${SECRET_KEY_NAME_FRAGMENTS.join("|")})`, "i");
  ENV_RE = new RegExp(`(?<![A-Za-z0-9])(${KEY_PATTERN})(\\s*=\\s*)([^\\s\\r\\n]+)`, "gi");
  COLON_VALUE_RE = new RegExp(`(?<!")\\b(${KEY_PATTERN})([ \\t]*:[ \\t]*)("[^"]*"|'[^']*'|[^\\r\\n]+)`, "gi");
  YAML_SECRET_BLOCK_RE = new RegExp(`^([ \\t]*)(${KEY_PATTERN})[ \\t]*:[ \\t]*(?:[|>][+-]?\\d{0,2})?[ \\t]*\\r?\\n` + "(?:\\1[ \\t]+[^\\r\\n]*\\r?\\n?)+", "gim");
  JSON_ENTRY_RE = new RegExp(`("(?:${KEY_PATTERN})"\\s*:\\s*)("(?:[^"\\\\]|\\\\.)*"|true|false|null|-?\\d+(?:\\.\\d+)?)`, "gi");
  BEARER_RE = /\b(Bearer\s+)([A-Za-z0-9._\-+/=]+)/gi;
  JWT_RE = /\b(?:eyJ|eyA|ewo|ew0|ewk)[A-Za-z0-9_-]{9,65533}(?:\.[A-Za-z0-9_-]{4,65536}){2}(?![A-Za-z0-9_-])/g;
  IPV4 = `${IPV4_OCTET}(?:\\.${IPV4_OCTET}){3}`;
  BASIC_AUTH_URL_RE = /\b([a-zA-Z][a-zA-Z0-9+.-]{0,31}:\/\/)([^\s/:@]{0,256}):(?!\d{1,5}\/)([^\s@]{1,4096})@/g;
  IPV4_PORT_RE = new RegExp(`\\b${IPV4}:\\d{1,5}\\b`, "g");
  FQDN_PORT_SOURCE_EXTS = "js|ts|tsx|jsx|py|json|rs|go|java|rb|php|c|cc|cpp|cxx|h|hpp|css|scss|sass|less|" + "html|htm|xml|yaml|yml|toml|ini|cfg|md|markdown|sh|bash|sql|vue|svelte|gradle|" + "kt|swift|scala|clj|ex|exs|erl|elm|dart|lua|pl|pm|r|jl|tf|lock|map|txt|csv|log";
  FQDN_PORT_RE = new RegExp("\\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+(?!(" + FQDN_PORT_SOURCE_EXTS + "):\\d)[a-zA-Z]{2,63}:\\d{1,5}\\b", "g");
  INTERNAL_HOST_RE = /\b(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+(?:internal|intranet|localdomain|local|lan|corp|home)\b/gi;
  IPV6_RE = new RegExp("(?<![\\w:.])(?:" + "(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}" + "|" + "(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{0,4}" + "|" + "::(?:[0-9A-Fa-f]{1,4}:){0,6}[0-9A-Fa-f]{1,4}" + ")(?![\\w:.])", "g");
  IPV4_BARE_RE = new RegExp(`(?<![\\w.])${IPV4}(?![\\w.])`, "g");
  VENDOR_TOKEN_RE = new RegExp([
    "\\b(?:sk|rk|pk)[-_][A-Za-z0-9._-]{3,200}",
    "\\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{6,255}",
    "\\bgithub_pat_[A-Za-z0-9_]{6,255}",
    "\\bxox[baprs]-[A-Za-z0-9-]{6,200}",
    "\\bAKIA[0-9A-Z]{16}\\b",
    "\\bAIza[0-9A-Za-z._-]{10,100}",
    "\\bglpat-[A-Za-z0-9_-]{6,100}"
  ].join("|"), "g");
  HIGH_ENTROPY_TOKEN_RE = /\b(?=[A-Za-z0-9_-]{24,200}\b)(?=[A-Za-z0-9_-]{0,199}[A-Za-z])(?=[A-Za-z0-9_-]{0,199}\d)[A-Za-z0-9_-]{24,200}\b/g;
  CONTENT_ADDRESS_RE = /^[0-9a-fA-F]+(?:-[0-9a-fA-F]+)*$/;
  SIGNAL_ID_RE = /^sig-\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/;
  BASE64_SECRET_RE = new RegExp("(?<![A-Za-z0-9+/=])" + "(?=[A-Za-z0-9+/=]{32,64}(?![A-Za-z0-9+/=]))" + "(?=[A-Za-z0-9+/=]{0,63}[a-z])" + "(?=[A-Za-z0-9+/=]{0,63}[A-Z])" + "(?=[A-Za-z0-9+/=]{0,63}\\d)" + "(?=[A-Za-z0-9+/=]{0,63}[+/=])" + "[A-Za-z0-9+=][A-Za-z0-9+/=]{30,62}[A-Za-z0-9+=]", "g");
  CREDENTIAL_QUERY_KEYS = Object.freeze([
    "sshkey",
    "token",
    "access_token",
    "password",
    "secret",
    "signature",
    "sig",
    "key",
    "aws_access_key_id",
    "aws_access_key_secret",
    "aws_secret_access_key",
    "aws_access_token",
    "x-amz-signature",
    "x-amz-credential",
    "x-amz-security-token",
    "x-goog-signature",
    "x-goog-credential"
  ]);
  CREDENTIAL_QUERY_KEY_SET = new Set(CREDENTIAL_QUERY_KEYS);
  TOKEN_USERINFO_SCHEMES = new Set([
    "http:",
    "https:",
    "git+http:",
    "git+https:"
  ]);
  PLACEHOLDER_PATTERN = PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  FRONTMATTER_BLOCK_RE = /^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/;
  FRONTMATTER_SCALAR_RE = new RegExp(`^([ \\t]*[^\\s#][^:\\r\\n]*:[ \\t]*)(${PLACEHOLDER_PATTERN}[^\\r\\n]*)$`, "gm");
  FRONTMATTER_ITEM_RE = new RegExp(`^([ \\t]*-[ \\t]+)(${PLACEHOLDER_PATTERN}[^\\r\\n]*)$`, "gm");
  FRONTMATTER_FLOW_ITEM_RE = new RegExp(`([[{,][ \\t]*)(${PLACEHOLDER_PATTERN})(?=[ \\t]*[,\\]}])`, "g");
  IDENTIFIER_KEY_RE = /(^|[_-])(id|ids|uuid|uuids|guid|path|paths|slug|slugs|filename|filenames|basename)$/i;
  PATH_ANCHOR_RE = /^(?:[/\\]|~[/\\]|\.{1,2}[/\\]|[A-Za-z]:[/\\])/;
  VENDOR_TOKEN_TEST_RE = new RegExp(VENDOR_TOKEN_RE.source);
});

// src/core/brain/path-constants.ts
import { posix } from "node:path";
var BRAIN_ROOT_REL = "Brain", BRAIN_INBOX_REL, BRAIN_PROCESSED_REL, BRAIN_ARCHIVED_SIGNALS_REL, BRAIN_PENDING_REL, BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL, BRAIN_SKILL_PROPOSALS_REL, BRAIN_SKILL_PROPOSALS_PENDING_REL, BRAIN_SKILL_PROPOSALS_ACCEPTED_REL, BRAIN_SKILL_PROPOSALS_REJECTED_REL, BRAIN_SKILL_ACCEPT_JOURNAL_REL, BRAIN_PROCEDURES_REL, BRAIN_PROCEDURAL_MEMORY_REL, BRAIN_ATTENTION_REL, BRAIN_OBLIGATIONS_REL, BRAIN_THESES_REL, BRAIN_DECISIONS_REL, BRAIN_GAP_TASKS_REL, BRAIN_TENSIONS_REL, BRAIN_LOG_DIR = "log", BRAIN_LOG_REL, BRAIN_CAPTURES_REL, BRAIN_CAPTURES_PROCESSED_REL, BRAIN_ENTITIES_REL, BRAIN_STATE_REL, BRAIN_INTERNAL_STATE_DIR = ".state", BRAIN_INTERNAL_STATE_REL, BRAIN_BASES_REL, BRAIN_SOURCES_REL, BRAIN_REPORTS_REL, BRAIN_DISTILLATIONS_REL, BRAIN_SNAPSHOTS_DIR = ".snapshots", BRAIN_SNAPSHOTS_REL, BRAIN_ARTIFACTS_DIR = ".artifacts", BRAIN_ARTIFACTS_REL, BRAIN_PAYLOADS_DIR = ".payloads", BRAIN_PAYLOADS_REL, BRAIN_WRITE_IMAGES_DIR = "write-images", BRAIN_WRITE_IMAGES_REL, BRAIN_SNAPSHOT_EXCLUDED_ENTRIES, JSONL_LEDGER_EXT = "jsonl", BRAIN_ACTIVE_FILE = "active.md", BRAIN_LESSONS_FILE = "lessons.md", BRAIN_COMPILED_DIGEST_RELS, BRAIN_INDEX_FILE = "_INDEX.md", BRAIN_INDEX_REL, BRAIN_PAGE_LANES_REL;
var init_path_constants = __esm(() => {
  BRAIN_INBOX_REL = posix.join(BRAIN_ROOT_REL, "inbox");
  BRAIN_PROCESSED_REL = posix.join(BRAIN_INBOX_REL, "processed");
  BRAIN_ARCHIVED_SIGNALS_REL = posix.join(BRAIN_INBOX_REL, "archived");
  BRAIN_PENDING_REL = posix.join(BRAIN_ROOT_REL, "pending");
  BRAIN_PREFERENCES_REL = posix.join(BRAIN_ROOT_REL, "preferences");
  BRAIN_RETIRED_REL = posix.join(BRAIN_ROOT_REL, "retired");
  BRAIN_SKILL_PROPOSALS_REL = posix.join(BRAIN_ROOT_REL, "skill-proposals");
  BRAIN_SKILL_PROPOSALS_PENDING_REL = posix.join(BRAIN_SKILL_PROPOSALS_REL, "pending");
  BRAIN_SKILL_PROPOSALS_ACCEPTED_REL = posix.join(BRAIN_SKILL_PROPOSALS_REL, "accepted");
  BRAIN_SKILL_PROPOSALS_REJECTED_REL = posix.join(BRAIN_SKILL_PROPOSALS_REL, "rejected");
  BRAIN_SKILL_ACCEPT_JOURNAL_REL = posix.join(BRAIN_SKILL_PROPOSALS_REL, "accept-journal");
  BRAIN_PROCEDURES_REL = posix.join(BRAIN_ROOT_REL, "procedures");
  BRAIN_PROCEDURAL_MEMORY_REL = posix.join(BRAIN_ROOT_REL, "procedural-memory");
  BRAIN_ATTENTION_REL = posix.join(BRAIN_ROOT_REL, "attention");
  BRAIN_OBLIGATIONS_REL = posix.join(BRAIN_ROOT_REL, "obligations");
  BRAIN_THESES_REL = posix.join(BRAIN_ROOT_REL, "theses");
  BRAIN_DECISIONS_REL = posix.join(BRAIN_ROOT_REL, "decisions");
  BRAIN_GAP_TASKS_REL = posix.join(BRAIN_ROOT_REL, "gap-tasks");
  BRAIN_TENSIONS_REL = posix.join(BRAIN_ROOT_REL, "tensions");
  BRAIN_LOG_REL = posix.join(BRAIN_ROOT_REL, BRAIN_LOG_DIR);
  BRAIN_CAPTURES_REL = posix.join(BRAIN_ROOT_REL, "captures");
  BRAIN_CAPTURES_PROCESSED_REL = posix.join(BRAIN_CAPTURES_REL, "processed");
  BRAIN_ENTITIES_REL = posix.join(BRAIN_ROOT_REL, "entities");
  BRAIN_STATE_REL = posix.join(BRAIN_ROOT_REL, "state");
  BRAIN_INTERNAL_STATE_REL = posix.join(BRAIN_ROOT_REL, BRAIN_INTERNAL_STATE_DIR);
  BRAIN_BASES_REL = posix.join(BRAIN_ROOT_REL, "bases");
  BRAIN_SOURCES_REL = posix.join(BRAIN_ROOT_REL, "sources");
  BRAIN_REPORTS_REL = posix.join(BRAIN_ROOT_REL, "reports");
  BRAIN_DISTILLATIONS_REL = posix.join(BRAIN_ROOT_REL, "distillations");
  BRAIN_SNAPSHOTS_REL = posix.join(BRAIN_ROOT_REL, BRAIN_SNAPSHOTS_DIR);
  BRAIN_ARTIFACTS_REL = posix.join(BRAIN_ROOT_REL, BRAIN_ARTIFACTS_DIR);
  BRAIN_PAYLOADS_REL = posix.join(BRAIN_ROOT_REL, BRAIN_PAYLOADS_DIR);
  BRAIN_WRITE_IMAGES_REL = posix.join(BRAIN_INTERNAL_STATE_REL, BRAIN_WRITE_IMAGES_DIR);
  BRAIN_SNAPSHOT_EXCLUDED_ENTRIES = Object.freeze([
    BRAIN_SNAPSHOTS_DIR,
    BRAIN_ARTIFACTS_DIR
  ]);
  BRAIN_COMPILED_DIGEST_RELS = Object.freeze([
    posix.join(BRAIN_ROOT_REL, BRAIN_ACTIVE_FILE),
    posix.join(BRAIN_ROOT_REL, BRAIN_LESSONS_FILE)
  ]);
  BRAIN_INDEX_REL = posix.join(BRAIN_ROOT_REL, BRAIN_INDEX_FILE);
  BRAIN_PAGE_LANES_REL = Object.freeze([
    BRAIN_SOURCES_REL,
    BRAIN_REPORTS_REL,
    BRAIN_DISTILLATIONS_REL
  ]);
});

// src/core/brain/ledger-shards.ts
function shardedFileName(base, shardId, ext) {
  if (shardId !== "" && !LEDGER_SHARD_ID_RE.test(shardId)) {
    throw new Error(`invalid ledger shard id ${JSON.stringify(shardId)} - ` + "expected a lowercase slug matching the device_id config shape");
  }
  return shardId === "" ? `${base}.${ext}` : `${base}.${shardId}.${ext}`;
}
function resolveAppendShardId() {
  try {
    return resolveDeviceId();
  } catch {
    return "";
  }
}
var LEDGER_SHARD_ID_RE, SYNC_CONFLICT_SHARD_PREFIX = "sync-conflict", SYNC_CONFLICT_MARKER, NAME_RE_CACHE;
var init_ledger_shards = __esm(() => {
  init_config();
  init_path_constants();
  LEDGER_SHARD_ID_RE = /^[a-z0-9-]{1,32}$/;
  SYNC_CONFLICT_MARKER = `.${SYNC_CONFLICT_SHARD_PREFIX}-`;
  NAME_RE_CACHE = new Map;
});

// src/core/reliability/audit.ts
import { closeSync as closeSync2, fsyncSync as fsyncSync2, mkdirSync as mkdirSync3, openSync as openSync2, writeFileSync } from "node:fs";
import { join as join4 } from "node:path";
function appendAuditRecord(auditRoot, record) {
  const timestamp = new Date(record.timestamp);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`invalid audit timestamp: ${record.timestamp}`);
  }
  mkdirSync3(auditRoot, { recursive: true });
  const path = join4(auditRoot, shardedFileName(isoWeekLabel(timestamp), resolveAppendShardId(), JSONL_LEDGER_EXT));
  const line = redactRawOutput(JSON.stringify(record), {
    maxInput: Number.POSITIVE_INFINITY
  });
  const fileDescriptor = openSync2(path, "a", 384);
  try {
    writeFileSync(fileDescriptor, line + `
`, "utf8");
    fsyncSync2(fileDescriptor);
  } finally {
    closeSync2(fileDescriptor);
  }
  return path;
}
function isoWeekLabel(input) {
  const date = new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  const dayNumber = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNumber);
  const year = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(year, 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}
var AUDIT_WEEK_SHARD_GRAMMAR;
var init_audit = __esm(() => {
  init_redactor();
  init_ledger_shards();
  AUDIT_WEEK_SHARD_GRAMMAR = Object.freeze({
    base: "\\d{4}-W\\d{2}",
    extensions: Object.freeze([JSONL_LEDGER_EXT])
  });
});

// src/core/brain/audit-dirs.ts
var SESSION_LIFECYCLE_AUDIT_DIR = "session-lifecycle", HYGIENE_AUDIT_DIR = "hygiene", SECRET_CUSTODY_AUDIT_DIR = "secret-custody", WATCHDOG_AUDIT_DIR = "watchdog", BRAIN_LOG_AUDIT_DIRS;
var init_audit_dirs = __esm(() => {
  BRAIN_LOG_AUDIT_DIRS = Object.freeze([
    SESSION_LIFECYCLE_AUDIT_DIR,
    HYGIENE_AUDIT_DIR,
    SECRET_CUSTODY_AUDIT_DIR,
    WATCHDOG_AUDIT_DIR
  ]);
});

// src/core/path-safety.ts
import { existsSync as existsSync2, realpathSync, statSync as statSync3 } from "node:fs";
import { basename as basename2, dirname as dirname3, join as join5, posix as posix2, relative, resolve as resolve3, sep } from "node:path";
function ensureInsideVault(target, vault) {
  const resolvedTarget = resolve3(target);
  const resolvedVault = resolve3(vault);
  if (!isLexicallyInside(resolvedTarget, resolvedVault)) {
    throw new VaultEscapeError(`path escapes vault: ${target}`);
  }
  if (existsSync2(resolvedVault) && !realpathInsideVault(resolvedTarget, resolvedVault)) {
    throw new VaultEscapeError(`path escapes vault via symlink: ${target}`);
  }
  return resolvedTarget;
}
function realpathInsideVault(target, vault) {
  const resolvedVault = resolve3(vault);
  if (!existsSync2(resolvedVault))
    return true;
  const realVault = safeRealpath(resolvedVault);
  const realAncestor = safeRealpath(deepestExistingAncestor(resolve3(target)));
  return isLexicallyInside(realAncestor, realVault);
}
function isLexicallyInside(target, root) {
  const t = process.platform === "win32" ? target.toLowerCase() : target;
  const r = process.platform === "win32" ? root.toLowerCase() : root;
  return t === r || t.startsWith(r + sep);
}
function deepestExistingAncestor(target) {
  let cur = target;
  while (!existsSync2(cur)) {
    const parent = dirname3(cur);
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
  return rel.split(/[\\/]/).filter((p) => p.length > 0).join(posix2.sep);
}
var VAULT_ESCAPE_CODE = "ESCAPE", VaultEscapeError;
var init_path_safety = __esm(() => {
  VaultEscapeError = class VaultEscapeError extends Error {
    code = VAULT_ESCAPE_CODE;
    constructor(message) {
      super(message);
      this.name = "VaultEscapeError";
    }
  };
});

// src/core/integrity/degradation.ts
function requireNonBlank(field, value) {
  if (value.trim().length === 0) {
    throw new DegradationNoticeError(field, "must be a non-blank string");
  }
  return value;
}
function degradationNotice(input) {
  const site = requireNonBlank("site", input.site);
  const detail = requireNonBlank("detail", input.detail);
  const path = input.path === undefined ? undefined : requireNonBlank("path", input.path);
  return Object.freeze({
    code: input.code,
    site,
    ...path !== undefined ? { path } : {},
    detail
  });
}
function emitDegradationNotice(sink, input) {
  const notice = degradationNotice(input);
  sink.push(notice);
  return notice;
}
function formatDegradationNotice(notice) {
  const site = collapse(notice.site);
  const detail = collapse(notice.detail);
  const where = notice.path === undefined ? "" : `${PATH_OPEN}${collapse(notice.path)}${PATH_CLOSE}`;
  return `${notice.code} at ${site}${where}: ${detail}`;
}
function collapse(value) {
  return value.replace(WHITESPACE_RUN_RE, " ").trim();
}
var DEGRADATION_CODE, DegradationNoticeError, WHITESPACE_RUN_RE, PATH_OPEN = " (", PATH_CLOSE = ")";
var init_degradation = __esm(() => {
  DEGRADATION_CODE = Object.freeze({
    frontmatterLineDropped: "frontmatter-line-dropped",
    frontmatterUnreadable: "frontmatter-unreadable",
    vaultWalkEntrySkipped: "vault-walk-entry-skipped",
    sessionLinkAbstained: "session-link-abstained",
    lineageObservationDropped: "lineage-observation-dropped",
    lineageChainBroken: "lineage-chain-broken",
    vaultMarkerAbsent: "vault-marker-absent",
    vaultMarkerMismatch: "vault-marker-mismatch",
    vaultFrozen: "vault-frozen",
    logChainBroken: "log-chain-broken"
  });
  DegradationNoticeError = class DegradationNoticeError extends Error {
    field;
    constructor(field, message) {
      super(`degradation notice: ${field}: ${message}`);
      this.name = "DegradationNoticeError";
      this.field = field;
    }
  };
  WHITESPACE_RUN_RE = /\s+/g;
});

// src/core/integrity/stamp.ts
function tokenOf(tokens, field) {
  const value = tokens[field];
  return value === undefined ? null : value;
}
function compareStamps(expected, actual) {
  const fields = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].toSorted();
  const mismatches = [];
  for (const field of fields) {
    const before = tokenOf(expected, field);
    const now = tokenOf(actual, field);
    if (before === now)
      continue;
    mismatches.push(Object.freeze({ field, expected: before, actual: now }));
  }
  return Object.freeze(mismatches);
}
function formatStampMismatch(mismatch) {
  const field = collapse2(mismatch.field);
  return `${field}: expected ${renderToken(mismatch.expected)}, actual ${renderToken(mismatch.actual)}`;
}
function renderToken(value) {
  return value === null ? UNRECORDED_MARKER : JSON.stringify(collapse2(value));
}
function collapse2(value) {
  return value.replace(WHITESPACE_RUN_RE2, " ").trim();
}
var GATE_MODE, GATE_MODES, STAMP_VERDICT, UNRECORDED_MARKER = "<unrecorded>", WHITESPACE_RUN_RE2;
var init_stamp = __esm(() => {
  GATE_MODE = Object.freeze({
    off: "off",
    warn: "warn",
    fail: "fail"
  });
  GATE_MODES = Object.freeze([
    GATE_MODE.off,
    GATE_MODE.warn,
    GATE_MODE.fail
  ]);
  STAMP_VERDICT = Object.freeze({
    pass: "pass",
    warn: "warn",
    fail: "fail"
  });
  WHITESPACE_RUN_RE2 = /\s+/g;
});

// src/core/brain/freeze-marker.ts
import { existsSync as existsSync3, readFileSync as readFileSync3, statSync as statSync4 } from "node:fs";
import { join as join6, resolve as resolve4 } from "node:path";
function frozenMarkerPath(vault) {
  return ensureInsideVault(join6(vault, BRAIN_INTERNAL_STATE_REL, FROZEN_MARKER_FILE), vault);
}
function parseMarker(path) {
  reloadCount += 1;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync3(path, "utf8"));
  } catch {
    return UNREADABLE_MARKER;
  }
  if (parsed === null || typeof parsed !== "object")
    return UNREADABLE_MARKER;
  if (typeof parsed.frozen_at !== "string" || parsed.frozen_at === "")
    return UNREADABLE_MARKER;
  return Object.freeze({
    schema: typeof parsed.schema === "number" ? parsed.schema : FREEZE_MARKER_SCHEMA_VERSION,
    frozen_at: parsed.frozen_at,
    by: typeof parsed.by === "string" ? parsed.by : "",
    device_id: typeof parsed.device_id === "string" ? parsed.device_id : "",
    reason: typeof parsed.reason === "string" ? parsed.reason : ""
  });
}
function readFreezeMarker(vault) {
  const root = resolve4(vault);
  let path = MARKER_PATHS.get(root);
  if (path === undefined) {
    path = frozenMarkerPath(root);
    MARKER_PATHS.set(root, path);
  }
  let stat;
  try {
    stat = statSync4(path, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  if (stat === undefined) {
    MARKER_STAMPS.delete(root);
    return null;
  }
  const cached = MARKER_STAMPS.get(root);
  if (cached !== undefined && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.marker;
  }
  const marker = parseMarker(path);
  MARKER_STAMPS.set(root, {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    marker
  });
  return marker;
}
function vaultFrozenNotice(vault, marker) {
  const why = marker.reason === "" ? "no reason given" : marker.reason;
  return degradationNotice({
    code: DEGRADATION_CODE.vaultFrozen,
    site: SITE,
    path: resolve4(vault),
    detail: `refusing to write: this vault was frozen at ${marker.frozen_at} by ` + `${marker.by === "" ? "an unnamed agent" : marker.by} (${why}). ` + `Run \`${FREEZE_NEXT_COMMAND}\` to lift it`
  });
}
function assertVaultNotFrozen(vault) {
  const marker = readFreezeMarker(vault);
  if (marker === null)
    return;
  throw new VaultFrozenError(vaultFrozenNotice(vault, marker), marker);
}
var FREEZE_MARKER_SCHEMA_VERSION = 1, FROZEN_MARKER_FILE = "frozen.json", SITE = "brain.freeze", FREEZE_NEXT_COMMAND = "o2b brain unfreeze", FREEZE_MARKER_UNREADABLE_REASON = "marker-unreadable", WRITE_LANE, VaultFrozenError, UNREADABLE_MARKER, MARKER_STAMPS, MARKER_PATHS, reloadCount = 0;
var init_freeze_marker = __esm(() => {
  init_path_safety();
  init_degradation();
  init_path_constants();
  WRITE_LANE = Object.freeze({
    content: "content",
    audit: "audit"
  });
  VaultFrozenError = class VaultFrozenError extends Error {
    notice;
    frozen_at;
    by;
    reason;
    next_command;
    constructor(notice, marker) {
      super(formatDegradationNotice(notice));
      this.name = "VaultFrozenError";
      this.notice = notice;
      this.frozen_at = marker.frozen_at;
      this.by = marker.by;
      this.reason = marker.reason;
      this.next_command = FREEZE_NEXT_COMMAND;
    }
  };
  UNREADABLE_MARKER = Object.freeze({
    schema: FREEZE_MARKER_SCHEMA_VERSION,
    frozen_at: "",
    by: "",
    device_id: "",
    reason: FREEZE_MARKER_UNREADABLE_REASON
  });
  MARKER_STAMPS = new Map;
  MARKER_PATHS = new Map;
});

// src/core/brain/vault-identity.ts
import { existsSync as existsSync4, readFileSync as readFileSync4, statSync as statSync5 } from "node:fs";
import { join as join7, resolve as resolve5 } from "node:path";
function vaultIdentityPath(vault) {
  return ensureInsideVault(join7(vault, BRAIN_ROOT_REL, VAULT_IDENTITY_FILE), vault);
}
function readVaultIdentity(vault) {
  const path = vaultIdentityPath(vault);
  if (!existsSync4(path))
    return null;
  try {
    const parsed = JSON.parse(readFileSync4(path, "utf8"));
    if (typeof parsed.vault_id !== "string" || parsed.vault_id.length === 0)
      return null;
    return Object.freeze({
      schema_version: typeof parsed.schema_version === "number" ? parsed.schema_version : VAULT_IDENTITY_SCHEMA_VERSION,
      vault_id: parsed.vault_id,
      created_at: typeof parsed.created_at === "string" ? parsed.created_at : ""
    });
  } catch {
    return null;
  }
}
function currentVaultId(root) {
  let path = MARKER_PATHS2.get(root);
  if (path === undefined) {
    path = vaultIdentityPath(root);
    MARKER_PATHS2.set(root, path);
  }
  let stat;
  try {
    stat = statSync5(path, { throwIfNoEntry: false });
  } catch {
    stat = undefined;
  }
  if (stat === undefined) {
    MARKER_STAMPS2.delete(root);
    return null;
  }
  const cached = MARKER_STAMPS2.get(root);
  if (cached !== undefined && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.vaultId;
  }
  const identity = readVaultIdentity(root);
  if (identity === null) {
    MARKER_STAMPS2.delete(root);
    return null;
  }
  MARKER_STAMPS2.set(root, {
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    vaultId: identity.vault_id
  });
  return identity.vault_id;
}
function vaultMarkerAbsentNotice(vault) {
  const root = resolve5(vault);
  if (currentVaultId(root) !== null)
    return null;
  return degradationNotice({
    code: DEGRADATION_CODE.vaultMarkerAbsent,
    site: SITE2,
    path: root,
    detail: "resolved vault root carries no identity marker; " + "run `o2b brain init` on this root if it is the intended vault"
  });
}
function assertVaultIdentityForWrite(vault, sink, lane = WRITE_LANE.content) {
  const root = resolve5(vault);
  if (lane === WRITE_LANE.content)
    assertVaultNotFrozen(root);
  const vaultId = currentVaultId(root);
  if (vaultId === null) {
    if (sink !== undefined) {
      const absent = vaultMarkerAbsentNotice(root);
      if (absent !== null)
        emitDegradationNotice(sink, absent);
    }
    return;
  }
  const pinned = PINNED_IDENTITIES.get(root);
  if (pinned === undefined) {
    PINNED_IDENTITIES.set(root, vaultId);
    return;
  }
  if (pinned === vaultId)
    return;
  const mismatch = compareStamps({ [VAULT_ID_FIELD]: pinned }, { [VAULT_ID_FIELD]: vaultId })[0];
  const evidence = mismatch;
  throw new VaultIdentityMismatchError(degradationNotice({
    code: DEGRADATION_CODE.vaultMarkerMismatch,
    site: SITE2,
    path: root,
    detail: `refusing to write: the store at this root is not the one this process opened (${formatStampMismatch(evidence)})`
  }), evidence);
}
var VAULT_IDENTITY_SCHEMA_VERSION = 1, VAULT_IDENTITY_FILE = "vault-id.json", SITE2 = "vault-identity", VAULT_ID_FIELD = "vault_id", VaultIdentityMismatchError, PINNED_IDENTITIES, MARKER_STAMPS2, MARKER_PATHS2;
var init_vault_identity = __esm(() => {
  init_fs_atomic();
  init_path_safety();
  init_degradation();
  init_stamp();
  init_freeze_marker();
  init_path_constants();
  VaultIdentityMismatchError = class VaultIdentityMismatchError extends Error {
    notice;
    mismatch;
    constructor(notice, mismatch) {
      super(formatDegradationNotice(notice));
      this.name = "VaultIdentityMismatchError";
      this.notice = notice;
      this.mismatch = mismatch;
    }
  };
  PINNED_IDENTITIES = new Map;
  MARKER_STAMPS2 = new Map;
  MARKER_PATHS2 = new Map;
});

// src/core/brain/paths.ts
import { join as join8 } from "node:path";
function brainDirs(vault) {
  const brain = ensureInsideVault(join8(vault, BRAIN_ROOT_REL), vault);
  return {
    brain,
    inbox: ensureInsideVault(join8(vault, BRAIN_INBOX_REL), vault),
    processed: ensureInsideVault(join8(vault, BRAIN_PROCESSED_REL), vault),
    archived: ensureInsideVault(join8(vault, BRAIN_ARCHIVED_SIGNALS_REL), vault),
    pending: ensureInsideVault(join8(vault, BRAIN_PENDING_REL), vault),
    preferences: ensureInsideVault(join8(vault, BRAIN_PREFERENCES_REL), vault),
    retired: ensureInsideVault(join8(vault, BRAIN_RETIRED_REL), vault),
    log: ensureInsideVault(join8(vault, BRAIN_LOG_REL), vault),
    entities: ensureInsideVault(join8(vault, BRAIN_ENTITIES_REL), vault),
    bases: ensureInsideVault(join8(vault, BRAIN_BASES_REL), vault),
    snapshots: ensureInsideVault(join8(vault, BRAIN_SNAPSHOTS_REL), vault)
  };
}
function brainDirsForWrite(vault, notices, lane) {
  assertVaultIdentityForWrite(vault, notices, lane);
  return brainDirs(vault);
}
var init_paths = __esm(() => {
  init_fs_atomic();
  init_path_safety();
  init_ledger_shards();
  init_path_constants();
  init_vault_identity();
  init_path_safety();
  init_freeze_marker();
  init_path_constants();
});

// src/core/brain/time.ts
function isoSecond(d = new Date) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
var init_time = () => {};

// src/core/brain/secrets/value-cipher.ts
import { createCipheriv, createDecipheriv, randomBytes as randomBytes2 } from "node:crypto";
function encryptValue(key, plaintext) {
  const iv = randomBytes2(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}
function decryptValue(key, encrypted) {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}
var ALGORITHM = "aes-256-gcm", IV_BYTES = 12;
var init_value_cipher = () => {};

// src/core/brain/secrets/owner-acl.ts
import { spawnSync } from "node:child_process";
import { resolve as resolve6, win32 as win322 } from "node:path";
function system32Tool(name, env = process.env) {
  const root = env["SystemRoot"] || env["windir"] || "C:\\Windows";
  return win322.join(root, "System32", name);
}
function parseWhoamiUser(stdout) {
  const m = /^\s*"([^"]+)","(S-1-\d+(?:-\d+)+)"\s*$/m.exec(stdout);
  return m ? { name: m[1], sid: m[2] } : null;
}
function currentWindowsIdentity() {
  if (cachedIdentity !== undefined)
    return cachedIdentity;
  try {
    const proc = spawnSync(system32Tool("whoami.exe"), ["/user", "/fo", "csv", "/nh"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: TOOL_TIMEOUT_MS
    });
    cachedIdentity = proc.error === undefined && proc.status === 0 ? parseWhoamiUser(proc.stdout) : null;
  } catch {
    cachedIdentity = null;
  }
  return cachedIdentity;
}
function ownerOnlyAclArgv(path, sid, kind) {
  const rights = kind === "directory" ? "(OI)(CI)F" : "F";
  return [path, "/inheritance:r", "/grant:r", `*${sid}:${rights}`];
}
function restrictToOwner(path, kind, platform = process.platform, force = false) {
  if (platform !== "win32")
    return true;
  const key = `${kind}:${resolve6(path).toLowerCase()}`;
  if (!force && restricted.has(key))
    return true;
  let detail;
  try {
    const identity = currentWindowsIdentity();
    if (identity === null) {
      detail = "the current user's SID could not be read (whoami /user)";
    } else {
      let proc = spawnSync(system32Tool("icacls.exe"), [path, "/reset"], {
        encoding: "utf8",
        windowsHide: true,
        timeout: TOOL_TIMEOUT_MS
      });
      if (proc.error === undefined && proc.status === 0) {
        proc = spawnSync(system32Tool("icacls.exe"), [...ownerOnlyAclArgv(path, identity.sid, kind)], { encoding: "utf8", windowsHide: true, timeout: TOOL_TIMEOUT_MS });
      }
      if (proc.error === undefined && proc.status === 0) {
        restricted.add(key);
        return true;
      }
      detail = proc.error !== undefined ? proc.error.message : `icacls exited ${proc.status ?? proc.signal}: ${(proc.stderr || proc.stdout).trim()}`;
    }
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  process.stderr.write(`warning: could not restrict secrets ${kind} to the current user, ` + `it keeps its inherited ACL: ${path}: ${detail}
`);
  return false;
}
var TOOL_TIMEOUT_MS = 1e4, cachedIdentity, restricted;
var init_owner_acl = __esm(() => {
  restricted = new Set;
});

// src/core/brain/secrets/envelope.ts
import { randomBytes as randomBytes3, scryptSync, timingSafeEqual } from "node:crypto";
import { chmodSync, readFileSync as readFileSync5, unlinkSync as unlinkSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { resolve as resolve7 } from "node:path";
function kdfCostCurveRefusal(kdf) {
  if (kdf.n > SCRYPT_N_MAX) {
    return `kdf n ${String(kdf.n)} exceeds this build's ceiling ${String(SCRYPT_N_MAX)}`;
  }
  if (kdf.r > SCRYPT_R_MAX) {
    return `kdf r ${String(kdf.r)} exceeds this build's ceiling ${String(SCRYPT_R_MAX)}`;
  }
  if (kdf.p > SCRYPT_P_MAX) {
    return `kdf p ${String(kdf.p)} exceeds this build's ceiling ${String(SCRYPT_P_MAX)}`;
  }
  if (kdf.maxmem > SCRYPT_MAXMEM_MAX) {
    return `kdf maxmem ${String(kdf.maxmem)} exceeds this build's ceiling ${String(SCRYPT_MAXMEM_MAX)}`;
  }
  const needed = 128 * kdf.n * kdf.r;
  if (kdf.maxmem < needed) {
    return `kdf maxmem ${String(kdf.maxmem)} is below the ${String(needed)} bytes ` + `these n/r parameters need`;
  }
  return null;
}
function holderSlot(keyPath) {
  const resolved = resolve7(keyPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function heldKeyOrRefusal(keyPath) {
  const held = HELD_KEYS.get(holderSlot(keyPath));
  if (held === undefined)
    throw new SecretStoreLockedError(keyPath);
  return held;
}
function clearHeldKey(keyPath) {
  const slot = holderSlot(keyPath);
  const held = HELD_KEYS.get(slot);
  if (held !== undefined) {
    held.fill(0);
    HELD_KEYS.delete(slot);
  }
}
function hasEnvelopeShape(parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return false;
  const candidate = parsed;
  if (typeof candidate.version !== "number")
    return false;
  const kdf = candidate.kdf;
  if (typeof kdf !== "object" || kdf === null || typeof kdf.algo !== "string")
    return false;
  if (typeof kdf.salt !== "string" || typeof kdf.n !== "number")
    return false;
  if (typeof kdf.r !== "number" || typeof kdf.p !== "number" || typeof kdf.maxmem !== "number") {
    return false;
  }
  const wrapped = candidate.wrapped;
  return typeof wrapped === "object" && wrapped !== null && typeof wrapped.ciphertext === "string" && typeof wrapped.iv === "string" && typeof wrapped.tag === "string";
}
function isEnvelopeFile(keyPath) {
  let bytes;
  try {
    bytes = readFileSync5(keyPath);
  } catch {
    return false;
  }
  return isEnvelopeBytes(bytes);
}
function isEnvelopeBytes(bytes) {
  try {
    return hasEnvelopeShape(JSON.parse(bytes.toString("utf8")));
  } catch {
    return false;
  }
}
function readEnvelope(keyPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync5(keyPath, "utf8"));
  } catch (err) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, `not parseable as an envelope: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!hasEnvelopeShape(parsed)) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, "missing fields");
  }
  if (parsed.version !== KEYFILE_ENVELOPE_SCHEMA_VERSION) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.version, keyPath, `version ${String(parsed.version)} is not read by this build`);
  }
  if (parsed.kdf.algo !== KDF_ALGO) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.kdfAlgo, keyPath, `kdf algo ${JSON.stringify(parsed.kdf.algo)} is not implemented by this build`);
  }
  if (!Number.isInteger(parsed.kdf.n) || parsed.kdf.n <= 0 || !Number.isInteger(parsed.kdf.r) || parsed.kdf.r <= 0 || !Number.isInteger(parsed.kdf.p) || parsed.kdf.p <= 0 || !Number.isInteger(parsed.kdf.maxmem) || parsed.kdf.maxmem <= 0) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, "kdf parameters must be positive integers");
  }
  const costRefusal = kdfCostCurveRefusal(parsed.kdf);
  if (costRefusal !== null) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.kdfCost, keyPath, costRefusal);
  }
  return parsed;
}
function freshWrapKdfParams() {
  return {
    algo: KDF_ALGO,
    salt: randomBytes3(SALT_BYTES).toString("base64"),
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM
  };
}
function deriveWrapKey(passphrase, kdf) {
  return scryptSync(passphrase, Buffer.from(kdf.salt, "base64"), WRAP_KEY_BYTES, {
    N: kdf.n,
    r: kdf.r,
    p: kdf.p,
    maxmem: kdf.maxmem
  });
}
function unwrapWith(derived, envelope, keyPath) {
  let plaintext;
  try {
    plaintext = decryptValue(derived, envelope.wrapped);
  } catch {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.passphrase, keyPath, "the passphrase does not unwrap this envelope (wrong passphrase, or the envelope is corrupt)");
  }
  const dek = Buffer.from(plaintext, "base64");
  if (dek.length !== DEK_BYTES) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, `unwrapped key material is ${String(dek.length)} bytes, expected ${String(DEK_BYTES)}`);
  }
  return dek;
}
function wrapKeyfile(keyPath, passphrase, dek) {
  if (passphrase.length === 0) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.passphrase, keyPath, "a wrap passphrase must not be empty");
  }
  if (dek.length !== DEK_BYTES) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, `refusing to wrap ${String(dek.length)} bytes of key material, expected ${String(DEK_BYTES)}`);
  }
  const kdf = freshWrapKdfParams();
  const envelope = {
    version: KEYFILE_ENVELOPE_SCHEMA_VERSION,
    kdf,
    wrapped: encryptValue(deriveWrapKey(passphrase, kdf), dek.toString("base64"))
  };
  const tmp = `${keyPath}.wrap-tmp`;
  try {
    writeFileSync2(tmp, `${JSON.stringify(envelope, null, 2)}
`, {
      encoding: "utf8",
      mode: 384
    });
    renameWithRetry(tmp, keyPath);
  } catch (err) {
    try {
      unlinkSync2(tmp);
    } catch {}
    throw err;
  }
  restrictToOwner(keyPath, "file", process.platform, true);
  if (process.platform !== "win32") {
    try {
      chmodSync(keyPath, 384);
    } catch (err) {
      process.stderr.write(`warning: could not re-apply owner-only mode to the wrapped keyfile: ` + `${keyPath}: ${err instanceof Error ? err.message : String(err)}
`);
    }
  }
  return envelope;
}
function unlockKeyfile(keyPath, passphrase) {
  const envelope = readEnvelope(keyPath);
  const dek = unwrapWith(deriveWrapKey(passphrase, envelope.kdf), envelope, keyPath);
  const slot = holderSlot(keyPath);
  const held = HELD_KEYS.get(slot);
  if (held !== undefined && !timingSafeEqual(held, dek)) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, "the passphrase unwrapped a different key than the one this process already holds");
  }
  HELD_KEYS.set(slot, dek);
  return dek;
}
var KEYFILE_ENVELOPE_SCHEMA_VERSION = 1, KDF_ALGO = "scrypt", WRAP_KEY_BYTES = 32, DEK_BYTES = 32, SALT_BYTES = 16, SCRYPT_N, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_MAXMEM, SCRYPT_N_MAX, SCRYPT_R_MAX = 16, SCRYPT_P_MAX = 8, SCRYPT_MAXMEM_MAX, ENVELOPE_REFUSAL_CODES, SecretEnvelopeError, SECRET_STORE_LOCKED_CODE = "secret_store_locked", SecretStoreLockedError, SECRET_STORE_KEYFILE_MISSING_CODE = "secret_store_keyfile_missing", SecretStoreKeyfileMissingError, HELD_KEYS;
var init_envelope = __esm(() => {
  init_fs_atomic();
  init_value_cipher();
  init_owner_acl();
  SCRYPT_N = 2 ** 15;
  SCRYPT_MAXMEM = 128 * 1024 * 1024;
  SCRYPT_N_MAX = 2 ** 18;
  SCRYPT_MAXMEM_MAX = 256 * 1024 * 1024;
  ENVELOPE_REFUSAL_CODES = Object.freeze({
    version: "keyfile_envelope_version_refused",
    kdfAlgo: "keyfile_envelope_kdf_algo_refused",
    kdfCost: "keyfile_envelope_kdf_params_refused",
    passphrase: "keyfile_envelope_passphrase_refused",
    malformed: "keyfile_envelope_malformed"
  });
  SecretEnvelopeError = class SecretEnvelopeError extends Error {
    code;
    keyPath;
    constructor(code, keyPath, detail) {
      super(`keyfile envelope refused (${code}): ${detail}`);
      this.name = "SecretEnvelopeError";
      this.code = code;
      this.keyPath = keyPath;
    }
  };
  SecretStoreLockedError = class SecretStoreLockedError extends Error {
    code = SECRET_STORE_LOCKED_CODE;
    keyPath;
    constructor(keyPath) {
      super(`the secret store is locked (the keyfile is passphrase-wrapped): run ` + `"o2b brain secret unlock" to unwrap it for this process - the unlock ` + `applies to this process only and the passphrase is never persisted, ` + `so a key-bearing command must run in the same process that unlocked it`);
      this.name = "SecretStoreLockedError";
      this.keyPath = keyPath;
    }
  };
  SecretStoreKeyfileMissingError = class SecretStoreKeyfileMissingError extends Error {
    code = SECRET_STORE_KEYFILE_MISSING_CODE;
    keyPath;
    constructor(keyPath) {
      super(`the secret store's keyfile is missing while the store still holds entries: ` + `refusing to mint a fresh key over them - restore the keyfile to read the stored secrets`);
      this.name = "SecretStoreKeyfileMissingError";
      this.keyPath = keyPath;
    }
  };
  HELD_KEYS = new Map;
});

// src/core/brain/secrets/crypto.ts
import { randomBytes as randomBytes4 } from "node:crypto";
import {
  chmodSync as chmodSync2,
  closeSync as closeSync3,
  existsSync as existsSync5,
  mkdirSync as mkdirSync4,
  openSync as openSync3,
  readFileSync as readFileSync6,
  writeFileSync as writeFileSync3,
  writeSync as writeSync2
} from "node:fs";
import { dirname as dirname4, join as join9 } from "node:path";
function ensureSyncExclusionMarker(dir) {
  const marker = join9(dir, ".gitignore");
  if (existsSync5(marker))
    return;
  try {
    writeFileSync3(marker, SYNC_EXCLUSION_CONTENT, { encoding: "utf8", flag: "wx", mode: 384 });
  } catch (err) {
    if (err.code !== "EEXIST") {
      process.stderr.write(`warning: could not write the sync-exclusion marker for the secrets directory: ` + `${marker}: ${err instanceof Error ? err.message : String(err)}
`);
    }
  }
}
function loadOrCreateKey(keyPath) {
  const keyDir = dirname4(keyPath);
  if (existsSync5(keyPath)) {
    restrictToOwner(keyDir, "directory");
    restrictToOwner(keyPath, "file");
    if (process.platform !== "win32") {
      try {
        chmodSync2(keyDir, 448);
        chmodSync2(keyPath, 384);
      } catch (err) {
        process.stderr.write(`warning: could not re-apply owner-only modes to the secrets keyfile: ` + `${keyPath}: ${err instanceof Error ? err.message : String(err)}
`);
      }
    }
    ensureSyncExclusionMarker(keyDir);
    const key2 = readFileSync6(keyPath);
    if (isEnvelopeBytes(key2))
      return heldKeyOrRefusal(keyPath);
    if (key2.length !== KEY_BYTES) {
      throw new Error(`secrets keyfile is corrupt (expected ${KEY_BYTES} bytes): ${keyPath}`);
    }
    return key2;
  }
  mkdirSync4(keyDir, { recursive: true, mode: 448 });
  restrictToOwner(keyDir, "directory");
  ensureSyncExclusionMarker(keyDir);
  const key = randomBytes4(KEY_BYTES);
  let fd;
  try {
    fd = openSync3(keyPath, "wx", 384);
  } catch (exc) {
    if (exc.code === "EEXIST")
      return loadOrCreateKey(keyPath);
    throw exc;
  }
  try {
    writeSync2(fd, key);
  } finally {
    closeSync3(fd);
  }
  restrictToOwner(keyPath, "file");
  return key;
}
var KEY_BYTES = 32, SYNC_EXCLUSION_CONTENT = `*
!.gitignore
`;
var init_crypto = __esm(() => {
  init_envelope();
  init_owner_acl();
  init_value_cipher();
});

// src/core/brain/secrets/store.ts
var exports_store = {};
__export(exports_store, {
  SECRETS_SCHEMA_VERSION: () => SECRETS_SCHEMA_VERSION,
  custodyTargets: () => custodyTargets,
  isValidSecretEnvVar: () => isValidSecretEnvVar,
  isValidSecretName: () => isValidSecretName,
  keyPath: () => keyPath,
  listSecrets: () => listSecrets,
  lockSecretKeyfile: () => lockSecretKeyfile,
  normalizeAllowPatterns: () => normalizeAllowPatterns,
  readStore: () => readStore,
  removeSecret: () => removeSecret,
  resolveSecretForExec: () => resolveSecretForExec,
  resolveSecretReadOnly: () => resolveSecretReadOnly,
  secretsDir: () => secretsDir,
  setSecret: () => setSecret,
  unlockSecretKeyfile: () => unlockSecretKeyfile,
  withSecretsLock: () => withSecretsLock,
  writeStore: () => writeStore
});
import { chmodSync as chmodSync3, existsSync as existsSync6, readFileSync as readFileSync7, statSync as statSync6, writeFileSync as writeFileSync4 } from "node:fs";
import { join as join10 } from "node:path";
function secretsDir(vault) {
  return join10(vault, ".open-second-brain", "secrets");
}
function storePath(vault) {
  return join10(secretsDir(vault), "secrets.json");
}
function keyPath(vault) {
  return join10(secretsDir(vault), "keyfile");
}
function isValidSecretName(name) {
  return NAME_RE.test(name);
}
function isValidSecretEnvVar(envVar) {
  return ENV_VAR_RE.test(envVar);
}
function normalizeAllowPatterns(patterns) {
  return patterns.map((pattern) => {
    const trimmed = pattern.trim();
    if (trimmed.length === 0)
      throw new Error("allow pattern must not be empty");
    return trimmed;
  });
}
function withSecretsLock(vault, fn) {
  loadOrCreateKey(keyPath(vault));
  const maxAttempts = 20;
  let release = null;
  let lastError;
  for (let attempt = 0;attempt < maxAttempts && release === null; attempt++) {
    try {
      release = import_proper_lockfile3.default.lockSync(secretsDir(vault), { stale: 1e4, realpath: false });
    } catch (exc) {
      if (exc.code !== "ELOCKED")
        throw exc;
      lastError = exc;
      if (attempt < maxAttempts - 1)
        Bun.sleepSync(25);
    }
  }
  if (release === null) {
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(`another writer holds the secrets store lock: ${msg}`);
  }
  try {
    return fn();
  } finally {
    release();
  }
}
function setSecret(vault, input) {
  assertVaultIdentityForWrite(vault);
  const name = input.name.trim().toLowerCase();
  if (!NAME_RE.test(name)) {
    throw new Error(`secret name must be a lowercase slug ([a-z0-9_-], starting alphanumeric): ${JSON.stringify(input.name)}`);
  }
  if (input.value.trim().length === 0) {
    throw new Error("secret value must not be empty");
  }
  const envVar = input.envVar ?? name.toUpperCase().replace(/-/g, "_");
  if (!ENV_VAR_RE.test(envVar)) {
    throw new Error(`secret env var must match ${ENV_VAR_RE}: ${JSON.stringify(envVar)}`);
  }
  const allow = normalizeAllowPatterns(input.allow ?? []);
  const key = loadOrCreateKey(keyPath(vault));
  if (process.platform === "win32") {
    const results = custodyTargets(vault).map(([path, kind]) => restrictToOwner(path, kind));
    if (results.includes(false)) {
      throw new Error(`refusing to store the secret: the secrets directory could not be restricted to the ` + `current user (${secretsDir(vault)}); resolve the icacls warning above and retry`);
    }
  }
  const { next, existing } = withSecretsLock(vault, () => {
    const file = readStore(vault);
    const current = file.secrets[name];
    const updated = {
      version: SECRETS_SCHEMA_VERSION,
      secrets: {
        ...file.secrets,
        [name]: {
          ...encryptValue(key, input.value),
          env_var: envVar,
          allow,
          created_at: current?.created_at ?? isoSecond(input.now),
          last_used_at: current?.last_used_at ?? null
        }
      }
    };
    writeStore(vault, updated);
    return { next: updated, existing: current };
  });
  audit(vault, input, "secret_set", name, {
    env_var: envVar,
    allow,
    replaced: existing !== undefined
  });
  return toMetadata(name, next.secrets[name]);
}
function listSecrets(vault) {
  const file = readStore(vault);
  return Object.entries(file.secrets).map(([name, stored]) => toMetadata(name, stored)).toSorted((a, b) => a.name.localeCompare(b.name));
}
function removeSecret(vault, name, ctx) {
  assertVaultIdentityForWrite(vault);
  const normalized = name.trim().toLowerCase();
  const removed = withSecretsLock(vault, () => {
    const file = readStore(vault);
    if (file.secrets[normalized] === undefined)
      return false;
    const secrets = { ...file.secrets };
    delete secrets[normalized];
    writeStore(vault, { version: SECRETS_SCHEMA_VERSION, secrets });
    return true;
  });
  if (removed)
    audit(vault, ctx, "secret_removed", normalized, {});
  return removed;
}
function resolveSecretForExec(vault, name, ctx = { agent: "cli", now: new Date }) {
  assertVaultIdentityForWrite(vault);
  const file = readStore(vault);
  const normalized = name.trim().toLowerCase();
  const stored = file.secrets[normalized];
  if (stored === undefined) {
    throw new Error(`unknown secret "${normalized}"`);
  }
  const key = loadOrCreateKey(keyPath(vault));
  const value = decryptValue(key, stored);
  touchLastUsed(vault, normalized, ctx.now);
  audit(vault, ctx, "secret_resolved_for_exec", normalized, { env_var: stored.env_var });
  return { name: normalized, env_var: stored.env_var, allow: stored.allow, value };
}
function resolveSecretReadOnly(vault, name) {
  const file = readStore(vault);
  const normalized = name.trim().toLowerCase();
  const stored = file.secrets[normalized];
  if (stored === undefined) {
    throw new Error(`unknown secret "${normalized}"`);
  }
  const kp = keyPath(vault);
  if (!existsSync6(kp))
    throw new SecretStoreKeyfileMissingError(kp);
  const key = loadOrCreateKey(kp);
  return {
    name: normalized,
    env_var: stored.env_var,
    allow: stored.allow,
    value: decryptValue(key, stored)
  };
}
function unlockSecretKeyfile(vault, passphrase, ctx) {
  assertVaultIdentityForWrite(vault);
  const kp = keyPath(vault);
  const wrapped = isEnvelopeFile(kp);
  if (wrapped) {
    unlockKeyfile(kp, passphrase);
  } else {
    withSecretsLock(vault, () => {
      if (!isEnvelopeFile(kp))
        wrapKeyfile(kp, passphrase, loadOrCreateKey(kp));
    });
    unlockKeyfile(kp, passphrase);
  }
  audit(vault, ctx, "secret_unlocked", "keyfile", { keyfile_was_wrapped: wrapped });
}
function lockSecretKeyfile(vault, ctx) {
  assertVaultIdentityForWrite(vault);
  const kp = keyPath(vault);
  if (!isEnvelopeFile(kp)) {
    throw new Error(`secret lock: the keyfile is not passphrase-wrapped, nothing to lock: ${kp}`);
  }
  clearHeldKey(kp);
  audit(vault, ctx, "secret_locked", "keyfile", {});
}
function custodyTargets(vault) {
  const targets = [
    [secretsDir(vault), "directory"],
    [keyPath(vault), "file"]
  ];
  if (existsSync6(storePath(vault)))
    targets.push([storePath(vault), "file"]);
  return targets;
}
function toMetadata(name, stored) {
  return {
    name,
    env_var: stored.env_var,
    allow: stored.allow,
    created_at: stored.created_at,
    last_used_at: stored.last_used_at
  };
}
function readStore(vault) {
  const path = storePath(vault);
  if (!existsSync6(path))
    return { version: SECRETS_SCHEMA_VERSION, secrets: {} };
  restrictToOwner(path, "file");
  if (process.platform !== "win32") {
    try {
      if ((statSync6(path).mode & 511) !== 384)
        chmodSync3(path, 384);
    } catch (err) {
      process.stderr.write(`warning: could not re-apply owner-only mode to the secrets store: ` + `${path}: ${err instanceof Error ? err.message : String(err)}
`);
    }
  }
  const parsed = JSON.parse(readFileSync7(path, "utf8"));
  if (parsed === null || typeof parsed !== "object" || parsed.version !== SECRETS_SCHEMA_VERSION) {
    throw new Error(`secrets store is corrupt or from a newer version: ${path}`);
  }
  const secrets = parsed.secrets;
  if (secrets === null || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new Error(`secrets store is corrupt: ${path}`);
  }
  return {
    version: SECRETS_SCHEMA_VERSION,
    secrets: { ...secrets }
  };
}
function writeStore(vault, file) {
  loadOrCreateKey(keyPath(vault));
  const path = storePath(vault);
  const tmp = `${path}.tmp`;
  writeFileSync4(tmp, JSON.stringify(file, null, 2) + `
`, { mode: 384 });
  renameWithRetry(tmp, path);
}
function touchLastUsed(vault, name, now) {
  withSecretsLock(vault, () => {
    const file = readStore(vault);
    const stored = file.secrets[name];
    if (stored === undefined)
      return;
    writeStore(vault, {
      version: SECRETS_SCHEMA_VERSION,
      secrets: { ...file.secrets, [name]: { ...stored, last_used_at: isoSecond(now) } }
    });
  });
}
function audit(vault, ctx, action, name, details) {
  appendAuditRecord(join10(brainDirsForWrite(vault).log, SECRET_CUSTODY_AUDIT_DIR), {
    timestamp: ctx.now.toISOString(),
    actor: ctx.agent,
    action,
    target: name,
    ok: true,
    details
  });
}
var import_proper_lockfile3, SECRETS_SCHEMA_VERSION = 1, NAME_RE, ENV_VAR_RE;
var init_store = __esm(() => {
  init_fs_atomic();
  init_audit();
  init_audit_dirs();
  init_paths();
  init_time();
  init_vault_identity();
  init_crypto();
  init_envelope();
  init_owner_acl();
  import_proper_lockfile3 = __toESM(require_proper_lockfile(), 1);
  NAME_RE = /^[a-z0-9][a-z0-9_-]*$/;
  ENV_VAR_RE = /^[A-Z_][A-Z0-9_]*$/;
});

// src/openclaw/index.ts
init_config();
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

// src/core/egress/guard.ts
init_redactor();
init_secret_ref();

// src/core/egress/registry.ts
var EGRESS_REDACTION = Object.freeze({
  sharedRedactor: "shared_redactor",
  noVaultContent: "no_vault_content",
  unscannedNetworkPayload: "unscanned_network_payload"
});
var EGRESS_REDACTION_STATUSES = Object.freeze([
  EGRESS_REDACTION.sharedRedactor,
  EGRESS_REDACTION.noVaultContent,
  EGRESS_REDACTION.unscannedNetworkPayload
]);
var R = EGRESS_REDACTION;
var EGRESS_SITES = Object.freeze({
  "brain-bank-export": {
    id: "brain-bank-export",
    verb: "o2b brain bank-export",
    module: "src/cli/brain/verbs/bank-export.ts",
    redaction: R.sharedRedactor,
    reason: "the widest export in the tree: preferences, the page graph, page contracts and " + "the sources dashboard composed into one file. Redaction runs over the bundle " + "TREE and the JSON is serialised afterwards, so a note whose text happens to " + "contain a credential assignment cannot mangle the document's own quoting."
  },
  "brain-graph-export": {
    id: "brain-graph-export",
    verb: "o2b brain graph-export",
    module: "src/cli/brain/verbs/graph-export.ts",
    redaction: R.sharedRedactor,
    reason: "carries no page body, but does carry every page title, path and typed-relation " + "target - a credential pasted into a title left through here verbatim."
  },
  "brain-okf-export": {
    id: "brain-okf-export",
    verb: "o2b brain okf-export",
    module: "src/cli/brain/verbs/okf-export.ts",
    redaction: R.sharedRedactor,
    reason: "the only export that carries page bodies VERBATIM, which is its interchange " + "contract and also why it is the widest leak by volume. The manifest is redacted " + "as a tree and `okf.json` re-serialised from it; the markdown files are redacted " + "as text. A bundle whose secrets were removed is no longer a lossless round-trip " + "of the vault, and the verb says so rather than implying otherwise. What it does NOT " + "do is filter by label: a page carrying `private: true` in its frontmatter exports in " + "full, because the `<private>` region marker is this product's only content-derived " + "privacy primitive and these composers are content composers, not visibility filters."
  },
  "brain-export": {
    id: "brain-export",
    verb: "o2b brain export",
    module: "src/cli/brain/verbs/export.ts",
    redaction: R.sharedRedactor,
    reason: "preference principles are free text an agent wrote, and the llms-txt form is " + "meant to be pasted into a foreign prompt - the destination least likely to be " + "read before it is shared. One entry covers all three of the verb's formats " + "because the census keys on the MODULE and the destination is declared once, in " + "the verb: the JSON and transcript forms are redacted as TREES and serialised " + "afterwards, llms-txt as text. What proves each branch scans is a per-handler " + "check in the census, not the guard-call count - counting guards against " + "DESTINATIONS is an inequality, and this module declares one destination against " + "three guards, so a fourth handler that scanned nothing would satisfy it. The " + "transcript form is the widest of the three by far - whole recorded " + "conversations with whichever runtime wrote them, which is where a key pasted " + "into a prompt actually lives. Its records are guarded ONE AT A TIME, so a " + "single oversized turn cannot put a machine's whole corpus past the scan window, " + "and a refusal names the conversation rather than the run - by its basename, " + "except when the basename is itself the secret-shaped identifier, where it is " + "named by runtime and start instant instead. The transcript branch is also the " + "one caller that passes `foreignIdentifiers`, because its `session_id` and " + "`turn_id` were named by the harness that wrote the transcript rather than by " + "this vault, so the guard's vendor-prefix-only rule for identifiers - an " + "argument about ids this build constructs - does not cover them."
  },
  "config-export": {
    id: "config-export",
    verb: "o2b export-config",
    module: "src/cli/main.ts",
    redaction: R.sharedRedactor,
    reason: "the machine-config snapshot an operator hands to someone else when reporting a " + "problem. It used a private copy that matched five substrings against KEY NAMES " + "and never inspected a value, so a credential stored under a name that copy did " + "not recognise was written out in full."
  },
  "brain-continuity-export": {
    id: "brain-continuity-export",
    verb: "o2b brain continuity export",
    module: "src/cli/brain/verbs/continuity.ts",
    redaction: R.sharedRedactor,
    reason: "was declared as covered by its read model, which was wrong in both directions. " + "The upstream call redacts at WRITE time with the redactor's DEFAULT options, so " + "`redactTokens` and `redactUrlCredentials` were both off and a vendor key, a bare " + "high-entropy token and a `user:pass@host` URL all left through here verbatim - " + "the two flags the export boundary exists to turn on. Write-time coverage also " + "says nothing about a record already on disk or appended by another writer, since " + "the read model never re-scans. The verb now scans what it READ, which answers " + "both, and gains the truncation refusal the other five already had."
  },
  "brain-explorer-export": {
    id: "brain-explorer-export",
    verb: "o2b brain explorer --export",
    module: "src/cli/brain/verbs/explorer.ts",
    redaction: R.sharedRedactor,
    reason: "a self-contained HTML file with the whole rule graph embedded as JSON: every " + "preference and retired principle verbatim, plus each one's topic, scope and " + "provenance counts. It is the export most likely to be handed to a person rather " + "than a program - it opens in a browser - and it was the one export that never " + "scanned anything. Redaction runs over the graph TREE before the template " + "substitution, so a principle whose text contains a quote cannot disturb the " + "document. The label rule holds here too: a preference is not withheld for carrying " + "a `private` tag, because the `<private>` region marker is the only content-derived " + "privacy primitive in this product."
  },
  "brain-knowledge-pack-export": {
    id: "brain-knowledge-pack-export",
    verb: "o2b brain knowledge-pack export",
    module: "src/cli/brain/verbs/knowledge-pack.ts",
    redaction: R.sharedRedactor,
    reason: "a selected subset - preference principles and page bodies verbatim - built to be " + "handed to someone else, so it is the one export that also filters by LABEL before " + "it scans: a page declaring `visibility:`, an entry carrying `owner:`, and an " + "unreviewed `OKF Review/` candidate are blocked and named, never written. What is " + "carried is redacted as a tree (OKF manifest, preference rows) and as text (pages) " + "BEFORE the pack is sealed, so the sha256 table hashes the bytes that left and a " + "recipient's integrity check verifies the redacted copy, not the vault. Preference " + "rows leave without their evidence links and rendered body."
  },
  "brain-secret-bundle-export": {
    id: "brain-secret-bundle-export",
    verb: "o2b brain secret export",
    module: "src/cli/brain/verbs/secret.ts",
    redaction: R.sharedRedactor,
    reason: "the operator-named file carries every stored credential value RE-ENCRYPTED " + "under a passphrase-derived key, so the shared guard runs over the bundle's " + "METADATA INVENTORY and never over the wrapped values, whose base64 bodies a " + "structural scan could only mangle. The inventory is scanned as an ARRAY of " + "entries - a name like `api-key` as a mapping KEY is the redactor's credential-" + "assignment shape and would replace the whole entry - and the KDF block is " + "excluded, because its random salt is exactly the high-entropy shape the token " + "pass exists to catch. Allow patterns are free text and scan in full; a " + "REWRITTEN entry name or env-var mapping refuses the export, since an " + "identifier is never rewritten into the file that has to carry it. What the " + "status does NOT claim: the file's secrecy is exactly the passphrase's " + "strength against offline guessing wherever the file travels."
  },
  "search-embedding-openai-compat": {
    id: "search-embedding-openai-compat",
    verb: "o2b search index (embedding provider)",
    module: "src/core/search/embeddings/openai-compat.ts",
    redaction: R.unscannedNetworkPayload,
    reason: "the largest and most continuous egress in this product: every indexed chunk BODY " + "is POSTed verbatim to whichever endpoint the operator configured, for every " + "reindex, and nothing scans it. It is declared unscanned rather than wired to the " + "guard because redaction here would corrupt the thing being built - a vector " + "computed over a placeholder is a vector for the placeholder, so the chunk would " + "come back unfindable while the index reported success, which is a silent failure " + "where this one is at least a stated exposure. The controls that do exist are " + "the operator's: semantic search is off until an endpoint and a key are configured, " + "and the endpoint is whichever host they name, including a local one. The request " + "also carries any extra body fields the operator declared in `embedding_extra_body`, " + "verbatim, next to the owned model, input and encoding fields."
  },
  "search-embedding-zeroentropy": {
    id: "search-embedding-zeroentropy",
    verb: "o2b search index (zeroentropy provider)",
    module: "src/core/search/embeddings/zeroentropy.ts",
    redaction: R.unscannedNetworkPayload,
    reason: "the same chunk bodies as the OpenAI-compatible provider, to a second vendor's " + "embed endpoint under the same operator-configured base URL. Listed separately " + "rather than folded into one 'embedding' entry because the census keys on the " + "module, and a provider that stops being reachable from the resolver would " + "otherwise leave a declaration covering a path nobody can find."
  },
  "search-rerank-cross-encoder": {
    id: "search-rerank-cross-encoder",
    verb: "o2b search query --rerank",
    module: "src/core/search/rerank/cross-encoder.ts",
    redaction: R.unscannedNetworkPayload,
    reason: "sends the QUERY plus the candidate documents to a rerank endpoint, so it carries " + "vault text the embedding path may never have seen - the top-of-pool bodies of the " + "current result set, chosen by relevance to what the operator just asked. Unscanned " + "for the same reason as the embedding path: a reranker scoring placeholders returns " + "an order computed over text nobody wrote."
  },
  "decision-model-systemone": {
    id: "decision-model-systemone",
    verb: "decision_model_uses (for example o2b search query with search_rerank_kind: decision-model)",
    module: "src/core/decision-model/systemone.ts",
    redaction: R.sharedRedactor,
    reason: "the optional decision-model route: a masked, clipped state (for a rerank, the QUERY " + "plus the top candidate passages as P0..Pn) and the question texts, POSTed to the " + "operator's configured `/v1/systemone` endpoint. Unlike the embedding and rerank " + "paths it IS scanned: a judgment over a redacted passage is still a usable judgment, " + "so the whole body passes the shared guard and a refusal sends nothing. Pages whose " + "visibility carries the reserved `private` token, or cannot be resolved, never enter " + "the state, and `<private>` regions are stripped first. The same module sends the " + "Vercel AI Gateway `/v1/evaluate` variant (`vercel-evaluate.ts` only renames fields) " + "and the self-hosted `laya` / `openjev` presets, which default to a loopback base URL " + "where nothing leaves the machine. Off unless the operator enables it in machine " + "config AND the named key variable is set (a loopback self-hosted server needs no " + "key); a vault can opt out."
  },
  "decision-model-llm-emulation": {
    id: "decision-model-llm-emulation",
    verb: "decision_model_uses with decision_model_provider: llm-emulation",
    module: "src/core/decision-model/llm-emulation.ts",
    redaction: R.sharedRedactor,
    reason: "the optional, uncalibrated decision emulation: the same masked, clipped state and " + "question texts as the `/v1/systemone` route, POSTed as a chat completion to the " + "operator's OpenAI-compatible endpoint, which asks a GENERATIVE model for " + "probabilities only. The state and questions pass the shared guard before the body " + "is built and a refusal sends nothing; the state is fenced as untrusted content. " + "Never selected implicitly and never a fallback: it runs only when the operator names " + "this provider, every record is `calibrated: false`, and `enforce` is refused unless " + "`decision_model_allow_uncalibrated` is true."
  },
  "brain-telegram-capture": {
    id: "brain-telegram-capture",
    verb: "o2b brain telegram-run",
    module: "src/core/brain/capture/telegram-capture.ts",
    redaction: R.unscannedNetworkPayload,
    reason: "POSTs reply text to the Telegram Bot API, and the `/catchup` reply is composed " + "from vault content. The transport is built only by the CLI runner verb, so an " + "install that never starts the runner never reaches this path at all - which is " + "why it is a declared narrow exposure rather than a guard call: the bytes are a " + "chat message the operator asked to be sent, and refusing to send one because it " + "quotes a credential-shaped string would break the surface without protecting a " + "destination the operator did not already choose."
  },
  "research-external-fetch": {
    id: "research-external-fetch",
    verb: "o2b brain research",
    module: "src/core/brain/research/external-fetch.ts",
    redaction: R.unscannedNetworkPayload,
    reason: "the one transport every research provider's POST goes through, which is why it is " + "declared here rather than at the provider modules that name the endpoints and " + "never call the network themselves. What leaves is an agent-composed search query, " + "not a page body, and the path is key-gated: with no key configured every call is " + "a typed `disabled` error, so an install that never sets one has no egress here."
  },
  "install-adapter-out": {
    id: "install-adapter-out",
    verb: "o2b install --out",
    module: "src/cli/install/install.ts",
    redaction: R.noVaultContent,
    reason: "writes an adapter configuration rendered from install templates plus the " + "resolved config path. It reads no vault note and composes no vault content, so " + "there is no vault payload to scan. In population only because it names a " + "destination, which is the syntactic rule the census uses on purpose - deciding " + "'is this vault content' is what this entry is for, not what the sweep should " + "guess."
  }
});

// src/core/egress/guard.ts
var EGRESS_OUTCOME = Object.freeze({
  released: "released",
  refusedScanTruncated: "refused_scan_truncated",
  refusedSecretIdentifier: "refused_secret_identifier"
});
var EGRESS_OUTCOMES = Object.freeze([
  EGRESS_OUTCOME.released,
  EGRESS_OUTCOME.refusedScanTruncated,
  EGRESS_OUTCOME.refusedSecretIdentifier
]);
var EGRESS_REDACTION_OPTIONS = Object.freeze({
  redactTokens: true,
  redactUrlCredentials: true
});
var SCAN_WINDOW_MIB = MAX_REDACTOR_INPUT / (1024 * 1024);
function composeRedactionOptions(policy) {
  return {
    ...EGRESS_REDACTION_OPTIONS,
    ...policy.foreignIdentifiers === true ? { foreignIdentifiers: true } : {},
    ...policy.resolvedLiterals === undefined ? {} : { literals: sortedDistinctLiterals(policy.resolvedLiterals) }
  };
}
function redactConfigMapping(data, policy = {}) {
  return redactStructured(data, composeRedactionOptions(policy)).value;
}

// src/core/secret-resolver.ts
init_config();
init_secret_ref();
init_secret_ref();
import { existsSync as existsSync7 } from "node:fs";
var custodyStoreModule;
function custodyStore() {
  if (custodyStoreModule === undefined) {
    custodyStoreModule = (init_store(), __toCommonJS(exports_store));
  }
  return custodyStoreModule;
}
function storeValue(vault, name) {
  const held = custodyStore().listSecrets(vault).some((meta) => meta.name === name);
  if (!held)
    return;
  return custodyStore().resolveSecretReadOnly(vault, name).value;
}
function secretProvider(vault) {
  const env = process.env;
  return new Proxy(env, {
    get(_target, prop) {
      if (typeof prop !== "string")
        return;
      return storeValue(vault, prop) ?? env[prop];
    },
    has(_target, prop) {
      if (typeof prop !== "string")
        return Reflect.has(env, prop);
      return storeValue(vault, prop) !== undefined || Reflect.has(env, prop);
    }
  });
}
function resolveNamedSecret(vault, value) {
  if (!isSecretReferenceValue(value))
    return value;
  return resolveSecretReference(value.trim(), secretProvider(vault));
}
function resolvedSecretLiterals(vault) {
  const store = custodyStore();
  let held;
  try {
    held = store.listSecrets(vault);
  } catch {
    return [];
  }
  if (held.length === 0)
    return [];
  if (!existsSync7(store.keyPath(vault)))
    return [];
  const out = [];
  for (const meta of held) {
    try {
      out.push(store.resolveSecretReadOnly(vault, meta.name).value);
    } catch {}
  }
  return out;
}
installNamedSecretResolver({ resolveNamedSecret });

// src/core/vault-presence.ts
init_fs_utils();
function vaultUnexaminable(vault, err) {
  const reason = err?.message ?? String(err);
  return {
    error: `cannot determine whether the vault directory ${vault} exists: ${reason}. ` + "It is NOT reported as absent - a path that cannot be examined is not a " + "path that is not there; make it and every parent directory traversable " + "(chmod u+rx), or set VAULT_DIR to a vault this process can read."
  };
}
function probeVaultDirectory(vault) {
  try {
    return { present: statOrAbsent(vault)?.isDirectory() === true, unexaminable: null };
  } catch (err) {
    return { present: false, unexaminable: vaultUnexaminable(vault, err) };
  }
}

// src/core/doctor.ts
init_config();
init_fs_utils();
import {
  existsSync as existsSync9,
  mkdirSync as mkdirSync5,
  openSync as openSync4,
  readFileSync as readFileSync8,
  rmSync,
  writeSync as writeSync3,
  closeSync as closeSync4
} from "node:fs";
import { dirname as dirname6, join as join12 } from "node:path";

// src/core/partner/codegraph.ts
init_config();
init_fs_utils();
import { existsSync as existsSync8, readdirSync, realpathSync as realpathSync2 } from "node:fs";
import { dirname as dirname5, join as join11, resolve as resolve8 } from "node:path";

// src/core/project-manifests.ts
var MANIFEST_ECOSYSTEM = Object.freeze({
  npm: "npm",
  pypi: "pypi",
  cargo: "cargo",
  go: "go",
  maven: "maven",
  gradle: "gradle",
  rubygems: "rubygems",
  composer: "composer"
});
function spec(file, ecosystem, dependencyReadable) {
  return Object.freeze({ file, ecosystem, dependencyReadable });
}
var DEPENDENCY_MANIFESTS = Object.freeze([
  spec("package.json", MANIFEST_ECOSYSTEM.npm, true),
  spec("pyproject.toml", MANIFEST_ECOSYSTEM.pypi, true),
  spec("Cargo.toml", MANIFEST_ECOSYSTEM.cargo, true),
  spec("go.mod", MANIFEST_ECOSYSTEM.go, true),
  spec("pom.xml", MANIFEST_ECOSYSTEM.maven, false),
  spec("build.gradle", MANIFEST_ECOSYSTEM.gradle, false),
  spec("Gemfile", MANIFEST_ECOSYSTEM.rubygems, false),
  spec("composer.json", MANIFEST_ECOSYSTEM.composer, false)
]);
var TYPESCRIPT_CONFIG_FILE = "tsconfig.json";
var CODE_MANIFEST_FILES = Object.freeze([
  ...DEPENDENCY_MANIFESTS.map((manifest) => manifest.file),
  TYPESCRIPT_CONFIG_FILE
]);
var SPEC_BY_FILE = new Map(DEPENDENCY_MANIFESTS.map((manifest) => [manifest.file, manifest]));

// src/core/partner/codegraph-health.ts
var GRAPH_HEALTH_CODES = Object.freeze({
  emptyGraph: "empty-graph",
  collapsedEdges: "collapsed-edges",
  danglingReferences: "dangling-references",
  selfLoops: "self-loops",
  cacheRootMismatch: "cache-root-mismatch"
});
var GRAPH_HEALTH_CODE_LIST = Object.freeze(Object.values(GRAPH_HEALTH_CODES));
function stripTrailingSlash(p) {
  return p.replace(/\/+$/, "");
}
function samePath(a, b) {
  return stripTrailingSlash(a) === stripTrailingSlash(b);
}
function assessGraphHealth(input) {
  const warnings = [];
  const nodes = Number.isFinite(input.nodeCount) ? input.nodeCount : 0;
  const edges = Number.isFinite(input.edgeCount) ? input.edgeCount : 0;
  if (nodes <= 0) {
    warnings.push({
      code: GRAPH_HEALTH_CODES.emptyGraph,
      message: "index is initialized but holds 0 nodes; extraction produced an empty graph - " + "labeling and recall will find nothing until it is re-indexed"
    });
  } else if (edges <= 0) {
    warnings.push({
      code: GRAPH_HEALTH_CODES.collapsedEdges,
      message: `graph has ${nodes} node(s) but 0 edges; relationship extraction collapsed - ` + "callers/callees/impact traversal will be empty"
    });
  }
  if (input.danglingRefs !== undefined && input.danglingRefs > 0) {
    warnings.push({
      code: GRAPH_HEALTH_CODES.danglingReferences,
      message: `${input.danglingRefs} dangling reference(s): edges point at nodes absent from the ` + "index; derived labels/imports built from them would reference missing symbols"
    });
  }
  if (input.selfLoops !== undefined && input.selfLoops > 0) {
    warnings.push({
      code: GRAPH_HEALTH_CODES.selfLoops,
      message: `${input.selfLoops} self-loop edge(s): a node references itself; ` + "impact and traversal surfaces may double-count or cycle"
    });
  }
  if (input.indexRoot && input.worktreeRoot && !samePath(input.indexRoot, input.worktreeRoot)) {
    warnings.push({
      code: GRAPH_HEALTH_CODES.cacheRootMismatch,
      message: `index was built for '${input.indexRoot}' but is being read from ` + `'${input.worktreeRoot}'; file and line references may be stale for this tree - ` + "re-index the current root before trusting graph-derived artifacts"
    });
  }
  return { ok: warnings.length === 0, warnings };
}
function summarizeGraphHealth(report) {
  if (report.warnings.length === 0)
    return "ok";
  const codes = report.warnings.map((w) => w.code).join(", ");
  return `${report.warnings.length} warning(s) [${codes}]`;
}

// src/core/partner/codegraph.ts
var DEFAULT_LIMIT = 50;
var CODEGRAPH_CLI = Object.freeze({
  bin: "codegraph",
  statusSubcommand: "status",
  statusJsonFlag: "-j",
  initSubcommand: "init"
});
function codegraphInitCommand(projectPath) {
  return `${CODEGRAPH_CLI.bin} ${CODEGRAPH_CLI.initSubcommand} ${projectPath}`;
}
function isCodeProject(dir) {
  try {
    if (!existsSync8(dir))
      return false;
    if (!isDir(join11(dir, ".git")))
      return false;
    return CODE_MANIFEST_FILES.some((m) => existsSync8(join11(dir, m)));
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
    const path = resolve8(raw);
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
  const vaultParent = dirname5(resolve8(opts.vault));
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
      consider(join11(vaultParent, name));
    }
  }
  for (const extra of opts.scanExtraPaths ?? []) {
    if (scanned >= limit)
      break;
    consider(extra);
  }
  return found;
}
function isCodegraphUnanswered(result) {
  return result.ok === false && "unanswered" in result;
}
function partnerEnv() {
  return process.env;
}
function defaultWhichCodegraph() {
  if (typeof Bun !== "undefined" && typeof Bun.which === "function") {
    const found = Bun.which(CODEGRAPH_CLI.bin, { PATH: partnerEnv()["PATH"] });
    return found ?? null;
  }
  return null;
}
var CODEGRAPH_PROJECT_PATH_USAGE_TOKEN = /\[path\]/;
var HELP_FLAG = "--help";
var CODEGRAPH_PARTNER_TIMEOUT_MS = 1e4;
function timedOut(proc) {
  return proc.exitedDueToTimeout === true;
}
function defaultDetectProjectPathSupport(timeoutMs = CODEGRAPH_PARTNER_TIMEOUT_MS) {
  try {
    const proc = Bun.spawnSync({
      cmd: [CODEGRAPH_CLI.bin, CODEGRAPH_CLI.statusSubcommand, HELP_FLAG],
      stdout: "pipe",
      stderr: "pipe",
      env: partnerEnv(),
      timeout: timeoutMs
    });
    if (timedOut(proc))
      return false;
    const help = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
    return CODEGRAPH_PROJECT_PATH_USAGE_TOKEN.test(help);
  } catch {
    return false;
  }
}
function defaultRunStatusJson(projectPath, timeoutMs = CODEGRAPH_PARTNER_TIMEOUT_MS) {
  try {
    const proc = Bun.spawnSync({
      cmd: [
        CODEGRAPH_CLI.bin,
        CODEGRAPH_CLI.statusSubcommand,
        CODEGRAPH_CLI.statusJsonFlag,
        projectPath
      ],
      stdout: "pipe",
      stderr: "pipe",
      env: partnerEnv(),
      timeout: timeoutMs
    });
    if (timedOut(proc))
      return { ok: false, unanswered: true, waitedMs: timeoutMs };
    const stdout = new TextDecoder().decode(proc.stdout).trim();
    const stderr = new TextDecoder().decode(proc.stderr).trim();
    if (!proc.success) {
      if (stdout) {
        try {
          const parsed2 = JSON.parse(stdout);
          return { ok: true, data: parsed2 };
        } catch {}
      }
      return {
        ok: false,
        error: stderr || `${CODEGRAPH_CLI.bin} ${CODEGRAPH_CLI.statusSubcommand} exited ${proc.exitCode}`
      };
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
    return codegraphDisabledResult();
  const projects = findCodeProjects(opts);
  if (projects.length === 0)
    return null;
  const whichFn = deps?.whichCodegraph ?? defaultWhichCodegraph;
  const cliPath = whichFn();
  if (!cliPath) {
    return null;
  }
  if (projects.length === 1) {
    return evaluateProjectStatus(projects[0], deps).result;
  }
  const detectFn = deps?.detectProjectPathSupport ?? (() => defaultDetectProjectPathSupport(partnerTimeout(deps)));
  if (!detectFn()) {
    const first = evaluateProjectStatus(projects[0], deps).result;
    return {
      name: "code_graph",
      ok: first.ok,
      message: `${first.message}; note: codegraph CLI did not report per-query project_path support - reported 1 of ${projects.length} discovered projects only`
    };
  }
  const results = [];
  let unanswered = false;
  for (const project of projects) {
    if (unanswered) {
      results.push({
        name: "code_graph",
        ok: false,
        message: `code project at ${project}: not consulted - ${CODEGRAPH_CLI.bin} did not answer for ` + "an earlier project in this workspace, so nothing is claimed here about this index"
      });
      continue;
    }
    const evaluated = evaluateProjectStatus(project, deps);
    unanswered = evaluated.unanswered;
    results.push(evaluated.result);
  }
  const header = `${projects.length} code projects:`;
  return {
    name: "code_graph",
    ok: results.every((r) => r.ok),
    message: [header, ...results.map((r) => `- ${r.message}`)].join(`
`)
  };
}
function partnerTimeout(deps) {
  return deps?.timeoutMs ?? CODEGRAPH_PARTNER_TIMEOUT_MS;
}
function codegraphDisabledResult() {
  return {
    name: "code_graph",
    ok: true,
    message: `check disabled by ${PARTNER_CODEGRAPH_DISABLED_ENV} / ` + `${PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY}: ${CODEGRAPH_CLI.bin} was not consulted, ` + "so nothing is claimed here about any index"
  };
}
function evaluateProjectStatus(project, deps) {
  const indexDir = join11(project, ".codegraph");
  let indexed;
  try {
    indexed = statOrAbsent(indexDir)?.isDirectory() === true;
  } catch (exc) {
    return answered({
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: index directory unreadable: ${exc.message ?? exc}`,
      fix: `chmod u+rx "${indexDir}"`
    });
  }
  if (!indexed) {
    return answered({
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: not indexed (run: ${codegraphInitCommand(project)})`
    });
  }
  const runFn = deps?.runStatusJson ?? ((path) => defaultRunStatusJson(path, partnerTimeout(deps)));
  const status = runFn(project);
  if (isCodegraphUnanswered(status)) {
    return {
      result: {
        name: "code_graph",
        ok: false,
        message: `code project at ${project}: ${CODEGRAPH_CLI.bin} ` + `${CODEGRAPH_CLI.statusSubcommand} did not answer within ${status.waitedMs}ms and was ` + "stopped, so NOTHING is claimed here about this index - a probe that did not complete " + "is not an index that failed",
        fix: `${CODEGRAPH_CLI.bin} ${CODEGRAPH_CLI.statusSubcommand} ${CODEGRAPH_CLI.statusJsonFlag} ${project}`
      },
      unanswered: true
    };
  }
  if (!status.ok) {
    return answered({
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: codegraph status failed: ${status.error}`
    });
  }
  if (!status.data.initialized) {
    return answered({
      name: "code_graph",
      ok: false,
      message: `code project at ${project}: not indexed (run: ${codegraphInitCommand(project)})`
    });
  }
  const nodes = status.data.nodeCount ?? 0;
  const files = status.data.fileCount ?? 0;
  const base = `code project at ${project}: indexed (${nodes} nodes, ${files} files)`;
  const health = assessGraphHealth({
    nodeCount: nodes,
    edgeCount: status.data.edgeCount ?? 0,
    ...status.data.danglingRefs !== undefined ? { danglingRefs: status.data.danglingRefs } : {},
    ...status.data.selfLoops !== undefined ? { selfLoops: status.data.selfLoops } : {},
    indexRoot: resolveRealpath(status.data.worktreeMismatch?.indexRoot ?? status.data.projectPath ?? null),
    worktreeRoot: resolveRealpath(status.data.worktreeMismatch?.worktreeRoot ?? project)
  });
  return answered({
    name: "code_graph",
    ok: true,
    message: health.ok ? base : `${base}; graph-health: ${summarizeGraphHealth(health)} - run: o2b partner codegraph report`
  });
}
function answered(result) {
  return { result, unanswered: false };
}
function resolveRealpath(value) {
  if (!value)
    return null;
  try {
    return realpathSync2(value);
  } catch {
    return value;
  }
}

// src/core/doctor.ts
var MANIFEST_FIX = "o2b update";
function checkVaultWriteable(vault) {
  if (!existsSync9(vault)) {
    return {
      name: "vault_writeable",
      ok: false,
      message: `vault directory missing: ${vault}`,
      fix: `mkdir -p "${vault}"`
    };
  }
  const probe = join12(vault, ".open-second-brain-doctor-test");
  try {
    const fd = openSync4(probe, "w");
    closeSync4(fd);
    rmSync(probe);
  } catch (exc) {
    return {
      name: "vault_writeable",
      ok: false,
      message: `cannot write to vault: ${exc.message ?? exc}`,
      fix: `chmod u+rwx "${vault}"`
    };
  }
  return { name: "vault_writeable", ok: true, message: `vault exists and is writable: ${vault}` };
}
function checkConfigWriteable(config) {
  let createdForCheck = false;
  try {
    mkdirSync5(dirname6(config), { recursive: true });
    if (!existsSync9(config))
      createdForCheck = true;
    const fd = openSync4(config, "a");
    writeSync3(fd, "");
    closeSync4(fd);
    if (createdForCheck)
      rmSync(config);
  } catch (exc) {
    return {
      name: "config_writeable",
      ok: false,
      message: `cannot write config ${config}: ${exc.message ?? exc}`,
      fix: `mkdir -p "${dirname6(config)}" && chmod u+rwx "${dirname6(config)}"`
    };
  }
  return { name: "config_writeable", ok: true, message: `config writable: ${config}` };
}
function manifestFileProblem(path) {
  let stat;
  try {
    stat = statOrAbsent(path);
  } catch (exc) {
    return {
      absent: false,
      message: `unreadable: ${path} (${exc.message ?? exc})`,
      fix: `chmod u+r "${path}"`
    };
  }
  if (stat?.isFile() === true)
    return null;
  return { absent: true, message: `missing: ${path}`, fix: MANIFEST_FIX };
}
function loadJsonManifest(path, name) {
  const problem = manifestFileProblem(path);
  if (problem !== null) {
    return {
      result: { name, ok: false, message: problem.message, fix: problem.fix },
      data: null
    };
  }
  let data;
  try {
    data = JSON.parse(readFileSync8(path, "utf8"));
  } catch (exc) {
    return {
      result: {
        name,
        ok: false,
        message: `invalid JSON: ${path} (${exc.message})`,
        fix: MANIFEST_FIX
      },
      data: null
    };
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {
      result: { name, ok: false, message: `invalid manifest object: ${path}`, fix: MANIFEST_FIX },
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
      message: `schema invalid: ${path} (${problems.join("; ")})`,
      fix: MANIFEST_FIX
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
      message: `schema invalid: ${path} (${problems.join("; ")})`,
      fix: MANIFEST_FIX
    };
  }
  return { name: "claude_manifest", ok: true, message: `valid Claude manifest: ${path}` };
}
function checkHermesManifest(path) {
  const problem = manifestFileProblem(path);
  if (problem !== null) {
    return { name: "hermes_manifest", ok: false, message: problem.message, fix: problem.fix };
  }
  let text;
  try {
    text = readFileSync8(path, "utf8");
  } catch (exc) {
    return {
      name: "hermes_manifest",
      ok: false,
      message: `invalid text: ${path} (${exc.message ?? exc})`,
      fix: MANIFEST_FIX
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
      message: `schema invalid: ${path} (missing ${missing.join(", ")})`,
      fix: MANIFEST_FIX
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
      message: `schema invalid: ${path} (${problems.join("; ")})`,
      fix: MANIFEST_FIX
    };
  }
  return { name: "openclaw_manifest", ok: true, message: `valid OpenClaw manifest: ${path}` };
}
function checkOpenclawInstallability(repoRoot) {
  const results = [];
  const pkgPath = join12(repoRoot, "package.json");
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
      message: "package.json missing or empty openclaw.extensions array",
      fix: MANIFEST_FIX
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
        message: `extension entry must be a string, got: ${typeof entry}`,
        fix: MANIFEST_FIX
      });
      continue;
    }
    const entryPath = join12(repoRoot, entry);
    const problem = manifestFileProblem(entryPath);
    if (problem === null) {
      results.push({
        name: `openclaw_entry_${entry}`,
        ok: true,
        message: `extension entry exists: ${entry}`
      });
    } else {
      results.push({
        name: `openclaw_entry_${entry}`,
        ok: false,
        message: problem.absent ? `missing extension entry: ${entry}` : `extension entry ${entry} ${problem.message}`,
        fix: problem.fix
      });
    }
  }
  return results;
}
function codegraphCheckDisabled(opts) {
  const explicit = opts.partner?.codegraph?.disabled;
  if (explicit !== undefined)
    return explicit;
  try {
    return resolvePartnerCodegraphDisabled(opts.config ?? undefined);
  } catch {
    return false;
  }
}
function doctor(opts) {
  const results = [];
  results.push(checkVaultWriteable(opts.vault));
  if (opts.config)
    results.push(checkConfigWriteable(opts.config));
  if (opts.repoRoot) {
    const root = opts.repoRoot;
    results.push(checkClaudeManifest(join12(root, ".claude-plugin", "plugin.json")));
    results.push(checkCodexManifest(join12(root, ".codex-plugin", "plugin.json")));
    results.push(checkHermesManifest(join12(root, "plugins", "hermes", "plugin.yaml")));
    results.push(checkOpenclawManifest(join12(root, "openclaw.plugin.json")));
    results.push(...checkOpenclawInstallability(root));
  }
  const cg = checkCodegraph({
    cwd: opts.cwd ?? process.cwd(),
    vault: opts.vault,
    scanExtraPaths: opts.partner?.codegraph?.scanExtraPaths,
    disabled: codegraphCheckDisabled(opts)
  });
  if (cg)
    results.push(cg);
  return results;
}

// src/core/identity-reminder.ts
import { readFileSync as readFileSync9 } from "node:fs";
import { dirname as dirname7, resolve as resolve9 } from "node:path";
import { fileURLToPath } from "node:url";
var TEMPLATE_PATH = resolve9(dirname7(fileURLToPath(import.meta.url)), "..", "..", "templates", "identity-reminder.txt");
var RUNTIME_TARGET = Object.freeze({
  hermes: "hermes",
  openclaw: "openclaw"
});
var KNOWN_RUNTIME_TARGETS = Object.freeze([
  RUNTIME_TARGET.hermes,
  RUNTIME_TARGET.openclaw
]);
function isRuntimeTarget(value) {
  return typeof value === "string" && KNOWN_RUNTIME_TARGETS.includes(value);
}
var commonTemplateCache;
function loadReminderTemplate() {
  if (commonTemplateCache !== undefined)
    return commonTemplateCache;
  try {
    commonTemplateCache = readFileSync9(TEMPLATE_PATH, "utf8").trimEnd();
    return commonTemplateCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load identity reminder template from ${TEMPLATE_PATH}: ${message}`, {
      cause: err
    });
  }
}
var TEMPLATES_DIR = resolve9(dirname7(fileURLToPath(import.meta.url)), "..", "..", "templates");
var PER_TARGET_PATHS = Object.freeze(Object.fromEntries(KNOWN_RUNTIME_TARGETS.map((t) => [t, resolve9(TEMPLATES_DIR, `identity-reminder.${t}.txt`)])));
var TEMPLATE_CACHE = new Map;
function tryReadTargetTemplate(target) {
  const cached = TEMPLATE_CACHE.get(target);
  if (cached !== undefined)
    return cached;
  let body;
  try {
    body = readFileSync9(PER_TARGET_PATHS[target], "utf8").trimEnd();
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

// src/core/vault.ts
init_wikilink();
init_fs_atomic();
init_fs_utils();
init_degradation();
init_path_safety();
import { mkdirSync as mkdirSync6, readFileSync as readFileSync10, readdirSync as readdirSync2, writeFileSync as writeFileSync5 } from "node:fs";
import { dirname as dirname8, join as join13, relative as relative2 } from "node:path";

// src/core/graph/transport-reach.ts
var TRANSPORT_REACH = Object.freeze({
  local: "local",
  remote: "remote"
});
var TRANSPORT_REACHES = Object.freeze([
  TRANSPORT_REACH.local,
  TRANSPORT_REACH.remote
]);
var MAINTENANCE_LANE_REACH = TRANSPORT_REACH.local;

// src/core/graph/visibility.ts
function normToken(raw) {
  return raw.normalize("NFC").trim().toLowerCase();
}
function pageVisibility(meta) {
  const v = meta["visibility"];
  const list = Array.isArray(v) ? v : typeof v === "string" && v.length > 0 ? [v] : [];
  return list.map((s) => normToken(String(s))).filter((s) => s.length > 0);
}
var REMOTE_DENY_VISIBILITY_TOKEN = "private";
function isRemotelyReadable(pageTags, reach) {
  if (reach === TRANSPORT_REACH.local)
    return true;
  return !pageTags.includes(REMOTE_DENY_VISIBILITY_TOKEN);
}

// src/core/vault.ts
init_fs_utils();
var FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?)\n---\s*\n?/;
var BYTE_ORDER_MARK = 65279;
var FRONTMATTER_KEY_PATTERN = "[a-zA-Z_][a-zA-Z0-9_-]*";
var FRONTMATTER_KEY_RE = new RegExp(`^${FRONTMATTER_KEY_PATTERN}$`);
var KEY_VALUE_RE = new RegExp(`^(${FRONTMATTER_KEY_PATTERN})\\s*:\\s*(.*?)\\s*$`);
var DASH_ITEM_RE = /^-(?:\s+(.*))?$/;
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
var FRONTMATTER_SITE = "vault.parseFrontmatter";
var NOTICE_LINE_MAX = 120;
var NOTICE_LINE_ELLIPSIS = "…";
function parseFrontmatterWithNotices(path, opts = {}) {
  const site = opts.site ?? FRONTMATTER_SITE;
  let text;
  try {
    text = readFileSync10(path, "utf8");
  } catch (err) {
    const notices = [];
    emitDegradationNotice(notices, {
      code: DEGRADATION_CODE.frontmatterUnreadable,
      site,
      path,
      detail: `frontmatter read failed: ${err instanceof Error ? err.message : String(err)}`
    });
    return [{}, "", notices];
  }
  return parseFrontmatterTextWithNotices(text, { site, path });
}
function parseFrontmatterTextWithNotices(raw, opts = {}) {
  const notices = [];
  const site = opts.site ?? FRONTMATTER_SITE;
  const text = raw.charCodeAt(0) === BYTE_ORDER_MARK ? raw.slice(1) : raw;
  const match = FRONTMATTER_RE.exec(text);
  if (!match) {
    return [{}, text.trim(), notices];
  }
  const fmBlock = match[1];
  const body = text.slice(match[0].length).trim();
  const metadata = {};
  const lines = fmBlock.split(`
`);
  let blockKey = null;
  for (let i = 0;i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#"))
      continue;
    const dash = DASH_ITEM_RE.exec(line);
    if (dash && blockKey !== null) {
      const arr = metadata[blockKey] ?? [];
      arr.push(stripQuotes(dash[1] ?? ""));
      metadata[blockKey] = arr;
      continue;
    }
    blockKey = null;
    const kv = KEY_VALUE_RE.exec(line);
    if (!kv) {
      emitDegradationNotice(notices, {
        code: DEGRADATION_CODE.frontmatterLineDropped,
        site,
        ...opts.path !== undefined ? { path: opts.path } : {},
        detail: `frontmatter line ${i + 1} is not a supported key/value or list item: ${clipNoticeLine(line)}`
      });
      continue;
    }
    const key = kv[1];
    let value = kv[2].trim();
    if (value === "") {
      let j = i + 1;
      let nextMeaningful = null;
      while (j < lines.length) {
        const cand = lines[j].trim();
        if (!cand || cand.startsWith("#")) {
          j++;
          continue;
        }
        nextMeaningful = cand;
        break;
      }
      if (nextMeaningful !== null && DASH_ITEM_RE.test(nextMeaningful)) {
        metadata[key] = [];
        blockKey = key;
      } else {
        metadata[key] = "";
      }
      continue;
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      metadata[key] = inner ? splitInlineArray(inner) : [];
      continue;
    }
    metadata[key] = stripQuotes(value);
  }
  return [metadata, body, notices];
}
function clipNoticeLine(line) {
  return line.length <= NOTICE_LINE_MAX ? line : line.slice(0, NOTICE_LINE_MAX) + NOTICE_LINE_ELLIPSIS;
}
var LIST_VAULT_PAGES_SITE = "vault.listVaultPages";
var UNMEASURABLE_PAGE_VISIBILITY = Object.freeze([
  REMOTE_DENY_VISIBILITY_TOKEN
]);
function listVaultPages(vaultDir, opts) {
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);
  const skipFiles = new Set((opts.skipFiles ?? DEFAULT_SKIP_FILES).map((f) => f.toLowerCase()));
  const walked = [];
  walk(vaultDir, vaultDir, skipDirs, skipFiles, walked, {
    sink: opts.notices,
    site: opts.site ?? LIST_VAULT_PAGES_SITE
  });
  const pages = walked.filter((w) => isRemotelyReadable(w.unreadable ? UNMEASURABLE_PAGE_VISIBILITY : pageVisibility(w.page.metadata), opts.reach)).map((w) => w.page);
  pages.sort((a, b) => a.title.toLowerCase().localeCompare(b.title.toLowerCase()));
  return pages;
}
function walk(root, dir, skipDirs, skipFiles, out, notices) {
  let entries;
  try {
    entries = readdirSync2(dir, { withFileTypes: true });
  } catch (err) {
    if (notices.sink !== undefined) {
      emitDegradationNotice(notices.sink, {
        code: DEGRADATION_CODE.vaultWalkEntrySkipped,
        site: notices.site,
        path: dir,
        detail: `directory listing failed: ${err instanceof Error ? err.message : String(err)}`
      });
    }
    return;
  }
  for (const entry of entries) {
    const full = join13(dir, entry.name);
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name))
        continue;
      walk(root, full, skipDirs, skipFiles, out, notices);
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
    const [meta, , pageNotices] = parseFrontmatterWithNotices(full, { site: notices.site });
    if (notices.sink !== undefined)
      notices.sink.push(...pageNotices);
    const titleVal = meta["title"];
    const title = typeof titleVal === "string" && titleVal ? titleVal : stem(entry.name);
    out.push({
      page: { title, path: full, metadata: meta },
      unreadable: pageNotices.some((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable)
    });
  }
}
function stripQuotes(s) {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return unescapeDoubleQuoted(s.slice(1, -1));
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1);
  }
  return s;
}
var DOUBLE_QUOTED_ESCAPES = Object.freeze({
  "\\": "\\",
  '"': '"',
  n: `
`,
  r: "\r",
  t: "\t"
});
function unescapeDoubleQuoted(inner) {
  return inner.replace(/\\([\\"nrt])/g, (_, ch) => DOUBLE_QUOTED_ESCAPES[ch] ?? `\\${ch}`);
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

// src/core/brain/entities/types.ts
var BRAIN_ENTITY_STATUS = {
  active: "active",
  archived: "archived",
  quarantine: "quarantine"
};
var BRAIN_ENTITY_STATUS_VALUES = Object.freeze(Object.values(BRAIN_ENTITY_STATUS));
var BRAIN_ENTITY_KIND = "brain-entity";

// src/core/brain/entities/status-scope.ts
var ENTITY_STATUS_SCOPE = {
  canonical: "canonical",
  readable: "readable"
};
var SCOPES_ADMITTING = Object.freeze({
  [BRAIN_ENTITY_STATUS.active]: Object.freeze([
    ENTITY_STATUS_SCOPE.canonical,
    ENTITY_STATUS_SCOPE.readable
  ]),
  [BRAIN_ENTITY_STATUS.archived]: Object.freeze([ENTITY_STATUS_SCOPE.readable]),
  [BRAIN_ENTITY_STATUS.quarantine]: Object.freeze([])
});
var SCOPES_BY_STATUS = new Map(Object.entries(SCOPES_ADMITTING));
function entityStatusInScope(status, scope) {
  return SCOPES_BY_STATUS.get(status)?.includes(scope) ?? false;
}

// src/core/brain/entities/page-scope.ts
function vaultPageInStatusScope(metadata, scope) {
  if (metadata["kind"] !== BRAIN_ENTITY_KIND)
    return true;
  const status = metadata["status"];
  return typeof status === "string" && entityStatusInScope(status, scope);
}

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
var HOST_QUALIFIED_NAME_RE = /^[^-]+-(.+)-agent$/;
function deriveRuntimeAgentName(runtimeId, operatorName) {
  const base = (operatorName ?? "").trim();
  if (base.length === 0)
    return runtimeId;
  const match = HOST_QUALIFIED_NAME_RE.exec(base);
  if (match)
    return `${runtimeId}-${match[1]}-agent`;
  return `${runtimeId}-${base}`;
}

// src/openclaw/index.ts
init_path_safety();

// src/mcp/vault-path-field.ts
init_config();
init_envelope();
init_secret_ref();
var VAULT_PATH_OUTPUT_SCHEMA = Object.freeze({});
var CONFIG_UNREADABLE_REASON = "the device-local config could not be read, so this reference cannot be " + "resolved; call second_brain_status for the file and the remedy";
var SECRET_STORE_LOCKED_REASON = "the vault's credential store is locked, so the installation secret " + 'reference cannot be resolved; run "o2b brain secret unlock" and retry';
var SECRET_STORE_KEYFILE_MISSING_REASON = "the vault's credential store is missing its keyfile, so the installation " + "secret reference cannot be resolved; restore the keyfile and retry";
var SECRET_REFERENCE_UNRESOLVED_REASON = "the installation secret is a $secret: reference the vault's credential " + "store cannot resolve; inspect the device config and the store with " + "`o2b secrets list`";
function hostPathReference(path, source) {
  const configPath = source.configPath ?? undefined;
  try {
    return resolveExposeHostPaths(configPath) ? path : vaultStoreReference(path, configPath);
  } catch (err) {
    if (err instanceof ConfigReadError)
      return { error: CONFIG_UNREADABLE_REASON };
    if (err instanceof SecretStoreLockedError)
      return { error: SECRET_STORE_LOCKED_REASON };
    if (err instanceof SecretStoreKeyfileMissingError) {
      return { error: SECRET_STORE_KEYFILE_MISSING_REASON };
    }
    if (err instanceof SecretReferenceError)
      return { error: SECRET_REFERENCE_UNRESOLVED_REASON };
    throw err;
  }
}
function vaultPathField(ctx) {
  return hostPathReference(ctx.vault, ctx);
}

// src/openclaw/index.ts
var OPENCLAW_TRANSPORT_REACH = TRANSPORT_REACH.remote;
function resolveVaultPath(api) {
  const cfg = api.pluginConfig ?? {};
  return cfg.vault || process.env["VAULT_DIR"] || ".";
}
var openclaw_default = definePluginEntry({
  register(api) {
    api.on("before_prompt_build", () => {
      const cfg = api.pluginConfig ?? {};
      const operator = normalizeAgentArgument(cfg.agentName ?? null) ?? process.env["VAULT_AGENT_NAME"] ?? resolveAgentName();
      if (operator === "agent")
        return;
      const agent = deriveRuntimeAgentName("openclaw", operator);
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
        const presence = probeVaultDirectory(vault);
        const result = {
          config_path: discovery.path,
          config_exists: discovery.exists,
          config_keys: Object.keys(discovery.data).toSorted(),
          config: redactConfigMapping(discovery.data, {
            resolvedLiterals: resolvedSecretLiterals(vault)
          }),
          vault_path: vaultPathField({ vault }),
          vault_exists: presence.unexaminable ?? presence.present
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
        const presence = probeVaultDirectory(vault);
        if (presence.unexaminable)
          throw new Error(presence.unexaminable.error);
        if (!presence.present)
          throw new Error(`vault directory missing: ${vault}`);
        const pattern = params["pattern"] ?? null;
        const limit = typeof params["limit"] === "number" ? params["limit"] : 50;
        if (limit < 1 || limit > 500)
          throw new Error("argument 'limit' must be between 1 and 500");
        const pages = listVaultPages(vault, { reach: OPENCLAW_TRANSPORT_REACH }).filter((p) => vaultPageInStatusScope(p.metadata, ENTITY_STATUS_SCOPE.readable));
        const needle = pattern ? pattern.toLowerCase() : null;
        const matched = (needle === null ? pages : pages.filter((p) => p.title.toLowerCase().includes(needle))).slice(0, limit).map((p) => ({
          title: p.title,
          path: vaultRelative(p.path, vault),
          metadata: p.metadata
        }));
        const result = {
          vault_path: vaultPathField({ vault }),
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
          vault_path: vaultPathField({ vault }),
          ok: results.every((r) => r.ok),
          checks: results.map((r) => ({
            name: r.name,
            ok: r.ok,
            message: r.message,
            ...r.fix !== undefined ? { fix: r.fix } : {}
          }))
        };
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
    });
  }
});
export {
  openclaw_default as default
};
