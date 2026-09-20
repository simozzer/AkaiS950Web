/*
 * Checks a disk image for the kinds of damage that would upset a sampler.
 *
 *   node fsck.js <image> [more images...]
 *
 * Read-only: it never writes to the file it is given.
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');

var BLOCK = 1024, FAT_OFF = 0x600, FAT_END = 0x8000, DIR_OFF = 0, ENTRY = 24, DIR_ENTRIES = 64;

function ramSize(words) { return Math.floor((2 * words + 15) / 16) * 16; }

/** 10-byte descriptors a sample consumes, which its loop mode decides. */
function loopRecords(words, mode) {
  var pages = Math.floor(2 * words / 131072);
  return mode === 'L' ? 3 + pages : mode === 'A' ? 3 * (1 + pages) : 2 + pages;
}

function check(file) {
  var bytes = new Uint8Array(fs.readFileSync(file));
  var disk, problems = [], notes = [];

  function bad(s) { problems.push(s); }
  function note(s) { notes.push(s); }

  try { disk = Akai.load(path.basename(file), bytes); }
  catch (e) { console.log(path.basename(file) + ': WILL NOT LOAD - ' + e.message); return 1; }

  console.log('');
  console.log('=== ' + path.basename(file) + '  (' + bytes.length.toLocaleString() + ' bytes)');

  // --- the medium itself
  if (disk.badCrc) bad(disk.badCrc + ' sectors with a bad CRC');
  if (disk.missing) bad(disk.missing + ' sectors could not be found at all');

  var total = disk.totalBlocks();
  var fat = function (b) {
    var o = FAT_OFF + b * 2;
    return o + 1 >= disk.image.length ? FAT_END : (disk.image[o] | (disk.image[o + 1] << 8));
  };

  // --- the shape of the directory itself
  // All 100 factory images fill slots 0..n-1 with no holes, so the sampler may well
  // read until the first empty slot and stop. A hole hides everything past it.
  var occupied = [];
  for (var i = 0; i < DIR_ENTRIES; i++)
    if (disk.image[DIR_OFF + i * ENTRY] !== 0) occupied.push(i);

  var holes = [];
  if (occupied.length)
    for (var i = 0; i < occupied[occupied.length - 1]; i++)
      if (occupied.indexOf(i) < 0) holes.push(i);

  if (holes.length)
    bad('the directory has ' + holes.length + ' empty slot(s) before the last file (' +
        holes.join(', ') + '); the sampler may stop reading there');
  // Programs, then OVERALL, then the drum set, then samples: 98 of 100 factory disks
  // are exactly PODS and the other two are programs only.
  var seq = '';
  disk.entries.forEach(function (e) { if (seq.charAt(seq.length - 1) !== e.type) seq += e.type; });
  if (seq && 'PODS'.indexOf(seq) < 0)
    note('files are grouped as ' + seq + ', not the usual P/O/D/S order');

  // --- the directory, and who owns which block
  var owner = {};                     // block -> file name
  var usedByChain = {};

  disk.entries.forEach(function (e) {
    if (e.startBlock < 4 || e.startBlock >= total)
      bad(e.name + ': starts at block ' + e.startBlock + ', outside the data area');

    var seen = {}, b = e.startBlock, n = 0, looped = false;
    while (b !== FAT_END && b >= 0 && b < total) {
      if (seen[b]) { looped = true; break; }
      seen[b] = true;
      usedByChain[b] = true;

      if (owner[b] !== undefined)
        bad('block ' + b + ' is claimed by both ' + owner[b] + ' and ' + e.name);
      owner[b] = e.name;

      if (b < 4) bad(e.name + ': chain runs through reserved block ' + b);
      n++;
      if (n > total) { looped = true; break; }
      b = fat(b);
    }
    if (looped) bad(e.name + ': its block chain loops');
    else if (b !== FAT_END && !(b >= 0 && b < total))
      bad(e.name + ': chain ends on out-of-range block ' + b);

    var need = Math.ceil(e.length / BLOCK);
    if (n < need) bad(e.name + ': ' + n + ' blocks allocated for ' + e.length +
                      ' bytes, needs ' + need);
    else if (n > need) note(e.name + ': ' + (n - need) + ' block(s) more than it needs');
  });

  // --- blocks the table says are in use but nothing owns, and the reverse
  var lost = 0, phantom = 0;
  for (var b = 4; b < total; b++) {
    var f = fat(b);
    if (f !== 0 && !usedByChain[b]) lost++;
    if (f === 0 && usedByChain[b]) phantom++;
  }
  if (lost) bad(lost + ' block(s) marked in use but belonging to no file');
  if (phantom) bad(phantom + ' block(s) used by a file but marked free');

  // Programs and samples repeat their name in the first ten bytes of the file, and it is
  // that copy the S950 displays - the directory entry is only how the tool finds it. All
  // 1104 library samples and 383 of its 388 programs hold the same name in both places
  // (the rest differ only by leading spaces), so a mismatch means the file appears on the
  // sampler under a name nobody chose.
  disk.entries.forEach(function (e) {
    if (e.type !== 'P' && e.type !== 'S') return;

    var body = disk.readFile(e), inFile = '';
    for (var i = 0; i < 10 && i < body.length; i++) {
      var ch = body[i];
      inFile += (ch >= 0x20 && ch < 0x7F) ? String.fromCharCode(ch) : ' ';
    }

    if (inFile.trim() !== e.name.trim())
      bad(e.name.trim() + ' is listed under that name but calls itself ' +
          JSON.stringify(inFile.trim()) + ', which is what the sampler will show');
  });

  // --- per-type structure
  var prevSample = null;
  disk.entries.filter(function (e) { return e.type === 'S'; })
              .sort(function (a, b) { return a.slot - b.slot; })
              .forEach(function (s) {
    if (s.sampleCount % 2) bad(s.name + ': odd sample count ' + s.sampleCount);
    if (s.length !== 60 + 1.5 * s.sampleCount)
      bad(s.name + ': length ' + s.length + ', expected ' + (60 + 1.5 * s.sampleCount) +
          ' for ' + s.sampleCount + ' words');
    if (s.sampleRate < 1000 || s.sampleRate > 48000)
      bad(s.name + ': sample rate ' + s.sampleRate + ' Hz');
    if ('OLA'.indexOf(s.loopMode) < 0)
      bad(s.name + ': loop mode is ' + JSON.stringify(s.loopMode));
    if (s.loopEnd > s.sampleCount)
      note(s.name + ': end marker ' + s.loopEnd + ' past the end (' + s.sampleCount + ')');

    if (prevSample) {
      var want = prevSample.memoryAddress + ramSize(prevSample.sampleCount);
      if (s.memoryAddress !== want)
        note(s.name + ': RAM address 0x' + s.memoryAddress.toString(16) +
             ', the chain implies 0x' + want.toString(16));

      // Loop descriptors sit in one table in directory order, and how many a sample
      // takes depends on its loop mode - so a mode changed without moving the rest
      // leaves every later sample reading the wrong records. 1,002 of the library's
      // 1,011 consecutive samples follow this exactly.
      var wantPtr = prevSample.loopDescriptorPtr +
                    10 * loopRecords(prevSample.sampleCount, prevSample.loopMode);
      if (s.loopDescriptorPtr !== wantPtr)
        note(s.name + ': loop descriptor at 0x' + s.loopDescriptorPtr.toString(16) +
             ', the chain implies 0x' + wantPtr.toString(16) +
             ' (' + ((s.loopDescriptorPtr - wantPtr) / 10) + ' records out)');
    }
    prevSample = s;
  });

  var names = {};
  disk.entries.forEach(function (e) { if (e.type === 'S') names[e.name.trim().toUpperCase()] = true; });

  // The keygroup records and the sample descriptor table share one arena, laid out
  // in directory order with an empty record between programs. Everything about it
  // follows from where the arena starts, so both can be checked exactly.
  var arena = disk.arenaBase();
  var lay = disk.arenaLayout();
  var base = disk.sampleTableAddress();

  if (arena !== 0xC5F6)
    note('the arena starts at 0x' + arena.toString(16) + ', not the usual 0xc5f6');

  var implied = disk.sampleTableBase();
  if (implied !== null && implied !== base)
    bad('the zone pointers imply a sample table at 0x' + implied.toString(16) +
        ', but the layout puts it at 0x' + base.toString(16) + ' (' +
        ((implied - base) / 70) + ' records out)');

  disk.entries.filter(function (e) { return e.type === 'P'; }).forEach(function (p) {
    var kgs = disk.keygroups(p);
    if (p.length !== 38 + 70 * kgs.length)
      bad(p.name + ': length ' + p.length + ', expected ' + (38 + 70 * kgs.length) +
          ' for ' + kgs.length + ' keygroups');
    if (!kgs.length) bad(p.name + ': no keygroups');

    // The header restates where the program's keygroups load and how many there are.
    // The sampler believes it: a stale count drops keygroups, and a stale load address
    // puts one program's records on top of another's.
    var body = disk.readFile(p);
    var wantLoad = arena + 70 * lay.first[p.slot];
    var haveLoad = body.length > 19 ? (body[18] | (body[19] << 8)) : -1;

    if (haveLoad !== wantLoad)
      bad(p.name + ': header loads its keygroups at 0x' + haveLoad.toString(16) +
          ', the arena layout says 0x' + wantLoad.toString(16));

    if (body.length > 23 && body[23] !== kgs.length)
      bad(p.name + ': header says ' + body[23] + ' keygroups, the file holds ' + kgs.length);

    kgs.forEach(function (kg, k) {
      if (kg.lowKey > kg.highKey)
        note(p.name + ' kg' + (k + 1) + ': low key ' + kg.lowKey + ' above high key ' + kg.highKey);

      var last = (k === kgs.length - 1);
      var wantNext = last ? 0 : arena + 70 * (lay.first[p.slot] + k + 1);
      if (kg.nextKeygroup !== wantNext)
        bad(p.name + ' kg' + (k + 1) + ': links to 0x' + kg.nextKeygroup.toString(16) +
            ', the arena layout says 0x' + wantNext.toString(16));

      [kg.zone1, kg.zone2].forEach(function (z, zi) {
        if (!z.inUse) return;
        var who = p.name + ' kg' + (k + 1) + ' zone ' + (zi + 1);

        if (!names[(z.name || '').trim().toUpperCase()]) {
          note(who + ': names "' + z.name + '", which is not on this disk');
          return;
        }

        // The pointer is the sample's position in directory order. Adding or
        // deleting samples moves those positions, and a stale pointer refers to
        // the wrong descriptor - or to one before the table even begins.
        var i = disk.sampleIndex(z.name);
        var want = base + 70 * i;
        if (z.pointer !== want)
          bad(who + ': "' + z.name.trim() + '" is sample ' + i + ', so its pointer should be 0x' +
              want.toString(16) + ' but is 0x' + z.pointer.toString(16) +
              ' (index ' + ((z.pointer - base) / 70) + ')');
      });
    });
  });

  console.log('  files ' + disk.entries.length + ', free blocks ' + disk.freeBlocks() +
              ', bad-CRC ' + disk.badCrc + ', unreadable ' + disk.missing);

  if (!problems.length) console.log('  no structural problems found');
  else {
    console.log('  PROBLEMS (' + problems.length + '):');
    problems.forEach(function (p) { console.log('    ' + p); });
  }
  if (notes.length) {
    console.log('  worth knowing (' + notes.length + '):');
    notes.slice(0, 12).forEach(function (n) { console.log('    ' + n); });
    if (notes.length > 12) console.log('    ... and ' + (notes.length - 12) + ' more');
  }
  return problems.length;
}

var bads = 0;
process.argv.slice(2).forEach(function (f) { bads += check(f); });
process.exit(bads ? 1 : 0);

