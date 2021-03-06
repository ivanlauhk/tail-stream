var path = require('path');
var stream = require('stream');
var util = require('util');
var fs = require('fs');

function TailStream(filepath, opts) {
    TailStream.super_.call(this, opts);

    this.lastSize = null;
    this.bytesRead = 0;
    this.watching = false;
    this.path = path.resolve(filepath);

    this.opts = {
        beginAt: 0,
        detectTruncate: true,
        onMove: 'follow', // or 'end' or 'exit' or 'stay'
        onTruncate: 'end', // or 'reset' to seek to beginning of file
        endOnError: false,
        useWatch: !!fs.watch,
        waitForCreate: false
    };

    for(var key in opts) {
        this.opts[key] = opts[key];
    }
    
    this._start = function() {
        this.firstRead = true;
        this.waitingForReappear = false;
        fs.openSync(this.path, 'r', (err, fd) => {
            if(err) {
                if(!this.opts.waitForCreate) { throw e; }
                this.fd = null;
                this.dataAvailable = false;
                this.waitForFileToReappear();
            }
            else {
                this.fd = fd;
                this.dataAvailable = true;
            }
        });
    };
    this._destroy = (err, cb) => {
        this.end();
        cb(err);
    };

    this.getCurrentPath = function(filename, callback) {
        if(filename && !fs.existsSync('/proc')) {
            return filename;
        }
        try {
            return fs.readlinkSync('/proc/self/fd/'+this.fd);
        } catch(e) {
            if(filename) return filename;
            return null;
        }
    };

    this.waitForFileToReappear = function() {
        // if we're using fs.watch, cancel it
        // since it follows moved files
        // we will switch to fs.watchFile
        // until a file re-appears at this.path
        if(this.opts.useWatch) {
            if(this.watcher && this.watcher.close) {
                this.watcher.close();
            }
            this.watcher = null;
        }
        if(this.fd) {
            this.fd = fs.closeSync(this.fd);
        }
        this.waitingForReappear = true;
        this.waitForMoreData(true);
    };

    this.fileReappeared = function() {
        try {
            this.fd = fs.openSync(this.path, 'r');
        } catch(e) {
            return;
        }
        this.waitingForReappear = false;
        // switch back to fs.watch if supported
        if(this.opts.useWatch) {
            this.waitForMoreData();
        }
        this.emit('replace');
        // reset size and bytes read since this is a new file
        this.lastSize = null;
        this.bytesRead = 0;
    };

    this.move = function(newpath) {
        var oldpath = this.path ? path.resolve(this.path) : null;
        if(this.opts.onMove == 'end') {
            this.path = newpath;
            this.emit('end'); return;
        } else if(this.opts.onMove == 'error') {
            this.path = newpath;
            this.error("File move detected"); return;
        } else if(this.opts.onMove == 'stay') {
            this.emit('move', oldpath, newpath);
            this.waitForFileToReappear();
        } else { // opts.onMove == 'follow
            this.path = newpath;
            this.emit('move', oldpath, newpath);
            this.waitForMoreData();
        }
    };

    // If forceWatchFile is true always use fs.watchFile instead of fs.watch
    this.waitForMoreData = function(forceWatchFile) {
        if(this.watcher) {
            return;
        }
        if(this.opts.useWatch && !forceWatchFile) {
            this.watcher = fs.watch(this.path, {persistent: true}, (event, filename) => {
                if(event === 'change') {
                    this.dataAvailable = true;
                    this.read(0);
                } else if(event === 'rename') {
                    var newpath = this.getCurrentPath(filename);
                    this.move(newpath);
                }
            });
        } else {
            // On Mac OS X and Linux, watchFile doesn't report the (re)appearance of
            // the file. Watch the enclosing dir and then compare the filename of events
            this.watcher = fs.watch(path.dirname(this.path), {persistent: true}, (event, filename) => {
                if(filename && path.basename(this.path) === filename) {
                    this.fileReappeared();
                }
            });
        }
    };

    this.error = function(msg, code) {
        if(this.opts.endOnError) {
            this.end(code);
        } else {
            this.emit('error', msg);
        }
    };

    this.watchFileCallback = function(cur, prev) {
        // was the file moved or deleted?
        if(!cur.dev && !cur.ino) {
            if(this.waitingForReappear) {
                return;
            }
            // check if it was moved
            var newpath = this.getCurrentPath();
            if(!newpath) {
                this.error("File was deleted", 'EBADF');
                return;
            } else {
                this.move(newpath);
            }
        }
        if(this.waitingForReappear) { // file re-appeared
            this.fileReappeared();
        }
        if(cur.mtime.getTime() > prev.mtime.getTime()) {
            this.dataAvailable = true;
            this.read(0);
        }

    };

    this.end = function(errCode) {
        this.dataAvailable = false;
        this.closed = true;
        this.push(null);
        if(this.fd) {
            this.fd = fs.closeSync(this.fd);
        }
        if(this.watcher) {
            if(this.watcher.close) {
                this.watcher.close();
            }
            this.watcher = null;
        }
    };

    this._read = function(size) {
        if(!this.dataAvailable) {
            return this.push('');
        }

        if(!this.path) {
            return this._readCont();
        }
        if((this.opts.detectTruncate || (this.firstRead && (this.opts.beginAt == 'end')))) {
            // check for truncate
            fs.stat(this.path, (err, stat) => {
                this._readCont.call(this, err, stat);
            });
        } else {
            this._readCont();
        }
    };

    this._readCont = function(err, stat) {
        if(err) {
            if(err.code == 'ENOENT') {
                if (this.opts.onMove !== 'follow') {
                    this.error("File deleted", err.code);
                }
            } else {
                this.error("Error during truncate detection: " + err, err.code);
            }
            stat = null;
        }

        if(stat) {
            // seek to end of file
            if(this.firstRead && (this.opts.beginAt == 'end')) {
                this.bytesRead = stat.size;
                this.dataAvailable = false;
                this.waitForMoreData();
                this.push('');
                this.firstRead = false;
                return;
            }

            // truncate detection
            if(!this.lastSize) {
                this.lastSize = stat.size;
            } else {
                if(stat.size < this.lastSize) {
                    this.emit('truncate', stat.size, this.lastSize);
                    if(this.opts.onTruncate == 'reset') {
                        this.bytesRead = 0;
                    } else {
                        this.end();
                        return;
                    }
                }
            }
            this.lastSize = stat.size;
        }

        // seek to desired start position
        if(this.firstRead) {
            if(parseInt(this.opts.beginAt) > 0) {
                this.bytesRead = parseInt(this.opts.beginAt);
            }
            this.firstRead = false;
        }
        if(!this.fd) {
            return false;
        }
        var buffer = Buffer.alloc(16 * 1024);
        fs.read(this.fd, buffer, 0, buffer.length, this.bytesRead, (err, bytesRead) => {
            if(err) {
                if(this.opts.endOnError) {
                    this.end(err.code);
                    return;
                } else {
                    this.waitForMoreData();
                    this.push('');
                    this.emit('error', err);
                }
            }

            if(bytesRead === 0) {
                this.dataAvailable = false;
                this.waitForMoreData();
                this.push('');
                this.emit('eof');
                return;
            }
            if(!this.destroyed) {
                this.bytesRead += bytesRead;
                if(!this.push(buffer.slice(0, bytesRead))) {
                    // TDOD: Maybe something should be done of the downstream consumer returns false?
                }
            }
        });
    };

    this._start();
}
util.inherits(TailStream, stream.Readable);

module.exports = ts = {
    createReadStream: function(path, options) {
        return new TailStream(path, options);
    }
};