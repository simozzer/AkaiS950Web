/*
 * Writing raw .img images, for FlashFloppy.
 *
 * An .img is the 800K sector image the sampler sees, with no MFM container around it, so
 * converting an .hfe to one should lose nothing at all. This checks that on every image:
 * the bytes match the decoded sectors exactly, the result reloads with the same contents,
 * and a second round trip is stable.
 *
 *   node imgtest.js [directory]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');

var dir = process.argv[2] || 'E:' + String.fromCharCode(92);
var SECTORS = 800, SSZ = 1024;
var totals = { disks: 0, bytes: 0, rebuilt: 0, identical: 0, problems: [] };

function fingerprint(disk) {
  var out = [];
  disk.entries.forEach(function (e) {
    out.push(e.slot + ':' + e.type + ':' + e.name.trim() + ':' + e.length + ':' + e.startBlock +
             (e.type === 'S' ? ':' + e.sampleCount + ':' + e.sampleRate + ':' + e.memoryAddress : ''));
  });
  disk.programsInOrder().forEach(function (p) {
    disk.keygroups(p).forEach(function (kg, k) {
      out.push(p.name.trim() + '/' + k + '/' + kg.lowKey + '-' + kg.highKey +
               '/' + kg.nextKeygroup + '/' + kg.zone1.name.trim() + ':' + kg.zone1.pointer +
               '/' + kg.zone2.name.trim() + ':' + kg.zone2.pointer);
    });
  });
  return out.join('|');
}

fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).sort().forEach(function (f) {
  var disk;
  try { disk = Akai.load(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))); }
  catch (e) { return; }

  totals.disks++;
  function bad(m) { totals.problems.push(f + ': ' + m); }

  var img = disk.save('img');
  totals.bytes += img.length;

  if (img.length !== SECTORS * SSZ)
    bad('img is ' + img.length + ' bytes, expected ' + (SECTORS * SSZ));

  // it must be exactly the sectors the HFE decoded to, byte for byte
  for (var i = 0; i < Math.min(img.length, disk.image.length); i++)
    if (img[i] !== disk.image[i]) { bad('img differs from the decoded sectors at ' + i); break; }

  // writing it must not have disturbed the disk it came from
  if (disk.save('img').length !== img.length) bad('a second save gave a different length');

  // and it must reload as the same disk
  var back;
  try { back = Akai.load(f.replace(/\.hfe$/i, '.img'), img); }
  catch (e) { bad('the .img will not load back - ' + e.message); return; }

  if (back.isHfe) bad('reloaded .img claims to be HFE');
  if (back.badCrc || back.missing)
    bad('reloaded .img reports ' + back.badCrc + ' bad-CRC, ' + back.missing + ' missing');
  if (back.entries.length !== disk.entries.length)
    bad('reloaded .img has ' + back.entries.length + ' files, expected ' + disk.entries.length);

  if (fingerprint(back) !== fingerprint(disk)) {
    var a = fingerprint(disk).split('|'), b = fingerprint(back).split('|'), first = '';
    for (var i = 0; i < Math.max(a.length, b.length); i++)
      if (a[i] !== b[i]) { first = '"' + a[i] + '" -> "' + b[i] + '"'; break; }
    bad('contents changed through the .img - ' + first);
  }

  // sample audio has to survive too, not just the headers
  disk.entries.filter(function (e) { return e.type === 'S'; }).forEach(function (s) {
    var was = disk.sampleWords12(s);
    var now = null;
    back.entries.forEach(function (x) { if (x.type === 'S' && x.slot === s.slot) now = x; });
    if (!now) { bad(s.name.trim() + ' is missing from the .img'); return; }

    var got = back.sampleWords12(now);
    if (got.length !== was.length) { bad(s.name.trim() + ' word count changed'); return; }
    for (var i = 0; i < was.length; i++)
      if (was[i] !== got[i]) { bad(s.name.trim() + ' audio differs at word ' + i); return; }
  });

  // --- and back to HFE, built from nothing but the sectors.
  //
  // The library's disks were all written by the same drive to the same layout, so a
  // correct encoder does not merely produce something readable - it reproduces the
  // original file. Anything less than byte-for-byte here means the track synthesis is
  // guessing somewhere, so that is what is checked.
  if (!back.canSave('hfe')) bad('a raw image says it cannot be written as HFE');

  var rebuilt;
  try { rebuilt = back.save('hfe'); }
  catch (e) { bad('building an HFE from the raw image threw - ' + e.message); return; }
  totals.rebuilt++;

  var original = new Uint8Array(fs.readFileSync(path.join(dir, f)));
  if (rebuilt.length !== original.length)
    bad('rebuilt HFE is ' + rebuilt.length + ' bytes, original ' + original.length);
  else {
    var at = -1;
    for (var i = 0; i < rebuilt.length; i++)
      if (rebuilt[i] !== original[i]) { at = i; break; }

    if (at < 0) totals.identical++;
    else bad('rebuilt HFE differs from the original at byte ' + at +
             ' (0x' + rebuilt[at].toString(16) + ' vs 0x' + original[at].toString(16) + ')');
  }

  // it must also decode back to the same disk, not just match bytes
  var viaHfe = Akai.load(f, rebuilt);
  if (viaHfe.badCrc || viaHfe.missing)
    bad('rebuilt HFE reports ' + viaHfe.badCrc + ' bad-CRC, ' + viaHfe.missing + ' missing');
  if (fingerprint(viaHfe) !== fingerprint(disk))
    bad('contents changed through img -> hfe');

  // img -> img is stable
  var twice = back.save('img');
  if (twice.length !== img.length) bad('img -> img changed length');
  for (var i = 0; i < twice.length; i++)
    if (twice[i] !== img[i]) { bad('img -> img differs at byte ' + i); break; }
});

console.log('');
console.log('images converted : ' + totals.disks);
console.log('bytes written    : ' + totals.bytes.toLocaleString());
console.log('rebuilt as HFE   : ' + totals.rebuilt +
            '   byte-identical to the original: ' + totals.identical);
console.log('problems         : ' + totals.problems.length);

if (totals.problems.length) {
  console.log('');
  totals.problems.slice(0, 20).forEach(function (p) { console.log('  ' + p); });
  process.exit(1);
}
