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
function atomicWriteText(targetPath, candidate, opts = {}) {
  opts.validate?.(candidate);
  if (opts.skipIfUnchanged && isUnchanged(targetPath, candidate))
    return false;
  withTempFile(targetPath, candidate, (tmpPath) => {
    renameWithRetry(tmpPath, targetPath);
  }, opts.mode ?? 384);
  return true;
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
function storeSecretName(name) {
  return name.trim().toLowerCase();
}
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
  return [...new Set(values)].filter((value) => value.length >= MIN_REDACTED_LITERAL_LENGTH).sort((a, b) => b.length - a.length);
}
var SecretReferenceError, SECRET_REFERENCE_RE, REFERENCE_PREFIX = "$secret:", MIN_REDACTED_LITERAL_LENGTH = 8;
var init_secret_ref = __esm(() => {
  SecretReferenceError = class SecretReferenceError extends Error {
    nameValue;
    constructor(message, nameValue) {
      super(message);
      this.name = "SecretReferenceError";
      this.nameValue = nameValue;
    }
  };
  SECRET_REFERENCE_RE = /^\$secret:([A-Za-z0-9_][A-Za-z0-9_-]*)$/;
});

// src/core/platform-dirs.ts
import { homedir } from "node:os";
import { join as join2, posix, win32 } from "node:path";
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
  return posix.join(source.home, ...POSIX_DEFAULT[kind]);
}
function configBaseDir(source = processDirsEnv()) {
  return baseDir("config", source);
}
function dataBaseDir(source = processDirsEnv()) {
  return baseDir("data", source);
}
function stateBaseDir(source = processDirsEnv()) {
  return baseDir("state", source);
}
function stateRootDir(source = processDirsEnv()) {
  return join2(baseDir("state", source), APP_DIR_NAME);
}
function noVaultRoot() {
  return join2(stateRootDir(processDirsEnv()), "no-vault");
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
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, statSync } from "node:fs";
import { dirname as dirname2, join as join3 } from "node:path";
function profilesPath(configPath) {
  return join3(dirname2(configPath), "profiles.json");
}
function load(configPath, opts = {}) {
  const path = profilesPath(configPath);
  if (!existsSync2(path))
    return { active: null, profiles: {} };
  try {
    const raw = JSON.parse(readFileSync2(path, "utf8"));
    const profiles = {};
    if (raw.profiles && typeof raw.profiles === "object") {
      for (const [name, entry] of Object.entries(raw.profiles)) {
        if (entry && typeof entry === "object" && typeof entry.vault === "string") {
          profiles[name] = { vault: entry.vault };
        }
      }
    }
    return { active: typeof raw.active === "string" ? raw.active : null, profiles };
  } catch (exc) {
    if (!opts.tolerateParseError) {
      throw new Error(`profiles registry is malformed: ${path}`, { cause: exc });
    }
    return { ...EMPTY };
  }
}
function resolveActiveProfileVault(configPath) {
  const data = load(configPath, { tolerateParseError: true });
  if (data.active === null)
    return null;
  return data.profiles[data.active]?.vault ?? null;
}
var import_proper_lockfile, EMPTY;
var init_profiles = __esm(() => {
  init_fs_atomic();
  import_proper_lockfile = __toESM(require_proper_lockfile(), 1);
  EMPTY = { active: null, profiles: {} };
});

// src/core/fs-utils.ts
import { statSync as statSync2 } from "node:fs";
function statOrAbsent(p) {
  return statSync2(p, { throwIfNoEntry: false });
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
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, rmSync } from "node:fs";
import { dirname as dirname3, join as join4, resolve as resolve2, sep } from "node:path";
function probeAt(dir) {
  const path = join4(dir, VAULT_POINTER_FILE);
  if (!existsSync3(path))
    return null;
  try {
    const raw = JSON.parse(readFileSync3(path, "utf8"));
    const vault = raw["vault"];
    if (typeof vault !== "string" || vault.trim() === "") {
      return Object.freeze({ path, dir, pointer: null, error: "pointer has no vault field" });
    }
    const linkedAt = typeof raw["linked_at"] === "string" ? raw["linked_at"] : null;
    return Object.freeze({
      path,
      dir,
      pointer: Object.freeze({ vault, linkedAt }),
      error: null
    });
  } catch (exc) {
    return Object.freeze({
      path,
      dir,
      pointer: null,
      error: `pointer is not valid JSON: ${exc.message}`
    });
  }
}
function findVaultPointer(startDir) {
  let dir = resolve2(startDir);
  for (;; ) {
    const probe = probeAt(dir);
    if (probe !== null)
      return probe;
    const parent = dirname3(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}
function resolvePointerVault(startDir) {
  const probe = findVaultPointer(startDir);
  if (probe === null || probe.pointer === null)
    return null;
  if (!isDir(probe.pointer.vault))
    return null;
  return probe.pointer.vault;
}
var VAULT_POINTER_FILE = ".o2b-vault.json";
var init_pointer = __esm(() => {
  init_fs_atomic();
  init_fs_utils();
});

// src/core/brain/yaml-parse.ts
function parseBrainYaml(text) {
  const lines = splitLines(text);
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent !== 0) {
      throw new Error(`line ${line.lineNumber}: unexpected indentation at top level`);
    }
    const kv = splitKeyValue(line);
    if (kv.value === "") {
      const child = {};
      i++;
      const blockIndent = detectBlockIndent(lines, i);
      while (i < lines.length && lines[i].indent >= blockIndent && blockIndent > 0) {
        const inner = lines[i];
        if (inner.indent !== blockIndent) {
          throw new Error(`line ${inner.lineNumber}: inconsistent indentation in block '${kv.key}' ` + `(expected ${blockIndent} spaces, got ${inner.indent})`);
        }
        const innerKv = splitKeyValue(inner);
        if (innerKv.value === "") {
          i++;
          const listIndent = detectBlockIndent(lines, i);
          if (listIndent <= blockIndent) {
            if (innerKv.key in child) {
              throw new Error(`line ${inner.lineNumber}: duplicate key '${innerKv.key}' in block '${kv.key}'`);
            }
            child[innerKv.key] = [];
            continue;
          }
          const items = [];
          while (i < lines.length && lines[i].indent >= listIndent) {
            const listLine = lines[i];
            if (listLine.indent !== listIndent) {
              throw new Error(`line ${listLine.lineNumber}: inconsistent indentation in list '${innerKv.key}' ` + `(expected ${listIndent} spaces, got ${listLine.indent})`);
            }
            if (!listLine.content.startsWith("- ") && listLine.content !== "-") {
              if (/^[A-Za-z_][A-Za-z0-9_-]*\s*:/.test(listLine.content)) {
                throw new Error(`line ${listLine.lineNumber}: nested blocks deeper than one level are not supported`);
              }
              throw new Error(`line ${listLine.lineNumber}: expected list item starting with '- ' ` + `in '${kv.key}.${innerKv.key}'`);
            }
            const itemText = listLine.content.startsWith("- ") ? listLine.content.slice(2).trim() : "";
            const item = parseScalar(itemText, listLine.lineNumber);
            if (Array.isArray(item)) {
              throw new Error(`line ${listLine.lineNumber}: nested inline arrays are not supported`);
            }
            items.push(item);
            i++;
          }
          if (innerKv.key in child) {
            throw new Error(`line ${inner.lineNumber}: duplicate key '${innerKv.key}' in block '${kv.key}'`);
          }
          child[innerKv.key] = items;
          continue;
        }
        if (innerKv.key in child) {
          throw new Error(`line ${inner.lineNumber}: duplicate key '${innerKv.key}' in block '${kv.key}'`);
        }
        child[innerKv.key] = parseScalar(innerKv.value, inner.lineNumber);
        i++;
      }
      if (kv.key in out) {
        throw new Error(`duplicate top-level key '${kv.key}'`);
      }
      out[kv.key] = child;
      continue;
    }
    if (kv.key in out) {
      throw new Error(`duplicate top-level key '${kv.key}'`);
    }
    out[kv.key] = parseScalar(kv.value, line.lineNumber);
    i++;
  }
  return out;
}
function splitLines(text) {
  const out = [];
  let lineNumber = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNumber++;
    const stripped = raw.replace(/\s+$/, "");
    if (stripped.trim() === "")
      continue;
    if (stripped.trimStart().startsWith("#"))
      continue;
    let content = stripped;
    if (!/['"]/.test(stripped)) {
      const hashIdx = stripped.indexOf(" #");
      if (hashIdx >= 0)
        content = stripped.slice(0, hashIdx).replace(/\s+$/, "");
    }
    const indent = content.length - content.trimStart().length;
    out.push({
      raw,
      indent,
      content: content.slice(indent),
      lineNumber
    });
  }
  return out;
}
function splitKeyValue(line) {
  const idx = line.content.indexOf(":");
  if (idx <= 0) {
    throw new Error(`line ${line.lineNumber}: expected 'key: value', got: ${JSON.stringify(line.raw)}`);
  }
  const key = line.content.slice(0, idx).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) {
    throw new Error(`line ${line.lineNumber}: invalid key name: ${JSON.stringify(key)}`);
  }
  if (key === "__proto__" || key === "constructor" || key === "prototype") {
    throw new Error(`line ${line.lineNumber}: reserved key name: ${JSON.stringify(key)}`);
  }
  const value = line.content.slice(idx + 1).trim();
  return { key, value };
}
function detectBlockIndent(lines, cursor) {
  if (cursor >= lines.length)
    return 0;
  const first = lines[cursor];
  if (first.indent === 0)
    return 0;
  return first.indent;
}
function parseScalar(text, lineNumber) {
  if (text.startsWith("[") && text.endsWith("]")) {
    return parseInlineArray(text.slice(1, -1), lineNumber);
  }
  if (text.length >= 2 && (text.startsWith('"') && text.endsWith('"') || text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  if (text === "true")
    return true;
  if (text === "false")
    return false;
  if (text === "null" || text === "~")
    return null;
  if (/^-?\d+$/.test(text)) {
    const n = parseInt(text, 10);
    return n;
  }
  if (/^-?\d+\.\d+$/.test(text)) {
    const n = parseFloat(text);
    if (!Number.isFinite(n)) {
      throw new Error(`line ${lineNumber}: non-finite number: ${text}`);
    }
    return n;
  }
  return text;
}
function parseInlineArray(innerRaw, lineNumber) {
  const inner = innerRaw.trim();
  if (inner === "")
    return [];
  const out = [];
  let current = "";
  let inQuote = false;
  let quoteChar = "";
  for (let i = 0;i < inner.length; i++) {
    const ch = inner[i];
    if (inQuote) {
      current += ch;
      if (ch === quoteChar) {
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
      out.push(parseInlineArrayItem(current, lineNumber));
      current = "";
      continue;
    }
    current += ch;
  }
  if (inQuote) {
    throw new Error(`line ${lineNumber}: unterminated quoted string in inline array`);
  }
  out.push(parseInlineArrayItem(current, lineNumber));
  return out;
}
function parseInlineArrayItem(text, lineNumber) {
  const trimmed = text.trim();
  if (trimmed === "") {
    throw new Error(`line ${lineNumber}: empty item in inline array`);
  }
  const parsed = parseScalar(trimmed, lineNumber);
  if (Array.isArray(parsed)) {
    throw new Error(`line ${lineNumber}: nested inline arrays are not supported`);
  }
  return parsed;
}

// src/core/brain/policy/errors.ts
var BrainConfigError;
var init_errors = __esm(() => {
  BrainConfigError = class BrainConfigError extends Error {
    field;
    source;
    constructor(message, field, source) {
      super(field ? `${source ?? "<config>"}: ${field}: ${message}` : `${source ?? "<config>"}: ${message}`);
      this.name = "BrainConfigError";
      this.field = field;
      this.source = source;
    }
  };
});

// src/core/brain/path-constants.ts
import { posix as posix2 } from "node:path";
var BRAIN_ROOT_REL = "Brain", BRAIN_INBOX_REL, BRAIN_PROCESSED_REL, BRAIN_ARCHIVED_SIGNALS_REL, BRAIN_PENDING_REL, BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL, BRAIN_SKILL_PROPOSALS_REL, BRAIN_SKILL_PROPOSALS_PENDING_REL, BRAIN_SKILL_PROPOSALS_ACCEPTED_REL, BRAIN_SKILL_PROPOSALS_REJECTED_REL, BRAIN_SKILL_ACCEPT_JOURNAL_REL, BRAIN_PROCEDURES_REL, BRAIN_PROCEDURAL_MEMORY_REL, BRAIN_ATTENTION_REL, BRAIN_OBLIGATIONS_REL, BRAIN_PLEDGES_REL, BRAIN_THESES_REL, BRAIN_DECISIONS_REL, BRAIN_GAP_TASKS_REL, BRAIN_TENSIONS_REL, BRAIN_LOG_DIR = "log", BRAIN_LOG_REL, BRAIN_CAPTURES_REL, BRAIN_CAPTURES_PROCESSED_REL, BRAIN_ENTITIES_REL, BRAIN_STATE_REL, BRAIN_INTERNAL_STATE_DIR = ".state", BRAIN_INTERNAL_STATE_REL, BRAIN_ANTICIPATORY_DIR = "anticipatory", BRAIN_ANTICIPATORY_REL, BRAIN_BASES_REL, BRAIN_SOURCES_REL, BRAIN_REPORTS_REL, BRAIN_DISTILLATIONS_REL, BRAIN_SNAPSHOTS_DIR = ".snapshots", BRAIN_SNAPSHOTS_REL, BRAIN_ARTIFACTS_DIR = ".artifacts", BRAIN_ARTIFACTS_REL, BRAIN_ARCHIVES_DIR = ".archives", BRAIN_ARCHIVES_REL, BRAIN_PAYLOADS_DIR = ".payloads", BRAIN_PAYLOADS_REL, BRAIN_WRITE_IMAGES_DIR = "write-images", BRAIN_WRITE_IMAGES_REL, BRAIN_SNAPSHOT_EXCLUDED_ENTRIES, DERIVED_STORE_DIR = ".open-second-brain", BENCH_RUNS_REL, JSONL_LEDGER_EXT = "jsonl", BRAIN_CONFIG_FILE = "_brain.yaml", BRAIN_ACTIVE_FILE = "active.md", BRAIN_LESSONS_FILE = "lessons.md", BRAIN_COMPILED_DIGEST_RELS, BRAIN_INDEX_FILE = "_INDEX.md", BRAIN_INDEX_REL, BRAIN_PAGE_LANES_REL;
var init_path_constants = __esm(() => {
  BRAIN_INBOX_REL = posix2.join(BRAIN_ROOT_REL, "inbox");
  BRAIN_PROCESSED_REL = posix2.join(BRAIN_INBOX_REL, "processed");
  BRAIN_ARCHIVED_SIGNALS_REL = posix2.join(BRAIN_INBOX_REL, "archived");
  BRAIN_PENDING_REL = posix2.join(BRAIN_ROOT_REL, "pending");
  BRAIN_PREFERENCES_REL = posix2.join(BRAIN_ROOT_REL, "preferences");
  BRAIN_RETIRED_REL = posix2.join(BRAIN_ROOT_REL, "retired");
  BRAIN_SKILL_PROPOSALS_REL = posix2.join(BRAIN_ROOT_REL, "skill-proposals");
  BRAIN_SKILL_PROPOSALS_PENDING_REL = posix2.join(BRAIN_SKILL_PROPOSALS_REL, "pending");
  BRAIN_SKILL_PROPOSALS_ACCEPTED_REL = posix2.join(BRAIN_SKILL_PROPOSALS_REL, "accepted");
  BRAIN_SKILL_PROPOSALS_REJECTED_REL = posix2.join(BRAIN_SKILL_PROPOSALS_REL, "rejected");
  BRAIN_SKILL_ACCEPT_JOURNAL_REL = posix2.join(BRAIN_SKILL_PROPOSALS_REL, "accept-journal");
  BRAIN_PROCEDURES_REL = posix2.join(BRAIN_ROOT_REL, "procedures");
  BRAIN_PROCEDURAL_MEMORY_REL = posix2.join(BRAIN_ROOT_REL, "procedural-memory");
  BRAIN_ATTENTION_REL = posix2.join(BRAIN_ROOT_REL, "attention");
  BRAIN_OBLIGATIONS_REL = posix2.join(BRAIN_ROOT_REL, "obligations");
  BRAIN_PLEDGES_REL = posix2.join(BRAIN_ROOT_REL, "pledges");
  BRAIN_THESES_REL = posix2.join(BRAIN_ROOT_REL, "theses");
  BRAIN_DECISIONS_REL = posix2.join(BRAIN_ROOT_REL, "decisions");
  BRAIN_GAP_TASKS_REL = posix2.join(BRAIN_ROOT_REL, "gap-tasks");
  BRAIN_TENSIONS_REL = posix2.join(BRAIN_ROOT_REL, "tensions");
  BRAIN_LOG_REL = posix2.join(BRAIN_ROOT_REL, BRAIN_LOG_DIR);
  BRAIN_CAPTURES_REL = posix2.join(BRAIN_ROOT_REL, "captures");
  BRAIN_CAPTURES_PROCESSED_REL = posix2.join(BRAIN_CAPTURES_REL, "processed");
  BRAIN_ENTITIES_REL = posix2.join(BRAIN_ROOT_REL, "entities");
  BRAIN_STATE_REL = posix2.join(BRAIN_ROOT_REL, "state");
  BRAIN_INTERNAL_STATE_REL = posix2.join(BRAIN_ROOT_REL, BRAIN_INTERNAL_STATE_DIR);
  BRAIN_ANTICIPATORY_REL = posix2.join(BRAIN_INTERNAL_STATE_REL, BRAIN_ANTICIPATORY_DIR);
  BRAIN_BASES_REL = posix2.join(BRAIN_ROOT_REL, "bases");
  BRAIN_SOURCES_REL = posix2.join(BRAIN_ROOT_REL, "sources");
  BRAIN_REPORTS_REL = posix2.join(BRAIN_ROOT_REL, "reports");
  BRAIN_DISTILLATIONS_REL = posix2.join(BRAIN_ROOT_REL, "distillations");
  BRAIN_SNAPSHOTS_REL = posix2.join(BRAIN_ROOT_REL, BRAIN_SNAPSHOTS_DIR);
  BRAIN_ARTIFACTS_REL = posix2.join(BRAIN_ROOT_REL, BRAIN_ARTIFACTS_DIR);
  BRAIN_ARCHIVES_REL = posix2.join(BRAIN_ROOT_REL, BRAIN_ARCHIVES_DIR);
  BRAIN_PAYLOADS_REL = posix2.join(BRAIN_ROOT_REL, BRAIN_PAYLOADS_DIR);
  BRAIN_WRITE_IMAGES_REL = posix2.join(BRAIN_INTERNAL_STATE_REL, BRAIN_WRITE_IMAGES_DIR);
  BRAIN_SNAPSHOT_EXCLUDED_ENTRIES = Object.freeze([
    BRAIN_SNAPSHOTS_DIR,
    BRAIN_ARTIFACTS_DIR
  ]);
  BENCH_RUNS_REL = posix2.join(DERIVED_STORE_DIR, "bench-runs");
  BRAIN_COMPILED_DIGEST_RELS = Object.freeze([
    posix2.join(BRAIN_ROOT_REL, BRAIN_ACTIVE_FILE),
    posix2.join(BRAIN_ROOT_REL, BRAIN_LESSONS_FILE)
  ]);
  BRAIN_INDEX_REL = posix2.join(BRAIN_ROOT_REL, BRAIN_INDEX_FILE);
  BRAIN_PAGE_LANES_REL = Object.freeze([
    BRAIN_SOURCES_REL,
    BRAIN_REPORTS_REL,
    BRAIN_DISTILLATIONS_REL
  ]);
});

// src/core/integrity/digest.ts
import { createHash } from "node:crypto";
function sha256Hex(input) {
  return createHash(DIGEST_ALGORITHM).update(input).digest("hex");
}
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).filter(([, child]) => child !== undefined).toSorted(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
var DIGEST_ALGORITHM = "sha256";
var init_digest = () => {};

// src/core/reliability/command-bridge.ts
var init_command_bridge = () => {};

// src/core/brain/llm-step.ts
var NEEDS_LLM_STEP_KEYS;
var init_llm_step = __esm(() => {
  NEEDS_LLM_STEP_KEYS = Object.freeze([
    "status",
    "step",
    "prompt",
    "schema_hints",
    "target_path"
  ]);
});

// src/core/brain/skill-rewrite-tasks.ts
import { posix as posix3 } from "node:path";
var SKILL_BENCHMARKS_DIR = "skill-benchmarks", SKILL_BENCHMARKS_ROOT_REL, SKILL_BENCH_TASK_KIND, SKILL_BENCH_TASK_KINDS, SKILL_BENCH_CHECK, SKILL_BENCH_CHECKS, SKILL_BENCH_VALUE_CLASS, SKILL_BENCH_VALUE_CLASSES;
var init_skill_rewrite_tasks = __esm(() => {
  init_digest();
  init_path_constants();
  SKILL_BENCHMARKS_ROOT_REL = posix3.join(BRAIN_ROOT_REL, SKILL_BENCHMARKS_DIR);
  SKILL_BENCH_TASK_KIND = Object.freeze({
    invocation_transcript: "invocation_transcript"
  });
  SKILL_BENCH_TASK_KINDS = Object.freeze(Object.values(SKILL_BENCH_TASK_KIND));
  SKILL_BENCH_CHECK = Object.freeze({
    tool_used: "tool_used",
    artifact_created: "artifact_created",
    step_order: "step_order",
    forbidden_step: "forbidden_step",
    output_field: "output_field"
  });
  SKILL_BENCH_CHECKS = Object.freeze(Object.values(SKILL_BENCH_CHECK));
  SKILL_BENCH_VALUE_CLASS = Object.freeze({
    non_empty_string: "non_empty_string",
    number: "number",
    boolean: "boolean",
    non_empty_array: "non_empty_array"
  });
  SKILL_BENCH_VALUE_CLASSES = Object.freeze(Object.values(SKILL_BENCH_VALUE_CLASS));
});

// src/core/brain/skill-rewrite-spec.ts
var SKILL_REWRITE_VERDICT, SKILL_REWRITE_VERDICTS, HASH_HEX_LENGTH = 64, HASH_HEX_RE;
var init_skill_rewrite_spec = __esm(() => {
  init_digest();
  init_skill_rewrite_tasks();
  SKILL_REWRITE_VERDICT = Object.freeze({
    promote: "promote",
    hold: "hold",
    not_enough_evidence: "not_enough_evidence"
  });
  SKILL_REWRITE_VERDICTS = Object.freeze(Object.values(SKILL_REWRITE_VERDICT));
  HASH_HEX_RE = new RegExp(`^[0-9a-f]{${HASH_HEX_LENGTH}}$`);
});

// src/core/brain/skill-rewrite.ts
function isSkillRewriteMode(value) {
  return typeof value === "string" && SKILL_REWRITE_MODES.includes(value);
}
function resolveSkillRewriteMode(raw) {
  const value = raw?.trim() ?? "";
  if (value === "")
    return SKILL_REWRITE_MODE.gated;
  if (isSkillRewriteMode(value))
    return value;
  throw new SkillRewriteError(`skill rewrite mode '${value}' is unknown (expected one of ${SKILL_REWRITE_MODES.join(", ")})`);
}
var SKILL_REWRITE_ROUND_ARM, SKILL_REWRITE_ROUND_ARMS, SKILL_REWRITE_MODE, SKILL_REWRITE_MODES, SkillRewriteError, SELF_REPORTED_KEYS, KNOWN_SUBMISSION_KEYS, SUBMISSION_SHAPE_HINT;
var init_skill_rewrite = __esm(() => {
  init_digest();
  init_command_bridge();
  init_llm_step();
  init_skill_rewrite_tasks();
  init_skill_rewrite_spec();
  init_skill_rewrite_spec();
  SKILL_REWRITE_ROUND_ARM = Object.freeze({
    baseline: "baseline",
    candidate: "candidate",
    heldout: "heldout"
  });
  SKILL_REWRITE_ROUND_ARMS = Object.freeze(Object.values(SKILL_REWRITE_ROUND_ARM));
  SKILL_REWRITE_MODE = Object.freeze({
    gated: "gated",
    iterative: "iterative"
  });
  SKILL_REWRITE_MODES = Object.freeze(Object.values(SKILL_REWRITE_MODE));
  SkillRewriteError = class SkillRewriteError extends Error {
    constructor(message) {
      super(message);
      this.name = "SkillRewriteError";
    }
  };
  SELF_REPORTED_KEYS = Object.freeze([
    "success",
    "passed",
    "succeeded",
    "ok"
  ]);
  KNOWN_SUBMISSION_KEYS = Object.freeze([
    "task_id",
    "steps",
    "tools_used",
    "artifacts",
    "output",
    "candidate_sha256"
  ]);
  SUBMISSION_SHAPE_HINT = "Return one JSON object per task with keys: task_id (string), steps (string array), " + "tools_used (string array), artifacts (string array), output (object), " + "candidate_sha256 (string, the sha-256 hex digest of the candidate skill body the " + "task was performed against). " + "No other top-level keys.";
});

// src/core/brain/wikilink.ts
import { basename as basename2 } from "node:path";
function normaliseWikilinkTarget(value) {
  let s = value.trim();
  const wm = ANCHORED_WIKILINK_RE.exec(s);
  if (wm)
    s = wm[1].trim();
  return stripBasenameDecoration(s);
}
function stripWikilinkDecoration(body) {
  let s = body.trim();
  const pipe = s.indexOf("|");
  if (pipe >= 0)
    s = s.slice(0, pipe).trim();
  const hash = s.indexOf("#");
  if (hash >= 0)
    s = s.slice(0, hash).trim();
  return s;
}
function stripBasenameDecoration(body) {
  let s = stripWikilinkDecoration(body);
  s = basename2(s);
  if (s.endsWith(".md"))
    s = s.slice(0, -".md".length);
  return s;
}
function stripBrainIdPrefix(id) {
  return id.trim().replace(BRAIN_ID_PREFIX_RE, "").trim();
}
function parseWikilink(value) {
  const m = EXACT_WIKILINK_RE.exec(value.trim());
  if (!m)
    return null;
  return normaliseWikilinkTarget(m[1]);
}
var ANCHORED_WIKILINK_RE, EXACT_WIKILINK_RE, BRAIN_ID_PREFIX_RE;
var init_wikilink = __esm(() => {
  ANCHORED_WIKILINK_RE = /^\[\[([^\]]+)\]\]/;
  EXACT_WIKILINK_RE = /^\[\[([^\]]+)\]\]$/;
  BRAIN_ID_PREFIX_RE = /^(?:pref-|ret-)/;
});

// src/core/brain/link-graph/format-wikilink.ts
function isWikiLinkFormat(value) {
  return WIKI_LINK_FORMATS.includes(value);
}
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

// src/core/store/constants.ts
var STORE_FORMAT_VERSION = 1, STORE_FORMAT_FILE = "FORMAT.md", STORE_IDENTITY_FILE = "store.json", STORE_PARTITIONS, STORE_STREAMS, LEDGER_STREAM = "ledgers", STORE_BLOBS_DIR = "blobs", STORE_SHARD_EXT = "jsonl", ENVELOPE_FIELDS, BLOB_REF_KEY = "$blob", BLOB_REF_BYTES_KEY = "bytes", COMPACTED_KIND = "compacted", STORE_RECORD_KINDS, STORE_LINE_CAP_BYTES, STORE_BODY_MAX_DEPTH = 64, STORE_BLOB_MAX_BYTES, STORE_ROOT_CONFIG_KEY = "store_root", STORE_ROOT_ENV = "OPEN_SECOND_BRAIN_STORE_ROOT", STORE_DEFAULT_DIR = "store", STORE_STATE_DIR = "stores", STORE_LOCKS_DIR = "locks", STORE_CLOCK_DIR = "clock", SEEN_SHARDS_FILE = "seen-shards.json", AUTHORITY_FIELD = "authority", VAULT_ID_FIELD = "vault_id", AUTHORITIES, PREFERENCE_SET_KIND = "preference-set", PREFERENCE_REMOVE_KIND = "preference-remove", PREFERENCE_EVIDENCE_KIND = "preference-evidence", PINNED_SET_KIND = "pinned-set", PINNED_CLEAR_KIND = "pinned-clear", SETTING_SET_KIND = "setting-set", SETTING_UNSET_KIND = "setting-unset", DEVICE_RETIRE_KIND = "device-retire", STATE_DIGEST_KIND = "state-digest", FOLD_RECORD_KINDS, EVIDENCE_RESULTS, PREFERENCE_COUNTER_FIELDS, SETTING_VIEW_LANGUAGE = "view.language", SETTING_TOPIC_MIN_RECORDS = "topics.new_min_records", SETTING_TOPIC_MIN_SESSIONS = "topics.new_min_sessions", SETTING_KEYS, STATE_DIGEST_FOLDS, DAY_MS, STORE_DUAL_WRITE_CONFIG_KEY = "store_dual_write", STORE_DUAL_WRITE_ENV = "OPEN_SECOND_BRAIN_STORE_DUAL_WRITE", SIGNAL_KIND = "signal", LOG_EVENT_KIND = "log-event", LEDGER_ROW_KIND = "ledger-row", DUAL_WRITE_RECORD_KINDS, DUAL_WRITE_STATUS_FILE = "dual-write.json", STORE_TMP_DIR = "tmp", BLOB_TEMP_PREFIX = ".tmp-";
var init_constants = __esm(() => {
  STORE_PARTITIONS = Object.freeze(["shared", "private"]);
  STORE_STREAMS = Object.freeze([
    "events",
    "log",
    "ledgers",
    "topics",
    "settings",
    "digests"
  ]);
  ENVELOPE_FIELDS = Object.freeze([
    "v",
    "id",
    "hlc",
    "device",
    "agent",
    "kind",
    "scope",
    "topic",
    "sum",
    "body"
  ]);
  STORE_RECORD_KINDS = Object.freeze([COMPACTED_KIND]);
  STORE_LINE_CAP_BYTES = 16 * 1024;
  STORE_BLOB_MAX_BYTES = 64 * 1024 * 1024;
  AUTHORITIES = Object.freeze(["human", "agent", "model"]);
  FOLD_RECORD_KINDS = Object.freeze([
    PREFERENCE_SET_KIND,
    PREFERENCE_REMOVE_KIND,
    PREFERENCE_EVIDENCE_KIND,
    PINNED_SET_KIND,
    PINNED_CLEAR_KIND,
    SETTING_SET_KIND,
    SETTING_UNSET_KIND,
    DEVICE_RETIRE_KIND,
    STATE_DIGEST_KIND
  ]);
  EVIDENCE_RESULTS = Object.freeze(["applied", "violated", "outdated"]);
  PREFERENCE_COUNTER_FIELDS = Object.freeze([
    "applied_count",
    "violated_count",
    "outdated_count"
  ]);
  SETTING_KEYS = Object.freeze([
    SETTING_VIEW_LANGUAGE,
    SETTING_TOPIC_MIN_RECORDS,
    SETTING_TOPIC_MIN_SESSIONS
  ]);
  STATE_DIGEST_FOLDS = Object.freeze(["preferences", "pinned", "settings"]);
  DAY_MS = 24 * 60 * 60 * 1000;
  DUAL_WRITE_RECORD_KINDS = Object.freeze([
    SIGNAL_KIND,
    LOG_EVENT_KIND,
    LEDGER_ROW_KIND
  ]);
});

// src/core/config.ts
var exports_config = {};
__export(exports_config, {
  ANSWER_QUOTE_CHECK_MODES: () => ANSWER_QUOTE_CHECK_MODES,
  ANSWER_QUOTE_CHECK_PHASES: () => ANSWER_QUOTE_CHECK_PHASES,
  ConfigReadError: () => ConfigReadError,
  DECISION_RECALL_MAX_PER_SESSION_CONFIG_KEY: () => DECISION_RECALL_MAX_PER_SESSION_CONFIG_KEY,
  DECISION_RECALL_MAX_PER_SESSION_ENV_KEY: () => DECISION_RECALL_MAX_PER_SESSION_ENV_KEY,
  DECISION_RECALL_MIN_SPACING_TURNS_CONFIG_KEY: () => DECISION_RECALL_MIN_SPACING_TURNS_CONFIG_KEY,
  DECISION_RECALL_MIN_SPACING_TURNS_ENV_KEY: () => DECISION_RECALL_MIN_SPACING_TURNS_ENV_KEY,
  DEVICE_ID_ENV: () => DEVICE_ID_ENV,
  DEVICE_ID_RE: () => DEVICE_ID_RE,
  INSTALLATION_SECRET_CONFIG_KEY: () => INSTALLATION_SECRET_CONFIG_KEY,
  INSTALLATION_SECRET_ENV_KEY: () => INSTALLATION_SECRET_ENV_KEY,
  INSTALLATION_SECRET_RE: () => INSTALLATION_SECRET_RE,
  LESSONS_PROMOTION_SCOPES_ENV_KEY: () => LESSONS_PROMOTION_SCOPES_ENV_KEY,
  MAINTENANCE_CUSTOM_TASKS_CONFIG_KEY: () => MAINTENANCE_CUSTOM_TASKS_CONFIG_KEY,
  MAINTENANCE_CUSTOM_TASKS_ENV: () => MAINTENANCE_CUSTOM_TASKS_ENV,
  MAINTENANCE_EMBEDDINGS_CONFIG_KEY: () => MAINTENANCE_EMBEDDINGS_CONFIG_KEY,
  MAINTENANCE_EMBEDDINGS_ENV: () => MAINTENANCE_EMBEDDINGS_ENV,
  MODEL_CONTEXT_WINDOW_ENV_KEY: () => MODEL_CONTEXT_WINDOW_ENV_KEY,
  PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY: () => PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY,
  PARTNER_CODEGRAPH_DISABLED_ENV: () => PARTNER_CODEGRAPH_DISABLED_ENV,
  REGROUND_PART_CHARS_DEFAULT: () => REGROUND_PART_CHARS_DEFAULT,
  SESSION_CAPTURE_ROLES: () => SESSION_CAPTURE_ROLES,
  SKILL_REWRITE_JUDGE_CMD_CONFIG_KEY: () => SKILL_REWRITE_JUDGE_CMD_CONFIG_KEY,
  SKILL_REWRITE_JUDGE_CMD_ENV_KEY: () => SKILL_REWRITE_JUDGE_CMD_ENV_KEY,
  SKILL_REWRITE_MODE_CONFIG_KEY: () => SKILL_REWRITE_MODE_CONFIG_KEY,
  SKILL_REWRITE_MODE_ENV_KEY: () => SKILL_REWRITE_MODE_ENV_KEY,
  UNCONFIGURED_AGENT_NAME: () => UNCONFIGURED_AGENT_NAME,
  UnsupportedPlatformError: () => UnsupportedPlatformError,
  VAULT_STORE_REF_PREFIX: () => VAULT_STORE_REF_PREFIX,
  configuredVaultKey: () => configuredVaultKey,
  defaultConfigPath: () => defaultConfigPath,
  discoverConfig: () => discoverConfig,
  installNamedSecretResolver: () => installNamedSecretResolver,
  isAnswerQuoteCheckMode: () => isAnswerQuoteCheckMode,
  isConfiguredAgentName: () => isConfiguredAgentName,
  isUsableLocalDeviceId: () => isUsableLocalDeviceId,
  isValidDeviceId: () => isValidDeviceId,
  isValidInstallationSecret: () => isValidInstallationSecret,
  isWindowsReservedDeviceId: () => isWindowsReservedDeviceId,
  parseSimpleYaml: () => parseSimpleYaml,
  readDeviceId: () => readDeviceId,
  resolveAgentName: () => resolveAgentName,
  resolveAnswerQuoteCheckActive: () => resolveAnswerQuoteCheckActive,
  resolveAnswerQuoteCheckRecall: () => resolveAnswerQuoteCheckRecall,
  resolveAnswerQuoteCheckSubagent: () => resolveAnswerQuoteCheckSubagent,
  resolveBacklogNudgeEnabled: () => resolveBacklogNudgeEnabled,
  resolveBenchJudgeCmd: () => resolveBenchJudgeCmd,
  resolveContextPackOutcomeEnabled: () => resolveContextPackOutcomeEnabled,
  resolveCounterpartyBriefEnabled: () => resolveCounterpartyBriefEnabled,
  resolveCounterpartyBriefTriggers: () => resolveCounterpartyBriefTriggers,
  resolveDecisionRecallMaxPerSession: () => resolveDecisionRecallMaxPerSession,
  resolveDecisionRecallMinSpacingTurns: () => resolveDecisionRecallMinSpacingTurns,
  resolveDefaultConfigPath: () => resolveDefaultConfigPath,
  resolveDensityRankingContextPack: () => resolveDensityRankingContextPack,
  resolveDeviceId: () => resolveDeviceId,
  resolveEntityFactsContextPack: () => resolveEntityFactsContextPack,
  resolveExposeHostPaths: () => resolveExposeHostPaths,
  resolveGapLoopEnabled: () => resolveGapLoopEnabled,
  resolveGapLoopThreshold: () => resolveGapLoopThreshold,
  resolveGenerationTraceEnabled: () => resolveGenerationTraceEnabled,
  resolveHookStrictEnabled: () => resolveHookStrictEnabled,
  resolveHostSettingsBackupEnabled: () => resolveHostSettingsBackupEnabled,
  resolveHygieneDigestEnabled: () => resolveHygieneDigestEnabled,
  resolveInstallationSecret: () => resolveInstallationSecret,
  resolveLinkOutputFormat: () => resolveLinkOutputFormat,
  resolveLogCatchupEnabled: () => resolveLogCatchupEnabled,
  resolveMaintenanceCustomTasksSwitch: () => resolveMaintenanceCustomTasksSwitch,
  resolveMaintenanceEmbeddings: () => resolveMaintenanceEmbeddings,
  resolveMcpRouteMetricsEnabled: () => resolveMcpRouteMetricsEnabled,
  resolveMcpToolProfile: () => resolveMcpToolProfile,
  resolveModelContextWindowEnvTokens: () => resolveModelContextWindowEnvTokens,
  resolveNavTierCadenceMinutes: () => resolveNavTierCadenceMinutes,
  resolveNavTierEnabled: () => resolveNavTierEnabled,
  resolveNearDuplicateRetireSiblingsEnabled: () => resolveNearDuplicateRetireSiblingsEnabled,
  resolveNearDuplicateWriteWideningEnabled: () => resolveNearDuplicateWriteWideningEnabled,
  resolvePartnerCodegraphDisabled: () => resolvePartnerCodegraphDisabled,
  resolvePostCompactSurvivalAudit: () => resolvePostCompactSurvivalAudit,
  resolveRecallAdequacyThresholds: () => resolveRecallAdequacyThresholds,
  resolveRecallGateTelemetry: () => resolveRecallGateTelemetry,
  resolveRecallInjectCaps: () => resolveRecallInjectCaps,
  resolveRecallInjectDedupe: () => resolveRecallInjectDedupe,
  resolveRecallInjectEnabled: () => resolveRecallInjectEnabled,
  resolveRecentTurnsResurface: () => resolveRecentTurnsResurface,
  resolveRegroundPartChars: () => resolveRegroundPartChars,
  resolveRegroundPartsEnabled: () => resolveRegroundPartsEnabled,
  resolveSearchFocusContextPack: () => resolveSearchFocusContextPack,
  resolveSessionCaptureRoles: () => resolveSessionCaptureRoles,
  resolveSessionHandoff: () => resolveSessionHandoff,
  resolveSharedNamespace: () => resolveSharedNamespace,
  resolveSkillAutoAttach: () => resolveSkillAutoAttach,
  resolveSkillRewriteJudgeCmd: () => resolveSkillRewriteJudgeCmd,
  resolveSkillRewriteModeConfig: () => resolveSkillRewriteModeConfig,
  resolveSkillsAttachTriggers: () => resolveSkillsAttachTriggers,
  resolveSkillsAttachUsageOrdering: () => resolveSkillsAttachUsageOrdering,
  resolveSkillsDir: () => resolveSkillsDir,
  resolveStoreDualWrite: () => resolveStoreDualWrite,
  resolveTailTrimContextPack: () => resolveTailTrimContextPack,
  resolveTelegramBotToken: () => resolveTelegramBotToken,
  resolveTelegramCaptureAllowlist: () => resolveTelegramCaptureAllowlist,
  resolveTimezone: () => resolveTimezone,
  resolveTokenImpactLedgerEnabled: () => resolveTokenImpactLedgerEnabled,
  resolveTriggerCooldownDays: () => resolveTriggerCooldownDays,
  resolveVault: () => resolveVault,
  resolveWikiLinkFormat: () => resolveWikiLinkFormat,
  setConfigValue: () => setConfigValue,
  validateTimezoneName: () => validateTimezoneName,
  vaultStoreReference: () => vaultStoreReference
});
import { mkdirSync as mkdirSync4, readFileSync as readFileSync4, statSync as statSync3 } from "node:fs";
import { createHmac, randomBytes } from "node:crypto";
import { homedir as homedir2 } from "node:os";
import { dirname as dirname4, isAbsolute, join as join5, resolve as resolve3 } from "node:path";
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
    return join5(expandTilde(xdg, source.platform, source.home), APP_DIR_NAME, "config.yaml");
  if (UNSUPPORTED_CONFIG_PLATFORMS.includes(source.platform)) {
    throw new UnsupportedPlatformError(source.platform);
  }
  return join5(configBaseDir(source), APP_DIR_NAME, "config.yaml");
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
    return statSync3(resolved, { throwIfNoEntry: false });
  } catch (err) {
    throw new ConfigReadError(resolved, err.message ?? String(err));
  }
}
function readConfigText(resolved) {
  let bytes;
  try {
    bytes = readFileSync4(resolved);
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
function validateTimezoneName(name) {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: name });
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
function resolveVault(configPath, opts = {}) {
  const env = process.env["VAULT_DIR"];
  if (env)
    return expandTilde(env);
  const pointerVault = resolvePointerVault(opts.cwd ?? process.cwd());
  if (pointerVault !== null)
    return expandTilde(pointerVault);
  const discovery = discoverConfig(configPath);
  const profileVault = resolveActiveProfileVault(discovery.path);
  if (profileVault)
    return expandTilde(profileVault);
  const cfg = discovery.data["vault"];
  if (cfg)
    return expandTilde(cfg);
  return null;
}
function configuredVaultKey(configPath) {
  const value = discoverConfig(configPath).data["vault"];
  return value ? expandTilde(value) : null;
}
function isConfiguredAgentName(name) {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed !== UNCONFIGURED_AGENT_NAME;
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
function resolveSharedNamespace(configPath) {
  const discovery = discoverConfig(configPath ?? undefined);
  const value = discovery.data[SHARED_NAMESPACE_KEY]?.trim();
  return value ? value : null;
}
function isValidDeviceId(value) {
  return DEVICE_ID_RE.test(value) && !value.startsWith("sync-conflict");
}
function isWindowsReservedDeviceId(value) {
  return WINDOWS_RESERVED_DEVICE_NAME_RE.test(value);
}
function isUsableLocalDeviceId(value, platform = process.platform) {
  return isValidDeviceId(value) && !(platform === "win32" && isWindowsReservedDeviceId(value));
}
function readDeviceId(configPath) {
  const env = process.env[DEVICE_ID_ENV];
  if (env === "")
    return null;
  if (env !== undefined && isUsableLocalDeviceId(env))
    return env;
  const value = discoverConfig(configPath ?? defaultConfigPath()).data["device_id"];
  return value !== undefined && isUsableLocalDeviceId(value) ? value : null;
}
function resolveDeviceId(configPath) {
  const env = process.env[DEVICE_ID_ENV];
  if (env !== undefined && (env === "" || isUsableLocalDeviceId(env)))
    return env;
  const resolved = configPath ?? defaultConfigPath();
  const read = () => {
    const value = discoverConfig(resolved).data["device_id"];
    return value && isUsableLocalDeviceId(value) ? value : null;
  };
  const existing = read();
  if (existing !== null)
    return existing;
  const dir = dirname4(resolved);
  mkdirSync4(dir, { recursive: true });
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
  const dir = dirname4(resolved);
  mkdirSync4(dir, { recursive: true });
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
  const digest = createHmac("sha256", key).update(resolve3(vaultPath)).digest("hex").slice(0, VAULT_STORE_REF_HEX_LEN);
  return `${VAULT_STORE_REF_PREFIX}${digest}`;
}
function resolveLinkOutputFormat(configPath) {
  const env = process.env["OBSIDIAN_LINK_FORMAT"]?.trim();
  const data = env ? {} : discoverConfig(configPath).data;
  const raw = env || data["link_output_format"] || data["linkOutputFormat"];
  return raw === "markdown" ? "markdown" : "wikilink";
}
function resolveMcpToolProfile(configPath) {
  const env = process.env["OPEN_SECOND_BRAIN_MCP_TOOL_PROFILE"]?.trim();
  if (env)
    return env;
  const raw = discoverConfig(configPath).data["mcp_tool_profile"]?.trim();
  return raw ? raw : null;
}
function resolveSkillsDir(configPath) {
  const discovery = discoverConfig(configPath);
  const env = process.env["OPEN_SECOND_BRAIN_SKILLS_DIR"]?.trim();
  const raw = env || discovery.data["skills_dir"]?.trim();
  if (!raw || raw.length === 0)
    return null;
  const expanded = expandTilde(raw);
  return isAbsolute(expanded) ? expanded : resolve3(dirname4(discovery.path), expanded);
}
function readSetting(envKey, configKey, data) {
  const env = process.env[envKey]?.trim();
  if (env)
    return env;
  const raw = (typeof data === "function" ? data() : data)[configKey]?.trim();
  return raw ? raw : undefined;
}
function rejectedSettingName(envKey, configKey) {
  return process.env[envKey]?.trim() ? envKey : configKey;
}
function resolveConfigFlag(envKey, configKey, configPath) {
  return isFlagOn(readSetting(envKey, configKey, () => discoverConfig(configPath).data));
}
function isFlagOn(raw) {
  return raw === "true" || raw === "1";
}
function resolveSkillsAttachTriggers(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_SKILLS_ATTACH_TRIGGERS", "skills_attach_triggers", configPath);
}
function resolveSkillAutoAttach(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_SKILL_AUTO_ATTACH", "skill_auto_attach", configPath);
}
function resolveSkillsAttachUsageOrdering(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_SKILLS_ATTACH_USAGE_ORDERING", "skills_attach_usage_ordering", configPath);
}
function resolveSearchFocusContextPack(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_SEARCH_FOCUS_CONTEXT_PACK", "search_focus_context_pack", configPath);
}
function resolveDensityRankingContextPack(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_DENSITY_RANKING_CONTEXT_PACK", "density_ranking_context_pack", configPath);
}
function resolveEntityFactsContextPack(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_ENTITY_FACTS_CONTEXT_PACK", "entity_facts_context_pack", configPath);
}
function resolveTailTrimContextPack(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_TAIL_TRIM_CONTEXT_PACK", "tail_trim_context_pack", configPath);
}
function resolveCounterpartyBriefEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_COUNTERPARTY_BRIEF_ENABLED", "counterparty_brief_enabled", configPath);
}
function resolveCounterpartyBriefTriggers(configPath) {
  const raw = discoverConfig(configPath).data["counterparty_brief_triggers"]?.trim();
  if (raw === undefined || raw === "")
    return [];
  if (raw.startsWith("[") && raw.endsWith("]"))
    return [];
  const tokens = [];
  for (const part of raw.split(",")) {
    const token = part.normalize("NFC").trim();
    if (token.length > 0)
      tokens.push(token);
  }
  return tokens;
}
function resolvePostCompactSurvivalAudit(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_POST_COMPACT_SURVIVAL_AUDIT", "post_compact_survival_audit", configPath);
}
function resolveRecentTurnsResurface(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_RECENT_TURNS_RESURFACE", "recent_turns_resurface", configPath);
}
function resolveNearDuplicateRetireSiblingsEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_NEAR_DUPLICATE_RETIRE_SIBLINGS_ENABLED", "near_duplicate_retire_siblings_enabled", configPath);
}
function resolveNearDuplicateWriteWideningEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_NEAR_DUPLICATE_WRITE_WIDENING_ENABLED", "near_duplicate_write_widening_enabled", configPath);
}
function resolveStoreDualWrite(configPath) {
  return resolveConfigFlag(STORE_DUAL_WRITE_ENV, STORE_DUAL_WRITE_CONFIG_KEY, configPath);
}
function resolveSessionHandoff(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_SESSION_HANDOFF", "session_handoff", configPath);
}
function resolveConfigNonNegativeInt(envKey, configKey, configPath) {
  const env = process.env[envKey]?.trim();
  const raw = env || discoverConfig(configPath).data[configKey]?.trim();
  if (!raw || raw.length === 0)
    return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0)
    return null;
  return n;
}
function resolveDecisionRecallMaxPerSession(configPath) {
  return resolveConfigNonNegativeInt(DECISION_RECALL_MAX_PER_SESSION_ENV_KEY, DECISION_RECALL_MAX_PER_SESSION_CONFIG_KEY, configPath);
}
function resolveDecisionRecallMinSpacingTurns(configPath) {
  return resolveConfigNonNegativeInt(DECISION_RECALL_MIN_SPACING_TURNS_ENV_KEY, DECISION_RECALL_MIN_SPACING_TURNS_CONFIG_KEY, configPath);
}
function resolveWikiLinkFormat(configPath) {
  const env = process.env["OPEN_SECOND_BRAIN_WIKI_LINK_FORMAT"]?.trim();
  const raw = env || discoverConfig(configPath).data["wiki_link_format"]?.trim();
  if (raw === undefined || raw === "")
    return "preserve";
  if (!isWikiLinkFormat(raw)) {
    throw new Error(`wiki_link_format must be one of ${WIKI_LINK_FORMATS.join(", ")}; got '${raw}'`);
  }
  return raw;
}
function resolveTriggerCooldownDays(configPath) {
  const env = process.env["OPEN_SECOND_BRAIN_TRIGGER_COOLDOWN_DAYS"]?.trim();
  const raw = env || discoverConfig(configPath).data["trigger_cooldown_days"]?.trim();
  if (raw === undefined || raw === "")
    return 7;
  const days = Number(raw);
  if (!Number.isInteger(days) || days < 0) {
    throw new Error(`trigger_cooldown_days must be a non-negative integer; got '${raw}'`);
  }
  return days;
}
function resolveRecallGateTelemetry(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_RECALL_GATE_TELEMETRY", "recall_gate_telemetry", configPath);
}
function resolveRecallAdequacyThresholds(configPath) {
  const data = discoverConfig(configPath).data;
  const sufficient = resolveAdequacyFloor("recall_adequacy_sufficient", process.env["OPEN_SECOND_BRAIN_RECALL_ADEQUACY_SUFFICIENT"], data["recall_adequacy_sufficient"], 0.6);
  const weak = resolveAdequacyFloor("recall_adequacy_weak", process.env["OPEN_SECOND_BRAIN_RECALL_ADEQUACY_WEAK"], data["recall_adequacy_weak"], 0.3);
  if (weak > sufficient) {
    throw new Error(`recall_adequacy_weak (${weak}) must not exceed recall_adequacy_sufficient (${sufficient})`);
  }
  const minResults = resolveAdequacyMinResults(process.env["OPEN_SECOND_BRAIN_RECALL_ADEQUACY_MIN_RESULTS"], data["recall_adequacy_min_results"]);
  return { sufficient, weak, minResults };
}
function resolveAdequacyFloor(key, env, fileValue, fallback) {
  const raw = (env?.trim() || fileValue?.trim()) ?? "";
  if (raw === "")
    return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${key} must be a number in [0,1]; got '${raw}'`);
  }
  return value;
}
function resolveAdequacyMinResults(env, fileValue) {
  const raw = (env?.trim() || fileValue?.trim()) ?? "";
  if (raw === "")
    return 1;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`recall_adequacy_min_results must be a positive integer; got '${raw}'`);
  }
  return value;
}
function resolveModelContextWindowEnvTokens() {
  const raw = process.env[MODEL_CONTEXT_WINDOW_ENV_KEY]?.trim() ?? "";
  if (raw === "")
    return;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${MODEL_CONTEXT_WINDOW_ENV_KEY} must be a positive integer; got '${raw}'`);
  }
  return value;
}
function resolveGenerationTraceEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_GENERATION_TRACE_ENABLED", "generation_trace_enabled", configPath);
}
function resolveMcpRouteMetricsEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_MCP_ROUTE_METRICS_ENABLED", "mcp_route_metrics_enabled", configPath);
}
function resolveTokenImpactLedgerEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_TOKEN_IMPACT_LEDGER_ENABLED", "token_impact_ledger_enabled", configPath);
}
function resolveContextPackOutcomeEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_CONTEXT_PACK_OUTCOME_ENABLED", "context_pack_outcome_enabled", configPath);
}
function resolveRecallInjectEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_RECALL_INJECT_ENABLED", "recall_inject_enabled", configPath);
}
function isAnswerQuoteCheckMode(value) {
  return typeof value === "string" && ANSWER_QUOTE_CHECK_MODES.includes(value);
}
function readQuoteCheckBlock(path) {
  let stat;
  try {
    const probed = statSync3(path, { throwIfNoEntry: false });
    if (probed === undefined)
      return null;
    stat = probed;
  } catch (err) {
    throw new BrainConfigError(`failed to stat: ${err.message}`, QUOTE_CHECK_BLOCK, path);
  }
  if (!stat.isFile()) {
    throw new BrainConfigError("path exists but is not a regular file; its settings are not in force and are not read as absent", QUOTE_CHECK_BLOCK, path);
  }
  let parsed;
  try {
    parsed = parseBrainYaml(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync4(path)));
  } catch (err) {
    throw new BrainConfigError(`failed to parse: ${err.message}`, QUOTE_CHECK_BLOCK, path);
  }
  const block = parsed[QUOTE_CHECK_BLOCK];
  if (block === undefined)
    return null;
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    throw new BrainConfigError(`expected a block of per-phase modes, got ${Array.isArray(block) ? "an array" : typeof block}`, QUOTE_CHECK_BLOCK, path);
  }
  return block;
}
function warnUnknownQuoteCheckKeys(path, block) {
  for (const key of Object.keys(block)) {
    if (ANSWER_QUOTE_CHECK_PHASES.includes(key))
      continue;
    const stamp = `${path}\x00${key}`;
    if (quoteCheckWarnedUnknownKeys.has(stamp))
      continue;
    quoteCheckWarnedUnknownKeys.add(stamp);
    process.stderr.write(`${QUOTE_CHECK_BLOCK}.${key}: unknown field ignored (forward-compat)
`);
  }
}
function resolveAnswerQuoteCheckPhase(phase, path) {
  if (path === null)
    return QUOTE_CHECK_DEFAULT;
  const block = readQuoteCheckBlock(path);
  if (block === null)
    return QUOTE_CHECK_DEFAULT;
  warnUnknownQuoteCheckKeys(path, block);
  const raw = block[phase];
  if (raw === undefined)
    return QUOTE_CHECK_DEFAULT;
  if (!isAnswerQuoteCheckMode(raw)) {
    throw new BrainConfigError(`unsupported value ${JSON.stringify(raw)}; expected one of ${ANSWER_QUOTE_CHECK_MODES.join(", ")}`, `${QUOTE_CHECK_BLOCK}.${phase}`, path);
  }
  return raw;
}
function defaultAnswerQuoteCheckConfigPath() {
  const vault = resolveVault();
  return vault === null ? null : join5(vault, BRAIN_ROOT_REL, BRAIN_CONFIG_FILE);
}
function resolveAnswerQuoteCheckRecall(configPath) {
  return resolveAnswerQuoteCheckPhase("recall", configPath ?? defaultAnswerQuoteCheckConfigPath());
}
function resolveAnswerQuoteCheckActive(configPath) {
  return resolveAnswerQuoteCheckPhase("active", configPath ?? defaultAnswerQuoteCheckConfigPath());
}
function resolveAnswerQuoteCheckSubagent(configPath) {
  return resolveAnswerQuoteCheckPhase("subagent", configPath ?? defaultAnswerQuoteCheckConfigPath());
}
function parseBounded(raw, min, max, integer) {
  const value = Number(raw);
  if (!Number.isFinite(value) || integer && !Number.isInteger(value))
    return;
  if (value < min || value > max)
    return;
  return value;
}
function resolveRecallInjectCaps(configPath) {
  const data = discoverConfig(configPath).data;
  const caps = {};
  const invalid = [];
  for (const spec of RECALL_INJECT_CAP_SPECS) {
    const raw = readSetting(spec.env, spec.key, data);
    if (raw === undefined)
      continue;
    const value = parseBounded(raw, spec.min, spec.max, spec.integer);
    if (value === undefined)
      invalid.push(rejectedSettingName(spec.env, spec.key));
    else
      caps[spec.field] = value;
  }
  return { caps, invalid };
}
function resolveRecallInjectDedupe(configPath) {
  const raw = readSetting("OPEN_SECOND_BRAIN_RECALL_INJECT_DEDUPE", "recall_inject_dedupe", discoverConfig(configPath).data);
  return raw !== "false" && raw !== "0";
}
function resolveRegroundPartsEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_REGROUND_PARTS_ENABLED", "reground_parts_enabled", configPath);
}
function resolveRegroundPartChars(runtime, configPath) {
  const data = discoverConfig(configPath).data;
  const levels = [
    [
      `OPEN_SECOND_BRAIN_REGROUND_PART_CHARS_${runtime.toUpperCase()}`,
      `reground_part_chars_${runtime}`
    ],
    ["OPEN_SECOND_BRAIN_REGROUND_PART_CHARS", "reground_part_chars"]
  ];
  const invalid = [];
  for (const [envKey, configKey] of levels) {
    const raw = readSetting(envKey, configKey, data);
    if (raw === undefined)
      continue;
    const value = parseBounded(raw, 2000, 1e5, true);
    if (value !== undefined)
      return { chars: value, invalid };
    invalid.push(rejectedSettingName(envKey, configKey));
  }
  return { chars: REGROUND_PART_CHARS_DEFAULT, invalid };
}
function resolveHygieneDigestEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_HYGIENE_DIGEST_ENABLED", "hygiene_digest_enabled", configPath);
}
function resolveNavTierEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_NAV_TIER_ENABLED", "nav_tier_enabled", configPath);
}
function resolveNavTierCadenceMinutes(configPath) {
  const env = process.env["OPEN_SECOND_BRAIN_NAV_TIER_CADENCE_MINUTES"]?.trim();
  const raw = env || discoverConfig(configPath).data["nav_tier_cadence_minutes"]?.trim();
  if (!raw)
    return;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    return;
  return value;
}
function resolveHookStrictEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_HOOK_STRICT_ENABLED", "hook_strict_enabled", configPath);
}
function resolveHostSettingsBackupEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_HOST_SETTINGS_BACKUP", "host_settings_backup", configPath);
}
function resolveMaintenanceEmbeddings(configPath) {
  return resolveConfigFlag(MAINTENANCE_EMBEDDINGS_ENV, MAINTENANCE_EMBEDDINGS_CONFIG_KEY, configPath);
}
function resolveMaintenanceCustomTasksSwitch(configPath, data = discoverConfig(configPath).data) {
  const env = process.env[MAINTENANCE_CUSTOM_TASKS_ENV]?.trim();
  const fromConfig = data[MAINTENANCE_CUSTOM_TASKS_CONFIG_KEY]?.trim();
  return {
    enabled: isFlagOn(env || fromConfig),
    source: env ? "env" : fromConfig ? "config" : "unset"
  };
}
function resolvePartnerCodegraphDisabled(configPath) {
  return resolveConfigFlag(PARTNER_CODEGRAPH_DISABLED_ENV, PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY, configPath);
}
function resolveGapLoopEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_GAP_LOOP_ENABLED", "gap_loop_enabled", configPath);
}
function resolveBacklogNudgeEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_BACKLOG_NUDGE_ENABLED", "backlog_nudge_enabled", configPath);
}
function resolveLogCatchupEnabled(configPath) {
  return resolveConfigFlag("OPEN_SECOND_BRAIN_LOG_CATCHUP_ENABLED", "log_catchup_enabled", configPath);
}
function resolveGapLoopThreshold(configPath) {
  const env = process.env["OPEN_SECOND_BRAIN_GAP_LOOP_THRESHOLD"]?.trim();
  const raw = env || discoverConfig(configPath).data["gap_loop_threshold"]?.trim();
  if (!raw)
    return;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1)
    return;
  return value;
}
function resolveBenchJudgeCmd(configPath) {
  const env = process.env["OPEN_SECOND_BRAIN_BENCH_JUDGE_CMD"]?.trim();
  const raw = env || discoverConfig(configPath).data["bench_judge_cmd"]?.trim();
  return raw !== undefined && raw !== "" ? raw : undefined;
}
function isSessionCaptureRole(value) {
  return SESSION_CAPTURE_ROLES.includes(value);
}
function resolveSessionCaptureRoles(configPath) {
  const env = process.env["OPEN_SECOND_BRAIN_SESSION_CAPTURE_ROLES"]?.trim();
  const raw = env || discoverConfig(configPath).data["session_capture_roles"]?.trim();
  if (!raw)
    return null;
  const roles = [];
  for (const part of raw.split(",")) {
    const role = part.trim().toLowerCase();
    if (role.length === 0)
      continue;
    if (!isSessionCaptureRole(role)) {
      throw new Error(`session_capture_roles: unknown role "${role}" (expected a subset of ${SESSION_CAPTURE_ROLES.join(", ")})`);
    }
    if (!roles.includes(role))
      roles.push(role);
  }
  return roles.length > 0 ? roles : null;
}
function resolveTelegramBotToken(configPath, secretsVault) {
  const env = process.env["TELEGRAM_BOT_TOKEN"]?.trim();
  const raw = env || discoverConfig(configPath).data["telegram_bot_token"]?.trim();
  if (raw === undefined || raw.length === 0)
    return null;
  if (secretsVault !== undefined && isSecretReferenceValue(raw)) {
    return resolveThroughNamedSecretResolver(secretsVault, raw);
  }
  return raw;
}
function resolveTelegramCaptureAllowlist(configPath) {
  const env = process.env["TELEGRAM_CHAT_ALLOWLIST"]?.trim();
  const raw = env || discoverConfig(configPath).data["telegram_chat_allowlist"]?.trim();
  if (!raw)
    return [];
  const ids = [];
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (id.length > 0 && !ids.includes(id))
      ids.push(id);
  }
  return ids;
}
function resolveSkillRewriteModeConfig(configPath) {
  const env = process.env[SKILL_REWRITE_MODE_ENV_KEY]?.trim();
  const raw = env || discoverConfig(configPath).data[SKILL_REWRITE_MODE_CONFIG_KEY]?.trim();
  return resolveSkillRewriteMode(raw);
}
function resolveSkillRewriteJudgeCmd(configPath) {
  const env = process.env[SKILL_REWRITE_JUDGE_CMD_ENV_KEY]?.trim();
  const raw = env || discoverConfig(configPath).data[SKILL_REWRITE_JUDGE_CMD_CONFIG_KEY]?.trim();
  return raw !== undefined && raw !== "" ? raw : undefined;
}
function expandTilde(p, platform = process.platform, home = homedir2()) {
  if (p === "~")
    return home;
  if (p.startsWith("~/"))
    return join5(home, p.slice(2));
  if (platform === "win32" && p.startsWith("~\\"))
    return join5(home, p.slice(2));
  return p;
}
var import_proper_lockfile2, namedSecretResolver, CONFIG_VALUE_REJECTED_CHARS, UNSUPPORTED_CONFIG_PLATFORMS, UnsupportedPlatformError, ConfigReadError, UNCONFIGURED_AGENT_NAME = "agent", SHARED_NAMESPACE_KEY = "shared_namespace", DEVICE_ID_RE, WINDOWS_RESERVED_DEVICE_NAME_RE, DEVICE_ID_ENV = "O2B_DEVICE_ID", INSTALLATION_SECRET_CONFIG_KEY = "installation_secret", INSTALLATION_SECRET_ENV_KEY = "O2B_INSTALLATION_SECRET", INSTALLATION_SECRET_RE, VAULT_STORE_REF_PREFIX = "vault://", VAULT_STORE_REF_HEX_LEN = 32, DECISION_RECALL_MAX_PER_SESSION_CONFIG_KEY = "decision_recall.max_per_session", DECISION_RECALL_MAX_PER_SESSION_ENV_KEY = "OPEN_SECOND_BRAIN_DECISION_RECALL_MAX_PER_SESSION", DECISION_RECALL_MIN_SPACING_TURNS_CONFIG_KEY = "decision_recall.min_spacing_turns", DECISION_RECALL_MIN_SPACING_TURNS_ENV_KEY = "OPEN_SECOND_BRAIN_DECISION_RECALL_MIN_SPACING_TURNS", LESSONS_PROMOTION_SCOPES_ENV_KEY = "OPEN_SECOND_BRAIN_LESSONS_PROMOTION_SCOPES", MODEL_CONTEXT_WINDOW_ENV_KEY = "OPEN_SECOND_BRAIN_MODEL_CONTEXT_WINDOW", ANSWER_QUOTE_CHECK_MODES, QUOTE_CHECK_BLOCK = "quote_check", ANSWER_QUOTE_CHECK_PHASES, QUOTE_CHECK_DEFAULT = "shadow", quoteCheckWarnedUnknownKeys, RECALL_INJECT_CAP_SPECS, REGROUND_PART_CHARS_DEFAULT = 9000, MAINTENANCE_EMBEDDINGS_ENV = "OPEN_SECOND_BRAIN_MAINTENANCE_EMBEDDINGS", MAINTENANCE_EMBEDDINGS_CONFIG_KEY = "maintenance_embeddings", MAINTENANCE_CUSTOM_TASKS_ENV = "OPEN_SECOND_BRAIN_MAINTENANCE_CUSTOM_TASKS", MAINTENANCE_CUSTOM_TASKS_CONFIG_KEY = "maintenance_custom_tasks", PARTNER_CODEGRAPH_DISABLED_ENV = "OPEN_SECOND_BRAIN_PARTNER_CODEGRAPH_DISABLED", PARTNER_CODEGRAPH_DISABLED_CONFIG_KEY = "partner_codegraph_disabled", SESSION_CAPTURE_ROLES, SKILL_REWRITE_MODE_CONFIG_KEY = "skill_rewrite.mode", SKILL_REWRITE_MODE_ENV_KEY = "OPEN_SECOND_BRAIN_SKILL_REWRITE_MODE", SKILL_REWRITE_JUDGE_CMD_CONFIG_KEY = "skill_rewrite_judge_cmd", SKILL_REWRITE_JUDGE_CMD_ENV_KEY = "OPEN_SECOND_BRAIN_SKILL_REWRITE_JUDGE_CMD";
var init_config = __esm(() => {
  init_fs_atomic();
  init_secret_ref();
  init_platform_dirs();
  init_profiles();
  init_pointer();
  init_errors();
  init_path_constants();
  init_skill_rewrite();
  init_format_wikilink();
  init_constants();
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
  WINDOWS_RESERVED_DEVICE_NAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/;
  INSTALLATION_SECRET_RE = /^[0-9a-f]{32}$/;
  ANSWER_QUOTE_CHECK_MODES = Object.freeze(["off", "shadow", "enforce"]);
  ANSWER_QUOTE_CHECK_PHASES = Object.freeze(["recall", "active", "subagent"]);
  quoteCheckWarnedUnknownKeys = new Set;
  RECALL_INJECT_CAP_SPECS = [
    {
      field: "maxNotes",
      env: "OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_NOTES",
      key: "recall_inject_max_notes",
      min: 1,
      max: 10,
      integer: true
    },
    {
      field: "maxChars",
      env: "OPEN_SECOND_BRAIN_RECALL_INJECT_MAX_CHARS",
      key: "recall_inject_max_chars",
      min: 200,
      max: 8000,
      integer: true
    },
    {
      field: "timeBudgetMs",
      env: "OPEN_SECOND_BRAIN_RECALL_INJECT_TIME_BUDGET_MS",
      key: "recall_inject_time_budget_ms",
      min: 250,
      max: 6000,
      integer: true
    },
    {
      field: "confidenceFloor",
      env: "OPEN_SECOND_BRAIN_RECALL_INJECT_CONFIDENCE_FLOOR",
      key: "recall_inject_confidence_floor",
      min: 0,
      max: 1,
      integer: false
    }
  ];
  SESSION_CAPTURE_ROLES = ["user", "assistant", "system", "tool", "meta"];
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
function privateRegionTexts(text) {
  if (!text)
    return [];
  return privateRegionSpans(text).map((span) => text.slice(span.start, span.end));
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
  out = out.replace(ENV_RE, (_match, key, sep2) => {
    return `${key}${sep2}${PLACEHOLDER}`;
  });
  out = out.replace(BEARER_RE, (_match, prefix) => `${prefix}${PLACEHOLDER}`);
  out = out.replace(JWT_RE, PLACEHOLDER);
  out = out.replace(YAML_SECRET_BLOCK_RE, (_match, indent, key) => `${indent}${key}: "${PLACEHOLDER}"
`);
  out = out.replace(COLON_VALUE_RE, (match, key, sep2, value) => {
    if (value.includes(PLACEHOLDER))
      return match;
    if (value.startsWith('"') && value.endsWith('"')) {
      return `${key}${sep2}"${PLACEHOLDER}"`;
    }
    if (value.startsWith("'") && value.endsWith("'")) {
      return `${key}${sep2}'${PLACEHOLDER}'`;
    }
    return `${key}${sep2}"${PLACEHOLDER}"`;
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

// src/core/path-safety.ts
import { existsSync as existsSync4, realpathSync, statSync as statSync4 } from "node:fs";
import {
  basename as basename3,
  dirname as dirname5,
  join as join6,
  posix as pathPosix,
  relative,
  resolve as resolve4,
  sep as sep2,
  win32 as pathWin32
} from "node:path";
function ensureInsideVault(target, vault) {
  const resolvedTarget = resolve4(target);
  const resolvedVault = resolve4(vault);
  if (!isLexicallyInsideHost(resolvedTarget, resolvedVault)) {
    throw new VaultEscapeError(`path escapes vault: ${target}`);
  }
  if (existsSync4(resolvedVault) && !realpathInsideVault(resolvedTarget, resolvedVault)) {
    throw new VaultEscapeError(`path escapes vault via symlink: ${target}`);
  }
  return resolvedTarget;
}
function realpathInsideVault(target, vault) {
  const resolvedVault = resolve4(vault);
  if (!existsSync4(resolvedVault))
    return true;
  const realVault = safeRealpath(resolvedVault);
  const realAncestor = safeRealpath(deepestExistingAncestor(resolve4(target)));
  return isLexicallyInsideHost(realAncestor, realVault);
}
function pathIsInside(target, root) {
  return pathIsInsideOn(hostPlatform(), target, root);
}
function pathIsInsideOn(platform, target, root) {
  const pathImpl = platform === "win32" ? pathWin32 : pathPosix;
  return isLexicallyInside(platform, pathImpl.resolve(target), pathImpl.resolve(root));
}
function isLexicallyInside(platform, target, root) {
  const fold = platform === "win32";
  const sepChar = fold ? pathWin32.sep : pathPosix.sep;
  const t = fold ? target.toLowerCase() : target;
  const r = fold ? root.toLowerCase() : root;
  return t === r || t.startsWith(r + sepChar);
}
function hostPlatform() {
  return process.platform === "win32" ? "win32" : "posix";
}
function isLexicallyInsideHost(target, root) {
  return isLexicallyInside(hostPlatform(), target, root);
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
function posixRel(p) {
  return sep2 === "/" ? p : p.replaceAll("\\", "/");
}
function vaultRelative(target, vault) {
  const rel = relative(resolve4(vault), resolve4(target));
  return rel.split(/[\\/]/).filter((p) => p.length > 0).join(pathPosix.sep);
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

// src/core/store-migration/device-state-layout.ts
var MIGRATION_LOCAL_DIR = "local", MIGRATION_BACKUP_DIR = "backup", MIGRATION_BACKUP_FILES_DIR = "files";

// src/core/store/compare.ts
function compareCodeUnits(a, b) {
  if (a === b)
    return 0;
  return a < b ? -1 : 1;
}

// src/core/store/hlc.ts
function formatHlc(clock) {
  return `${clock.physical}.${clock.counter}`;
}
function parseHlc(text) {
  const match = HLC_RE.exec(text);
  if (match === null)
    return null;
  const physical = Number(match[1]);
  const counter = Number(match[2]);
  if (!Number.isSafeInteger(physical) || !Number.isSafeInteger(counter))
    return null;
  return { physical, counter };
}
function compareHlc(a, b) {
  if (a.physical !== b.physical)
    return a.physical < b.physical ? -1 : 1;
  if (a.counter !== b.counter)
    return a.counter < b.counter ? -1 : 1;
  return 0;
}
function maxHlc(a, b) {
  return compareHlc(a, b) >= 0 ? a : b;
}
function sendHlc(local, wallMs) {
  const wall = Math.max(0, Math.floor(wallMs));
  if (wall > local.physical)
    return { physical: wall, counter: 0 };
  return { physical: local.physical, counter: local.counter + 1 };
}
function receiveHlc(local, remote, wallMs) {
  const wall = Math.max(0, Math.floor(wallMs));
  const adoptable = remote.physical - wall <= HLC_MAX_DRIFT_MS;
  const known = adoptable ? maxHlc(local, remote) : local;
  if (wall > known.physical)
    return { physical: wall, counter: 0 };
  return known;
}
var HLC_MAX_DRIFT_MS, HLC_ZERO, HLC_RE;
var init_hlc = __esm(() => {
  HLC_MAX_DRIFT_MS = 24 * 60 * 60 * 1000;
  HLC_ZERO = Object.freeze({ physical: 0, counter: 0 });
  HLC_RE = /^(0|[1-9]\d{0,15})\.(0|[1-9]\d{0,9})$/;
});

// src/core/store/clock-floor.ts
import { resolve as resolve5 } from "node:path";
function noteObservedClock(storeRoot, clock) {
  const key = resolve5(storeRoot);
  const seen = floors.get(key);
  if (seen === undefined || maxHlc(seen, clock) !== seen)
    floors.set(key, clock);
}
function observedClockFloor(storeRoot) {
  return floors.get(resolve5(storeRoot)) ?? null;
}
var floors;
var init_clock_floor = __esm(() => {
  init_hlc();
  floors = new Map;
});

// src/core/brain/sync-lockfile.ts
import {
  closeSync as closeSync2,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  readFileSync as readFileSync5,
  mkdirSync as mkdirSync5,
  openSync as openSync2,
  readdirSync,
  unlinkSync as unlinkSync2,
  writeSync as writeSync2
} from "node:fs";
function isWindowsDeletePending(e, lockPath, platform = process.platform, occupied = nameIsOccupied) {
  if (platform !== "win32" || e.code !== "EPERM" && e.code !== "EACCES")
    return false;
  return occupied(lockPath);
}
function nameIsOccupied(path) {
  try {
    lstatSync(path);
    return true;
  } catch (err) {
    return err.code !== "ENOENT";
  }
}
function resolveLockWaitBudgetMs(env = process.env) {
  const raw = env[LOCK_WAIT_BUDGET_ENV];
  if (raw === undefined || raw.trim() === "")
    return LOCK_WAIT_BUDGET_MS;
  const text = raw.trim();
  const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${LOCK_WAIT_BUDGET_ENV}=${raw} is not a lock wait; set it to a whole number of ` + `milliseconds >= 0 (the default is ${LOCK_WAIT_BUDGET_MS}), or unset it`);
  }
  return parsed;
}
var heldLocks, LOCK_WAIT_BUDGET_MS = 5000, LOCK_WAIT_BUDGET_ENV = "OPEN_SECOND_BRAIN_LOCK_WAIT_MS", RETRY_SLEEP_CEILING_MS = 25, contendedReleases, HANDOFF_WINDOW_MS, AGED_WAITER_AFTER_MS, POSIX_MIN_STAMP_BYTES = 48, WIN32_MIN_STAMP_BYTES = 30, MIN_STAMP_BYTES, WAITER_MARK, MARK_OPEN_FLAGS;
var init_sync_lockfile = __esm(() => {
  init_path_constants();
  heldLocks = new Map;
  contendedReleases = new Map;
  HANDOFF_WINDOW_MS = RETRY_SLEEP_CEILING_MS * 4;
  AGED_WAITER_AFTER_MS = RETRY_SLEEP_CEILING_MS * 10;
  MIN_STAMP_BYTES = process.platform === "win32" ? WIN32_MIN_STAMP_BYTES : POSIX_MIN_STAMP_BYTES;
  WAITER_MARK = Buffer.from("w", "utf8");
  MARK_OPEN_FLAGS = fsConstants.O_RDWR | (fsConstants.O_NOFOLLOW ?? 0);
});

// src/core/store/local-lock.ts
import { mkdirSync as mkdirSync6 } from "node:fs";
import { dirname as dirname6 } from "node:path";
function isLockContention(err, lockTarget, platform = process.platform) {
  const e = err;
  return e.code === "ELOCKED" || isWindowsDeletePending(e, `${lockTarget}.lock`, platform);
}
function isWindowsRefusal(err, platform = process.platform) {
  const code = err.code;
  return platform === "win32" && (code === "EPERM" || code === "EACCES");
}
function acquireDirLock(lockTarget, options) {
  const started = Date.now();
  let refusalRetried = false;
  for (let attempt = 0;; attempt++) {
    try {
      return import_proper_lockfile3.default.lockSync(lockTarget, { stale: options.staleMs, realpath: false });
    } catch (err) {
      if (!isLockContention(err, lockTarget)) {
        if (refusalRetried || !isWindowsRefusal(err))
          throw err;
        refusalRetried = true;
        continue;
      }
      if (Date.now() - started >= options.budgetMs) {
        const refused = new Error(`${options.label} busy: ${lockTarget}: still held after waiting ` + `${Date.now() - started} ms; ${options.remedy}`, { cause: err });
        refused.code = "ELOCKED";
        refused.path = lockTarget;
        throw refused;
      }
      sleepSync(1 + Math.floor(Math.random() * Math.min(RETRY_SLEEP_MAX_MS, 2 + attempt * 2)));
    }
  }
}
function withLocalLock(lockTarget, fn, budgetMs) {
  mkdirSync6(dirname6(lockTarget), { recursive: true });
  const release = acquireDirLock(lockTarget, {
    staleMs: STORE_LOCK_STALE_MS,
    budgetMs: budgetMs ?? resolveLockWaitBudgetMs(),
    label: "store lock",
    remedy: "retry once the other writer finishes, or allow a longer wait with " + "OPEN_SECOND_BRAIN_LOCK_WAIT_MS=<milliseconds>"
  });
  try {
    return fn();
  } finally {
    release();
  }
}
var import_proper_lockfile3, STORE_LOCK_STALE_MS = 60000, RETRY_SLEEP_MAX_MS = 20;
var init_local_lock = __esm(() => {
  init_sync_lockfile();
  init_fs_atomic();
  import_proper_lockfile3 = __toESM(require_proper_lockfile(), 1);
});

// src/core/store/clock-store.ts
import { readFileSync as readFileSync6 } from "node:fs";
import { join as join7 } from "node:path";
function clockFilePath(deviceStateDir, device) {
  return join7(deviceStateDir, STORE_CLOCK_DIR, `${device}.json`);
}
function readClock(deviceStateDir, device) {
  let text;
  try {
    text = readFileSync6(clockFilePath(deviceStateDir, device), "utf8");
  } catch (err) {
    if (err.code === "ENOENT")
      return null;
    throw err;
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed.hlc === "string" ? parseHlc(parsed.hlc) : null;
  } catch {
    return null;
  }
}
function update(deviceStateDir, device, step) {
  const path = clockFilePath(deviceStateDir, device);
  return withLocalLock(path, () => {
    const next = step(readClock(deviceStateDir, device) ?? HLC_ZERO);
    atomicWriteText(path, `${JSON.stringify({ hlc: formatHlc(next) })}
`);
    return next;
  });
}
function tickClock(deviceStateDir, device, now = systemWallClock, floor = null) {
  return update(deviceStateDir, device, (local) => {
    const wall = now();
    return sendHlc(floor === null ? local : receiveHlc(local, floor, wall), wall);
  });
}
var systemWallClock = () => Date.now();
var init_clock_store = __esm(() => {
  init_fs_atomic();
  init_constants();
  init_hlc();
  init_local_lock();
});

// src/core/store/ulid.ts
import { randomBytes as randomBytes2 } from "node:crypto";
function encodeTime(time) {
  let out = "";
  let rest = time;
  for (let i = 0;i < TIME_CHARS; i++) {
    out = ALPHABET[rest % 32] + out;
    rest = Math.floor(rest / 32);
  }
  return out;
}
function freshRandom() {
  const bytes = randomBytes2(RANDOM_CHARS);
  return Array.from(bytes, (byte) => byte % 32);
}
function increment(digits) {
  for (let i = digits.length - 1;i >= 0; i--) {
    if (digits[i] < 31) {
      digits[i] += 1;
      return true;
    }
    digits[i] = 0;
  }
  return false;
}
function newUlid(nowMs = Date.now()) {
  const time = Math.min(MAX_TIME, Math.max(0, Math.floor(nowMs)));
  if (time === lastTime) {
    if (!increment(lastRandom)) {
      lastTime += 1;
      lastRandom = freshRandom();
    }
  } else {
    lastTime = time;
    lastRandom = freshRandom();
  }
  return encodeTime(lastTime) + lastRandom.map((d) => ALPHABET[d]).join("");
}
function isUlid(value) {
  return typeof value === "string" && ULID_RE.test(value);
}
var ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ", TIME_CHARS = 10, RANDOM_CHARS = 16, ULID_RE, MAX_TIME, lastTime = -1, lastRandom;
var init_ulid = __esm(() => {
  ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
  MAX_TIME = 2 ** 48 - 1;
  lastRandom = [];
});

// src/core/store/envelope.ts
function canonicalBodyText(body) {
  return canonicalJson(body);
}
function bodyChecksum(body) {
  return sha256Hex(canonicalBodyText(body));
}
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function bodyTooDeep(body) {
  const stack = [[body, 1]];
  while (stack.length > 0) {
    const [value, depth] = stack.pop();
    if (value === null || typeof value !== "object")
      continue;
    if (depth > STORE_BODY_MAX_DEPTH)
      return true;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child !== null && typeof child === "object")
        stack.push([child, depth + 1]);
    }
  }
  return false;
}
function isBlobRef(body) {
  const bytes = body[BLOB_REF_BYTES_KEY];
  return Object.keys(body).length === 2 && typeof body[BLOB_REF_KEY] === "string" && typeof bytes === "number" && Number.isSafeInteger(bytes) && bytes >= 0;
}
function labelProblem(value) {
  if (typeof value !== "string" || value.trim() === "" || value.length > MAX_LABEL_LENGTH) {
    return `must be a non-empty string of at most ${MAX_LABEL_LENGTH} characters`;
  }
  if (/[\r\n]/.test(value))
    return "must be one line";
  return null;
}
function isRecordLabel(value) {
  return labelProblem(value) === null;
}
function label(name, value, nullable) {
  if (value === null || value === undefined) {
    if (nullable)
      return null;
    throw new EnvelopeError(`record ${name} is required`);
  }
  const problem = labelProblem(value);
  if (problem !== null)
    throw new EnvelopeError(`record ${name} ${problem}`);
  return value;
}
function buildRecord(input) {
  if (!isValidDeviceId(input.device)) {
    throw new EnvelopeError(`record device "${input.device}" is not a valid device id (lowercase letters, digits and hyphens, not "sync-conflict")`);
  }
  if (!RECORD_KIND_RE.test(input.kind)) {
    throw new EnvelopeError(`record kind "${input.kind}" must match ${RECORD_KIND_RE}`);
  }
  const agent = label("agent", input.agent, false);
  const scope = label("scope", input.scope, true);
  const topic = input.topic ?? null;
  if (topic !== null && !isUlid(topic)) {
    throw new EnvelopeError(`record topic "${topic}" must be a topic id (ULID) or null`);
  }
  if (!isPlainObject(input.body))
    throw new EnvelopeError("record body must be a JSON object");
  if (bodyTooDeep(input.body))
    throw new EnvelopeError(`record ${BODY_TOO_DEEP_REASON}`);
  if (BLOB_REF_KEY in input.body) {
    throw new EnvelopeError(`record body must not use the reserved key "${BLOB_REF_KEY}"`);
  }
  const id = input.id ?? newUlid(input.hlc.physical);
  if (!isUlid(id))
    throw new EnvelopeError(`record id "${id}" must be a ULID`);
  const body = JSON.parse(JSON.stringify(input.body));
  return {
    v: STORE_FORMAT_VERSION,
    id,
    hlc: formatHlc(input.hlc),
    device: input.device,
    agent,
    kind: input.kind,
    scope,
    topic,
    sum: bodyChecksum(body),
    body
  };
}
function verifyEnvelope(value) {
  if (!isPlainObject(value))
    return fail("line is not a JSON object");
  for (const field of ENVELOPE_FIELDS) {
    if (!(field in value))
      return fail(`missing field "${field}"`);
  }
  const v = value["v"];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1)
    return fail("invalid version");
  if (v !== STORE_FORMAT_VERSION) {
    return { ok: false, reason: `unknown format version ${v}`, unknownVersion: v };
  }
  const { id, hlc, device, agent, kind, scope, topic, sum, body } = value;
  if (!isUlid(id))
    return fail("invalid id");
  if (typeof hlc !== "string" || parseHlc(hlc) === null)
    return fail("invalid hlc");
  if (typeof device !== "string" || !isValidDeviceId(device))
    return fail("invalid device");
  if (labelProblem(agent) !== null)
    return fail("invalid agent");
  if (typeof kind !== "string" || !RECORD_KIND_RE.test(kind))
    return fail("invalid kind");
  if (scope !== null && labelProblem(scope) !== null)
    return fail("invalid scope");
  if (topic !== null && !isUlid(topic))
    return fail("invalid topic");
  if (typeof sum !== "string" || !SHA256_RE.test(sum))
    return fail("invalid sum");
  if (!isPlainObject(body))
    return fail("invalid body");
  if (bodyTooDeep(body))
    return fail(BODY_TOO_DEEP_REASON);
  if (isBlobRef(body)) {
    if (body[BLOB_REF_KEY] !== sum)
      return fail("checksum mismatch: blob reference does not match sum");
  } else if (bodyChecksum(body) !== sum) {
    return fail("checksum mismatch");
  }
  return { ok: true, record: value };
}
function compareRecords(a, b) {
  const byClock = compareHlc(parseHlc(a.hlc), parseHlc(b.hlc));
  if (byClock !== 0)
    return byClock;
  if (a.device !== b.device)
    return a.device < b.device ? -1 : 1;
  if (a.id !== b.id)
    return a.id < b.id ? -1 : 1;
  return 0;
}
var EnvelopeError, RECORD_KIND_RE, MAX_LABEL_LENGTH = 200, SHA256_RE, BODY_TOO_DEEP_REASON, fail = (reason) => ({ ok: false, reason });
var init_envelope = __esm(() => {
  init_config();
  init_digest();
  init_constants();
  init_hlc();
  init_ulid();
  EnvelopeError = class EnvelopeError extends Error {
    constructor(message) {
      super(message);
      this.name = "EnvelopeError";
    }
  };
  RECORD_KIND_RE = /^[a-z][a-z0-9-]{0,63}$/;
  SHA256_RE = /^[0-9a-f]{64}$/;
  BODY_TOO_DEEP_REASON = `body nests deeper than ${STORE_BODY_MAX_DEPTH} levels`;
});

// src/core/store/safe-fs.ts
import {
  closeSync as closeSync3,
  constants,
  fstatSync as fstatSync2,
  lstatSync as lstatSync2,
  mkdirSync as mkdirSync7,
  openSync as openSync3
} from "node:fs";
import { dirname as dirname7, isAbsolute as isAbsolute2, join as join8, relative as relative2, sep as sep3 } from "node:path";
function errnoCode(err) {
  return err?.code;
}
function lstatOrNull(path) {
  try {
    return lstatSync2(path);
  } catch (err) {
    if (errnoCode(err) === "ENOENT")
      return null;
    throw err;
  }
}
function assertRealDirectory(path) {
  const stat = lstatOrNull(path);
  if (stat === null)
    return;
  if (stat.isSymbolicLink())
    throw new StoreUnsafePathError(path, "is a symbolic link");
  if (!stat.isDirectory())
    throw new StoreUnsafePathError(path, "is not a directory");
}
function ensureStoreDir(partitionRoot, dir) {
  const rel = relative2(partitionRoot, dir);
  if (rel === ".." || rel.startsWith(`..${sep3}`) || isAbsolute2(rel)) {
    throw new StoreUnsafePathError(dir, "is outside the partition folder");
  }
  mkdirSync7(partitionRoot, { recursive: true, mode: STORE_DIR_MODE });
  let current = partitionRoot;
  for (const part of rel === "" ? [] : rel.split(sep3)) {
    current = join8(current, part);
    assertRealDirectory(current);
    try {
      mkdirSync7(current, { mode: STORE_DIR_MODE });
    } catch (err) {
      if (errnoCode(err) !== "EEXIST")
        throw err;
    }
    assertRealDirectory(current);
  }
}
function isRealDirBelowPartition(partitionRoot, dir) {
  const rel = relative2(partitionRoot, dir);
  if (rel === ".." || rel.startsWith(`..${sep3}`) || isAbsolute2(rel))
    return false;
  let current = partitionRoot;
  for (const part of rel === "" ? [] : rel.split(sep3)) {
    current = join8(current, part);
    const stat = lstatOrNull(current);
    if (stat === null || stat.isSymbolicLink() || !stat.isDirectory())
      return false;
  }
  return true;
}
function openRegularFileForRead(path, partitionRoot) {
  if (!lstatSync2(path).isFile())
    return null;
  let fd;
  try {
    fd = openSync3(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
  } catch (err) {
    if (errnoCode(err) === "ELOOP")
      return null;
    throw err;
  }
  let keep = false;
  try {
    const opened = fstatSync2(fd);
    keep = opened.isFile() && (NO_FOLLOW !== 0 || nameIsOpenedFile(path, opened)) && (partitionRoot === undefined || isRealDirBelowPartition(partitionRoot, dirname7(path)));
  } finally {
    if (!keep)
      closeSync3(fd);
  }
  return keep ? fd : null;
}
function nameIsOpenedFile(path, opened) {
  const now = lstatOrNull(path);
  return now !== null && !now.isSymbolicLink() && now.ino === opened.ino && now.dev === opened.dev;
}
function assertNameIsOpenedFile(path, opened) {
  const now = lstatOrNull(path);
  if (now === null)
    throw new StoreUnsafePathError(path, "was removed while it was opened");
  if (now.isSymbolicLink())
    throw new StoreUnsafePathError(path, "is a symbolic link");
  if (now.ino !== opened.ino || now.dev !== opened.dev) {
    throw new StoreUnsafePathError(path, "was replaced while it was opened");
  }
}
function openShardForAppend(path) {
  const before = lstatOrNull(path);
  if (before?.isSymbolicLink() === true)
    throw new StoreUnsafePathError(path, "is a symbolic link");
  let fd;
  try {
    fd = openSync3(path, constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW, STORE_FILE_MODE);
  } catch (err) {
    if (errnoCode(err) === "ELOOP")
      throw new StoreUnsafePathError(path, "is a symbolic link");
    throw err;
  }
  try {
    const stat = fstatSync2(fd);
    if (!stat.isFile())
      throw new StoreUnsafePathError(path, "is not a regular file");
    if (stat.nlink > 1)
      throw new StoreUnsafePathError(path, `has ${stat.nlink} hard links`);
    if (NO_FOLLOW === 0)
      assertNameIsOpenedFile(path, stat);
  } catch (err) {
    closeSync3(fd);
    throw err;
  }
  return fd;
}
var STORE_DIR_MODE = 448, STORE_FILE_MODE = 384, StoreUnsafePathError, NO_FOLLOW, NON_BLOCK;
var init_safe_fs = __esm(() => {
  StoreUnsafePathError = class StoreUnsafePathError extends Error {
    path;
    constructor(path, why) {
      super(`refusing to write through ${path} in the brain store: it ${why}. ` + "Something other than Open Second Brain put it there (a sync peer, a restore, a manual " + "edit); remove it and let the store create the path again");
      this.name = "StoreUnsafePathError";
      this.path = path;
    }
  };
  NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
  NON_BLOCK = constants.O_NONBLOCK ?? 0;
});

// src/core/store/store-paths.ts
import { realpathSync as realpathSync2 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { join as join9, posix as posix4, win32 as win322 } from "node:path";
function pathsFor(platform) {
  return platform === "win32" ? win322 : posix4;
}
function expandHome(value, source) {
  const paths = pathsFor(source.platform);
  if (value === "~")
    return source.home;
  if (value.startsWith("~/") || source.platform === "win32" && value.startsWith("~\\")) {
    return paths.join(source.home, value.slice(2));
  }
  return value;
}
function resolveLinks(path, platform) {
  if (platform !== process.platform)
    return path;
  const paths = pathsFor(platform);
  let head = path;
  const tail = [];
  for (;; ) {
    try {
      return paths.join(realpathSync2(head), ...tail.toReversed());
    } catch {
      const parent = paths.dirname(head);
      if (parent === head)
        return path;
      tail.push(paths.basename(head));
      head = parent;
    }
  }
}
function isPathInside(child, parent, platform) {
  const paths = pathsFor(platform);
  const fold = (p) => CASE_INSENSITIVE_PLATFORMS.has(platform) ? p.toLowerCase() : p;
  const rel = paths.relative(fold(paths.resolve(parent)), fold(paths.resolve(child)));
  const escapes = rel === ".." || rel.startsWith(`..${paths.sep}`);
  return rel === "" || !escapes && !paths.isAbsolute(rel);
}
function isPathInsideResolved(child, parent, platform) {
  return isPathInside(child, parent, platform) || isPathInside(resolveLinks(child, platform), resolveLinks(parent, platform), platform);
}
function defaultStoreRoot(source = processDirsEnv()) {
  return pathsFor(source.platform).join(dataBaseDir(source), APP_DIR_NAME, STORE_DEFAULT_DIR);
}
function resolveStoreRoot(source) {
  const paths = pathsFor(source.platform);
  const env = source.env[STORE_ROOT_ENV]?.trim();
  const configured = source.config[STORE_ROOT_CONFIG_KEY]?.trim();
  let resolved;
  if (env) {
    resolved = { root: paths.resolve(expandHome(env, source)), origin: "env" };
  } else if (configured) {
    const expanded = expandHome(configured, source);
    const root = paths.isAbsolute(expanded) ? paths.normalize(expanded) : paths.resolve(paths.dirname(source.configPath), expanded);
    resolved = { root, origin: "config" };
  } else {
    resolved = { root: defaultStoreRoot(source), origin: "default" };
  }
  if (source.vault !== null && source.vault.trim() !== "") {
    const vault = expandHome(source.vault.trim(), source);
    if (isPathInsideResolved(resolved.root, vault, source.platform))
      throw new StoreRootInsideVaultError(resolved.root, vault, resolved.origin);
  }
  return resolved;
}
function resolveConfiguredStoreRoot(configPath) {
  const path = configPath ?? defaultConfigPath();
  return resolveStoreRoot({
    platform: process.platform,
    home: homedir3(),
    env: process.env,
    config: discoverConfig(path).data,
    configPath: path,
    vault: resolveVault(path)
  });
}
function storesStateDir(source = processDirsEnv()) {
  return pathsFor(source.platform).join(stateBaseDir(source), APP_DIR_NAME, STORE_STATE_DIR);
}
function deviceStateDirFor(storeId, source = processDirsEnv()) {
  if (!isUlid(storeId))
    throw new Error(`store id "${storeId}" is not a ULID`);
  return pathsFor(source.platform).join(storesStateDir(source), storeId);
}
function dualWriteStatusPath(source = processDirsEnv()) {
  return pathsFor(source.platform).join(storesStateDir(source), DUAL_WRITE_STATUS_FILE);
}
function partitionDir(root, partition) {
  return join9(root, partition);
}
function shardMonth(physicalMs) {
  return new Date(physicalMs).toISOString().slice(0, 7);
}
function streamSegments(ref) {
  if (ref.stream === LEDGER_STREAM) {
    if (ref.ledger === undefined || !LEDGER_NAME_RE.test(ref.ledger)) {
      throw new Error(`the ${LEDGER_STREAM} stream needs a ledger name matching ${LEDGER_NAME_RE}`);
    }
    return [ref.stream, ref.ledger];
  }
  if (ref.ledger !== undefined)
    throw new Error(`stream ${ref.stream} takes no ledger name`);
  return [ref.stream];
}
function shardRelPath(ref, device, month) {
  if (!isValidDeviceId(device))
    throw new Error(`"${device}" is not a valid device id`);
  if (!SHARD_MONTH_RE.test(month))
    throw new Error(`"${month}" is not a YYYY-MM month`);
  return posix4.join(...streamSegments(ref), device, `${month}.${STORE_SHARD_EXT}`);
}
function shardPath(root, partition, ref, device, month) {
  return join9(partitionDir(root, partition), ...shardRelPath(ref, device, month).split("/"));
}
function blobPath(partitionRoot, sha) {
  if (!SHA256_RE2.test(sha))
    throw new Error(`"${sha}" is not a sha256 hex digest`);
  return join9(partitionRoot, STORE_BLOBS_DIR, sha.slice(0, 2), sha);
}
function shardLockTarget(deviceStateDir, partition, rel) {
  return join9(deviceStateDir, STORE_LOCKS_DIR, partition, ...rel.split("/"));
}
var StoreRootInsideVaultError, CASE_INSENSITIVE_PLATFORMS, LEDGER_NAME_RE, SHARD_MONTH_RE, SHA256_RE2;
var init_store_paths = __esm(() => {
  init_config();
  init_platform_dirs();
  init_constants();
  init_ulid();
  StoreRootInsideVaultError = class StoreRootInsideVaultError extends Error {
    root;
    vault;
    setting;
    origin;
    constructor(root, vault, origin) {
      const setting = origin === "env" ? `the ${STORE_ROOT_ENV} environment variable` : origin === "config" ? `\`${STORE_ROOT_CONFIG_KEY}\` in the machine config` : "the default store root";
      const remedy = origin === "default" ? `set \`${STORE_ROOT_CONFIG_KEY}\` in the machine config to a directory outside the vault` : `change ${setting} to a directory outside the vault, or remove it to use the per-user default`;
      super(`the brain store root ${root} (from ${setting}) is inside the vault ${vault}; ` + `the store must live outside the vault: ${remedy}.`);
      this.name = "StoreRootInsideVaultError";
      this.root = root;
      this.vault = vault;
      this.setting = setting;
      this.origin = origin;
    }
  };
  CASE_INSENSITIVE_PLATFORMS = new Set(["win32", "darwin"]);
  LEDGER_NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
  SHARD_MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  SHA256_RE2 = /^[0-9a-f]{64}$/;
});

// src/core/store/blobs.ts
import {
  closeSync as closeSync4,
  fstatSync as fstatSync3,
  fsyncSync as fsyncSync2,
  linkSync as linkSync2,
  mkdirSync as mkdirSync8,
  openSync as openSync4,
  readFileSync as readFileSync7,
  readSync,
  statSync as statSync5,
  unlinkSync as unlinkSync3,
  writeSync as writeSync3
} from "node:fs";
import { basename as basename4, dirname as dirname8, join as join10 } from "node:path";
function errnoCode2(err) {
  return err?.code;
}
function sameFilesystem(a, b) {
  try {
    return statSync5(a).dev === statSync5(b).dev;
  } catch {
    return false;
  }
}
function writeAll(fd, bytes) {
  let written = 0;
  while (written < bytes.length)
    written += writeSync3(fd, bytes, written, bytes.length - written);
  fsyncSync2(fd);
}
function createExclusive(path, bytes) {
  const fd = openSync4(path, "wx", STORE_FILE_MODE);
  try {
    writeAll(fd, bytes);
  } finally {
    closeSync4(fd);
  }
}
function tempPathFor(target, tempDir) {
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const blobDir = dirname8(target);
  if (tempDir !== undefined) {
    try {
      mkdirSync8(tempDir, { recursive: true });
      if (sameFilesystem(tempDir, blobDir))
        return join10(tempDir, `${basename4(target)}.${unique}`);
    } catch {}
  }
  return join10(blobDir, `${BLOB_TEMP_PREFIX}${basename4(target)}.${unique}`);
}
function verifies(path, sha, size, attempts, sleepMs) {
  for (let attempt = 0;attempt < attempts; attempt += 1) {
    try {
      const fd = openRegularFileForRead(path);
      if (fd !== null) {
        try {
          if (fstatSync3(fd).size === size && sha256Hex(readFileSync7(fd)) === sha)
            return true;
        } finally {
          closeSync4(fd);
        }
      }
    } catch (err) {
      if (errnoCode2(err) !== "ENOENT")
        throw err;
    }
    if (attempt < attempts - 1)
      sleepSync(sleepMs);
  }
  return false;
}
function settleExisting(path, sha, bytes, options) {
  if (verifies(path, sha, bytes.length, VERIFY_ATTEMPTS, VERIFY_SLEEP_MS))
    return;
  const repair = tempPathFor(path, options.tempDir);
  try {
    createExclusive(repair, bytes);
    try {
      (options.rename ?? renameWithRetry)(repair, path);
    } catch (err) {
      const code = errnoCode2(err);
      if (code === undefined || !STILL_OPEN_CODES.has(code))
        throw err;
      if (!verifies(path, sha, bytes.length, VERIFY_ATTEMPTS, VERIFY_SLEEP_MS * 10))
        throw err;
    }
  } finally {
    try {
      unlinkSync3(repair);
    } catch {}
  }
  if (!verifies(path, sha, bytes.length, 1, 0)) {
    throw new Error(`blob ${path} does not hold the content its name promises, even after a rewrite`);
  }
}
function createFileOnce(path, bytes, options = {}) {
  const link = options.link ?? linkSync2;
  mkdirSync8(dirname8(path), { recursive: true, mode: STORE_DIR_MODE });
  const temp = tempPathFor(path, options.tempDir);
  try {
    createExclusive(temp, bytes);
    try {
      link(temp, path);
      return true;
    } catch (err) {
      const code = errnoCode2(err);
      if (code === "EEXIST")
        return false;
      if (code === undefined || !NO_LINK_CODES.has(code))
        throw err;
    }
  } finally {
    try {
      unlinkSync3(temp);
    } catch {}
  }
  try {
    createExclusive(path, bytes);
    return true;
  } catch (err) {
    if (errnoCode2(err) !== "EEXIST")
      throw err;
    return false;
  }
}
function writeBlob(partitionRoot, text, options = {}) {
  const sha = sha256Hex(text);
  const path = blobPath(partitionRoot, sha);
  const bytes = Buffer.from(text, "utf8");
  ensureStoreDir(partitionRoot, dirname8(path));
  if (createFileOnce(path, bytes, options))
    return { sha, path, created: true };
  settleExisting(path, sha, bytes, options);
  return { sha, path, created: false };
}
function readBlob(partitionRoot, sha, bytes) {
  const path = blobPath(partitionRoot, sha);
  let fd;
  try {
    const opened = openRegularFileForRead(path, partitionRoot);
    if (opened === null)
      return { status: "mismatch" };
    fd = opened;
  } catch (err) {
    if (err.code === "ENOENT")
      return { status: "missing" };
    throw err;
  }
  try {
    const stat = fstatSync3(fd);
    if (stat.size > STORE_BLOB_MAX_BYTES)
      return { status: "mismatch" };
    if (bytes !== undefined && stat.size !== bytes)
      return { status: "mismatch" };
    const content = Buffer.alloc(stat.size);
    let read = 0;
    while (read < content.length) {
      const n = readSync(fd, content, read, content.length - read, read);
      if (n === 0)
        break;
      read += n;
    }
    const got = content.subarray(0, read);
    if (sha256Hex(got) !== sha)
      return { status: "mismatch" };
    return { status: "ok", text: got.toString("utf8") };
  } finally {
    closeSync4(fd);
  }
}
var NO_LINK_CODES, VERIFY_ATTEMPTS = 5, VERIFY_SLEEP_MS = 20, STILL_OPEN_CODES;
var init_blobs = __esm(() => {
  init_fs_atomic();
  init_digest();
  init_constants();
  init_safe_fs();
  init_store_paths();
  NO_LINK_CODES = new Set([
    "EPERM",
    "ENOTSUP",
    "EOPNOTSUPP",
    "ENOSYS",
    "EXDEV",
    "EMLINK"
  ]);
  STILL_OPEN_CODES = new Set(["EPERM", "EBUSY"]);
});

// src/core/store/appender.ts
import { closeSync as closeSync5, fstatSync as fstatSync4, fsyncSync as fsyncSync3, openSync as openSync5, readSync as readSync2, writeSync as writeSync4 } from "node:fs";
import { dirname as dirname9, join as join11 } from "node:path";
function lineBytes(record) {
  return Buffer.from(`${JSON.stringify(record)}
`, "utf8");
}
function fsyncDirBestEffort(dir) {
  try {
    const fd = openSync5(dir, "r");
    try {
      fsyncSync3(fd);
    } finally {
      closeSync5(fd);
    }
  } catch {}
}
function appendLine(partitionRoot, path, bytes) {
  ensureStoreDir(partitionRoot, dirname9(path));
  const fd = openShardForAppend(path);
  let created = false;
  try {
    const size = fstatSync4(fd).size;
    created = size === 0;
    let payload = bytes;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync2(fd, last, 0, 1, size - 1);
      if (last[0] !== NEWLINE)
        payload = Buffer.concat([Buffer.from([NEWLINE]), bytes]);
    }
    let written = 0;
    while (written < payload.length) {
      written += writeSync4(fd, payload, written, payload.length - written);
    }
    fsyncSync3(fd);
  } finally {
    closeSync5(fd);
  }
  if (created)
    fsyncDirBestEffort(dirname9(path));
}
function appendRecord(store, input, options = {}) {
  if (!store.partitions.has(input.partition)) {
    throw new PartitionUnavailableError(input.partition, store.root);
  }
  const ref = input.ledger === undefined ? { stream: input.stream } : { stream: input.stream, ledger: input.ledger };
  const hlc = tickClock(store.deviceStateDir, store.device, options.now, observedClockFloor(store.root));
  const month = shardMonth(hlc.physical);
  const rel = shardRelPath(ref, store.device, month);
  const record = buildRecord({
    hlc,
    device: store.device,
    agent: input.agent,
    kind: input.kind,
    scope: input.scope ?? null,
    topic: input.topic ?? null,
    body: input.body
  });
  let bytes = lineBytes(record);
  let spilled = false;
  if (bytes.length > STORE_LINE_CAP_BYTES) {
    const text = canonicalBodyText(record.body);
    const reference = {
      [BLOB_REF_KEY]: record.sum,
      [BLOB_REF_BYTES_KEY]: Buffer.byteLength(text, "utf8")
    };
    bytes = lineBytes({ ...record, body: reference });
    if (bytes.length > STORE_LINE_CAP_BYTES)
      throw new RecordTooLargeError(bytes.length);
    writeBlob(partitionDir(store.root, input.partition), text, {
      tempDir: join11(store.deviceStateDir, STORE_TMP_DIR)
    });
    spilled = true;
  }
  const path = shardPath(store.root, input.partition, ref, store.device, month);
  withLocalLock(shardLockTarget(store.deviceStateDir, input.partition, rel), () => appendLine(partitionDir(store.root, input.partition), path, bytes));
  return { record, path, rel, spilled };
}
var PartitionUnavailableError, RecordTooLargeError, NEWLINE = 10;
var init_appender = __esm(() => {
  init_clock_floor();
  init_clock_store();
  init_constants();
  init_envelope();
  init_blobs();
  init_local_lock();
  init_safe_fs();
  init_store_paths();
  PartitionUnavailableError = class PartitionUnavailableError extends Error {
    partition;
    constructor(partition, root) {
      super(`this machine does not hold the ${partition} partition of the brain store at ${root}; ` + "the record was not written");
      this.name = "PartitionUnavailableError";
      this.partition = partition;
    }
  };
  RecordTooLargeError = class RecordTooLargeError extends Error {
    constructor(bytes) {
      super(`a store record line is ${bytes} bytes even with its body in a blob, above the ${STORE_LINE_CAP_BYTES}-byte cap; shorten its agent, scope or kind`);
      this.name = "RecordTooLargeError";
    }
  };
});

// src/core/store/fold.ts
function preferVersion(a, b) {
  const order = compareRecords(a, b);
  if (order !== 0)
    return order < 0 ? a : b;
  return canonicalJson(a) <= canonicalJson(b) ? a : b;
}
function prepareRecords(input) {
  const byId = new Map;
  const delivered = new Map;
  let duplicates = 0;
  for (const record of input) {
    const seen = byId.get(record.id);
    if (seen === undefined) {
      byId.set(record.id, record);
      continue;
    }
    let texts = delivered.get(record.id);
    if (texts === undefined) {
      texts = new Set([canonicalJson(seen)]);
      delivered.set(record.id, texts);
    }
    const text = canonicalJson(record);
    if (texts.has(text)) {
      duplicates += 1;
      continue;
    }
    texts.add(text);
    byId.set(record.id, preferVersion(seen, record));
  }
  const records = [];
  const pending = [];
  for (const record of byId.values())
    (isBlobRef(record.body) ? pending : records).push(record);
  records.sort(compareRecords);
  pending.sort(compareRecords);
  const conflicts = [...delivered.entries()].filter(([, texts]) => texts.size > 1).map(([id, texts]) => ({ id, versions: texts.size })).toSorted((a, b) => compareCodeUnits(a.id, b.id));
  return { records, duplicates, conflicts, pending };
}
function authorityRank(authority) {
  return AUTHORITIES.length - AUTHORITIES.indexOf(authority);
}
function isAuthority(value) {
  return typeof value === "string" && AUTHORITIES.includes(value);
}
function recordAuthority(record) {
  const value = record.body[AUTHORITY_FIELD];
  return isAuthority(value) ? value : null;
}
function beats(next, current) {
  return authorityRank(next) >= authorityRank(current);
}

class RegisterSet {
  #winners = new Map;
  #history = new Map;
  offer(key, entry) {
    const current = this.#winners.get(key);
    if (current === undefined || beats(entry.authority, current.authority)) {
      this.#winners.set(key, entry);
    }
    const history = this.#history.get(key) ?? [];
    history.push(entry);
    this.#history.set(key, history);
  }
  get(key) {
    const winner = this.#winners.get(key);
    if (winner === undefined)
      return;
    const removed = winner.value === TOMBSTONE;
    return {
      value: removed ? null : winner.value,
      removed,
      winner,
      history: this.#history.get(key)
    };
  }
  keys() {
    return [...this.#winners.keys()].toSorted();
  }
}
var TOMBSTONE;
var init_fold = __esm(() => {
  init_digest();
  init_constants();
  init_envelope();
  TOMBSTONE = Symbol("tombstone");
});

// src/core/store/fold-pinned.ts
function rejection(record) {
  if (recordAuthority(record) === null)
    return "missing or invalid authority";
  if (record.kind === PINNED_SET_KIND && typeof record.body["content"] !== "string") {
    return "content must be a string";
  }
  return null;
}
function foldPinned(input) {
  const { records } = prepareRecords(input);
  const register = new RegisterSet;
  const rejected = [];
  for (const record of records) {
    if (record.kind !== PINNED_SET_KIND && record.kind !== PINNED_CLEAR_KIND)
      continue;
    const reason = rejection(record);
    if (reason !== null) {
      rejected.push({ id: record.id, kind: record.kind, reason });
      continue;
    }
    const authority = recordAuthority(record);
    const value = record.kind === PINNED_CLEAR_KIND ? TOMBSTONE : record.body["content"];
    register.offer(KEY, { record, authority, value });
  }
  const state = register.get(KEY);
  return {
    content: state?.value ?? null,
    cleared: state?.removed ?? false,
    winner: state?.winner.record.id ?? null,
    history: state?.history ?? [],
    rejected
  };
}
var KEY = "pinned";
var init_fold_pinned = __esm(() => {
  init_constants();
  init_fold();
});

// src/core/store/fold-preferences.ts
function preferenceId(record) {
  const id = record.body["preference"];
  if (typeof id !== "string" || id.trim() === "" || id.length > MAX_ID_LENGTH)
    return null;
  return /[\r\n]/.test(id) ? null : id;
}
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function rejection2(record) {
  if (preferenceId(record) === null)
    return "missing or invalid preference id";
  if (record.kind === PREFERENCE_EVIDENCE_KIND) {
    const result = record.body["result"];
    return EVIDENCE_RESULTS.includes(result) ? null : `evidence result must be one of ${EVIDENCE_RESULTS.join(", ")}`;
  }
  if (recordAuthority(record) === null)
    return "missing or invalid authority";
  if (record.kind === PREFERENCE_REMOVE_KIND)
    return null;
  const fields = record.body["fields"];
  if (!isPlainObject2(fields) || Object.keys(fields).length === 0) {
    return "fields must be a non-empty object";
  }
  const bad = Object.keys(fields).find((name) => !PREFERENCE_FIELD_RE.test(name));
  if (bad !== undefined)
    return `invalid field name "${bad}"`;
  return Object.keys(fields).some((name) => !COUNTERS.has(name)) ? null : "fields name only derived counters";
}
function zeroCounters() {
  return Object.fromEntries(PREFERENCE_COUNTER_FIELDS.map((name) => [name, 0]));
}
function foldPreferences(input) {
  const { records } = prepareRecords(input);
  const existence = new RegisterSet;
  const fields = new RegisterSet;
  const fieldNames = new Map;
  const history = new Map;
  const counters = new Map;
  const rejected = [];
  const position = new Map;
  const removes = new Map;
  for (const [index, record] of records.entries()) {
    position.set(record.id, index);
    if (!KINDS.has(record.kind))
      continue;
    const reason = rejection2(record);
    if (reason !== null) {
      rejected.push({ id: record.id, kind: record.kind, reason });
      continue;
    }
    const id = preferenceId(record);
    const own = history.get(id) ?? [];
    own.push(record);
    history.set(id, own);
    if (record.kind === PREFERENCE_EVIDENCE_KIND) {
      const count = counters.get(id) ?? zeroCounters();
      count[COUNTER_OF[record.body["result"]]] += 1;
      counters.set(id, count);
      continue;
    }
    const authority = recordAuthority(record);
    if (record.kind === PREFERENCE_REMOVE_KIND) {
      existence.offer(id, { record, authority, value: TOMBSTONE });
      removes.set(id, [...removes.get(id) ?? [], index]);
      continue;
    }
    existence.offer(id, { record, authority, value: true });
    const names = fieldNames.get(id) ?? new Set;
    for (const [name, value] of Object.entries(record.body["fields"])) {
      if (COUNTERS.has(name))
        continue;
      names.add(name);
      fields.offer(fieldKey(id, name), { record, authority, value });
    }
    fieldNames.set(id, names);
  }
  const preferences = new Map;
  for (const id of [...history.keys()].toSorted()) {
    const exist = existence.get(id);
    const values = {};
    const winners = {};
    const removed = exist?.removed ?? false;
    const winnerAt = exist === undefined ? -1 : position.get(exist.winner.record.id);
    const cut = (removes.get(id) ?? []).findLast((at) => at < winnerAt);
    const recreated = !removed && exist !== undefined && cut !== undefined;
    if (recreated) {
      const after = new RegisterSet;
      const names = new Set;
      for (const record of history.get(id)) {
        if (record.kind !== PREFERENCE_SET_KIND || position.get(record.id) < cut)
          continue;
        const authority = recordAuthority(record);
        for (const [name, value] of Object.entries(record.body["fields"])) {
          if (COUNTERS.has(name))
            continue;
          names.add(name);
          after.offer(name, { record, authority, value });
        }
      }
      for (const name of [...names].toSorted()) {
        const state = after.get(name);
        values[name] = state.value;
        winners[name] = state.winner.record.id;
      }
    }
    for (const name of removed || recreated ? [] : [...fieldNames.get(id) ?? []].toSorted()) {
      const state = fields.get(fieldKey(id, name));
      values[name] = state.value;
      winners[name] = state.winner.record.id;
    }
    preferences.set(id, {
      id,
      exists: exist !== undefined && !exist.removed,
      removed: exist?.removed ?? false,
      fields: values,
      fieldWinners: winners,
      existenceWinner: exist?.winner.record.id ?? null,
      counters: counters.get(id) ?? zeroCounters(),
      history: history.get(id)
    });
  }
  return { preferences, rejected };
}
var PREFERENCE_FIELD_RE, MAX_ID_LENGTH = 200, COUNTER_OF, COUNTERS, KINDS, fieldKey = (id, field) => `${id}\x00${field}`;
var init_fold_preferences = __esm(() => {
  init_constants();
  init_fold();
  PREFERENCE_FIELD_RE = /^[a-z][a-z0-9_]{0,63}$/;
  COUNTER_OF = {
    applied: "applied_count",
    violated: "violated_count",
    outdated: "outdated_count"
  };
  COUNTERS = new Set(PREFERENCE_COUNTER_FIELDS);
  KINDS = new Set([
    PREFERENCE_SET_KIND,
    PREFERENCE_REMOVE_KIND,
    PREFERENCE_EVIDENCE_KIND
  ]);
});

// src/core/store/fold-settings.ts
var positiveInt = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 1, LANGUAGE_RE, SETTING_RULES;
var init_fold_settings = __esm(() => {
  init_constants();
  init_fold();
  LANGUAGE_RE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$/;
  SETTING_RULES = Object.freeze({
    [SETTING_VIEW_LANGUAGE]: {
      valid: (value) => typeof value === "string" && LANGUAGE_RE.test(value),
      expected: "a language tag such as en or pt-BR",
      fallback: null
    },
    [SETTING_TOPIC_MIN_RECORDS]: { valid: positiveInt, expected: "a positive integer", fallback: 5 },
    [SETTING_TOPIC_MIN_SESSIONS]: { valid: positiveInt, expected: "a positive integer", fallback: 2 }
  });
});

// src/core/store/shard-quarantine.ts
import { createHash as createHash2 } from "node:crypto";
import { closeSync as closeSync6, readFileSync as readFileSync8, readSync as readSync3, statSync as statSync6 } from "node:fs";
import { join as join12, resolve as resolve6 } from "node:path";
function ledgerPath(root) {
  const key = createHash2("sha256").update(resolve6(root)).digest("hex").slice(0, 32);
  return join12(storesStateDir(), SHARD_QUARANTINE_DIR, `${key}.json`);
}
function stampOf(path) {
  const stat = statSync6(path, { throwIfNoEntry: false });
  return stat === undefined ? "absent" : `${stat.size}:${stat.mtimeMs}`;
}
function isPartition(value) {
  return STORE_PARTITIONS.includes(value);
}
function isLine(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const v = value;
  return isPartition(v["partition"]) && typeof v["shard"] === "string" && typeof v["offset"] === "number" && Number.isSafeInteger(v["offset"]) && typeof v["sha256"] === "string" && (v["kind"] === "corrupt-line" || v["kind"] === "blob-pending") && typeof v["reason"] === "string" && typeof v["quarantined_at"] === "string";
}
function appliedLines(parsed) {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return [];
  const { version, lines } = parsed;
  if (version !== QUARANTINE_LEDGER_VERSION || !Array.isArray(lines))
    return [];
  return lines.filter(isLine);
}
function load2(root) {
  const path = ledgerPath(root);
  let stamp;
  try {
    stamp = stampOf(path);
  } catch {
    return { root: resolve6(root), lines: [] };
  }
  const hit = loaded.get(path);
  if (hit !== undefined && hit.stamp === stamp)
    return hit.ledger;
  let lines = [];
  if (stamp !== "absent") {
    try {
      lines = appliedLines(JSON.parse(readFileSync8(path, "utf8")));
    } catch {
      lines = [];
    }
  }
  const ledger = { root: resolve6(root), lines };
  loaded.set(path, { stamp, ledger });
  return ledger;
}
function quarantineStamp(root) {
  try {
    return stampOf(ledgerPath(root));
  } catch {
    return "unreadable";
  }
}
function quarantinedLines(partitionRoot, rel) {
  const partition = resolve6(partitionRoot).split(/[\\/]/).pop();
  if (!isPartition(partition))
    return new Map;
  const out = new Map;
  for (const line of load2(resolve6(partitionRoot, "..")).lines) {
    if (line.partition === partition && line.shard === rel) {
      out.set(line.offset, { sha256: line.sha256, kind: line.kind });
    }
  }
  return out;
}
function probeLineHashAtFd(fd, offset) {
  try {
    const hash = createHash2("sha256");
    const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
    let position = offset;
    let read = 0;
    for (;; ) {
      const want = Math.min(chunk.length, QUARANTINE_HASH_CAP_BYTES - read + 1);
      const n = readSync3(fd, chunk, 0, want, position);
      if (n === 0)
        break;
      const end = chunk.subarray(0, n).indexOf(10);
      const take = end === -1 ? n : end + 1;
      if (read + take > QUARANTINE_HASH_CAP_BYTES)
        return { failure: "too-long" };
      hash.update(chunk.subarray(0, take));
      read += take;
      if (end !== -1)
        break;
      position += n;
    }
    return read === 0 ? { failure: "unreadable" } : { sha256: hash.digest("hex") };
  } catch {
    return { failure: "unreadable" };
  }
}
function lineSha256AtFd(fd, offset) {
  return hashOf(probeLineHashAtFd(fd, offset));
}
var SHARD_QUARANTINE_DIR = "shard-quarantine", QUARANTINE_LEDGER_VERSION = 1, DAY_MS2, PENDING_BLOB_QUARANTINE_AGE_MS, PENDING_BLOB_QUARANTINE_AGE_TEXT, loaded, HASH_CHUNK_BYTES, QUARANTINE_HASH_CAP_BYTES, hashOf = (probe) => ("sha256" in probe) ? probe.sha256 : null;
var init_shard_quarantine = __esm(() => {
  init_constants();
  init_hlc();
  init_safe_fs();
  init_store_paths();
  DAY_MS2 = 24 * 60 * 60 * 1000;
  PENDING_BLOB_QUARANTINE_AGE_MS = 7 * DAY_MS2;
  PENDING_BLOB_QUARANTINE_AGE_TEXT = `${PENDING_BLOB_QUARANTINE_AGE_MS / DAY_MS2} days`;
  loaded = new Map;
  HASH_CHUNK_BYTES = 64 * 1024;
  QUARANTINE_HASH_CAP_BYTES = 64 * STORE_LINE_CAP_BYTES;
});

// src/core/store/shard-list.ts
import { readdirSync as readdirSync2 } from "node:fs";
import { join as join13, posix as posix5 } from "node:path";
function isShardFileName(name) {
  return SHARD_FILE_RE.test(name) && !name.includes(".sync-conflict");
}
function isReadableDeviceDir(name, platform = process.platform) {
  return isValidDeviceId(name) && !(platform === "win32" && isWindowsReservedDeviceId(name));
}
function entries(dir) {
  try {
    return readdirSync2(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT")
      return [];
    throw err;
  }
}
function listShards(partitionRoot, ref) {
  const segments = ref.ledger === undefined ? [ref.stream] : [ref.stream, ref.ledger];
  if (ref.ledger !== undefined && !LEDGER_NAME_RE.test(ref.ledger))
    return [];
  const streamDir = join13(partitionRoot, ...segments);
  const out = [];
  for (const deviceEntry of entries(streamDir)) {
    if (!deviceEntry.isDirectory() || !isReadableDeviceDir(deviceEntry.name))
      continue;
    for (const file of entries(join13(streamDir, deviceEntry.name))) {
      if (!(file.isFile() || file.isSymbolicLink()) || !isShardFileName(file.name))
        continue;
      out.push({
        device: deviceEntry.name,
        rel: posix5.join(...segments, deviceEntry.name, file.name),
        path: join13(streamDir, deviceEntry.name, file.name)
      });
    }
  }
  return out.toSorted((a, b) => compareCodeUnits(a.rel, b.rel));
}
var SHARD_FILE_RE;
var init_shard_list = __esm(() => {
  init_config();
  init_constants();
  init_store_paths();
  SHARD_FILE_RE = new RegExp(`^\\d{4}-(0[1-9]|1[0-2])(\\.[a-z0-9][a-z0-9-]{0,39})?\\.${STORE_SHARD_EXT}$`);
});

// src/core/store/torn-line.ts
function isTornObjectPrefix(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("{"))
    return false;
  const stack = [];
  let expect = "value";
  let i = 0;
  const afterValue = () => {
    const top = stack.at(-1);
    expect = top === undefined ? "end" : top === "o" ? "comma-or-close-object" : "comma-or-close-array";
  };
  while (i < trimmed.length) {
    const c = trimmed[i];
    if (WHITESPACE.has(c)) {
      i += 1;
      continue;
    }
    if (expect === "end")
      return false;
    if (expect === "colon") {
      if (c !== ":")
        return false;
      expect = "value";
      i += 1;
      continue;
    }
    if (expect === "comma-or-close-object" || expect === "comma-or-close-array") {
      const close = expect === "comma-or-close-object" ? "}" : "]";
      if (c === ",")
        expect = expect === "comma-or-close-object" ? "key" : "value";
      else if (c === close) {
        stack.pop();
        afterValue();
      } else
        return false;
      i += 1;
      continue;
    }
    if (expect === "key-or-close" && c === "}") {
      stack.pop();
      afterValue();
      i += 1;
      continue;
    }
    if (expect === "value-or-close" && c === "]") {
      stack.pop();
      afterValue();
      i += 1;
      continue;
    }
    const keyPosition = expect === "key" || expect === "key-or-close";
    if (c === '"') {
      i += 1;
      let closed = false;
      while (i < trimmed.length) {
        const s = trimmed[i];
        if (s === '"') {
          closed = true;
          i += 1;
          break;
        }
        if (s < " ")
          return false;
        if (s === "\\") {
          const e = trimmed[i + 1];
          if (e === undefined)
            return true;
          if (e === "u") {
            for (let k = 2;k < 6; k += 1) {
              const h = trimmed[i + k];
              if (h === undefined)
                return true;
              if (!HEX.test(h))
                return false;
            }
            i += 6;
            continue;
          }
          if (!'"\\/bfnrt'.includes(e))
            return false;
          i += 2;
          continue;
        }
        i += 1;
      }
      if (!closed)
        return true;
      if (keyPosition)
        expect = "colon";
      else
        afterValue();
      continue;
    }
    if (keyPosition)
      return false;
    if (c === "{") {
      stack.push("o");
      expect = "key-or-close";
      i += 1;
      continue;
    }
    if (c === "[") {
      stack.push("a");
      expect = "value-or-close";
      i += 1;
      continue;
    }
    if (c === "-" || c >= "0" && c <= "9") {
      let j = i;
      while (j < trimmed.length && NUMBER_CHARS.test(trimmed[j]))
        j += 1;
      const run = trimmed.slice(i, j);
      if (j === trimmed.length)
        return /^-?(\d+(\.\d*)?([eE][+-]?\d*)?)?$/.test(run);
      if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(run))
        return false;
      i = j;
      afterValue();
      continue;
    }
    const literal = LITERALS.find((word) => word.startsWith(c));
    if (literal === undefined)
      return false;
    const rest = trimmed.slice(i, i + literal.length);
    if (!literal.startsWith(rest))
      return false;
    if (rest.length < literal.length)
      return i + rest.length === trimmed.length;
    i += literal.length;
    afterValue();
  }
  return stack.length > 0;
}
var LITERALS, WHITESPACE, NUMBER_CHARS, HEX;
var init_torn_line = __esm(() => {
  LITERALS = ["true", "false", "null"];
  WHITESPACE = new Set([" ", "\t", "\r", `
`]);
  NUMBER_CHARS = /[0-9+\-.eE]/;
  HEX = /[0-9a-fA-F]/;
});

// src/core/store/reader.ts
import { basename as basename5, dirname as dirname10, relative as relative3 } from "node:path";
import { closeSync as closeSync7, fstatSync as fstatSync5, readSync as readSync4 } from "node:fs";
function observeRead(partitionRoot, records) {
  let newest = null;
  for (const { record } of records) {
    const clock = parseHlc(record.hlc);
    if (clock !== null && (newest === null || compareHlc(clock, newest) > 0))
      newest = clock;
  }
  if (newest !== null)
    noteObservedClock(dirname10(partitionRoot), newest);
}
function isPaths(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}
function asCompaction(record) {
  const { replaces, into } = record.body;
  if (!isPaths(replaces) || !isPaths(into))
    return null;
  return { id: record.id, replaces, into };
}
function isPlainObject3(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readBlobBody(partitionRoot, sum, bytes) {
  const blob = readBlob(partitionRoot, sum, bytes);
  if (blob.status !== "ok")
    return { status: "pending" };
  let parsed;
  try {
    parsed = JSON.parse(blob.text);
  } catch {
    return { status: "invalid", reason: `blob ${sum} is not valid JSON` };
  }
  if (!isPlainObject3(parsed) || BLOB_REF_KEY in parsed) {
    return { status: "invalid", reason: `blob ${sum} does not hold a record body (a JSON object)` };
  }
  if (bodyTooDeep(parsed))
    return { status: "invalid", reason: `blob ${sum}: ${BODY_TOO_DEEP_REASON}` };
  if (bodyChecksum(parsed) !== sum) {
    return { status: "invalid", reason: `blob ${sum} does not hold the canonical JSON of a body` };
  }
  return { status: "ok", body: parsed };
}
function resolveBody(record, partitionRoot) {
  if (!isBlobRef(record.body))
    return "inline";
  if (partitionRoot === undefined)
    return "pending";
  const read = readBlobBody(partitionRoot, record.body[BLOB_REF_KEY], record.body[BLOB_REF_BYTES_KEY]);
  if (read.status === "ok")
    return { body: read.body };
  if (read.status === "invalid")
    return { invalid: read.reason };
  return "pending";
}
function shardDeviceOf(path) {
  if (!isShardFileName(basename5(path)))
    return null;
  const device = basename5(dirname10(path));
  return isValidDeviceId(device) ? device : null;
}
function readLine(text, lineOffset, length, isLast, shardDevice, partitionRoot) {
  if (text.trim() === "")
    return { kind: "skip" };
  let check;
  let notJson = false;
  try {
    check = verifyEnvelope(JSON.parse(text));
  } catch {
    notJson = true;
    check = { ok: false, reason: "line is not valid JSON" };
  }
  const corrupt = (reason) => ({
    kind: "diagnostic",
    diagnostic: { kind: "corrupt-line", offset: lineOffset, reason }
  });
  if (notJson && !isLast && isTornObjectPrefix(text)) {
    return {
      kind: "diagnostic",
      diagnostic: {
        kind: "corrupt-line",
        offset: lineOffset,
        reason: "line is a record cut short by a crash (a torn write)",
        torn: true
      }
    };
  }
  if (!check.ok) {
    if (check.unknownVersion !== undefined) {
      return {
        kind: "diagnostic",
        diagnostic: { kind: "unknown-version", offset: lineOffset, reason: check.reason }
      };
    }
    return isLast ? { kind: "hold" } : corrupt(check.reason);
  }
  let record = check.record;
  if (shardDevice !== null && record.device !== shardDevice) {
    return corrupt(`record device "${record.device}" is not the device "${shardDevice}" whose shard it is in`);
  }
  const body = resolveBody(record, partitionRoot);
  let bodyState;
  if (typeof body === "string")
    bodyState = body;
  else if ("invalid" in body)
    return corrupt(body.invalid);
  else {
    record = { ...record, body: body.body };
    bodyState = "blob";
  }
  const compaction = record.kind === COMPACTED_KIND && bodyState !== "pending" ? asCompaction(record) : null;
  return { kind: "record", record: { record, bodyState, offset: lineOffset, length }, compaction };
}
function markQuarantined(fd, path, partitionRoot, records, diagnostics) {
  const rel = relative3(partitionRoot, path).split("\\").join("/");
  const ledger = quarantinedLines(partitionRoot, rel);
  if (ledger.size === 0)
    return { records, diagnostics };
  const settings = rel.split("/")[0] === "settings";
  const matches = (offset, kind) => {
    const entry = ledger.get(offset);
    return entry !== undefined && entry.kind === kind && lineSha256AtFd(fd, offset) === entry.sha256;
  };
  return {
    records: records.map((r) => r.bodyState === "pending" && !settings && matches(r.offset, "blob-pending") ? { ...r, quarantined: true } : r),
    diagnostics: diagnostics.map((d) => d.kind === "corrupt-line" && d.torn !== true && matches(d.offset, "corrupt-line") ? { ...d, quarantined: true } : d)
  };
}
function readShard(path, options = {}) {
  const start = options.offset ?? 0;
  const records = [];
  const diagnostics = [];
  const compactions = [];
  const shardDevice = shardDeviceOf(path);
  const fd = openRegularFileForRead(path, options.partitionRoot);
  if (fd === null) {
    diagnostics.push({
      kind: "not-a-file",
      offset: start,
      reason: "the shard is not a regular file (a symbolic link or a special file) or is reached " + "through a linked folder inside the partition; it is not read"
    });
    return {
      records,
      diagnostics,
      compactions,
      nextOffset: start,
      pendingTailBytes: 0,
      size: start
    };
  }
  try {
    const size = fstatSync5(fd).size;
    if (start > size) {
      diagnostics.push({
        kind: "offset-past-end",
        offset: start,
        reason: `offset ${start} is past the end of the shard (${size} bytes); the shard was truncated or replaced`
      });
      return { records, diagnostics, compactions, nextOffset: start, pendingTailBytes: 0, size };
    }
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(size - start, 1)));
    let consumed = start;
    let position = start;
    let carry = [];
    let carried = 0;
    let oversized = false;
    const overlong = () => {
      diagnostics.push({
        kind: "corrupt-line",
        offset: consumed,
        reason: `line is longer than the ${STORE_LINE_CAP_BYTES}-byte line-size cap`
      });
    };
    let held = false;
    while (!held && position < size) {
      const n = readSync4(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (n === 0)
        break;
      const base = position;
      position += n;
      let cursor = 0;
      while (cursor < n) {
        const end = chunk.subarray(0, n).indexOf(NEWLINE2, cursor);
        if (end === -1) {
          if (!oversized) {
            carry.push(Buffer.from(chunk.subarray(cursor, n)));
            carried += n - cursor;
            if (carried >= STORE_LINE_CAP_BYTES) {
              oversized = true;
              carry = [];
              carried = 0;
            }
          }
          break;
        }
        const lineEnd = base + end + 1;
        if (oversized) {
          overlong();
          oversized = false;
        } else if (carried + (end - cursor) + 1 > STORE_LINE_CAP_BYTES) {
          overlong();
        } else {
          carry.push(chunk.subarray(cursor, end));
          const text = Buffer.concat(carry).toString("utf8");
          const outcome = readLine(text, consumed, lineEnd - consumed, lineEnd === size, shardDevice, options.partitionRoot);
          if (outcome.kind === "hold") {
            held = true;
            break;
          }
          if (outcome.kind === "diagnostic")
            diagnostics.push(outcome.diagnostic);
          if (outcome.kind === "record") {
            records.push(outcome.record);
            if (outcome.compaction !== null)
              compactions.push(outcome.compaction);
          }
        }
        carry = [];
        carried = 0;
        consumed = lineEnd;
        cursor = end + 1;
      }
    }
    if (!held && oversized) {
      overlong();
      consumed = position;
    }
    if (options.partitionRoot !== undefined)
      observeRead(options.partitionRoot, records);
    const marked = options.partitionRoot === undefined ? { records, diagnostics } : markQuarantined(fd, path, options.partitionRoot, records, diagnostics);
    return {
      records: marked.records,
      diagnostics: marked.diagnostics,
      compactions,
      nextOffset: consumed,
      pendingTailBytes: size - consumed,
      size
    };
  } finally {
    closeSync7(fd);
  }
}
function shardReadGap(read) {
  const reasons = [];
  const pending = read.records.filter((r) => r.bodyState === "pending" && r.quarantined !== true).length;
  if (pending > 0) {
    reasons.push(pending === 1 ? "a record whose body is a blob that has not arrived yet" : `${pending} records whose bodies are blobs that have not arrived yet`);
  }
  for (const d of read.diagnostics) {
    if (d.torn === true || d.quarantined === true)
      continue;
    reasons.push(`${d.kind} at byte ${d.offset}: ${d.reason}`);
  }
  return reasons.length === 0 ? null : reasons.join("; ");
}
function replacedShards(compactions) {
  const out = new Set;
  for (const compaction of compactions)
    for (const rel of compaction.replaces)
      out.add(rel);
  return out;
}
var NEWLINE2 = 10, READ_CHUNK_BYTES;
var init_reader = __esm(() => {
  init_config();
  init_constants();
  init_blobs();
  init_clock_floor();
  init_hlc();
  init_envelope();
  init_safe_fs();
  init_shard_quarantine();
  init_shard_list();
  init_torn_line();
  READ_CHUNK_BYTES = 1024 * 1024;
});

// src/core/store/device-retirement.ts
function isRetire(record) {
  const device = record.body["device"];
  return record.kind === DEVICE_RETIRE_KIND && record.body[AUTHORITY_FIELD] === "human" && typeof device === "string" && isValidDeviceId(device);
}
function latestRetirements(records) {
  const out = new Map;
  for (const record of records.filter(isRetire).toSorted(compareRecords)) {
    out.set(record.body["device"], record);
  }
  return out;
}
var init_device_retirement = __esm(() => {
  init_config();
  init_constants();
  init_envelope();
});

// src/core/store/format-doc.ts
import { readFileSync as readFileSync9 } from "node:fs";
import { join as join14 } from "node:path";
import { fileURLToPath } from "node:url";
function shippedFormatDoc() {
  shipped ??= readFileSync9(join14(fileURLToPath(new URL(".", import.meta.url)), STORE_FORMAT_FILE), "utf8");
  return shipped;
}
function formatDocVersion(text) {
  const match = VERSION_MARKER_RE.exec(text);
  return match === null ? null : Number(match[1]);
}
function writeFormatDoc(dir) {
  const text = shippedFormatDoc();
  const target = join14(dir, STORE_FORMAT_FILE);
  let existing = null;
  try {
    existing = readFileSync9(target, "utf8");
  } catch {
    existing = null;
  }
  if (existing === text)
    return false;
  if (existing !== null) {
    const onDisk = formatDocVersion(existing);
    const ours = formatDocVersion(text);
    if (onDisk !== null && ours !== null && onDisk >= ours)
      return false;
  }
  return atomicWriteText(target, text, { mode: FORMAT_DOC_MODE });
}
var VERSION_MARKER_RE, FORMAT_DOC_MODE = 420, shipped;
var init_format_doc = __esm(() => {
  init_fs_atomic();
  init_constants();
  VERSION_MARKER_RE = /^<!-- open-second-brain-store-format: (\d+) -->/;
});

// src/core/store/held-ledger.ts
import { createHash as createHash3 } from "node:crypto";
import { existsSync as existsSync5, mkdirSync as mkdirSync9, rmSync as rmSync2 } from "node:fs";
import { join as join15, resolve as resolve7 } from "node:path";
function ledgerDir(dirs = processDirsEnv()) {
  return join15(storesStateDir(dirs), HELD_LEDGER_DIR);
}
function markerPath(dir, root, partition) {
  const key = createHash3("sha256").update(resolve7(root)).digest("hex").slice(0, 32);
  return join15(dir, `${key}.${partition}`);
}
function recordHeldPartitions(root, partitions, dirs) {
  const dir = ledgerDir(dirs);
  for (const partition of partitions) {
    const marker = markerPath(dir, root, partition);
    if (existsSync5(marker))
      continue;
    try {
      mkdirSync9(dir, { recursive: true });
      atomicWriteFileSync(marker, `${resolve7(root)}
`);
    } catch {}
  }
}
function lostHeldPartitions(root, held) {
  if (STORE_PARTITIONS.every((p) => held.has(p)))
    return [];
  const dir = ledgerDir();
  return STORE_PARTITIONS.filter((p) => !held.has(p) && existsSync5(markerPath(dir, root, p)));
}
var HELD_LEDGER_DIR = "held-partitions";
var init_held_ledger = __esm(() => {
  init_fs_atomic();
  init_platform_dirs();
  init_constants();
  init_store_paths();
});

// src/core/store/store-open.ts
import { readFileSync as readFileSync10, statSync as statSync7 } from "node:fs";
import { join as join16 } from "node:path";
function readStoreId(dir) {
  let text;
  try {
    text = readFileSync10(join16(dir, STORE_IDENTITY_FILE), "utf8");
  } catch (err) {
    if (err.code === "ENOENT")
      return null;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StoreIdentityError(`${join16(dir, STORE_IDENTITY_FILE)} is not valid JSON`);
  }
  if (!isUlid(parsed.store_id)) {
    throw new StoreIdentityError(`${join16(dir, STORE_IDENTITY_FILE)} carries no valid store_id`);
  }
  return parsed.store_id;
}
function heldPartitions(root) {
  if (statSync7(root, { throwIfNoEntry: false })?.isDirectory() === false) {
    throw new StoreOpenError(`the brain store root ${root} is not a directory; move the file away or point ` + "the store root at a directory");
  }
  const ids = new Map;
  for (const partition of STORE_PARTITIONS) {
    const id = readStoreId(partitionDir(root, partition));
    if (id !== null)
      ids.set(partition, id);
  }
  if (new Set(ids.values()).size > 1) {
    throw new StoreOpenError(`the partitions under ${root} belong to different stores (${[...ids].map(([p, id]) => `${p}: ${id}`).join(", ")}); keep one store per root`);
  }
  const first = ids.values().next();
  return { held: new Set(ids.keys()), storeId: first.done === true ? null : first.value };
}
function heldPartitionsChecked(root) {
  const found = heldPartitions(root);
  const lost = lostHeldPartitions(root, found.held);
  if (lost.length > 0)
    throw new HeldPartitionLostError(root, lost);
  return found;
}
function inspectStore(root) {
  const { held, storeId } = heldPartitionsChecked(root);
  return storeId === null ? null : { root, storeId, partitions: held };
}
function openStore(options) {
  if (!isUsableLocalDeviceId(options.device)) {
    throw new StoreOpenError(`the brain store needs a device id, got "${options.device}"; set device_id in the machine ` + `config or O2B_DEVICE_ID to lowercase letters, digits and hyphens`);
  }
  const { held, storeId } = heldPartitionsChecked(options.root);
  if (storeId === null)
    throw new NoStoreError(options.root);
  recordHeldPartitions(options.root, held, options.dirs);
  writeFormatDoc(options.root);
  for (const partition of held)
    writeFormatDoc(partitionDir(options.root, partition));
  return {
    root: options.root,
    storeId,
    device: options.device,
    deviceStateDir: deviceStateDirFor(storeId, options.dirs ?? processDirsEnv()),
    partitions: held
  };
}
var StoreOpenError, NoStoreError, StoreIdentityError, HeldPartitionLostError;
var init_store_open = __esm(() => {
  init_platform_dirs();
  init_config();
  init_constants();
  init_format_doc();
  init_held_ledger();
  init_store_paths();
  init_ulid();
  StoreOpenError = class StoreOpenError extends Error {
    constructor(message) {
      super(message);
      this.name = "StoreOpenError";
    }
  };
  NoStoreError = class NoStoreError extends StoreOpenError {
    root;
    constructor(root) {
      super(`no brain store at ${root}: no partition holds ${STORE_IDENTITY_FILE}; ` + "run `o2b store init` to create one, or let sync deliver it from a machine that has it");
      this.root = root;
      this.name = "NoStoreError";
    }
  };
  StoreIdentityError = class StoreIdentityError extends StoreOpenError {
    constructor(message) {
      super(message);
      this.name = "StoreIdentityError";
    }
  };
  HeldPartitionLostError = class HeldPartitionLostError extends StoreOpenError {
    root;
    partitions;
    constructor(root, partitions) {
      const leave = partitions.includes("shared") ? "" : `, or run ${partitions.map((p) => `\`o2b store partition leave ${p}\``).join(" and ")} to stop holding ${partitions.length > 1 ? "them" : "it"} on this machine`;
      super(`the ${partitions.join(" and ")} partition${partitions.length > 1 ? "s" : ""} of the ` + `brain store at ${root}, which this machine has held, no longer show${partitions.length > 1 ? "" : "s"} ${STORE_IDENTITY_FILE}; its records cannot be read, so the store is not opened. ` + `Restore ${partitions.map((p) => `${p}/${STORE_IDENTITY_FILE}`).join(" and ")} ` + `from sync or a backup${leave}`);
      this.root = root;
      this.partitions = partitions;
      this.name = "HeldPartitionLostError";
    }
  };
});

// src/core/store/seen-shards.ts
import { mkdirSync as mkdirSync10, readFileSync as readFileSync11, statSync as statSync8 } from "node:fs";
import { createHash as createHash4 } from "node:crypto";
import { basename as basename6, dirname as dirname11, join as join17, resolve as resolve8 } from "node:path";
function isPartition2(value) {
  return STORE_PARTITIONS.includes(value);
}
function stampOf2(path) {
  const stat = statSync8(path, { throwIfNoEntry: false });
  return stat === undefined ? "absent" : `${stat.size}:${stat.mtimeMs}`;
}
function parseLedger(text) {
  const out = new Map;
  const parsed = JSON.parse(text);
  for (const [partition, rels] of Object.entries(parsed.shards ?? {})) {
    if (!isPartition2(partition) || !Array.isArray(rels))
      continue;
    out.set(partition, new Set(rels.filter((r) => typeof r === "string")));
  }
  return out;
}
function load3(path) {
  let stamp;
  try {
    stamp = stampOf2(path);
  } catch {
    return new Map;
  }
  const hit = loaded2.get(path);
  if (hit !== undefined && hit.stamp === stamp)
    return hit.ledger;
  let ledger = new Map;
  if (stamp !== "absent") {
    try {
      ledger = parseLedger(readFileSync11(path, "utf8"));
    } catch {}
  }
  loaded2.set(path, { stamp, ledger });
  return ledger;
}
function update2(path, change) {
  try {
    loaded2.delete(path);
    const ledger = load3(path);
    change(ledger);
    const shards = {};
    for (const [partition, rels] of [...ledger].toSorted(([a], [b]) => compareCodeUnits(a, b))) {
      shards[partition] = [...rels].toSorted();
    }
    mkdirSync10(dirname11(path), { recursive: true });
    atomicWriteText(path, `${JSON.stringify({ version: 1, shards }, null, 2)}
`);
    loaded2.set(path, { stamp: stampOf2(path), ledger });
  } catch {
    loaded2.delete(path);
  }
}
function seenLedgerFile(storeRoot, storeId) {
  const rootKey = createHash4("sha256").update(resolve8(storeRoot)).digest("hex").slice(0, 16);
  const name = SEEN_SHARDS_FILE.replace(/\.json$/, `-${rootKey}.json`);
  return join17(deviceStateDirFor(storeId, processDirsEnv()), name);
}
function ledgerPath2(partitionRoot) {
  const partition = basename6(partitionRoot);
  if (!isPartition2(partition))
    return null;
  let storeId;
  try {
    storeId = readStoreId(partitionRoot);
  } catch {
    return null;
  }
  if (storeId === null)
    return null;
  return { path: seenLedgerFile(dirname11(partitionRoot), storeId), partition };
}
function deviceOf(rel) {
  const parts = rel.split("/");
  return parts[parts.length - 2] ?? "";
}
function monthOf(rel) {
  return rel.slice(rel.lastIndexOf("/") + 1).slice(0, 7);
}
function retiredDevices(storeRoot) {
  const sharedRoot = partitionDir(storeRoot, "shared");
  const records = [];
  try {
    for (const shard of listShards(sharedRoot, { stream: "settings" })) {
      try {
        for (const r of readShard(shard.path, { partitionRoot: sharedRoot }).records) {
          if (r.bodyState !== "pending")
            records.push(r.record);
        }
      } catch {}
    }
  } catch {
    return new Set;
  }
  return new Set(latestRetirements(records).keys());
}
function trackSeenShards(partitionRoot, scope, listed, replaced = new Set) {
  const at = ledgerPath2(partitionRoot);
  if (at === null)
    return [];
  const seen = load3(at.path).get(at.partition) ?? new Set;
  const present = new Set(listed);
  const fresh = listed.filter((rel) => !seen.has(rel));
  let missing = [...seen].filter((rel) => rel.startsWith(scope.prefix) && !present.has(rel) && (scope.device === undefined || deviceOf(rel) === scope.device) && (scope.month === undefined || scope.month(monthOf(rel))));
  let expected = missing.filter((rel) => replaced.has(rel));
  missing = missing.filter((rel) => !replaced.has(rel));
  if (missing.length > 0) {
    const retired = retiredDevices(dirname11(partitionRoot));
    expected = [...expected, ...missing.filter((rel) => retired.has(deviceOf(rel)))];
    missing = missing.filter((rel) => !retired.has(deviceOf(rel)));
  }
  if (readOnlyDepth === 0 && (fresh.length > 0 || expected.length > 0)) {
    update2(at.path, (ledger) => {
      const own = ledger.get(at.partition) ?? new Set;
      for (const rel of fresh)
        own.add(rel);
      for (const rel of expected)
        own.delete(rel);
      ledger.set(at.partition, own);
    });
  }
  return missing.toSorted();
}
var loaded2, readOnlyDepth = 0, SEEN_SHARD_MISSING_REASON;
var init_seen_shards = __esm(() => {
  init_fs_atomic();
  init_platform_dirs();
  init_constants();
  init_device_retirement();
  init_reader();
  init_shard_list();
  init_store_open();
  init_store_paths();
  loaded2 = new Map;
  SEEN_SHARD_MISSING_REASON = "this machine read the shard before and it is gone now (the store never deletes a shard); " + "its records are unknown until sync delivers it again";
});

// src/core/store/state-digest.ts
var init_state_digest = __esm(() => {
  init_digest();
  init_appender();
  init_clock_store();
  init_constants();
  init_envelope();
  init_fold_pinned();
  init_fold_preferences();
  init_fold_settings();
  init_hlc();
  init_reader();
  init_seen_shards();
  init_shard_list();
  init_store_paths();
});

// src/core/record-path.ts
var init_record_path = __esm(() => {
  init_path_safety();
});

// src/core/store/read/stream-read.ts
function monthOf2(rel) {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return name.slice(0, 7);
}
function streamPrefix(ref) {
  return ref.ledger !== undefined ? `${ref.stream}/${ref.ledger}` : ref.stream;
}
function readStreamRecords(root, partition, ref, options = {}) {
  const partitionRoot = partitionDir(root, partition);
  const records = [];
  const unreadable = [];
  let shards;
  try {
    shards = listShards(partitionRoot, ref);
  } catch {
    return { records, unreadable: [streamPrefix(ref)], skippedPending: false };
  }
  const compactions = [];
  let skippedPending = false;
  for (const shard of shards) {
    if (options.device !== undefined && shard.device !== options.device)
      continue;
    if (options.month !== undefined && !options.month(monthOf2(shard.rel)))
      continue;
    let read;
    try {
      read = readShard(shard.path, { partitionRoot });
    } catch {
      unreadable.push(shard.rel);
      continue;
    }
    if (read.diagnostics.some((d) => d.kind === "not-a-file")) {
      unreadable.push(shard.rel);
      continue;
    }
    if (shardReadGap(read) !== null)
      unreadable.push(shard.rel);
    compactions.push(...read.compactions);
    for (const entry of read.records) {
      if (entry.bodyState !== "pending")
        records.push(entry.record);
      else
        skippedPending = true;
    }
  }
  const gone = trackSeenShards(partitionRoot, {
    prefix: `${streamPrefix(ref)}/`,
    ...options.device !== undefined ? { device: options.device } : {},
    ...options.month !== undefined ? { month: options.month } : {}
  }, shards.map((shard) => shard.rel), replacedShards(compactions));
  return { records, unreadable: [...unreadable, ...gone], skippedPending };
}
var init_stream_read = __esm(() => {
  init_reader();
  init_seen_shards();
  init_shard_list();
  init_store_paths();
});

// src/core/store-migration/migration-records.ts
function sharedSettings(store) {
  if (!store.partitions.has("shared"))
    return [];
  return [...readStreamRecords(store.root, "shared", { stream: MIGRATION_STREAM }).records];
}
function isHuman(record) {
  return record.body[AUTHORITY_FIELD] === "human";
}
function switchedDevices(records) {
  const latest = new Map;
  for (const record of records) {
    if (record.kind !== DEVICE_SWITCHED_KIND && record.kind !== DEVICE_UNSWITCHED_KIND)
      continue;
    if (record.body["device"] !== record.device || !isHuman(record))
      continue;
    const seen = latest.get(record.device);
    if (seen === undefined || compareRecords(record, seen) > 0)
      latest.set(record.device, record);
  }
  const out = new Set;
  for (const [device, record] of latest)
    if (record.kind === DEVICE_SWITCHED_KIND)
      out.add(device);
  return out;
}
function isDeviceSwitched(store, deviceId) {
  return switchedDevices(sharedSettings(store)).has(deviceId);
}
var MIGRATION_COHORT_KIND = "migration-cohort", MIGRATION_DONE_KIND = "migration-done", DEVICE_SWITCHED_KIND = "device-switched", DEVICE_UNSWITCHED_KIND = "device-unswitched", LEGACY_TREE_REMOVED_KIND = "legacy-tree-removed", MIGRATION_RECORD_KINDS, MIGRATION_STREAM = "settings";
var init_migration_records = __esm(() => {
  init_record_path();
  init_constants();
  init_device_retirement();
  init_envelope();
  init_state_digest();
  init_stream_read();
  init_store_paths();
  MIGRATION_RECORD_KINDS = Object.freeze([
    MIGRATION_COHORT_KIND,
    MIGRATION_DONE_KIND,
    DEVICE_SWITCHED_KIND,
    DEVICE_UNSWITCHED_KIND,
    LEGACY_TREE_REMOVED_KIND
  ]);
});

// src/core/store-migration/journal-scope.ts
var init_journal_scope = __esm(() => {
  init_digest();
  init_migration_records();
});

// src/core/store-migration/journal.ts
var MIGRATION_STATE_DIR = "migration";
var init_journal = __esm(() => {
  init_fs_atomic();
  init_state_digest();
  init_store_paths();
  init_journal_scope();
  init_migration_records();
});

// src/core/store/store-only.ts
import { existsSync as existsSync6, mkdirSync as mkdirSync11, readFileSync as readFileSync12 } from "node:fs";
import { dirname as dirname12, join as join18 } from "node:path";
function hasLegacyTree(vault) {
  if (vault === null || vault.trim() === "")
    return false;
  return existsSync6(join18(vault, BRAIN_ROOT_REL));
}
function markerPath2() {
  return join18(storesStateDir(processDirsEnv()), SWITCH_MARKER_FILE);
}
function markerKey(root, device) {
  return `${root}\x00${device}`;
}
function readMarker() {
  try {
    const parsed = JSON.parse(readFileSync12(markerPath2(), "utf8"));
    if (!Array.isArray(parsed.switched))
      return new Set;
    return new Set(parsed.switched.filter((e) => typeof e === "object" && e !== null && typeof e.root === "string" && typeof e.device === "string").map((e) => markerKey(e.root, e.device)));
  } catch {
    return new Set;
  }
}
function updateMarker(change, strict = false) {
  try {
    mkdirSync11(dirname12(markerPath2()), { recursive: true });
    withLocalLock(markerPath2(), () => {
      const known = readMarker();
      if (!change(known))
        return;
      const switched = [...known].map((key) => {
        const [r, d] = key.split("\x00");
        return { root: r, device: d };
      });
      atomicWriteFileSync(markerPath2(), `${JSON.stringify({ switched }, null, 2)}
`);
    });
  } catch (err) {
    if (strict)
      throw err;
  }
}
function writeMarker(root, device, strict = false) {
  const key = markerKey(root, device);
  updateMarker((known) => {
    if (known.has(key))
      return false;
    known.add(key);
    return true;
  }, strict);
}
function vaultOf(context) {
  if (context.vault !== undefined)
    return context.vault;
  try {
    return resolveVault(context.configPath);
  } catch {
    return null;
  }
}
function configuredSwitchKey(configPath) {
  try {
    const device = readDeviceId(configPath ?? null);
    const root = resolveConfiguredStoreRoot(configPath).root;
    return device === null ? null : { root, device };
  } catch {
    return null;
  }
}
function markedKey(key) {
  if (seenSwitched.has(key))
    return true;
  if (!readMarker().has(key))
    return false;
  seenSwitched.add(key);
  return true;
}
function isSwitched(context, options) {
  const at = configuredSwitchKey(context.configPath);
  if (at === null)
    return false;
  const { root, device } = at;
  const key = markerKey(root, device);
  if (markedKey(key))
    return true;
  let store;
  try {
    store = inspectStore(root);
  } catch {
    return false;
  }
  if (store === null)
    return false;
  let switched;
  try {
    switched = (options.readSwitched ?? readSwitchRecords)(store, device);
  } catch {
    switched = false;
  }
  if (switched && options.persistSwitch !== false) {
    seenSwitched.add(key);
    writeMarker(root, device);
  }
  return switched;
}
function storeOnlyMode(context = {}, options = {}) {
  const vault = vaultOf(context);
  if (isSwitched(context, options))
    return { storeOnly: true, reason: "device-switched", vault };
  if (!hasLegacyTree(vault))
    return { storeOnly: true, reason: "no-legacy-tree", vault };
  return { storeOnly: false, reason: "legacy", vault };
}
function isStoreOnly(context = {}, options = {}) {
  return storeOnlyMode(context, options).storeOnly;
}
var SWITCH_MARKER_FILE = "store-only.json", readSwitchRecords = (store, deviceId) => isDeviceSwitched(store, deviceId), seenSwitched;
var init_store_only = __esm(() => {
  init_path_constants();
  init_config();
  init_fs_atomic();
  init_migration_records();
  init_platform_dirs();
  init_local_lock();
  init_store_open();
  init_store_paths();
  seenSwitched = new Set;
});

// src/core/brain/secrets/owner-acl.ts
import { spawnSync } from "node:child_process";
import { resolve as resolve9, win32 as win323 } from "node:path";
function system32Tool(name, env = process.env) {
  const root = env["SystemRoot"] || env["windir"] || "C:\\Windows";
  return win323.join(root, "System32", name);
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
  const key = `${kind}:${resolve9(path).toLowerCase()}`;
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

// src/core/state/state-moves.ts
import { randomBytes as randomBytes3 } from "node:crypto";
import {
  chmodSync,
  closeSync as closeSync8,
  constants as constants2,
  copyFileSync,
  existsSync as existsSync7,
  fsyncSync as fsyncSync4,
  openSync as openSync6,
  linkSync as linkSync3,
  lstatSync as lstatSync3,
  mkdirSync as mkdirSync12,
  readdirSync as readdirSync3,
  readFileSync as readFileSync13,
  rmdirSync,
  statSync as statSync9,
  unlinkSync as unlinkSync4,
  utimesSync,
  writeFileSync,
  writeSync as writeSync5
} from "node:fs";
import { basename as basename7, dirname as dirname13, join as join19, relative as relative4, sep as sep4 } from "node:path";
function filesBelow(path) {
  let stat;
  try {
    stat = lstatSync3(path);
  } catch {
    return [];
  }
  if (stat.isFile())
    return TEMP_NAME_RE.test(basename7(path)) ? [] : [path];
  if (!stat.isDirectory())
    return [];
  return readdirSync3(path).toSorted().flatMap((name) => filesBelow(join19(path, name)));
}
function sameBytes(a, b) {
  try {
    if (statSync9(a).size !== statSync9(b).size)
      return false;
    return readFileSync13(a).equals(readFileSync13(b));
  } catch {
    return false;
  }
}
function mkdirOwnerOnly(dir) {
  const created = mkdirSync12(dir, { recursive: true, mode: 448 });
  if (created !== undefined && process.platform === "win32")
    restrictToOwner(created, "directory");
}
function writeExclusive(path, bytes) {
  const fd = openSync6(path, "wx", 384);
  try {
    writeSync5(fd, bytes);
    fsyncSync4(fd);
  } catch (err) {
    closeSync8(fd);
    tryUnlink(path);
    throw err;
  }
  closeSync8(fd);
}
function tryUnlink(path) {
  try {
    unlinkSync4(path);
  } catch {}
}
function copyNoClobber(file, target) {
  if (existsSync7(target))
    return false;
  mkdirOwnerOnly(dirname13(target));
  const temp = join19(dirname13(target), `.${basename7(target)}${TEMP_INFIX}${randomBytes3(6).toString("hex")}`);
  const { atime, mtime } = statSync9(file);
  try {
    copyFileSync(file, temp, constants2.COPYFILE_EXCL);
    if (process.platform !== "win32")
      chmodSync(temp, 384);
    utimesSync(temp, atime, mtime);
    try {
      linkSync3(temp, target);
      return true;
    } catch (err) {
      if (err.code === "EEXIST")
        return false;
    }
    try {
      writeExclusive(target, readFileSync13(temp));
    } catch (err) {
      if (err.code === "EEXIST")
        return false;
      throw err;
    }
    utimesSync(target, atime, mtime);
    return true;
  } finally {
    if (existsSync7(temp))
      tryUnlink(temp);
  }
}
function removeEmptyDirs(dir) {
  let stat;
  try {
    stat = lstatSync3(dir);
  } catch {
    return;
  }
  if (!stat.isDirectory())
    return;
  for (const name of readdirSync3(dir))
    removeEmptyDirs(join19(dir, name));
  try {
    rmdirSync(dir);
  } catch {}
}
function sameLanded(file, target, aside, rel) {
  if (sameBytes(file, target))
    return true;
  for (let n = 0;n < 100; n++) {
    const kept = join19(aside, n === 0 ? rel : `${rel}.${n}`);
    if (!existsSync7(kept))
      return false;
    if (sameBytes(file, kept))
      return true;
  }
  return false;
}
function keepAside(file, aside, rel) {
  for (let n = 0;n < 100; n++) {
    const kept = join19(aside, n === 0 ? rel : `${rel}.${n}`);
    if (sameBytes(file, kept))
      return true;
    if (!existsSync7(kept)) {
      copyNoClobber(file, kept);
      if (sameBytes(file, kept))
        return true;
    }
  }
  return false;
}
function adoptFolder(from, to) {
  if (from === to)
    return true;
  if (!existsSync7(from))
    return true;
  let settled = true;
  const aside = join19(dirname13(to), ADOPT_CONFLICTS_DIR, basename7(from));
  for (const file of filesBelow(from)) {
    const rel = relative4(from, file);
    const target = join19(to, rel);
    try {
      const landed = copyNoClobber(file, target) || sameBytes(file, target) || keepAside(file, aside, rel);
      if (!landed || !sameLanded(file, target, aside, rel)) {
        settled = false;
        continue;
      }
      unlinkSync4(file);
    } catch {
      settled = false;
    }
  }
  removeEmptyDirs(from);
  return settled && filesBelow(from).length === 0;
}
function seedFolderOnce(from, to, marker) {
  if (existsSync7(marker) || !existsSync7(from))
    return;
  try {
    const seeded = [];
    for (const file of filesBelow(from)) {
      const rel = relative4(from, file);
      if (copyNoClobber(file, join19(to, rel)))
        seeded.push(rel.split(sep4).join("/"));
    }
    mkdirSync12(dirname13(marker), { recursive: true });
    writeFileSync(marker, `${JSON.stringify({ from, seeded }, null, 2)}
`);
  } catch {}
}
var ADOPT_CONFLICTS_DIR = "adopt-conflicts", TEMP_INFIX = ".adopt-", TEMP_NAME_RE;
var init_state_moves = __esm(() => {
  init_owner_acl();
  TEMP_NAME_RE = /^\..+\.adopt-[0-9a-f]{12}$/;
});

// src/core/state/machine-state.ts
import { createHash as createHash5 } from "node:crypto";
import { cpSync, existsSync as existsSync8, readdirSync as readdirSync4, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname14, join as join20, relative as relative5, resolve as resolve10, sep as sep5 } from "node:path";
function storeIdAt(root) {
  const known = STORE_IDS.get(root);
  if (known !== undefined)
    return known;
  let id;
  try {
    id = heldPartitions(root).storeId;
  } catch {
    id = null;
  }
  if (id !== null)
    STORE_IDS.set(root, id);
  return id;
}
function configuredStoreId(configPath) {
  try {
    return storeIdAt(resolveConfiguredStoreRoot(configPath).root);
  } catch {
    return null;
  }
}
function deviceStateDir(storeId) {
  const source = processDirsEnv();
  return storeId === null ? storesStateDir(source) : deviceStateDirFor(storeId, source);
}
function vaultKey(vault) {
  return createHash5("sha256").update(resolve10(vault)).digest("hex").slice(0, VAULT_KEY_CHARS);
}
function freshVaultRel(vault) {
  return join20(FRESH_STATE_DIR, vaultKey(vault));
}
function adoptOnce(from, to) {
  if (from === to || ADOPTED.has(from) || !existsSync8(from))
    return;
  if (adoptFolder(from, to))
    ADOPTED.add(from);
}
function seedFromVaultOnce(vault, root) {
  const marker = join20(root, SEEDED_MARKER_DIR, `${vaultKey(vault)}.json`);
  seedFolderOnce(join20(vault, DERIVED_STORE_DIR), join20(root, DERIVED_STORE_DIR), marker);
}
function restoreBackupOnce(local) {
  if (RESTORED.has(local))
    return;
  const migration = dirname14(local);
  const marker = join20(migration, BACKUP_RESTORED_MARKER);
  if (existsSync8(marker)) {
    RESTORED.add(local);
    return;
  }
  const files = join20(migration, MIGRATION_BACKUP_DIR, MIGRATION_BACKUP_FILES_DIR);
  if (!existsSync8(files)) {
    RESTORED.add(local);
    return;
  }
  try {
    const restored = [];
    for (const file of filesBelow(files)) {
      const rel = relative5(files, file);
      const target = join20(local, rel);
      if (existsSync8(target))
        continue;
      cpSync(file, target, { preserveTimestamps: true });
      restored.push(rel.split(sep5).join("/"));
    }
    writeFileSync2(marker, `${JSON.stringify({ restored }, null, 2)}
`);
    RESTORED.add(local);
  } catch {}
}
function machineStateLocation(vault, configPath) {
  return locate(vault, configPath, true);
}
function locate(vault, configPath, settle) {
  const hasVault = vault !== null && vault.trim() !== "" && vault !== noVaultRoot();
  if (hasVault) {
    const mode = storeOnlyMode({ vault, ...configPath !== undefined ? { configPath } : {} });
    if (!mode.storeOnly)
      return { relocated: false, root: vault };
    if (mode.reason === "no-legacy-tree") {
      const storeId2 = configuredStoreId(configPath);
      const root2 = join20(deviceStateDir(storeId2), freshVaultRel(vault));
      if (!settle)
        return { relocated: true, root: root2 };
      if (storeId2 !== null)
        adoptOnce(join20(deviceStateDir(null), freshVaultRel(vault)), root2);
      seedFromVaultOnce(vault, root2);
      return { relocated: true, root: root2 };
    }
  }
  const storeId = configuredStoreId(configPath);
  const root = join20(deviceStateDir(storeId), MIGRATION_STATE_DIR, MIGRATION_LOCAL_DIR);
  if (!settle)
    return { relocated: true, root };
  if (storeId !== null) {
    adoptOnce(join20(deviceStateDir(null), MIGRATION_STATE_DIR, MIGRATION_LOCAL_DIR), root);
  }
  if (hasVault) {
    adoptOnce(join20(deviceStateDir(null), freshVaultRel(vault)), root);
    if (storeId !== null)
      adoptOnce(join20(deviceStateDir(storeId), freshVaultRel(vault)), root);
    if (!existsSync8(join20(vault, BRAIN_ROOT_REL)))
      seedFromVaultOnce(vault, root);
  }
  restoreBackupOnce(root);
  return { relocated: true, root };
}
function machineStateRoot(vault, configPath) {
  return machineStateLocation(vault, configPath).root;
}
function machineStatePath(vault, ...segments) {
  return machineStatePathIn(machineStateRoot(vault), ...segments);
}
function machineStatePathIn(root, ...segments) {
  return ensureInsideVault(join20(root, ...segments), root);
}
var FRESH_STATE_DIR = "fresh", VAULT_KEY_CHARS = 16, BACKUP_RESTORED_MARKER = "local-restored.json", STORE_IDS, ADOPTED, SEEDED_MARKER_DIR, RESTORED;
var init_machine_state = __esm(() => {
  init_path_constants();
  init_path_safety();
  init_platform_dirs();
  init_journal();
  init_store_open();
  init_store_only();
  init_store_paths();
  init_state_moves();
  STORE_IDS = new Map;
  ADOPTED = new Set;
  SEEDED_MARKER_DIR = join20(DERIVED_STORE_DIR, "seeded-from-vault");
  RESTORED = new Set;
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
import { existsSync as existsSync9, readFileSync as readFileSync14, statSync as statSync10 } from "node:fs";
import { resolve as resolve11 } from "node:path";
function markerPathIn(root) {
  return machineStatePathIn(root, BRAIN_INTERNAL_STATE_REL, FROZEN_MARKER_FILE);
}
function parseMarker(path) {
  reloadCount += 1;
  let parsed;
  try {
    parsed = JSON.parse(readFileSync14(path, "utf8"));
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
  const root = resolve11(vault);
  let path = MARKER_PATHS.get(root);
  if (path === undefined) {
    const location = machineStateLocation(root);
    path = markerPathIn(location.root);
    if (location.relocated)
      MARKER_PATHS.set(root, path);
  }
  let stat;
  try {
    stat = statSync10(path, { throwIfNoEntry: false });
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
    path: resolve11(vault),
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
  init_machine_state();
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

// src/core/migration-gate.ts
import { mkdirSync as mkdirSync13, readFileSync as readFileSync15, realpathSync as realpathSync3, unlinkSync as unlinkSync5 } from "node:fs";
import { dirname as dirname15, join as join21, resolve as resolve12 } from "node:path";
function migrationGatePath(source = processDirsEnv()) {
  return join21(stateRootDir(source), GATE_FILE);
}
function canonicalVault(vault) {
  let path;
  try {
    path = realpathSync3(vault);
  } catch {
    path = resolve12(vault);
  }
  return process.platform === "win32" ? path.toLowerCase() : path;
}
function gateNames(gate, vault) {
  return canonicalVault(gate.vault) === canonicalVault(vault);
}
function readMigrationGateState(source) {
  const path = migrationGatePath(source);
  let text = null;
  let code = "";
  for (let attempt = 0;attempt < READ_ATTEMPTS && text === null; attempt++) {
    if (attempt > 0)
      sleepSync(READ_RETRY_MS);
    try {
      text = readFileSync15(path, "utf8");
    } catch (err) {
      code = String(err.code ?? "EIO");
      if (code === "ENOENT")
        return { kind: "none" };
    }
  }
  if (text === null)
    return { kind: "unreadable", code };
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.vault === "string" && typeof parsed.run_id === "string") {
      return {
        kind: "held",
        gate: {
          vault: parsed.vault,
          run_id: parsed.run_id,
          since: typeof parsed.since === "string" ? parsed.since : "",
          pid: typeof parsed.pid === "number" ? parsed.pid : 0,
          ...typeof parsed.started === "string" ? { started: parsed.started } : {}
        }
      };
    }
  } catch {}
  return { kind: "damaged" };
}
function readMigrationGate(source) {
  const state = readMigrationGateState(source);
  if (state.kind === "none")
    return null;
  return state.kind === "held" ? state.gate : UNREADABLE_GATE;
}
function assertNoMigrationInProgress(vault) {
  const gate = readMigrationGate();
  if (gate === null)
    return;
  if (gate.vault === "" || gateNames(gate, vault))
    throw new MigrationInProgressError(gate);
}
var GATE_FILE = "migration-gate.json", MIGRATION_GATE_NEXT_COMMAND = "o2b brain migrate-store --resume", MigrationInProgressError, READ_ATTEMPTS = 3, READ_RETRY_MS = 25, UNREADABLE_GATE;
var init_migration_gate = __esm(() => {
  init_fs_atomic();
  init_platform_dirs();
  MigrationInProgressError = class MigrationInProgressError extends Error {
    gate;
    name = "MigrationInProgressError";
    next_command = MIGRATION_GATE_NEXT_COMMAND;
    constructor(gate) {
      super(`a brain store migration of this vault is in progress on this machine (run ${gate.run_id}, ` + `since ${gate.since}); the write was refused and nothing was written. Try again when ` + "`o2b brain migrate-store` has finished, or resume an interrupted one with `--resume`");
      this.gate = gate;
    }
  };
  UNREADABLE_GATE = Object.freeze({
    vault: "",
    run_id: "unknown",
    since: "",
    pid: 0
  });
});

// src/core/brain/vault-identity.ts
import { existsSync as existsSync10, readFileSync as readFileSync16, statSync as statSync11 } from "node:fs";
import { join as join22, resolve as resolve13 } from "node:path";
function vaultIdentityPath(vault) {
  return ensureInsideVault(join22(vault, BRAIN_ROOT_REL, VAULT_IDENTITY_FILE), vault);
}
function readVaultIdentity(vault) {
  const path = vaultIdentityPath(vault);
  if (!existsSync10(path))
    return null;
  try {
    const parsed = JSON.parse(readFileSync16(path, "utf8"));
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
    stat = statSync11(path, { throwIfNoEntry: false });
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
  const root = resolve13(vault);
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
  const root = resolve13(vault);
  if (lane === WRITE_LANE.content) {
    assertVaultNotFrozen(root);
    assertNoMigrationInProgress(root);
  }
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
  const mismatch = compareStamps({ [VAULT_ID_FIELD2]: pinned }, { [VAULT_ID_FIELD2]: vaultId })[0];
  const evidence = mismatch;
  throw new VaultIdentityMismatchError(degradationNotice({
    code: DEGRADATION_CODE.vaultMarkerMismatch,
    site: SITE2,
    path: root,
    detail: `refusing to write: the store at this root is not the one this process opened (${formatStampMismatch(evidence)})`
  }), evidence);
}
var VAULT_IDENTITY_SCHEMA_VERSION = 1, VAULT_IDENTITY_FILE = "vault-id.json", SITE2 = "vault-identity", VAULT_ID_FIELD2 = "vault_id", VaultIdentityMismatchError, PINNED_IDENTITIES, MARKER_STAMPS2, MARKER_PATHS2;
var init_vault_identity = __esm(() => {
  init_fs_atomic();
  init_path_safety();
  init_degradation();
  init_stamp();
  init_freeze_marker();
  init_migration_gate();
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
import { join as join23, posix as posix6 } from "node:path";
function brainDirs(vault) {
  const brain = ensureInsideVault(join23(vault, BRAIN_ROOT_REL), vault);
  return {
    brain,
    inbox: ensureInsideVault(join23(vault, BRAIN_INBOX_REL), vault),
    processed: ensureInsideVault(join23(vault, BRAIN_PROCESSED_REL), vault),
    archived: ensureInsideVault(join23(vault, BRAIN_ARCHIVED_SIGNALS_REL), vault),
    pending: ensureInsideVault(join23(vault, BRAIN_PENDING_REL), vault),
    preferences: ensureInsideVault(join23(vault, BRAIN_PREFERENCES_REL), vault),
    retired: ensureInsideVault(join23(vault, BRAIN_RETIRED_REL), vault),
    log: ensureInsideVault(join23(vault, BRAIN_LOG_REL), vault),
    entities: ensureInsideVault(join23(vault, BRAIN_ENTITIES_REL), vault),
    bases: ensureInsideVault(join23(vault, BRAIN_BASES_REL), vault),
    snapshots: ensureInsideVault(join23(vault, BRAIN_SNAPSHOTS_REL), vault)
  };
}
function brainDirsForWrite(vault, notices, lane) {
  assertVaultIdentityForWrite(vault, notices, lane);
  return brainDirs(vault);
}
function preferencePath(vault, slug) {
  const s = validateSlug(slug);
  return ensureInsideVault(join23(brainDirs(vault).preferences, `pref-${s}.md`), vault);
}
function retiredPath(vault, slug) {
  const s = validateSlug(slug);
  return ensureInsideVault(join23(brainDirs(vault).retired, `ret-${s}.md`), vault);
}
function validateSlug(slug) {
  const trimmed = slug.trim();
  if (!trimmed)
    throw new Error("slug must not be empty");
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    throw new Error(`slug must not contain path separators: ${slug}`);
  }
  if (/[:*?"<>|\x00-\x1F]/.test(trimmed)) {
    throw new Error(`slug contains invalid character: ${JSON.stringify(slug)}`);
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
var WINDOWS_RESERVED_BASENAME_RE;
var init_paths = __esm(() => {
  init_fs_atomic();
  init_path_safety();
  init_machine_state();
  init_ledger_shards();
  init_path_constants();
  init_vault_identity();
  init_skill_rewrite_tasks();
  init_skill_rewrite();
  init_path_safety();
  init_freeze_marker();
  init_path_constants();
  WINDOWS_RESERVED_BASENAME_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
});

// src/core/graph/transport-reach.ts
var TRANSPORT_REACH, TRANSPORT_REACHES, MAINTENANCE_LANE_REACH;
var init_transport_reach = __esm(() => {
  TRANSPORT_REACH = Object.freeze({
    local: "local",
    remote: "remote"
  });
  TRANSPORT_REACHES = Object.freeze([
    TRANSPORT_REACH.local,
    TRANSPORT_REACH.remote
  ]);
  MAINTENANCE_LANE_REACH = TRANSPORT_REACH.local;
});

// src/core/graph/visibility.ts
function normToken(raw) {
  return raw.normalize("NFC").trim().toLowerCase();
}
function pageVisibility(meta) {
  const v = meta["visibility"];
  const list = Array.isArray(v) ? v : typeof v === "string" && v.length > 0 ? [v] : [];
  return list.map((s) => normToken(String(s))).filter((s) => s.length > 0);
}
function isRemotelyReadable(pageTags, reach) {
  if (reach === TRANSPORT_REACH.local)
    return true;
  return !pageTags.includes(REMOTE_DENY_VISIBILITY_TOKEN);
}
var REMOTE_DENY_VISIBILITY_TOKEN = "private";
var init_visibility = __esm(() => {
  init_transport_reach();
});

// src/core/graph/privacy-markers.ts
function declaredValues(raw) {
  if (typeof raw === "string")
    return [raw];
  if (!Array.isArray(raw))
    return [];
  return raw.filter((v) => typeof v === "string");
}
function hasPrivacyDenyMarker(meta) {
  for (const key of Object.keys(meta)) {
    if (!PRIVACY_MARKER_KEY_TOKENS.has(normToken(key)))
      continue;
    for (const value of declaredValues(meta[key])) {
      if (PRIVACY_DENY_MARKER_VALUES.includes(normToken(value)))
        return true;
    }
  }
  return false;
}
function markerDenyTokens(meta) {
  return hasPrivacyDenyMarker(meta) ? Object.freeze([REMOTE_DENY_VISIBILITY_TOKEN]) : Object.freeze([]);
}
function remoteDenyVisibilityTokens(meta) {
  const declared = pageVisibility(meta);
  const out = [...declared];
  for (const token of markerDenyTokens(meta)) {
    if (!out.includes(token))
      out.push(token);
  }
  return Object.freeze(out);
}
var PRIVACY_MARKER_KEYS, PRIVACY_DENY_MARKER_VALUES, PRIVACY_MARKER_KEY_TOKENS;
var init_privacy_markers = __esm(() => {
  init_visibility();
  PRIVACY_MARKER_KEYS = Object.freeze([
    "access",
    "confidentiality",
    "sensitivity"
  ]);
  PRIVACY_DENY_MARKER_VALUES = Object.freeze([
    "private",
    "secret",
    "confidential"
  ]);
  PRIVACY_MARKER_KEY_TOKENS = Object.freeze(new Set(PRIVACY_MARKER_KEYS.map((key) => normToken(key))));
});

// src/core/vault.ts
import { mkdirSync as mkdirSync14, readFileSync as readFileSync17, readdirSync as readdirSync5, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname16, join as join24, relative as relative6 } from "node:path";
function parseFrontmatterWithNotices(path, opts = {}) {
  const site = opts.site ?? FRONTMATTER_SITE;
  let text;
  try {
    text = readFileSync17(path, "utf8");
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
function listVaultPages(vaultDir, opts) {
  const skipDirs = new Set(opts.skipDirs ?? DEFAULT_SKIP_DIRS);
  const skipFiles = new Set((opts.skipFiles ?? DEFAULT_SKIP_FILES).map((f) => f.toLowerCase()));
  const walked = [];
  walk(vaultDir, vaultDir, skipDirs, skipFiles, walked, {
    sink: opts.notices,
    site: opts.site ?? LIST_VAULT_PAGES_SITE
  });
  const pages = walked.filter((w) => isRemotelyReadable(w.unreadable ? UNMEASURABLE_PAGE_VISIBILITY : remoteDenyVisibilityTokens(w.page.metadata), opts.reach)).map((w) => w.page);
  pages.sort((a, b) => COLLATOR.compare(a.title.toLowerCase(), b.title.toLowerCase()));
  return pages;
}
function walk(root, dir, skipDirs, skipFiles, out, notices) {
  let entries2;
  try {
    entries2 = readdirSync5(dir, { withFileTypes: true });
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
  for (const entry of entries2) {
    const full = join24(dir, entry.name);
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
    const rel = relative6(root, full);
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
var FRONTMATTER_RE, BYTE_ORDER_MARK = 65279, FRONTMATTER_KEY_PATTERN = "[a-zA-Z_][a-zA-Z0-9_-]*", FRONTMATTER_KEY_RE, KEY_VALUE_RE, DASH_ITEM_RE, MEDIA_EXTENSIONS, DEFAULT_SKIP_DIRS, DEFAULT_SKIP_FILES, FRONTMATTER_SITE = "vault.parseFrontmatter", NOTICE_LINE_MAX = 120, NOTICE_LINE_ELLIPSIS = "…", LIST_VAULT_PAGES_SITE = "vault.listVaultPages", COLLATOR, UNMEASURABLE_PAGE_VISIBILITY, DOUBLE_QUOTED_ESCAPES;
var init_vault = __esm(() => {
  init_wikilink();
  init_fs_atomic();
  init_fs_utils();
  init_degradation();
  init_path_safety();
  init_privacy_markers();
  init_visibility();
  init_fs_utils();
  FRONTMATTER_RE = /^---[^\S\n]*\n([\s\S]*?)\n---\s*\n?/;
  FRONTMATTER_KEY_RE = new RegExp(`^${FRONTMATTER_KEY_PATTERN}$`);
  KEY_VALUE_RE = new RegExp(`^(${FRONTMATTER_KEY_PATTERN})\\s*:\\s*(.*?)\\s*$`);
  DASH_ITEM_RE = /^-(?:\s+(.*))?$/;
  MEDIA_EXTENSIONS = new Set([
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
  DEFAULT_SKIP_DIRS = [".git", ".obsidian", ".trash", ".stversions"];
  DEFAULT_SKIP_FILES = ["index.md", "log.md"];
  COLLATOR = new Intl.Collator("en", { numeric: true });
  UNMEASURABLE_PAGE_VISIBILITY = Object.freeze([
    REMOTE_DENY_VISIBILITY_TOKEN
  ]);
  DOUBLE_QUOTED_ESCAPES = Object.freeze({
    "\\": "\\",
    '"': '"',
    n: `
`,
    r: "\r",
    t: "\t"
  });
});

// src/core/store/private-page.ts
function isPrivateFrontmatter(frontmatter) {
  return remoteDenyVisibilityTokens(frontmatter).includes(REMOTE_DENY_VISIBILITY_TOKEN);
}
function isPrivatePageFile(path) {
  const [frontmatter, , notices] = parseFrontmatterWithNotices(path);
  if (notices.some((n) => n.code === DEGRADATION_CODE.frontmatterUnreadable))
    return true;
  return isPrivateFrontmatter(frontmatter);
}
var init_private_page = __esm(() => {
  init_privacy_markers();
  init_visibility();
  init_degradation();
  init_vault();
});

// src/core/store/fold-signals.ts
function isPlainObject4(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function lifecycleOf(state) {
  return state === "approved" ? "active" : state;
}
function rejection3(record) {
  if (recordAuthority(record) === null)
    return "missing or invalid authority";
  const id = record.body["signal"];
  if (typeof id !== "string" || id === "")
    return "signal must be a non-empty string";
  const state = record.body["state"];
  const fields = record.body["fields"];
  if (state !== undefined && (typeof state !== "string" || !STATE_SET.has(state))) {
    return `state must be one of ${SIGNAL_STATE_VALUES.join(", ")}`;
  }
  if (fields !== undefined && !isPlainObject4(fields))
    return "fields must be an object";
  if (state === undefined && fields === undefined)
    return "a state or fields is required";
  return null;
}
function building(map, id) {
  let entry = map.get(id);
  if (entry === undefined) {
    entry = {
      signal: null,
      state: null,
      stateRecord: null,
      patches: new Map,
      history: [],
      removed: false
    };
    map.set(id, entry);
  }
  return entry;
}
function foldSignals(input) {
  const { records } = prepareRecords(input);
  const byId = new Map;
  const rejected = [];
  const removedCounts = new Map;
  const voided = new Set;
  for (const record of records) {
    if (record.kind === SIGNAL_KIND) {
      const id = record.body["id"];
      if (typeof id !== "string" || id === "") {
        rejected.push({
          id: record.id,
          kind: record.kind,
          reason: "id must be a non-empty string"
        });
        continue;
      }
      const entry2 = building(byId, id);
      if (entry2.removed) {
        removedCounts.set(id, (removedCounts.get(id) ?? 0) + entry2.history.length);
        for (const old of entry2.history)
          voided.add(old.id);
        entry2.state = null;
        entry2.stateRecord = null;
        entry2.patches.clear();
        entry2.history = [];
      }
      entry2.signal = record;
      entry2.removed = false;
      entry2.history.push(record);
      continue;
    }
    if (record.kind === SIGNAL_REMOVED_KIND) {
      const id = record.body["signal"];
      if (recordAuthority(record) === null || typeof id !== "string" || id === "") {
        rejected.push({
          id: record.id,
          kind: record.kind,
          reason: "authority and signal required"
        });
        continue;
      }
      const entry2 = building(byId, id);
      removedCounts.set(id, (removedCounts.get(id) ?? 0) + entry2.history.length);
      for (const old of entry2.history)
        voided.add(old.id);
      entry2.signal = null;
      entry2.state = null;
      entry2.stateRecord = null;
      entry2.patches.clear();
      entry2.history = [];
      entry2.removed = true;
      continue;
    }
    if (record.kind !== SIGNAL_STATE_KIND)
      continue;
    const reason = rejection3(record);
    if (reason !== null) {
      rejected.push({ id: record.id, kind: record.kind, reason });
      continue;
    }
    const entry = building(byId, record.body["signal"]);
    entry.history.push(record);
    const state = record.body["state"];
    if (typeof state === "string") {
      entry.state = lifecycleOf(state);
      entry.stateRecord = record;
    }
    const fields = record.body["fields"];
    if (isPlainObject4(fields)) {
      for (const [name, value] of Object.entries(fields))
        entry.patches.set(name, value);
    }
  }
  const signals = new Map;
  const orphans = [];
  const removed = new Map(removedCounts);
  for (const [id, entry] of byId) {
    if (entry.removed) {
      removed.set(id, (removed.get(id) ?? 0) + entry.history.length);
      for (const old of entry.history)
        voided.add(old.id);
      continue;
    }
    if (entry.signal === null) {
      orphans.push(...entry.history);
      continue;
    }
    const captured = entry.signal.body["frontmatter"];
    const frontmatter = isPlainObject4(captured) ? { ...captured } : {};
    for (const [name, value] of entry.patches) {
      if (value === null)
        delete frontmatter[name];
      else
        frontmatter[name] = value;
    }
    signals.set(id, {
      id,
      signal: entry.signal,
      state: entry.state ?? (entry.signal.body["staged"] === true ? "staged" : "active"),
      stateRecord: entry.stateRecord,
      frontmatter,
      history: entry.history
    });
  }
  return { signals, removed, voided, orphans, rejected };
}
var SIGNAL_STATE_KIND = "signal-state", SIGNAL_REMOVED_KIND = "signal-removed", SIGNAL_STATE_VALUES, LIVE_SIGNAL_STATES, STATE_SET;
var init_fold_signals = __esm(() => {
  init_constants();
  init_fold();
  SIGNAL_STATE_VALUES = Object.freeze([
    "consumed",
    "archived",
    "retired",
    "expired",
    "staged",
    "approved",
    "rejected"
  ]);
  LIVE_SIGNAL_STATES = new Set(["active", "staged"]);
  STATE_SET = new Set(SIGNAL_STATE_VALUES);
});

// src/core/store/read/store-entities.ts
import { statSync as statSync12 } from "node:fs";
function fingerprintOf(store) {
  const parts = [store.storeId, `quarantine=${quarantineStamp(store.root)}`];
  for (const partition of [...store.partitions].toSorted()) {
    let shards;
    try {
      shards = listShards(partitionDir(store.root, partition), EVENTS);
    } catch {
      parts.push(`${partition}=unlisted:${Date.now()}:${Math.random()}`);
      continue;
    }
    for (const shard of shards) {
      let stamp = "missing";
      try {
        const stat = statSync12(shard.path);
        stamp = `${stat.size}:${stat.mtimeMs}`;
      } catch {}
      parts.push(`${partition}/${shard.rel}=${stamp}`);
    }
  }
  return parts.join(`
`);
}
function signalIsPrivate(record, partition) {
  if (partition === "private")
    return true;
  const frontmatter = record.body["frontmatter"];
  return typeof frontmatter === "object" && frontmatter !== null && !Array.isArray(frontmatter) && isPrivateFrontmatter(frontmatter);
}
function build(store) {
  const all = [];
  const unreadable = [];
  const pinned = new Map;
  let skippedPending = false;
  for (const partition of store.partitions) {
    const read = readStreamRecords(store.root, partition, EVENTS);
    if (read.skippedPending)
      skippedPending = true;
    unreadable.push(...read.unreadable.map((rel) => `${partition}/${rel}`));
    for (const record of read.records)
      all.push({ record, partition });
    pinned.set(partition, foldPinned(read.records.filter((r) => r.kind === PINNED_SET_KIND || r.kind === PINNED_CLEAR_KIND)));
  }
  const degraded = unreadable.length > 0;
  const privateIds = new Set(all.filter((e) => e.partition === "private").map((e) => e.record.id));
  const fold = foldPreferences(all.map((e) => e.record));
  const preferences = new Map;
  for (const [id, state] of fold.preferences) {
    const inPrivate = state.history.some((record) => privateIds.has(record.id));
    const markedPrivate = state.removed ? state.history.some((record) => record.kind === PREFERENCE_SET_KIND && isPrivateFrontmatter(record.body["fields"] ?? {})) : isPrivateFrontmatter(state.fields);
    preferences.set(id, { state, private: degraded || inPrivate || markedPrivate });
  }
  const signals = new Map;
  const partitionOf = new Map(all.map((e) => [e.record.id, e.partition]));
  const signalFold = foldSignals(all.filter((e) => e.record.kind === SIGNAL_KIND || e.record.kind === SIGNAL_STATE_KIND || e.record.kind === SIGNAL_REMOVED_KIND).map((e) => e.record));
  for (const [id, entry] of signalFold.signals) {
    const partition = partitionOf.get(entry.signal.id) ?? "shared";
    const isPrivate = entry.history.some((record) => privateIds.has(record.id)) || entry.history.some((record) => record.kind === SIGNAL_KIND && signalIsPrivate(record, partitionOf.get(record.id) ?? "shared")) || isPrivateFrontmatter(entry.frontmatter);
    signals.set(id, {
      record: entry.signal,
      partition,
      private: degraded || isPrivate,
      state: entry.state,
      frontmatter: entry.frontmatter,
      history: entry.history,
      partitions: new Set(entry.history.map((r) => partitionOf.get(r.id) ?? "shared"))
    });
  }
  return { store, preferences, signals, pinned, unreadable, skippedPending };
}
function readEntitiesOf(store) {
  const fingerprint = fingerprintOf(store);
  const cached = cache.get(store.root);
  if (cached !== undefined && cached.fingerprint === fingerprint)
    return cached.entities;
  const entities = build(store);
  if (entities.unreadable.length === 0 && !entities.skippedPending)
    cache.set(store.root, { fingerprint, entities });
  else
    cache.delete(store.root);
  return entities;
}
function configuredStore(configPath) {
  try {
    return inspectStore(resolveConfiguredStoreRoot(configPath).root);
  } catch {
    return null;
  }
}
function readStoreEntities(configPath) {
  const store = configuredStore(configPath);
  return store === null ? null : readEntitiesOf(store);
}
var cache, EVENTS;
var init_store_entities = __esm(() => {
  init_constants();
  init_private_page();
  init_fold_pinned();
  init_fold_signals();
  init_fold_preferences();
  init_shard_list();
  init_store_open();
  init_store_paths();
  init_stream_read();
  init_shard_quarantine();
  cache = new Map;
  EVENTS = { stream: "events" };
});

// src/core/store/store-privacy.ts
import { posix as posix7 } from "node:path";
function judgesFromStore(vault, configPath) {
  return isStoreOnly({ vault, ...configPath !== undefined ? { configPath } : {} });
}
function signalIdOf(ref) {
  const trimmed = ref.trim();
  const target = (parseWikilink(trimmed) ?? trimmed).split("|")[0].split("#")[0].trim();
  const base = posix7.basename(target.replaceAll("\\", "/")).replace(/\.md$/, "");
  return SIGNAL_ID_RE2.test(base) ? base : undefined;
}
function storePreferenceIdIsPrivate(id, configPath) {
  const slug = stripBrainIdPrefix(id);
  if (slug === "")
    return true;
  const entities = readStoreEntities(configPath);
  if (entities === null)
    return true;
  const found = entities.preferences.get(`${PREFERENCE_ID_PREFIX}${slug}`);
  return found === undefined || found.private;
}
function storePreferenceIdIsKnownPrivate(id, configPath) {
  const slug = stripBrainIdPrefix(id);
  const entities = readStoreEntities(configPath);
  if (entities === null)
    return true;
  const found = entities.preferences.get(`${PREFERENCE_ID_PREFIX}${slug}`);
  return found?.private ?? entities.unreadable.length > 0;
}
function storeSignalIdIsPrivate(id, configPath) {
  const entities = readStoreEntities(configPath);
  if (entities === null)
    return true;
  const found = entities.signals.get(id);
  return found === undefined || found.private;
}
var SIGNAL_ID_RE2, PREFERENCE_ID_PREFIX = "pref-";
var init_store_privacy = __esm(() => {
  init_wikilink();
  init_store_entities();
  init_store_only();
  SIGNAL_ID_RE2 = /^sig-\d{4}-\d{2}-\d{2}-[A-Za-z0-9][A-Za-z0-9_-]*$/;
});

// src/core/store/dual-write-records.ts
function plain(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
function partitionOf(partition) {
  return {
    private: partition === "private",
    ...partition === "private-when-held" ? { privateWhenHeld: true } : {}
  };
}
function ledgerRowRecord(ledger, row, partition, agent) {
  return {
    stream: "ledgers",
    ledger,
    kind: LEDGER_ROW_KIND,
    ...agent !== undefined ? { agent } : {},
    ...partitionOf(partition),
    body: { row: plain(row) }
  };
}
function auditRowRecord(ledger, row, agent, isPrivate) {
  return ledgerRowRecord(ledger, row, isPrivate ? "private" : "private-when-held", agent);
}
var COUNTERS2, DUAL_WRITE_LEDGERS;
var init_dual_write_records = __esm(() => {
  init_paths();
  init_constants();
  init_fold_preferences();
  init_private_page();
  init_store_privacy();
  init_private_page();
  COUNTERS2 = new Set(PREFERENCE_COUNTER_FIELDS);
  DUAL_WRITE_LEDGERS = Object.freeze({
    idempotency: "idempotency",
    continuity: "continuity",
    metrics: "metrics",
    lineage: "lineage",
    permissions: "permissions",
    gitCommits: "git-commits",
    reliabilityAudit: "reliability-audit",
    maintenanceJournal: "maintenance-journal",
    verifierRejections: "verifier-rejections",
    preferenceAudit: "preference-audit",
    editHistory: "edit-history",
    decisionReceipts: "decision-receipts",
    truthClaims: "truth-claims",
    queryDemand: "query-demand",
    recurrence: "recurrence"
  });
});

// src/core/store/read/read-context.ts
function readSource(context = {}) {
  const mode = storeOnlyMode({
    ...context.vault !== undefined ? { vault: context.vault } : {},
    ...context.configPath !== undefined ? { configPath: context.configPath } : {}
  }, context.storeOnly);
  if (!mode.storeOnly && mode.vault !== null)
    return { kind: "legacy", vault: mode.vault };
  return { kind: "store", store: configuredStore(context.configPath) };
}
var init_read_context = __esm(() => {
  init_store_only();
  init_store_entities();
});

// src/core/store/read/memory-ids.ts
import { posix as posix8 } from "node:path";
function contextOf(vault, configPath) {
  return { vault, ...configPath !== undefined ? { configPath } : {} };
}
function memoryFromStore(vault, configPath) {
  return readSource(contextOf(vault, configPath)).kind === "store";
}
function memoryEntities(context) {
  const source = readSource(context);
  if (source.kind !== "store" || source.store === null)
    return null;
  return readEntitiesOf(source.store);
}
function preferencePageRel(slug, retired) {
  const id = `${retired ? RETIRED_PREFIX : PREFERENCE_PREFIX}${slug}`;
  return posix8.join(retired ? BRAIN_RETIRED_REL : BRAIN_PREFERENCES_REL, `${id}${PAGE_EXT}`);
}
function signalPageRel(id, state) {
  return posix8.join(SIGNAL_FOLDER[state], `${id}${PAGE_EXT}`);
}
function memoryRelOf(entities, id) {
  if (entities === null)
    return null;
  const signal = entities.signals.get(id);
  if (signal !== undefined)
    return signalPageRel(id, signal.state);
  const retiredAsked = id.startsWith(RETIRED_PREFIX);
  const slug = retiredAsked ? id.slice(RETIRED_PREFIX.length) : id.startsWith(PREFERENCE_PREFIX) ? id.slice(PREFERENCE_PREFIX.length) : null;
  if (slug === null)
    return null;
  const preference = entities.preferences.get(`${PREFERENCE_PREFIX}${slug}`);
  if (preference === undefined || !preference.state.exists)
    return null;
  const retired = preference.state.fields["status"] === RETIRED_STATUS;
  return retired === retiredAsked ? preferencePageRel(slug, retired) : null;
}
var PAGE_EXT = ".md", PREFERENCE_PREFIX = "pref-", RETIRED_PREFIX = "ret-", RETIRED_STATUS = "retired", SIGNAL_FOLDER;
var init_memory_ids = __esm(() => {
  init_path_constants();
  init_read_context();
  init_store_entities();
  SIGNAL_FOLDER = Object.freeze({
    active: BRAIN_INBOX_REL,
    staged: BRAIN_PENDING_REL,
    consumed: BRAIN_PROCESSED_REL,
    archived: BRAIN_ARCHIVED_SIGNALS_REL,
    retired: BRAIN_RETIRED_REL,
    rejected: BRAIN_RETIRED_REL,
    expired: BRAIN_INBOX_REL
  });
});

// src/core/brain/artifact-ref-resolve.ts
import { isAbsolute as isAbsolute3, join as join25 } from "node:path";
import { existsSync as existsSync11, statSync as statSync13 } from "node:fs";
function artifactRefScope(vault, fromStore) {
  let store = fromStore;
  let dirs;
  let entities;
  return {
    fromStore: () => store ??= memoryFromStore(vault),
    dirs: () => dirs ??= brainDirs(vault),
    entities: () => (entities ??= { value: memoryEntities({ vault }) }).value
  };
}
function unbracket(ref) {
  const match = ANCHORED_WIKILINK_RE.exec(ref.trim());
  return stripWikilinkDecoration(match === null ? ref : match[1]);
}
function artifactPath(vault, id, scope) {
  const dirs = scope.dirs();
  const fromStore = scope.fromStore();
  if (fromStore) {
    const rel = memoryRelOf(scope.entities(), id);
    if (rel !== null)
      return rel;
  }
  const memoryDirs = fromStore ? [] : [dirs.preferences, dirs.retired, dirs.inbox, dirs.processed, dirs.archived, dirs.pending];
  for (const dir of [
    ...memoryDirs,
    join25(vault, BRAIN_SOURCES_REL),
    dirs.entities,
    join25(vault, BRAIN_DECISIONS_REL)
  ]) {
    const abs = join25(dir, `${id}${MARKDOWN_EXT}`);
    if (existsSync11(abs))
      return vaultRelative(abs, vault);
  }
  return null;
}
function pageCandidate(vault, bare) {
  if (isVaultFile(vault, bare))
    return bare;
  const twin = bare + MARKDOWN_EXT;
  if (isVaultFile(vault, twin))
    return twin;
  return null;
}
function isVaultFile(vault, rel) {
  if (!pathIsInside(join25(vault, rel), vault))
    return false;
  try {
    return statSync13(join25(vault, rel)).isFile();
  } catch {
    return false;
  }
}
function resolveArtifactRef(vault, ref, scope = artifactRefScope(vault)) {
  const spelled = posixRel(unbracket(ref));
  if (spelled.length === 0)
    return null;
  const bare = isAbsolute3(spelled) ? vaultRelative(spelled, vault) : spelled;
  if (bare.length === 0)
    return null;
  if (bare.endsWith(MARKDOWN_EXT))
    return bare;
  if (bare.includes("/"))
    return pageCandidate(vault, bare);
  return artifactPath(vault, bare, scope);
}
var MARKDOWN_EXT = ".md";
var init_artifact_ref_resolve = __esm(() => {
  init_path_safety();
  init_memory_ids();
  init_paths();
  init_wikilink();
});

// src/core/brain/note-path.ts
var init_note_path = () => {};

// src/core/brain/types.ts
var BRAIN_SIGNAL_SOURCE_TYPE, BRAIN_SIGNAL_SOURCE_TYPES, BRAIN_MEMORY_LAYER, BRAIN_MEMORY_LAYER_VALUES, BRAIN_LOG_EVENT_KIND, BRAIN_COMMITMENT_TIER, BRAIN_COMMITMENT_TIER_VALUES, BRAIN_LOG_EVENT_KIND_SET, BRAIN_SNAPSHOT_REASON, BRAIN_SNAPSHOT_REASONS;
var init_types = __esm(() => {
  BRAIN_SIGNAL_SOURCE_TYPE = {
    live: "live",
    inline: "inline",
    session: "session",
    extracted: "extracted",
    autoExtract: "auto_extract"
  };
  BRAIN_SIGNAL_SOURCE_TYPES = Object.freeze(Object.values(BRAIN_SIGNAL_SOURCE_TYPE));
  BRAIN_MEMORY_LAYER = {
    L0: "L0",
    L1: "L1",
    L2: "L2",
    L3: "L3"
  };
  BRAIN_MEMORY_LAYER_VALUES = Object.values(BRAIN_MEMORY_LAYER);
  BRAIN_LOG_EVENT_KIND = {
    dream: "dream",
    feedback: "feedback",
    applyEvidence: "apply-evidence",
    forceConfirmed: "force-confirmed",
    reject: "reject",
    promote: "promote",
    retire: "retire",
    notedRedundant: "noted-redundant",
    skipCorruptedFrontmatter: "skip-corrupted-frontmatter",
    pin: "pin",
    unpin: "unpin",
    rollback: "rollback",
    snapshot: "snapshot",
    signalSuppressed: "signal-suppressed",
    scanInline: "scan-inline",
    importSession: "import-session",
    merge: "merge",
    upgrade: "upgrade",
    importClaudeMemory: "import-claude-memory",
    promoteHostMemory: "promote-host-memory",
    note: "note",
    sessionLifecycle: "session-lifecycle",
    reconcile: "reconcile",
    writeSession: "write-session",
    entityAnchorSkip: "entity-anchor-skip",
    attributeWrite: "attribute-write",
    durabilitySkip: "durability-skip",
    ambientWithheld: "ambient-withheld",
    writeConflictAdvisory: "write-conflict-advisory",
    captureRoutingHint: "capture-routing-hint",
    signalRetire: "signal-retire",
    tombstone: "tombstone",
    temporalReplace: "temporal-replace",
    chainDecay: "chain-decay",
    decisionRecord: "decision-record",
    decisionOutcome: "decision-outcome",
    decisionRating: "decision-rating",
    decisionChangeReceipt: "decision-change-receipt",
    decisionOpen: "decision-open",
    decisionResolved: "decision-resolved",
    decisionDiscarded: "decision-discarded",
    authoredAtBackfill: "authored-at-backfill",
    tension: "tension",
    sourceCitation: "source-citation",
    doctorRepair: "doctor-repair",
    vectorBackfill: "vector-backfill",
    eventAnchorBackfill: "event-anchor-backfill",
    expirationSet: "expiration-set",
    freeze: "freeze",
    unfreeze: "unfreeze",
    writeRefused: "write-refused",
    noteWrite: "note-write",
    lessonsApproved: "lessons-approved",
    lessonsDenied: "lessons-denied",
    lessonsPromoted: "lessons-promoted"
  };
  BRAIN_COMMITMENT_TIER = {
    exploring: "exploring",
    leaning: "leaning",
    decided: "decided",
    locked: "locked"
  };
  BRAIN_COMMITMENT_TIER_VALUES = Object.values(BRAIN_COMMITMENT_TIER);
  BRAIN_LOG_EVENT_KIND_SET = new Set(Object.values(BRAIN_LOG_EVENT_KIND));
  BRAIN_SNAPSHOT_REASON = Object.freeze({
    dream: "dream",
    upgrade: "upgrade",
    importClaudeMemory: "import-claude-memory",
    promoteHostMemory: "promote-host-memory",
    deleteBySource: "delete-by-source",
    entityPrune: "entity-prune",
    entityMerge: "entity-merge",
    noteDelete: "note-delete",
    noteRevert: "note-revert",
    knowledgePackUninstall: "knowledge-pack-uninstall",
    payloadGc: "payload-gc",
    receiptCompaction: "receipt-compaction",
    storeMigration: "store-migration",
    sessionBoundary: "session-boundary",
    planBoundary: "plan-boundary",
    decisionBoundary: "decision-boundary",
    manual: "manual"
  });
  BRAIN_SNAPSHOT_REASONS = Object.freeze(Object.values(BRAIN_SNAPSHOT_REASON));
});

// src/core/brain/temporal/period-common.ts
function extractId(linkOrId) {
  const stripped = linkOrId.replace(LINK_REASON_RE, "").trim();
  const target = parseWikilink(stripped) ?? stripped;
  return ID_PREFIX_RE.test(target) ? target : undefined;
}
var LINK_REASON_RE, ID_PREFIX_RE;
var init_period_common = __esm(() => {
  init_wikilink();
  init_types();
  LINK_REASON_RE = /\(([^)]+)\)\s*$/;
  ID_PREFIX_RE = /^(pref|ret)-[A-Za-z0-9-]+$/;
});

// src/core/store/private-region.ts
function textCarriesPrivateRegion(text) {
  return text.includes(PRIVATE_REGION_PLACEHOLDER) || privateRegionTexts(text).length > 0;
}
function valueCarriesPrivateRegion(value) {
  const strings = rowStrings(value, new Set);
  return strings === null || strings.texts.some(textCarriesPrivateRegion);
}
function rowStrings(row, opaque) {
  const references = [];
  const texts = [];
  const stack = [[row, 0, false]];
  while (stack.length > 0) {
    const [value, depth, isOpaque] = stack.pop();
    if (typeof value === "string") {
      texts.push(value);
      if (!isOpaque)
        references.push(value);
      continue;
    }
    if (value === null || typeof value !== "object")
      continue;
    if (depth >= ROW_WALK_MAX_DEPTH)
      return null;
    if (Array.isArray(value)) {
      for (const child of value)
        stack.push([child, depth + 1, isOpaque]);
      continue;
    }
    for (const [field, child] of Object.entries(value)) {
      stack.push([child, depth + 1, isOpaque || opaque.has(field)]);
    }
  }
  return { texts, references };
}
var ROW_WALK_MAX_DEPTH = 32;
var init_private_region = __esm(() => {
  init_redactor();
});

// src/core/store/reference-privacy.ts
import { existsSync as existsSync12, statSync as statSync14 } from "node:fs";
import { resolve as resolve14 } from "node:path";
function namesAPage(ref) {
  const trimmed = ref.trim();
  return ANCHORED_WIKILINK_RE.test(trimmed) || trimmed.endsWith(PAGE_EXTENSION);
}
function preferenceIdIsPrivate(vault, id, fromStore = vault === null || judgesFromStore(vault)) {
  if (fromStore || vault === null)
    return storePreferenceIdIsPrivate(id);
  let paths;
  try {
    const slug = stripBrainIdPrefix(id);
    paths = [preferencePath(vault, slug), retiredPath(vault, slug)].filter((p) => existsSync12(p));
  } catch {
    return true;
  }
  return paths.length === 0 || paths.some((p) => isPrivatePageFile(p));
}
function preferenceIdOfPath(ref) {
  const trimmed = ref.trim();
  const anchored = ANCHORED_WIKILINK_RE.exec(trimmed);
  const target = stripWikilinkDecoration(anchored !== null ? anchored[1] : trimmed).replaceAll("\\", "/").replace(/\.md$/, "");
  const slash = target.lastIndexOf("/");
  if (slash === -1 || !PREFERENCE_DIRS.has(target.slice(0, slash)))
    return;
  return extractId(target.slice(slash + 1));
}
function logRefsNamePrivatePage(vault, refs, guessed) {
  return refsNamePrivatePage(vault, refs, guessed, vault === null || judgesFromStore(vault));
}
function refsNamePrivatePage(vault, refs, guessed, fromStore, scope) {
  let guessSpared = guessed === undefined;
  for (const ref of refs) {
    if (ref === undefined || ref === "")
      continue;
    const isGuess = !guessSpared && ref === guessed;
    if (isGuess)
      guessSpared = true;
    const id = extractId(ref) ?? (fromStore ? preferenceIdOfPath(ref) : undefined);
    if (id !== undefined && !isGuess && preferenceIdIsPrivate(vault, id, fromStore))
      return true;
    if (fromStore) {
      const signal = signalIdOf(ref);
      if (signal !== undefined) {
        if (storeSignalIdIsPrivate(signal))
          return true;
        continue;
      }
      if (id !== undefined) {
        if (isGuess && storePreferenceIdIsKnownPrivate(id))
          return true;
        continue;
      }
    }
    if (vault === null) {
      if (namesAPage(ref))
        return true;
      continue;
    }
    const rel = resolveArtifactRef(vault, ref, scope ?? artifactRefScope(vault, fromStore));
    if (rel === null)
      continue;
    const abs = resolve14(vault, rel);
    if (!pathIsInside(abs, vault) || existsSync12(abs) && isPrivatePageFile(abs))
      return true;
  }
  return false;
}
var PAGE_EXTENSION = ".md", PREFERENCE_DIRS;
var init_reference_privacy = __esm(() => {
  init_artifact_ref_resolve();
  init_note_path();
  init_path_constants();
  init_paths();
  init_period_common();
  init_path_safety();
  init_vault();
  init_wikilink();
  init_dual_write_records();
  init_private_region();
  init_store_privacy();
  PREFERENCE_DIRS = new Set([BRAIN_PREFERENCES_REL, BRAIN_RETIRED_REL]);
});

// src/core/origin-channel.ts
var ORIGIN_CHANNEL, ORIGIN_CHANNELS;
var init_origin_channel = __esm(() => {
  ORIGIN_CHANNEL = Object.freeze({
    mcpTool: "mcp-tool",
    cli: "cli",
    import: "import"
  });
  ORIGIN_CHANNELS = Object.freeze(Object.values(ORIGIN_CHANNEL));
});

// src/core/store/operation-scope.ts
import { AsyncLocalStorage } from "node:async_hooks";
function activeOperationPrivate() {
  return storage.getStore()?.() ?? false;
}
var storage;
var init_operation_scope = __esm(() => {
  storage = new AsyncLocalStorage;
});

// src/core/store/dual-write.ts
import { readFileSync as readFileSync18 } from "node:fs";
function isDualWriteEnabled(configPath) {
  try {
    return resolveStoreDualWrite(configPath);
  } catch {
    return false;
  }
}
function readDualWriteStatus(path = dualWriteStatusPath()) {
  try {
    const parsed = JSON.parse(readFileSync18(path, "utf8"));
    return {
      failures: typeof parsed.failures === "number" ? parsed.failures : 0,
      skipped_no_device: typeof parsed.skipped_no_device === "number" ? parsed.skipped_no_device : 0,
      skipped_no_store: typeof parsed.skipped_no_store === "number" ? parsed.skipped_no_store : 0,
      last_error: typeof parsed.last_error === "string" ? parsed.last_error : null,
      last_failure_at: typeof parsed.last_failure_at === "string" ? parsed.last_failure_at : null,
      last_skip_at: typeof parsed.last_skip_at === "string" ? parsed.last_skip_at : null,
      shared_failures: typeof parsed.shared_failures === "number" ? parsed.shared_failures : 0,
      shared_last_error: typeof parsed.shared_last_error === "string" ? parsed.shared_last_error : null,
      shared_last_failure_at: typeof parsed.shared_last_failure_at === "string" ? parsed.shared_last_failure_at : null
    };
  } catch {
    return EMPTY_STATUS;
  }
}
function bumpStatus(update3) {
  try {
    const path = dualWriteStatusPath();
    withLocalLock(path, () => {
      const next = update3(readDualWriteStatus(path));
      atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}
`);
    });
  } catch {}
}
function warnOnce(kind, message) {
  if (warned.has(kind))
    return;
  warned.add(kind);
  try {
    process.stderr.write(`Open Second Brain: ${message}
`);
  } catch {}
}
function recordFailure(err) {
  const message = err instanceof Error ? err.message : String(err);
  warnOnce("failure", `a brain store dual write failed (${message}); the legacy write is intact. ` + "Later failures in this process are counted, not printed; `o2b brain doctor` reports them.");
  const at = new Date().toISOString();
  const shared = failedOnlyInShared(err);
  bumpStatus((s) => ({
    ...s,
    failures: s.failures + 1,
    last_error: message.slice(0, 500),
    last_failure_at: at,
    ...shared ? {
      shared_failures: s.shared_failures + 1,
      shared_last_error: message.slice(0, 500),
      shared_last_failure_at: at
    } : {}
  }));
}
function recordNoDevice() {
  warnOnce("device", "brain store dual writes are on but this machine has no device id (O2B_DEVICE_ID is empty " + "or device_id is unset); the dual writes are skipped and the legacy writes are intact.");
  const at = new Date().toISOString();
  bumpStatus((s) => ({ ...s, skipped_no_device: s.skipped_no_device + 1, last_skip_at: at }));
}
function recordNoStore(root) {
  warnOnce("store", `brain store dual writes are on but there is no store at ${root}; the dual writes are ` + "skipped and the legacy writes are intact. Run `o2b store init` to create the store.");
  const at = new Date().toISOString();
  bumpStatus((s) => ({ ...s, skipped_no_store: s.skipped_no_store + 1, last_skip_at: at }));
}
function storeFor(device, context) {
  const { root, origin } = resolveConfiguredStoreRoot(context.configPath);
  const vault = context.vault?.trim();
  if (vault !== undefined && vault !== "" && isPathInsideResolved(root, vault, process.platform)) {
    throw new StoreRootInsideVaultError(root, vault, origin);
  }
  const key = `${root}\x00${device}`;
  const cached = handles.get(key);
  if (cached !== undefined && STORE_PARTITIONS.every((p) => {
    const id = readStoreId(partitionDir(root, p));
    return cached.partitions.has(p) ? id === cached.storeId : id === null;
  })) {
    return cached;
  }
  const handle = openStore({ root, device });
  handles.set(key, handle);
  return handle;
}
function vaultIdOf(context) {
  const vault = context.vault?.trim();
  if (vault === undefined || vault === "")
    return null;
  return readVaultIdentity(vault)?.vault_id ?? null;
}
function defaultAgent() {
  try {
    return resolveAgentName();
  } catch {
    return "agent";
  }
}
function builtRecords(build2) {
  const built = build2();
  if (built === null)
    return [];
  return Array.isArray(built) ? built : [built];
}
function appendStoreRecords(store, records, context) {
  const vaultId = vaultIdOf(context);
  const scoped = activeOperationPrivate();
  const joined = records.filter((record) => record.located === undefined);
  const isPrivate = scoped || joined.some((record) => record.private === true || valueCarriesPrivateRegion(record.body) || record.privateWhenHeld === true && store.partitions.has("private"));
  const partition = isPrivate ? "private" : "shared";
  const placed = [];
  for (const record of records) {
    const at = record.located;
    if (at === undefined) {
      placed.push([record, partition]);
      continue;
    }
    const raised = at.content && (scoped || valueCarriesPrivateRegion(record.body)) ? "private" : at.partition;
    if (at.onlyIfApart === true && (joined.length === 0 || raised === partition))
      continue;
    placed.push([record, raised]);
  }
  try {
    for (const [, at] of placed) {
      if (!store.partitions.has(at))
        throw new PartitionUnavailableError(at, store.root);
    }
    return placed.map(([record, at]) => appendRecord(store, {
      partition: at,
      stream: record.stream,
      ...record.ledger !== undefined ? { ledger: record.ledger } : {},
      kind: record.kind,
      agent: record.agent !== undefined && record.agent.trim() !== "" ? record.agent : defaultAgent(),
      scope: record.scope ?? null,
      body: { ...record.body, [VAULT_ID_FIELD]: vaultId }
    }));
  } catch (err) {
    if (typeof err === "object" && err !== null) {
      failedPlacement.set(err, new Set(placed.map(([, at]) => at)));
    }
    throw err;
  }
}
function failedOnlyInShared(err) {
  for (const e of [err, err?.cause]) {
    if (typeof e !== "object" || e === null)
      continue;
    const placed = failedPlacement.get(e);
    if (placed !== undefined)
      return placed.size > 0 && [...placed].every((p) => p === "shared");
  }
  return false;
}
function dualWrite(build2, context = {}) {
  if (!isDualWriteEnabled(context.configPath))
    return;
  try {
    const device = resolveAppendShardId();
    if (device === "") {
      recordNoDevice();
      return;
    }
    const records = builtRecords(build2);
    if (records.length === 0)
      return;
    let store;
    try {
      store = storeFor(device, context);
    } catch (err) {
      if (!(err instanceof NoStoreError))
        throw err;
      recordNoStore(err.root);
      return;
    }
    appendStoreRecords(store, records, context);
  } catch (err) {
    recordFailure(err);
  }
}
var EMPTY_STATUS, warned, handles, failedPlacement;
var init_dual_write = __esm(() => {
  init_fs_atomic();
  init_config();
  init_origin_channel();
  init_ledger_shards();
  init_vault_identity();
  init_appender();
  init_constants();
  init_local_lock();
  init_operation_scope();
  init_private_region();
  init_store_open();
  init_store_paths();
  EMPTY_STATUS = Object.freeze({
    failures: 0,
    skipped_no_device: 0,
    skipped_no_store: 0,
    last_error: null,
    last_failure_at: null,
    last_skip_at: null,
    shared_failures: 0,
    shared_last_error: null,
    shared_last_failure_at: null
  });
  warned = new Set;
  handles = new Map;
  failedPlacement = new WeakMap;
});

// src/core/store/store-identity.ts
import { mkdirSync as mkdirSync15, readFileSync as readFileSync19 } from "node:fs";
import { dirname as dirname17, join as join26 } from "node:path";
function storeIdentityPath() {
  return join26(storesStateDir(processDirsEnv()), STORE_IDENTITY_FILE2);
}
function isBinding(value) {
  if (typeof value !== "object" || value === null)
    return false;
  const v = value;
  return typeof v["root"] === "string" && typeof v["store_id"] === "string" && typeof v["device"] === "string" && typeof v["bound_at"] === "string";
}
function readBindingsStrict(path) {
  let text;
  try {
    text = readFileSync19(path, "utf8");
  } catch (err) {
    return err.code === "ENOENT" ? [] : null;
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed.bindings) ? parsed.bindings.filter(isBinding) : null;
  } catch {
    return null;
  }
}
function unreadableBindings(root, path) {
  return new StoreIdentityMismatchError(root, `this machine's store binding file ${path} cannot be read, so the store at ${root} ` + "cannot be checked; repair or remove it, or run `o2b init` to bind this machine again");
}
function writeBindingLocked(path, root, storeId, device, repair) {
  const current = readBindingsStrict(path);
  if (current === null && !repair)
    throw unreadableBindings(root, path);
  const others = (current ?? []).filter((b) => b.root !== root);
  const bindings = [
    ...others,
    { root, store_id: storeId, device, bound_at: new Date().toISOString() }
  ];
  atomicWriteFileSync(path, `${JSON.stringify({ bindings }, null, 2)}
`);
}
function verifiedKey(root, storeId, device) {
  return `${root}\x00${storeId}\x00${device}`;
}
function assertStoreIdentityForWrite(root, storeId, device) {
  const pin = pinned.get(root);
  if (pin !== undefined && pin !== storeId) {
    throw new StoreIdentityMismatchError(root, `the store at ${root} is not the one this process opened (store id ${storeId}, ` + `opened ${pin})`);
  }
  const key = verifiedKey(root, storeId, device);
  if (verified.has(key))
    return;
  const path = storeIdentityPath();
  const bindings = readBindingsStrict(path);
  if (bindings === null)
    throw unreadableBindings(root, path);
  let binding = bindings.find((b) => b.root === root);
  if (binding === undefined) {
    try {
      mkdirSync15(dirname17(path), { recursive: true });
      binding = withLocalLock(path, () => {
        const again = readBindingsStrict(path);
        if (again === null)
          throw unreadableBindings(root, path);
        const found = again.find((b) => b.root === root);
        if (found !== undefined)
          return found;
        writeBindingLocked(path, root, storeId, device, false);
        return;
      });
    } catch (err) {
      if (err instanceof StoreIdentityMismatchError)
        throw err;
    }
  }
  if (binding !== undefined) {
    if (binding.store_id !== storeId) {
      throw new StoreIdentityMismatchError(root, `the store at ${root} has store id ${storeId}, and this machine is bound to ` + `${binding.store_id}`);
    }
    if (binding.device !== device) {
      throw new StoreIdentityMismatchError(root, `this machine writes as device ${device}, and its device-local state is bound to ` + `device ${binding.device} (copied from another machine, or the device id changed)`);
    }
  }
  pinned.set(root, storeId);
  verified.add(key);
}
var STORE_IDENTITY_FILE2 = "identity.json", StoreIdentityMismatchError, pinned, verified;
var init_store_identity = __esm(() => {
  init_fs_atomic();
  init_platform_dirs();
  init_local_lock();
  init_store_paths();
  StoreIdentityMismatchError = class StoreIdentityMismatchError extends Error {
    root;
    constructor(root, detail) {
      super(`refusing to write: ${detail}`);
      this.root = root;
      this.name = "StoreIdentityMismatchError";
    }
  };
  pinned = new Map;
  verified = new Set;
});

// src/core/store/store-write.ts
import { mkdirSync as mkdirSync16, readFileSync as readFileSync20 } from "node:fs";
import { dirname as dirname18, join as join27 } from "node:path";
function asStoreWriteError(err) {
  if (err instanceof StoreWriteError)
    return err;
  const detail = err instanceof Error ? err.message : String(err);
  return new StoreWriteError(failureOf(err), detail, { cause: err });
}
function failureOf(err) {
  if (err instanceof NoStoreError)
    return "no-store";
  if (err instanceof StoreRootInsideVaultError)
    return "root-inside-vault";
  if (err instanceof PartitionUnavailableError)
    return "partition-unavailable";
  if (err instanceof StoreIdentityMismatchError)
    return "store-identity";
  return "store-error";
}
function writerDevice(configPath) {
  let device;
  try {
    device = resolveDeviceId(configPath);
  } catch (err) {
    throw new StoreWriteError("store-error", `this machine's device id cannot be resolved: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (device === "") {
    throw new StoreWriteError("no-device", "this machine has no device id (O2B_DEVICE_ID is empty)");
  }
  return device;
}
function storeWrite(build2, context = {}) {
  try {
    const device = writerDevice(context.configPath);
    const records = builtRecords(build2);
    if (records.length === 0)
      return [];
    const store = storeFor(device, context);
    assertStoreIdentityForWrite(store.root, store.storeId, device);
    return appendStoreRecords(store, records, context);
  } catch (err) {
    throw asStoreWriteError(err);
  }
}
function routeWrite(spec) {
  const context = spec.context ?? {};
  const mode = storeOnlyMode({
    ...context.vault !== undefined ? { vault: context.vault } : {},
    ...context.configPath !== undefined ? { configPath: context.configPath } : {}
  }, spec.storeOnly);
  if (!mode.storeOnly) {
    const value = spec.legacy();
    dualWrite(spec.store, context);
    return { mode: "legacy", value };
  }
  try {
    return { mode: "store", records: storeWrite(spec.store, context) };
  } catch (err) {
    const error = asStoreWriteError(err);
    if (spec.failOpen !== true)
      throw error;
    recordFailOpen(error);
    try {
      spec.onFailure?.(error);
    } catch {}
    return { mode: "store", records: [], failed: error };
  }
}
function storeWriteStatusPath() {
  return join27(storesStateDir(processDirsEnv()), STORE_WRITE_STATUS_FILE);
}
function readStoreWriteStatus(path = storeWriteStatusPath()) {
  try {
    const parsed = JSON.parse(readFileSync20(path, "utf8"));
    return {
      failures: typeof parsed.failures === "number" ? parsed.failures : 0,
      last_reason: typeof parsed.last_reason === "string" && Object.hasOwn(REMEDIES, parsed.last_reason) ? parsed.last_reason : null,
      last_error: typeof parsed.last_error === "string" ? parsed.last_error : null,
      last_failure_at: typeof parsed.last_failure_at === "string" ? parsed.last_failure_at : null,
      shared_failures: typeof parsed.shared_failures === "number" ? parsed.shared_failures : 0,
      shared_last_error: typeof parsed.shared_last_error === "string" ? parsed.shared_last_error : null,
      shared_last_failure_at: typeof parsed.shared_last_failure_at === "string" ? parsed.shared_last_failure_at : null
    };
  } catch {
    return EMPTY_STATUS2;
  }
}
function recordFailOpen(error) {
  if (!warned2) {
    warned2 = true;
    try {
      process.stderr.write(`Open Second Brain: ${error.message} Later failures in this process are counted, ` + "not printed; `o2b brain doctor` reports them.\n");
    } catch {}
  }
  const shared = failedOnlyInShared(error);
  try {
    const path = storeWriteStatusPath();
    mkdirSync16(dirname18(path), { recursive: true });
    withLocalLock(path, () => {
      const current = readStoreWriteStatus(path);
      const at = new Date().toISOString();
      const message = error.message.slice(0, 500);
      const next = {
        failures: current.failures + 1,
        last_reason: error.reason,
        last_error: message,
        last_failure_at: at,
        ...shared ? {
          shared_failures: current.shared_failures + 1,
          shared_last_error: message,
          shared_last_failure_at: at
        } : {
          shared_failures: current.shared_failures,
          shared_last_error: current.shared_last_error,
          shared_last_failure_at: current.shared_last_failure_at
        }
      };
      atomicWriteFileSync(path, `${JSON.stringify(next, null, 2)}
`);
    });
  } catch {}
}
var REMEDIES, StoreWriteError, STORE_WRITE_STATUS_FILE = "store-write.json", EMPTY_STATUS2, warned2 = false;
var init_store_write = __esm(() => {
  init_config();
  init_fs_atomic();
  init_platform_dirs();
  init_appender();
  init_dual_write();
  init_local_lock();
  init_store_identity();
  init_store_only();
  init_store_open();
  init_store_paths();
  REMEDIES = Object.freeze({
    "no-store": "Run `o2b store init` on this machine, or let sync deliver the store's partitions.",
    "no-device": "Set `device_id` in the machine config, or O2B_DEVICE_ID, to lowercase letters, digits " + "and hyphens.",
    "root-inside-vault": "Point `store_root` in the machine config (or OPEN_SECOND_BRAIN_STORE_ROOT) at a " + "directory outside the vault.",
    "partition-unavailable": "Sync that partition's folder of the store to this machine, or make the write from a " + "machine that holds it.",
    "store-identity": "If the store or this machine's device id was changed on purpose, run `o2b init` to bind " + "this machine to the store again; otherwise restore the store this machine was bound to.",
    "store-error": "Run `o2b brain doctor` for the store's state, then retry."
  });
  StoreWriteError = class StoreWriteError extends Error {
    reason;
    remedy;
    constructor(reason, detail, options) {
      const remedy = REMEDIES[reason];
      super(`the brain store write failed: ${detail.replace(/\.+$/, "")}. ${remedy}`, options);
      this.name = "StoreWriteError";
      this.reason = reason;
      this.remedy = remedy;
    }
  };
  EMPTY_STATUS2 = Object.freeze({
    failures: 0,
    last_reason: null,
    last_error: null,
    last_failure_at: null,
    shared_failures: 0,
    shared_last_error: null,
    shared_last_failure_at: null
  });
});

// src/core/reliability/audit.ts
import { closeSync as closeSync9, fsyncSync as fsyncSync5, mkdirSync as mkdirSync17, openSync as openSync7, writeFileSync as writeFileSync4 } from "node:fs";
import { basename as basename8, join as join28 } from "node:path";
function appendAuditRecord(auditRoot, record, vault, options = {}) {
  const timestamp = new Date(record.timestamp);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error(`invalid audit timestamp: ${record.timestamp}`);
  }
  const line = redactRawOutput(JSON.stringify(record), {
    maxInput: Number.POSITIVE_INFINITY
  });
  const effectiveVault = vault ?? configuredVaultOrUndefined();
  const context = vault !== undefined ? { vault } : {};
  if (!trailInsideVault(auditRoot, effectiveVault) && isStoreOnly(effectiveVault !== undefined ? { vault: effectiveVault } : {})) {
    return appendLegacyAuditLine(auditRoot, timestamp, line);
  }
  const routed = routeWrite({
    legacy: () => appendLegacyAuditLine(auditRoot, timestamp, line),
    store: () => {
      const written = JSON.parse(line);
      return auditRowRecord(DUAL_WRITE_LEDGERS.reliabilityAudit, { audit_dir: basename8(auditRoot), record: written }, isRecordLabel(written.actor) ? written.actor : undefined, auditRowNamesPrivatePage(vault, written));
    },
    context,
    ...options.failOpen === true || basename8(auditRoot) === HOOK_AUDIT_TRAIL ? { failOpen: true } : {}
  });
  if (routed.mode === "legacy")
    return routed.value;
  return routed.records.length > 0 ? AUDIT_STORE_LEDGER_NAME : "";
}
function configuredVaultOrUndefined() {
  try {
    const vault = resolveVault();
    return vault !== null && vault.trim() !== "" ? vault : undefined;
  } catch {
    return;
  }
}
function trailInsideVault(auditRoot, vault) {
  return vault !== undefined && vault.trim() !== "" && isPathInsideResolved(auditRoot, vault, process.platform);
}
function appendLegacyAuditLine(auditRoot, timestamp, line) {
  mkdirSync17(auditRoot, { recursive: true });
  const path = join28(auditRoot, shardedFileName(isoWeekLabel(timestamp), resolveAppendShardId(), JSONL_LEDGER_EXT));
  const fileDescriptor = openSync7(path, "a", 384);
  try {
    writeFileSync4(fileDescriptor, line + `
`, "utf8");
    fsyncSync5(fileDescriptor);
  } finally {
    closeSync9(fileDescriptor);
  }
  return path;
}
function stringsIn(value, out = []) {
  if (typeof value === "string")
    out.push(value);
  else if (Array.isArray(value))
    for (const v of value)
      stringsIn(v, out);
  else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value))
      stringsIn(v, out);
  }
  return out;
}
function auditRowNamesPrivatePage(vault, record) {
  if (vault === undefined)
    return true;
  return logRefsNamePrivatePage(vault, [record.target, ...stringsIn(record.details)]);
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
var AUDIT_WEEK_SHARD_GRAMMAR, HOOK_AUDIT_TRAIL = "hook-audit", AUDIT_STORE_LEDGER_NAME;
var init_audit = __esm(() => {
  init_redactor();
  init_ledger_shards();
  init_dual_write_records();
  init_envelope();
  init_reference_privacy();
  init_store_only();
  init_store_paths();
  init_store_write();
  init_config();
  AUDIT_WEEK_SHARD_GRAMMAR = Object.freeze({
    base: "\\d{4}-W\\d{2}",
    extensions: Object.freeze([JSONL_LEDGER_EXT])
  });
  AUDIT_STORE_LEDGER_NAME = `store:ledgers/${DUAL_WRITE_LEDGERS.reliabilityAudit}`;
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

// src/core/brain/time.ts
function isoSecond(d = new Date) {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}
var init_time = () => {};

// src/core/brain/secrets/value-cipher.ts
import { createCipheriv, createDecipheriv, randomBytes as randomBytes4 } from "node:crypto";
function encryptValue(key, plaintext, aad) {
  const iv = randomBytes4(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  if (aad !== undefined)
    cipher.setAAD(Buffer.from(aad, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    ciphertext: ciphertext.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64")
  };
}
function decryptValue(key, encrypted, aad) {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, "base64"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
  if (aad !== undefined)
    decipher.setAAD(Buffer.from(aad, "utf8"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final()
  ]);
  return plaintext.toString("utf8");
}
var ALGORITHM = "aes-256-gcm", IV_BYTES = 12;
var init_value_cipher = () => {};

// src/core/brain/secrets/envelope.ts
import { randomBytes as randomBytes5, scryptSync, timingSafeEqual } from "node:crypto";
import {
  chmodSync as chmodSync2,
  closeSync as closeSync10,
  fsyncSync as fsyncSync6,
  openSync as openSync8,
  readFileSync as readFileSync21,
  unlinkSync as unlinkSync6,
  writeSync as writeSync6
} from "node:fs";
import { dirname as dirname19, resolve as resolve15 } from "node:path";
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
  const resolved = resolve15(keyPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
function heldUnlockedKey(keyPath) {
  return HELD_KEYS.get(holderSlot(keyPath)) ?? null;
}
function heldKeyOrRefusal(keyPath) {
  const held = HELD_KEYS.get(holderSlot(keyPath));
  if (held !== undefined)
    return held;
  const fromEnvironment = unlockFromEnvironmentOffer(keyPath);
  if (fromEnvironment !== null)
    return fromEnvironment;
  throw new SecretStoreLockedError(keyPath);
}
function unlockFromEnvironmentOffer(keyPath) {
  const offered = process.env[SECRET_STORE_PASSPHRASE_ENV];
  if (offered === undefined)
    return null;
  delete process.env[SECRET_STORE_PASSPHRASE_ENV];
  if (offered.length === 0)
    return null;
  try {
    return unlockKeyfile(keyPath, offered);
  } catch (err) {
    if (err instanceof SecretEnvelopeError && err.code === ENVELOPE_REFUSAL_CODES.passphrase) {
      throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.passphrase, keyPath, `the passphrase in ${SECRET_STORE_PASSPHRASE_ENV} does not unwrap this envelope ` + "(wrong passphrase, or the envelope is corrupt)");
    }
    throw err;
  }
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
    bytes = readFileSync21(keyPath);
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
    parsed = JSON.parse(readFileSync21(keyPath, "utf8"));
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
    salt: randomBytes5(SALT_BYTES).toString("base64"),
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
function wrapKeyfile(keyPath, passphrase, dek, seams = {}) {
  if (passphrase.length === 0) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.passphrase, keyPath, "a wrap passphrase must not be empty");
  }
  if (dek.length !== DEK_BYTES) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, `refusing to wrap ${String(dek.length)} bytes of key material, expected ${String(DEK_BYTES)}`);
  }
  const kdf = freshWrapKdfParams();
  const derived = deriveWrapKey(passphrase, kdf);
  const seal = seams.seal ?? ((key, plaintext) => encryptValue(key, plaintext));
  const envelope = {
    version: KEYFILE_ENVELOPE_SCHEMA_VERSION,
    kdf,
    wrapped: seal(derived, dek.toString("base64"))
  };
  const unwrapped = unwrapWith(derived, envelope, keyPath);
  if (!timingSafeEqual(unwrapped, dek)) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, "the produced envelope does not unwrap to the key it wraps; the raw keyfile was left untouched");
  }
  const envelopeText = `${JSON.stringify(envelope, null, 2)}
`;
  const write = seams.write ?? ((target, text) => {
    atomicWriteText(target, text, { mode: 384 });
  });
  write(keyPath, envelopeText);
  try {
    const landed = readEnvelope(keyPath);
    const restored = unwrapWith(derived, landed, keyPath);
    if (!timingSafeEqual(restored, dek)) {
      throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, "the written envelope does not unwrap to the key it wraps");
    }
  } catch (err) {
    try {
      writeRawKeyfileBytes(keyPath, dek);
    } catch (restoreErr) {
      process.stderr.write(`warning: could not restore the raw keyfile after a failed read-back check: ` + `${keyPath}: ${restoreErr instanceof Error ? restoreErr.message : String(restoreErr)}
`);
    }
    throw err;
  }
  restrictToOwner(keyPath, "file", process.platform, true);
  if (process.platform !== "win32") {
    try {
      chmodSync2(keyPath, 384);
    } catch (err) {
      process.stderr.write(`warning: could not re-apply owner-only mode to the wrapped keyfile: ` + `${keyPath}: ${err instanceof Error ? err.message : String(err)}
`);
    }
  }
  return envelope;
}
function writeRawKeyfileBytes(keyPath, dek) {
  if (dek.length !== DEK_BYTES) {
    throw new SecretEnvelopeError(ENVELOPE_REFUSAL_CODES.malformed, keyPath, `refusing to write ${String(dek.length)} bytes of key material, expected ${String(DEK_BYTES)}`);
  }
  const tmp = `${keyPath}.raw-tmp`;
  let fd = null;
  try {
    fd = openSync8(tmp, "wx", 384);
    let written = 0;
    while (written < dek.byteLength) {
      written += writeSync6(fd, dek, written, dek.byteLength - written);
    }
    fsyncSync6(fd);
    closeSync10(fd);
    fd = null;
    renameWithRetry(tmp, keyPath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync10(fd);
      } catch {}
    }
    try {
      unlinkSync6(tmp);
    } catch {}
    throw err;
  }
  try {
    const dfd = openSync8(dirname19(keyPath), "r");
    try {
      fsyncSync6(dfd);
    } finally {
      closeSync10(dfd);
    }
  } catch {}
}
function unwrapKeyfileToRaw(keyPath, passphrase) {
  const envelope = readEnvelope(keyPath);
  const dek = unwrapWith(deriveWrapKey(passphrase, envelope.kdf), envelope, keyPath);
  writeRawKeyfileBytes(keyPath, dek);
  return dek;
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
var KEYFILE_ENVELOPE_SCHEMA_VERSION = 1, KDF_ALGO = "scrypt", WRAP_KEY_BYTES = 32, DEK_BYTES = 32, SALT_BYTES = 16, SCRYPT_N, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_MAXMEM, SCRYPT_N_MAX, SCRYPT_R_MAX = 16, SCRYPT_P_MAX = 8, SCRYPT_MAXMEM_MAX, ENVELOPE_REFUSAL_CODES, SecretEnvelopeError, SECRET_STORE_LOCKED_CODE = "secret_store_locked", SECRET_STORE_PASSPHRASE_ENV = "OPEN_SECOND_BRAIN_SECRETS_PASSPHRASE", SecretStoreLockedError, SECRET_STORE_KEYFILE_MISSING_CODE = "secret_store_keyfile_missing", SecretStoreKeyfileMissingError, HELD_KEYS;
var init_envelope2 = __esm(() => {
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
      super(`the secret store is locked (the keyfile is passphrase-wrapped): pass the ` + `passphrase to this command via --passphrase-from-env or stdin, or set ` + `${SECRET_STORE_PASSPHRASE_ENV} for this process (a non-interactive host such ` + `as the MCP server reads it once and drops it), or run ` + `"o2b brain secret unlock" to unlock this process only - the passphrase is ` + `never persisted; "o2b brain secret unwrap" writes the raw keyfile back`);
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
import { randomBytes as randomBytes6 } from "node:crypto";
import {
  chmodSync as chmodSync3,
  closeSync as closeSync11,
  existsSync as existsSync13,
  mkdirSync as mkdirSync18,
  openSync as openSync9,
  readFileSync as readFileSync22,
  writeFileSync as writeFileSync5,
  writeSync as writeSync7
} from "node:fs";
import { dirname as dirname20, join as join29 } from "node:path";
function ensureSyncExclusionMarker(dir) {
  const marker = join29(dir, ".gitignore");
  if (existsSync13(marker))
    return;
  try {
    writeFileSync5(marker, SYNC_EXCLUSION_CONTENT, { encoding: "utf8", flag: "wx", mode: 384 });
  } catch (err) {
    if (err.code !== "EEXIST") {
      process.stderr.write(`warning: could not write the sync-exclusion marker for the secrets directory: ` + `${marker}: ${err instanceof Error ? err.message : String(err)}
`);
    }
  }
}
function loadOrCreateKey(keyPath) {
  const keyDir = dirname20(keyPath);
  if (existsSync13(keyPath)) {
    restrictToOwner(keyDir, "directory");
    restrictToOwner(keyPath, "file");
    if (process.platform !== "win32") {
      try {
        chmodSync3(keyDir, 448);
        chmodSync3(keyPath, 384);
      } catch (err) {
        process.stderr.write(`warning: could not re-apply owner-only modes to the secrets keyfile: ` + `${keyPath}: ${err instanceof Error ? err.message : String(err)}
`);
      }
    }
    ensureSyncExclusionMarker(keyDir);
    const key2 = readFileSync22(keyPath);
    if (isEnvelopeBytes(key2))
      return heldKeyOrRefusal(keyPath);
    if (key2.length !== KEY_BYTES) {
      throw new Error(`secrets keyfile is corrupt (expected ${KEY_BYTES} bytes): ${keyPath}`);
    }
    return key2;
  }
  mkdirSync18(keyDir, { recursive: true, mode: 448 });
  restrictToOwner(keyDir, "directory");
  ensureSyncExclusionMarker(keyDir);
  const key = randomBytes6(KEY_BYTES);
  let fd;
  try {
    fd = openSync9(keyPath, "wx", 384);
  } catch (exc) {
    if (exc.code === "EEXIST")
      return loadOrCreateKey(keyPath);
    throw exc;
  }
  try {
    writeSync7(fd, key);
  } finally {
    closeSync11(fd);
  }
  restrictToOwner(keyPath, "file");
  return key;
}
var KEY_BYTES = 32, SYNC_EXCLUSION_CONTENT = `*
!.gitignore
`;
var init_crypto = __esm(() => {
  init_envelope2();
  init_owner_acl();
  init_value_cipher();
});

// src/core/store-migration/owner-only-copy.ts
import { chmodSync as chmodSync4, copyFileSync as copyFileSync2, mkdirSync as mkdirSync19 } from "node:fs";
import { dirname as dirname21, relative as relative7, resolve as resolve16, sep as sep6 } from "node:path";
function ensureOwnerOnlyRoot(root) {
  mkdirSync19(root, { recursive: true, mode: DIR_MODE });
  if (process.platform === "win32")
    restrictToOwner(root, "directory");
  else
    chmodSync4(root, DIR_MODE);
}
function foldersFrom(root, dir) {
  const rel = relative7(resolve16(root), resolve16(dir));
  if (rel === "" || rel.startsWith(".."))
    return [resolve16(root)];
  const out = [resolve16(root)];
  for (const segment of rel.split(sep6))
    out.push(`${out.at(-1)}${sep6}${segment}`);
  return out;
}
function copyOwnerOnly(source, target, root) {
  mkdirSync19(dirname21(target), { recursive: true, mode: DIR_MODE });
  if (process.platform !== "win32") {
    for (const folder of foldersFrom(root, dirname21(target)))
      chmodSync4(folder, DIR_MODE);
  }
  copyFileSync2(source, target);
  if (process.platform !== "win32")
    chmodSync4(target, FILE_MODE);
}
var DIR_MODE = 448, FILE_MODE = 384;
var init_owner_only_copy = __esm(() => {
  init_owner_acl();
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
  storeLockedForThisProcess: () => storeLockedForThisProcess,
  tokenStorePath: () => tokenStorePath,
  unlockSecretKeyfile: () => unlockSecretKeyfile,
  unwrapSecretKeyfile: () => unwrapSecretKeyfile,
  withSecretsLock: () => withSecretsLock,
  writeStore: () => writeStore
});
import {
  chmodSync as chmodSync5,
  existsSync as existsSync14,
  readdirSync as readdirSync6,
  readFileSync as readFileSync23,
  renameSync as renameSync2,
  rmSync as rmSync3,
  statSync as statSync15,
  writeFileSync as writeFileSync6
} from "node:fs";
import { join as join30 } from "node:path";
function secretsDir(vault) {
  const dir = machineStatePath(vault, DERIVED_STORE_DIR, "secrets");
  adoptVaultSecrets(join30(vault, DERIVED_STORE_DIR, "secrets"), dir);
  return dir;
}
function adoptVaultSecrets(legacy, dir) {
  if (legacy === dir || existsSync14(dir) || !existsSync14(legacy))
    return;
  const names = readdirSync6(legacy).filter((name) => statSync15(join30(legacy, name)).isFile());
  if (names.length === 0)
    return;
  const staging = `${dir}.adopt-${process.pid}`;
  rmSync3(staging, { recursive: true, force: true });
  try {
    ensureOwnerOnlyRoot(staging);
    for (const name of names)
      copyOwnerOnly(join30(legacy, name), join30(staging, name), staging);
    try {
      renameSync2(staging, dir);
    } catch (err) {
      if (!existsSync14(dir))
        throw err;
    }
  } finally {
    rmSync3(staging, { recursive: true, force: true });
  }
}
function storePath(vault) {
  return join30(secretsDir(vault), "secrets.json");
}
function keyPath(vault) {
  return join30(secretsDir(vault), "keyfile");
}
function tokenStorePath(vault) {
  return join30(secretsDir(vault), "mcp-tokens.json");
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
      release = import_proper_lockfile4.default.lockSync(secretsDir(vault), { stale: 1e4, realpath: false });
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
  if (!existsSync14(kp))
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
function storeLockedForThisProcess(vault) {
  const kp = keyPath(vault);
  return isEnvelopeFile(kp) && heldUnlockedKey(kp) === null;
}
function unwrapSecretKeyfile(vault, passphrase, ctx) {
  assertVaultIdentityForWrite(vault);
  const kp = keyPath(vault);
  if (!isEnvelopeFile(kp)) {
    throw new Error(`secret unwrap: the keyfile is not passphrase-wrapped, nothing to unwrap: ${kp}`);
  }
  unwrapKeyfileToRaw(kp, passphrase);
  clearHeldKey(kp);
  audit(vault, ctx, "secret_unwrapped", "keyfile", { keyfile_was_wrapped: true });
}
function custodyTargets(vault) {
  const targets = [
    [secretsDir(vault), "directory"],
    [keyPath(vault), "file"]
  ];
  if (existsSync14(storePath(vault)))
    targets.push([storePath(vault), "file"]);
  if (existsSync14(tokenStorePath(vault)))
    targets.push([tokenStorePath(vault), "file"]);
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
  if (!existsSync14(path))
    return { version: SECRETS_SCHEMA_VERSION, secrets: {} };
  restrictToOwner(path, "file");
  if (process.platform !== "win32") {
    try {
      if ((statSync15(path).mode & 511) !== 384)
        chmodSync5(path, 384);
    } catch (err) {
      process.stderr.write(`warning: could not re-apply owner-only mode to the secrets store: ` + `${path}: ${err instanceof Error ? err.message : String(err)}
`);
    }
  }
  const parsed = JSON.parse(readFileSync23(path, "utf8"));
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
  writeFileSync6(tmp, JSON.stringify(file, null, 2) + `
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
  appendAuditRecord(join30(brainDirsForWrite(vault).log, SECRET_CUSTODY_AUDIT_DIR), {
    timestamp: ctx.now.toISOString(),
    actor: ctx.agent,
    action,
    target: name,
    ok: true,
    details
  }, vault);
}
var import_proper_lockfile4, SECRETS_SCHEMA_VERSION = 1, NAME_RE, ENV_VAR_RE;
var init_store = __esm(() => {
  init_fs_atomic();
  init_audit();
  init_audit_dirs();
  init_paths();
  init_time();
  init_vault_identity();
  init_crypto();
  init_envelope2();
  init_owner_acl();
  init_machine_state();
  init_owner_only_copy();
  init_path_constants();
  import_proper_lockfile4 = __toESM(require_proper_lockfile(), 1);
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
    reason: "the widest export in the tree: preferences, the page graph, page contracts and " + "the sources dashboard composed into one file. Redaction runs over the bundle " + "TREE and the JSON is serialised afterwards, so a note whose text happens to " + "contain a credential assignment cannot mangle the document's own quoting. A page " + "whose content_class carries the reserved prompt-derived value is left out of both " + "page sections - graph node and contract - and the omission is named on stderr; " + "--include-prompt-derived carries it back in. The sources dashboard is an aggregate " + "over signal records, carries no page text, and is not class-filtered."
  },
  "brain-graph-export": {
    id: "brain-graph-export",
    verb: "o2b brain graph-export",
    module: "src/cli/brain/verbs/graph-export.ts",
    redaction: R.sharedRedactor,
    reason: "carries no page body, but does carry every page title, path and typed-relation " + "target - a credential pasted into a title left through here verbatim. A page whose " + "content_class carries the reserved prompt-derived value has no node in the graph - " + "title, path and relations go with it - and the omission is named on stderr; " + "--include-prompt-derived carries it back in. Link and relation targets inside a " + "kept node are that page's own declared citations and are not rewritten."
  },
  "brain-okf-export": {
    id: "brain-okf-export",
    verb: "o2b brain okf-export",
    module: "src/cli/brain/verbs/okf-export.ts",
    redaction: R.sharedRedactor,
    reason: "the only export that carries page bodies VERBATIM, which is its interchange " + "contract and also why it is the widest leak by volume. The manifest is redacted " + "as a tree and `okf.json` re-serialised from it; the markdown files are redacted " + "as text. A bundle whose secrets were removed is no longer a lossless round-trip " + "of the vault, and the verb says so rather than implying otherwise. What it does NOT " + "do is filter by the informal privacy labels: a page carrying `private: true` in its " + "frontmatter exports in full, because the `<private>` region marker is this product's " + "only content-derived privacy primitive and these composers are content composers, " + "not visibility filters. What it DOES filter, since the content class shipped, is the " + "server-derived class itself: a page stamped content_class: prompt-derived is absent " + "from the manifest and no file is written for it, every omission is named on stderr, " + "and --include-prompt-derived carries the pages back in."
  },
  "brain-export": {
    id: "brain-export",
    verb: "o2b brain export",
    module: "src/cli/brain/verbs/export.ts",
    redaction: R.sharedRedactor,
    reason: "preference principles are free text an agent wrote, and the llms-txt form is " + "meant to be pasted into a foreign prompt - the destination least likely to be " + "read before it is shared. One entry covers all three of the verb's formats " + "because the census keys on the MODULE and the destination is declared once, in " + "the verb: the JSON and transcript forms are redacted as TREES and serialised " + "afterwards, llms-txt as text. What proves each branch scans is a per-handler " + "check in the census, not the guard-call count - counting guards against " + "DESTINATIONS is an inequality, and this module declares one destination against " + "three guards, so a fourth handler that scanned nothing would satisfy it. The " + "transcript form is the widest of the three by far - whole recorded " + "conversations with whichever runtime wrote them, which is where a key pasted " + "into a prompt actually lives. Its records are guarded ONE AT A TIME, so a " + "single oversized turn cannot put a machine's whole corpus past the scan window, " + "and a refusal names the conversation rather than the run - by its basename, " + "except when the basename is itself the secret-shaped identifier, where it is " + "named by runtime and start instant instead. The transcript branch is also the " + "one caller that passes `foreignIdentifiers`, because its `session_id` and " + "`turn_id` were named by the harness that wrote the transcript rather than by " + "this vault, so the guard's vendor-prefix-only rule for identifiers - an " + "argument about ids this build constructs - does not cover them. The formats " + "carry no page-classed material - the two preference forms serialise preference " + "rows, which never take the content-class stamp, and the transcript corpus is " + "runtime session logs, not vault pages - so the default content-class exclusion " + "has nothing to remove here; the transcript branch still does not apply it " + "SILENTLY: a record that carries the reserved class is omitted and named, and a " + "corpus the policy would empty is a refusal, never an empty file."
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
    reason: "was declared as covered by its read model, which was wrong in both directions. " + "The upstream call redacts at WRITE time with the redactor's DEFAULT options, so " + "`redactTokens` and `redactUrlCredentials` were both off and a vendor key, a bare " + "high-entropy token and a `user:pass@host` URL all left through here verbatim - " + "the two flags the export boundary exists to turn on. Write-time coverage also " + "says nothing about a record already on disk or appended by another writer, since " + "the read model never re-scans. The verb now scans what it READ, which answers " + "both, and gains the truncation refusal the other five already had. Continuity " + "records are structured events, not pages, and never take the content-class " + "stamp, so the default class exclusion removes nothing here."
  },
  "brain-explorer-export": {
    id: "brain-explorer-export",
    verb: "o2b brain explorer --export",
    module: "src/cli/brain/verbs/explorer.ts",
    redaction: R.sharedRedactor,
    reason: "a self-contained HTML file with the whole rule graph embedded as JSON: every " + "preference and retired principle verbatim, plus each one's topic, scope and " + "provenance counts. It is the export most likely to be handed to a person rather " + "than a program - it opens in a browser - and it was the one export that never " + "scanned anything. Redaction runs over the graph TREE before the template " + "substitution, so a principle whose text contains a quote cannot disturb the " + "document. The label rule holds here too: a preference is not withheld for carrying " + "a `private` tag, because the `<private>` region marker is the only content-derived " + "privacy primitive in this product. The content-class default removes nothing here " + "either: preferences and retired principles are operator-curated rows and never " + "take the prompt-derived stamp, which is written by note creation, the session " + "import and the report writers only."
  },
  "brain-knowledge-pack-export": {
    id: "brain-knowledge-pack-export",
    verb: "o2b brain knowledge-pack export",
    module: "src/cli/brain/verbs/knowledge-pack.ts",
    redaction: R.sharedRedactor,
    reason: "a selected subset - preference principles and page bodies verbatim - built to be " + "handed to someone else, so it is the one export that also filters by LABEL before " + "it scans: a page declaring `visibility:`, an entry carrying `owner:`, an " + "unreviewed `OKF Review/` candidate, and - since the content class shipped - a page " + "stamped content_class: prompt-derived are blocked and named, never written. What is " + "carried is redacted as a tree (OKF manifest, preference rows) and as text (pages) " + "BEFORE the pack is sealed, so the sha256 table hashes the bytes that left and a " + "recipient's integrity check verifies the redacted copy, not the vault. Preference " + "rows leave without their evidence links and rendered body."
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
  "decision-model-converse": {
    id: "decision-model-converse",
    verb: "decision_model_uses with decision_model_provider: converse",
    module: "src/core/decision-model/converse.ts",
    redaction: R.sharedRedactor,
    reason: "the optional decision-model route through a bearer-authenticated gateway that speaks " + "the Bedrock-style Converse protocol: the same masked, clipped state and question texts " + "as every decision route, POSTed as a chat-shaped request to the operator's configured " + "gateway. The state and questions pass the shared guard before the body is built and a " + "refusal sends nothing; the state is fenced as untrusted content because the mapping is " + "chat-shaped, and the scan carries the resolved bearer key as a literal so a value that " + "leaked into vault text cannot ride along with the credential it would otherwise meet. " + "Off unless the operator enables it in machine config AND the named key variable is " + "set; a vault can opt out."
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
import { existsSync as existsSync15 } from "node:fs";
var custodyStoreModule;
function custodyStore() {
  if (custodyStoreModule === undefined) {
    custodyStoreModule = (init_store(), __toCommonJS(exports_store));
  }
  return custodyStoreModule;
}
var configModule;
function discoverDeviceConfig() {
  if (configModule === undefined) {
    configModule = (init_config(), __toCommonJS(exports_config));
  }
  return configModule.discoverConfig();
}
function storeValue(vault, name) {
  if (vault === null)
    return;
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
      return storeValue(vault, storeSecretName(prop)) ?? env[prop];
    },
    has(_target, prop) {
      if (typeof prop !== "string")
        return Reflect.has(env, prop);
      return storeValue(vault, storeSecretName(prop)) !== undefined || Reflect.has(env, prop);
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
  const heldNames = new Set(held.map((meta) => meta.name));
  const out = [];
  if (held.length > 0 && existsSync15(store.keyPath(vault))) {
    for (const meta of held) {
      try {
        out.push(store.resolveSecretReadOnly(vault, meta.name).value);
      } catch {}
    }
  }
  out.push(...envReferenceLiterals(vault, heldNames));
  return out;
}
function envReferenceLiterals(vault, heldNames) {
  let data;
  try {
    const discovery = discoverDeviceConfig();
    if (!discovery.exists)
      return [];
    data = discovery.data;
  } catch {
    return [];
  }
  const out = [];
  for (const value of Object.values(data)) {
    const ref = parseSecretReference(value);
    if (!ref)
      continue;
    if (heldNames.has(storeSecretName(ref.name)))
      continue;
    const envValue = process.env[ref.name];
    if (envValue !== undefined)
      out.push(envValue);
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
  existsSync as existsSync17,
  mkdirSync as mkdirSync20,
  openSync as openSync10,
  readFileSync as readFileSync24,
  rmSync as rmSync4,
  writeSync as writeSync8,
  closeSync as closeSync12
} from "node:fs";
import { dirname as dirname23, join as join32 } from "node:path";

// src/core/partner/codegraph.ts
init_config();
init_fs_utils();
import { existsSync as existsSync16, readdirSync as readdirSync7, realpathSync as realpathSync4 } from "node:fs";
import { dirname as dirname22, join as join31, resolve as resolve17 } from "node:path";

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
    if (!existsSync16(dir))
      return false;
    if (!isDir(join31(dir, ".git")))
      return false;
    return CODE_MANIFEST_FILES.some((m) => existsSync16(join31(dir, m)));
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
    const path = resolve17(raw);
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
  const vaultParent = dirname22(resolve17(opts.vault));
  if (isDir(vaultParent)) {
    let entries2 = [];
    try {
      entries2 = readdirSync7(vaultParent);
    } catch {
      entries2 = [];
    }
    entries2.sort((a, b) => a.localeCompare(b));
    for (const name of entries2) {
      if (scanned >= limit)
        break;
      consider(join31(vaultParent, name));
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
  const indexDir = join31(project, ".codegraph");
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
    return realpathSync4(value);
  } catch {
    return value;
  }
}

// src/core/doctor.ts
var MANIFEST_FIX = "o2b update";
function checkVaultWriteable(vault) {
  if (!existsSync17(vault)) {
    return {
      name: "vault_writeable",
      ok: false,
      message: `vault directory missing: ${vault}`,
      fix: `mkdir -p "${vault}"`
    };
  }
  const probe = join32(vault, ".open-second-brain-doctor-test");
  try {
    const fd = openSync10(probe, "w");
    closeSync12(fd);
    rmSync4(probe);
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
    mkdirSync20(dirname23(config), { recursive: true });
    if (!existsSync17(config))
      createdForCheck = true;
    const fd = openSync10(config, "a");
    writeSync8(fd, "");
    closeSync12(fd);
    if (createdForCheck)
      rmSync4(config);
  } catch (exc) {
    return {
      name: "config_writeable",
      ok: false,
      message: `cannot write config ${config}: ${exc.message ?? exc}`,
      fix: `mkdir -p "${dirname23(config)}" && chmod u+rwx "${dirname23(config)}"`
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
    data = JSON.parse(readFileSync24(path, "utf8"));
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
    text = readFileSync24(path, "utf8");
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
  const pkgPath = join32(repoRoot, "package.json");
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
    const entryPath = join32(repoRoot, entry);
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
    results.push(checkClaudeManifest(join32(root, ".claude-plugin", "plugin.json")));
    results.push(checkCodexManifest(join32(root, ".codex-plugin", "plugin.json")));
    results.push(checkHermesManifest(join32(root, "plugins", "hermes", "plugin.yaml")));
    results.push(checkOpenclawManifest(join32(root, "openclaw.plugin.json")));
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
import { readFileSync as readFileSync25 } from "node:fs";
import { dirname as dirname24, resolve as resolve18 } from "node:path";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var TEMPLATE_PATH = resolve18(dirname24(fileURLToPath2(import.meta.url)), "..", "..", "templates", "identity-reminder.txt");
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
    commonTemplateCache = readFileSync25(TEMPLATE_PATH, "utf8").trimEnd();
    return commonTemplateCache;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to load identity reminder template from ${TEMPLATE_PATH}: ${message}`, {
      cause: err
    });
  }
}
var TEMPLATES_DIR = resolve18(dirname24(fileURLToPath2(import.meta.url)), "..", "..", "templates");
var PER_TARGET_PATHS = Object.freeze(Object.fromEntries(KNOWN_RUNTIME_TARGETS.map((t) => [t, resolve18(TEMPLATES_DIR, `identity-reminder.${t}.txt`)])));
var TEMPLATE_CACHE = new Map;
function tryReadTargetTemplate(target) {
  const cached = TEMPLATE_CACHE.get(target);
  if (cached !== undefined)
    return cached;
  let body;
  try {
    body = readFileSync25(PER_TARGET_PATHS[target], "utf8").trimEnd();
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

// src/openclaw/index.ts
init_vault();
init_transport_reach();

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
init_envelope2();
init_secret_ref();
var VAULT_PATH_OUTPUT_SCHEMA = Object.freeze({});
var CONFIG_UNREADABLE_REASON = "the device-local config could not be read, so this reference cannot be " + "resolved; call second_brain_status for the file and the remedy";
var SECRET_STORE_LOCKED_REASON = "the vault's credential store is locked, so the installation secret " + "reference cannot be resolved; set OPEN_SECOND_BRAIN_SECRETS_PASSPHRASE " + "for the server process, pass --passphrase-from-env or the passphrase on " + "stdin to any key-bearing verb, or run `o2b brain secret unwrap` to " + "return the store to its raw state";
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
  if (ctx.vaultOrNull === null)
    return null;
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
