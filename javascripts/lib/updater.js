'use strict';
var path = require('path');
var irkit = require('./irkit');
var async = require('async');
var github = require('./github');
var passwordExtractor = require("./password_extractor");
var passwordReplacer = require("./intelhex_replacer");
var versionExtractor = require("./version_extractor");
var temp = require("temp");
temp.track(); // automatic cleanup

module.exports = {
  // callback(err, foundPort, availableRelease)
  onReady: function(callback) {
    var foundPort = null;
    var availableRelease = null;

    async.waterfall([
      irkit.serialports,
      function (irkitPorts, callback) {
        if (irkitPorts.length !== 1) {
          callback( "IRKit not connected. Connect IRKit with a USB cable to this machine and restart" );
          return;
        }

        foundPort = irkitPorts[0];

        callback(null);
      },
      function (callback) {
        // GET https://api.github.com/repos/irkit/device/releases
        github.releases('irkit','device', callback);
      },
      function (response, releases, callback) {
        var releasesWithAssets = releases.filter( function(release,index) {
          // if ( (release.assets.length > 0) && !release.prerelease ) { // TODO uncomment
          if ( release.assets.length > 0 ) {
            return true;
          }
          return false;
        });

        if (releasesWithAssets.length === 0) {
          callback( "No available versions found on https://github.com/irkit/device/releases" );
          return;
        }

        availableRelease = releasesWithAssets[0];

        callback(null);
      }
    ], function (err) {
      callback( err, foundPort, availableRelease );
    });
  },
  // progress( message )
  // completion( error, fromVersion, toVersion )
  update: function (port, release, progress, completion) {
    function callProgressStep(message) {
      return function () {
        progress(message);

        // pass along arguments
        var args = Array.prototype.slice.call(arguments);
        var callback = args.pop();
        args.unshift(null); // error is null
        callback.apply(null, args);
      };
    }
    function sleepStep (sleep) {
      return function () {
        progress("Sleeping for " + sleep + " seconds\n");

        // pass along arguments
        var args = Array.prototype.slice.call(arguments);
        var callback = args.pop();
        args.unshift(null); // error is null
        setTimeout( function () {
          callback.apply(null, args);
        }, sleep * 1000 );
      };
    }

    var downloader = new github.Downloader(release);
    var hexFilePath = null;
    var fromVersion = null;
    var toVersion = null;

    async.waterfall([
      callProgressStep( "Downloading "+release.name+" from "+release.url + "\n" ),
      downloader.download.bind(downloader),
      function (path, callback) {
        progress( "Successfully downloaded to "+path+"\n" );
        hexFilePath = path;
        callback();
      },
      callProgressStep( "Reading current firmware from IRKit\n" ),
      function (callback) {
        irkit.readFlash( port, 10000, progress, callback );
      },
      function (readHEXFilePath, callback) {
        progress( "Successfully read Flash into "+readHEXFilePath+"\n" );
        hexFilePath = readHEXFilePath;
        callback();
      },
      function (callback) {
        progress( "Extracting current version\n" );
        versionExtractor.extract(hexFilePath, progress, callback);
      },
      function (version, callback) {
        progress( "Current version: "+version+"\n" );
        fromVersion = version;
        callback();
      },
      function (callback) {
        passwordExtractor.extract(hexFilePath, progress, callback);
      },
      function (password, callback) {
        progress( "Extracted original password "+password+"\n" );
        progress( "Replacing password in hex file\n" );

        var file = temp.openSync({ suffix: ".hex" }); // I know, I know but creating temp files are not gonna take much time
        passwordReplacer.replace( path.normalize(hexFilePath),
                                  "XXXXXXXXXX",
                                  password,
                                  file.path,
                                  progress,
                                  callback );
        hexFilePath = file.path;
      },
      sleepStep(5),
      function (callback) {
        progress( "Writing new firmware\n" );
        irkit.writeFlash( port, hexFilePath, 10000, progress, callback );
      },
      sleepStep(5),
      function (callback) {
        progress( "Checking firmware\n" );
        irkit.readFlash( port, 10000, progress, callback );
      },
      function (flashHEXPath, callback) {
        progress( "Extracting written version\n" );
        versionExtractor.extract(flashHEXPath, progress, callback);
      },
      function (version, callback) {
        progress( "Read version: "+version+"\n" );
        toVersion = version;

        var readVersion = version.split(".");
        var downloadedVersion = release.tag_name.replace(/^v/,"").split(".");
        if ((readVersion[0] == downloadedVersion[0]) &&
            (readVersion[1] == downloadedVersion[1]) &&
            (readVersion[2] == downloadedVersion[2])) {
          callback();
        }
        else {
          callback( "Invalid version!!\n" +
                    "Version expected to be " + downloadedVersion.join(".") + " but got " + version );
        }
      }
    ], function (err) {
      completion(err, fromVersion, toVersion);
    });
  }
};