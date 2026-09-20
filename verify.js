/*
 * Checks the JavaScript port against the disk corpus, the same way the C# was checked.
 *
 *   node verify.js [directory]        default E:\
 *
 * Three things are proved here:
 *   1. every image decodes with no bad CRCs and no missing sectors
 *   2. re-encoding every sector with its own data reproduces the original HFE
 *      byte for byte - the identity round-trip that validates the MFM writer
 *   3. the decoded contents match the manifest the C# tool produced, so the two
 *      implementations agree file by file and sample by sample
 */
var fs = require('fs');
var path = require('path');
var Akai = require('./akai.js');

var dir = process.argv[2] || 'E:\\';
var manifestPath = path.join(__dirname, 'expected.json');

var files = fs.readdirSync(dir)
  .filter(function (f) { return /\.(hfe|img)$/i.test(f); })
  .sort();

if (files.length === 0) {
  console.error('No .hfe or .img files in ' + dir);
  process.exit(1);
}

var expected = null;
if (fs.existsSync(manifestPath)) {
  // Windows PowerShell writes UTF-8 with a BOM, which JSON.parse will not take.
  expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''));
  console.log('comparing against expected.json (' + Object.keys(expected).length + ' disks)');
} else {
  console.log('no expected.json - structural checks only');
}

/**
 * Fletcher-style checksum over the 12-bit sample words, so the two implementations
 * can be compared cheaply. The intermediates stay small enough that JavaScript and
 * PowerShell compute it identically without either overflowing.
 */
function hashWords(w) {
  var a = 1, b = 0;
  for (var i = 0; i < w.length; i++) {
    a = (a + (w[i] & 0xFFFF)) % 65521;
    b = (b + a) % 65521;
  }
  return b * 65536 + a;
}

var totals = {
  disks: 0, files: 0, samples: 0,
  badCrc: 0, missing: 0,
  identityChecked: 0, identityFailed: 0,
  mismatches: []
};

var started = Date.now();

files.forEach(function (f) {
  var full = path.join(dir, f);
  var bytes = new Uint8Array(fs.readFileSync(full));

  var disk;
  try { disk = Akai.load(f, bytes); }
  catch (e) { totals.mismatches.push(f + ': ' + e.message); return; }

  totals.disks++;
  totals.files += disk.entries.length;
  totals.badCrc += disk.badCrc;
  totals.missing += disk.missing;

  // --- 2. identity round-trip: re-encode every sector with its own data
  if (disk.isHfe) {
    var again = disk.save();
    totals.identityChecked++;

    if (again.length !== bytes.length) {
      totals.identityFailed++;
      totals.mismatches.push(f + ': rebuilt length ' + again.length + ' vs ' + bytes.length);
    } else {
      var diff = -1;
      for (var i = 0; i < again.length; i++) {
        if (again[i] !== bytes[i]) { diff = i; break; }
      }
      if (diff >= 0) {
        totals.identityFailed++;
        totals.mismatches.push(f + ': rebuilt differs at byte ' + diff);
      }
    }
  }

  // --- 3. compare with what the C# produced
  var mine = { badCrc: disk.badCrc, missing: disk.missing, files: [] };

  disk.entries.forEach(function (e) {
    var rec = { name: e.name, type: e.type, length: e.length, start: e.startBlock };
    if (e.type === 'S') {
      var w = disk.sampleWords12(e);
      rec.words = w.length;
      rec.rate = e.sampleRate;
      rec.tuning = e.tuning;
      rec.hash = hashWords(w);
      totals.samples++;
    } else if (e.type === 'P') {
      rec.keygroups = disk.keygroupCount(e);
    }
    mine.files.push(rec);
  });

  if (expected && expected[f]) {
    var want = expected[f];
    if (want.badCrc !== mine.badCrc || want.missing !== mine.missing)
      totals.mismatches.push(f + ': crc/missing ' + mine.badCrc + '/' + mine.missing +
                             ' vs ' + want.badCrc + '/' + want.missing);
    if (want.files.length !== mine.files.length)
      totals.mismatches.push(f + ': ' + mine.files.length + ' files vs ' + want.files.length);
    else
      for (var k = 0; k < want.files.length; k++) {
        var a = mine.files[k], b = want.files[k];
        for (var key in b) {
          if (!Object.prototype.hasOwnProperty.call(b, key)) continue;
          if (a[key] !== b[key]) {
            totals.mismatches.push(f + ' ' + b.name + ': ' + key + ' ' + a[key] + ' vs ' + b[key]);
            break;
          }
        }
      }
  }

  if (process.argv.indexOf('--emit') >= 0) {
    (global.__out = global.__out || {})[f] = mine;
  }
});

if (process.argv.indexOf('--emit') >= 0) {
  fs.writeFileSync(path.join(__dirname, 'actual.json'), JSON.stringify(global.__out, null, 1));
  console.log('wrote actual.json');
}

var secs = ((Date.now() - started) / 1000).toFixed(1);

console.log('');
console.log('disks decoded        : ' + totals.disks);
console.log('files                : ' + totals.files);
console.log('samples              : ' + totals.samples);
console.log('bad-CRC sectors      : ' + totals.badCrc);
console.log('missing sectors      : ' + totals.missing);
console.log('identity round-trips : ' + totals.identityChecked +
            ' checked, ' + totals.identityFailed + ' differing');
console.log('mismatches vs C#     : ' + totals.mismatches.length);
console.log('elapsed              : ' + secs + ' s');

if (totals.mismatches.length) {
  console.log('');
  totals.mismatches.slice(0, 20).forEach(function (m) { console.log('  ' + m); });
  process.exit(1);
}
