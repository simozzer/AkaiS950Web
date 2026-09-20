/*
 * Builds AkaiS950Web.zip - what the page's "Download source" link hands the user.
 *
 * Just enough to run the app locally: the page, whatever the page loads, the little
 * server, and the README. Nothing else - the checkers, the calibration rig and the format
 * document are all on GitHub for anyone who wants them, and a download that only has to
 * work is friendlier than one that carries the workshop with it.
 *
 * The file list is read out of index.html rather than kept by hand, so a script added to
 * the page is in the next zip without anyone remembering. The previous version of this
 * kept a list of twenty-seven paths, which went stale the moment the repository was
 * reorganised.
 *
 *   node tools/makezip.js
 */
var fs = require('fs');
var path = require('path');
var zlib = require('zlib');

var ROOT = path.join(__dirname, '..');
var OUT = path.join(ROOT, 'AkaiS950Web.zip');

/* ------------------------------------------------------- what goes in the zip */

var page = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
var loaded = [];
var re = /(?:src|href)\s*=\s*"([^"]+)"/g, m;
while ((m = re.exec(page))) {
  var ref = m[1];
  // only what the page loads from beside itself: no http(s), no data:, no anchors,
  // and not the zip this script is building
  if (/^[a-z]+:/i.test(ref) || ref.charAt(0) === '#' || ref.indexOf('/') >= 0) continue;
  if (ref === 'AkaiS950Web.zip') continue;
  if (loaded.indexOf(ref) < 0 && fs.existsSync(path.join(ROOT, ref))) loaded.push(ref);
}

var files = ['index.html'].concat(loaded, ['serve.js', 'README.md']);

var missing = files.filter(function (f) { return !fs.existsSync(path.join(ROOT, f)); });
if (missing.length) {
  console.error('missing: ' + missing.join(', '));
  process.exit(1);
}

/* ------------------------------------------------------------- a minimal zip */

var CRC = (function () {
  var t = new Int32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  var c = 0xFFFFFFFF;
  for (var i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** MS-DOS packed date and time, which is what a zip entry carries. */
function dosStamp(d) {
  return {
    time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
    date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF
  };
}

var local = [], central = [], offset = 0;

files.forEach(function (name) {
  var full = path.join(ROOT, name);
  var body = fs.readFileSync(full);
  var packed = zlib.deflateRawSync(body, { level: 9 });
  var stamp = dosStamp(fs.statSync(full).mtime);
  var sum = crc32(body);
  var nameBuf = Buffer.from(name, 'utf8');

  var head = Buffer.alloc(30);
  head.writeUInt32LE(0x04034B50, 0);      // local file header
  head.writeUInt16LE(20, 4);              // version needed
  head.writeUInt16LE(0, 6);               // flags
  head.writeUInt16LE(8, 8);               // deflate
  head.writeUInt16LE(stamp.time, 10);
  head.writeUInt16LE(stamp.date, 12);
  head.writeUInt32LE(sum, 14);
  head.writeUInt32LE(packed.length, 18);
  head.writeUInt32LE(body.length, 22);
  head.writeUInt16LE(nameBuf.length, 26);
  head.writeUInt16LE(0, 28);              // no extra field

  local.push(head, nameBuf, packed);

  var entry = Buffer.alloc(46);
  entry.writeUInt32LE(0x02014B50, 0);     // central directory header
  entry.writeUInt16LE(20, 4);             // version made by
  entry.writeUInt16LE(20, 6);             // version needed
  entry.writeUInt16LE(0, 8);
  entry.writeUInt16LE(8, 10);
  entry.writeUInt16LE(stamp.time, 12);
  entry.writeUInt16LE(stamp.date, 14);
  entry.writeUInt32LE(sum, 16);
  entry.writeUInt32LE(packed.length, 20);
  entry.writeUInt32LE(body.length, 24);
  entry.writeUInt16LE(nameBuf.length, 28);
  entry.writeUInt16LE(0, 30);             // extra
  entry.writeUInt16LE(0, 32);             // comment
  entry.writeUInt16LE(0, 34);             // disk
  entry.writeUInt16LE(0, 36);             // internal attributes
  entry.writeUInt32LE(0, 38);             // external attributes
  entry.writeUInt32LE(offset, 42);
  central.push(entry, nameBuf);

  offset += head.length + nameBuf.length + packed.length;
});

var dir = Buffer.concat(central);
var end = Buffer.alloc(22);
end.writeUInt32LE(0x06054B50, 0);         // end of central directory
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(dir.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);                 // no archive comment

fs.writeFileSync(OUT, Buffer.concat(local.concat([dir, end])));

/* ------------------------------------------------------------------ the report */

var build = (fs.readFileSync(path.join(ROOT, 'akai.js'), 'utf8')
  .match(/Akai\.BUILD = '([^']+)'/) || [])[1];

console.log('AkaiS950Web.zip  ' + Math.round(fs.statSync(OUT).size / 1024) + ' KB  (' +
            files.length + ' files)');
files.forEach(function (f) { console.log('  ' + f); });
console.log('build ' + build + '   -   the stamp inside must match the one the page shows');
