/*
 * Creating and deleting programs, checked across the corpus.
 *
 * A program cannot just be appended: programs come before the overall settings, the drum
 * set and the samples, so adding one opens a gap in the middle of the directory and moves
 * every entry above it. It also changes the arena, which moves the sample descriptor table
 * and so every zone pointer on the disk.
 *
 * The strongest check here is the round trip - add a program, delete it again, and the
 * disk should be structurally back where it started.
 *
 *   node progtest.js [directory]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('./akai.js');

var dir = process.argv[2] || 'E:' + String.fromCharCode(92);
var REC = 70;
var totals = { disks: 0, added: 0, deleted: 0, full: 0, problems: [] };

function ramSize(w) { return Math.floor((2 * w + 15) / 16) * 16; }

function audit(disk, f, when) {
  function bad(m) { totals.problems.push(f + ' ' + when + ': ' + m); }

  var seen = [];
  for (var i = 0; i < 64; i++) if (disk.image[i * 24] !== 0) seen.push(i);
  seen.forEach(function (s, i) { if (s !== i) bad('directory hole before slot ' + s); });

  // programs, then overall, then drum set, then samples
  var order = '';
  disk.entries.forEach(function (e) { if (order.charAt(order.length - 1) !== e.type) order += e.type; });
  if (order && 'PODS'.indexOf(order) < 0) bad('type order became ' + order);

  var arena = disk.arenaBase(), lay = disk.arenaLayout();
  var table = arena + REC * lay.records;

  disk.programsInOrder().forEach(function (p) {
    var kgs = disk.keygroups(p), body = disk.readFile(p), start = lay.first[p.slot];

    if (p.length !== 38 + REC * kgs.length) bad(p.name.trim() + ' length vs keygroup count');
    if ((body[18] | (body[19] << 8)) !== arena + REC * start)
      bad(p.name.trim() + ' header load address wrong');
    if (body[23] !== kgs.length) bad(p.name.trim() + ' header count wrong');

    kgs.forEach(function (kg, k) {
      var want = (k === kgs.length - 1) ? 0 : arena + REC * (start + k + 1);
      if (kg.nextKeygroup !== want) bad(p.name.trim() + ' kg' + (k + 1) + ' chain wrong');

      [kg.zone1, kg.zone2].forEach(function (z, zi) {
        if (!z.inUse) return;
        var idx = disk.sampleIndex(z.name);
        if (idx < 0) { bad(p.name.trim() + ' kg' + (k + 1) + ' names a missing sample'); return; }
        if (z.pointer !== table + REC * idx)
          bad(p.name.trim() + ' kg' + (k + 1) + ' zone ' + (zi + 1) + ' pointer wrong');
      });
    });
  });

  var prev = null;
  disk.samplesInOrder().forEach(function (s) {
    if (prev && s.memoryAddress !== prev.memoryAddress + ramSize(prev.sampleCount))
      bad('RAM chain breaks at ' + s.name.trim());
    prev = s;
  });

  var owner = {};
  disk.entries.forEach(function (e) {
    disk.chain(e.startBlock).forEach(function (b) {
      if (owner[b] !== undefined) bad('block ' + b + ' claimed twice');
      owner[b] = e.name;
    });
  });
}

/** Everything about a disk that adding then deleting a program must not change. */
function fingerprint(disk) {
  var out = [];
  disk.entries.forEach(function (e) {
    out.push(e.type + ':' + e.name.trim() + ':' + e.length +
             (e.type === 'S' ? ':' + e.memoryAddress + ':' + e.sampleCount : ''));
  });
  disk.programsInOrder().forEach(function (p) {
    disk.keygroups(p).forEach(function (kg, k) {
      [kg.zone1, kg.zone2].forEach(function (z) {
        out.push(p.name.trim() + '/' + k + '/' + z.name.trim() + '/' + z.pointer);
      });
      out.push(p.name.trim() + '/' + k + '/next/' + kg.nextKeygroup);
    });
  });
  out.push('table:' + disk.sampleTableAddress());
  return out.join('|');
}

fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).sort().forEach(function (f) {
  var disk;
  try { disk = Akai.load(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))); }
  catch (e) { return; }
  if (!disk.entries.length) return;

  totals.disks++;
  audit(disk, f, 'as loaded');
  var before = fingerprint(disk);
  var files = disk.entries.length;

  var made;
  try { made = disk.addProgram('ZZTEST'); }
  catch (err) {
    if (/directory is full|Not enough room/.test(err.message)) { totals.full++; return; }
    totals.problems.push(f + ': addProgram threw - ' + err.message);
    return;
  }
  totals.added++;

  if (disk.entries.length !== files + 1)
    totals.problems.push(f + ': file count ' + files + ' -> ' + disk.entries.length);
  if (disk.keygroupCount(made) !== 1)
    totals.problems.push(f + ': new program has ' + disk.keygroupCount(made) + ' keygroups');
  if (made.length !== 38 + REC)
    totals.problems.push(f + ': new program is ' + made.length + ' bytes, expected ' + (38 + REC));

  // the file has to call itself what the directory calls it - that copy is what the
  // sampler displays, and a template name would show there instead
  var body = disk.readFile(made), inFile = '';
  for (var i = 0; i < 10; i++) {
    var ch = body[i];
    inFile += (ch >= 0x20 && ch < 0x7F) ? String.fromCharCode(ch) : ' ';
  }
  if (inFile.trim() !== made.name.trim())
    totals.problems.push(f + ': new program is listed as ' + JSON.stringify(made.name.trim()) +
                         ' but calls itself ' + JSON.stringify(inFile.trim()));

  audit(disk, f, 'after adding a program');

  // it must survive the trip through an image
  var again = Akai.load(f, disk.save());
  audit(again, f, 'after save and reload');
  if (again.entries.length !== disk.entries.length)
    totals.problems.push(f + ': save lost a file');

  // and deleting it must put the disk back exactly as it was
  var victim = null;
  disk.entries.forEach(function (e) { if (e.type === 'P' && e.name.trim() === 'ZZTEST') victim = e; });
  if (!victim) { totals.problems.push(f + ': the new program vanished'); return; }

  disk.deleteProgram(victim);
  totals.deleted++;
  audit(disk, f, 'after deleting it again');

  if (disk.entries.length !== files)
    totals.problems.push(f + ': after delete ' + disk.entries.length + ' files, expected ' + files);

  var after = fingerprint(disk);
  if (after !== before) {
    var a = before.split('|'), b = after.split('|'), first = '';
    for (var i = 0; i < Math.max(a.length, b.length); i++)
      if (a[i] !== b[i]) { first = '"' + a[i] + '" -> "' + b[i] + '"'; break; }
    totals.problems.push(f + ': add-then-delete changed the disk - ' + first);
  }
});

console.log('');
console.log('disks tested      : ' + totals.disks);
console.log('programs created  : ' + totals.added + '   (no room: ' + totals.full + ')');
console.log('programs deleted  : ' + totals.deleted);
console.log('problems          : ' + totals.problems.length);

if (totals.problems.length) {
  console.log('');
  totals.problems.slice(0, 20).forEach(function (p) { console.log('  ' + p); });
  process.exit(1);
}
