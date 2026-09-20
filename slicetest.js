/*
 * Slicing a sample into one-shots, checked across the corpus.
 *
 * Slicing is the heaviest write the tool does: it adds many samples in one go, appends a
 * keygroup for each, and so moves the sample table and every zone pointer past it. This
 * slices a break on every image that has room and checks the disk is still whole.
 *
 *   node slicetest.js [directory]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('./akai.js');
var Audio = require('./audio.js');

var dir = process.argv[2] || 'E:' + String.fromCharCode(92);
var REC = 70;
var totals = { disks: 0, sliced: 0, slices: 0, keygroups: 0, refused: 0, problems: [] };

function ramSize(w) { return Math.floor((2 * w + 15) / 16) * 16; }

function audit(disk, f, when) {
  function bad(m) { totals.problems.push(f + ' ' + when + ': ' + m); }

  // the directory must stay contiguous and in order
  var seen = [];
  for (var i = 0; i < 64; i++) if (disk.image[i * 24] !== 0) seen.push(i);
  seen.forEach(function (s, i) { if (s !== i) bad('directory hole before slot ' + s); });

  // the arena: chains, headers and zone pointers all follow from the layout
  var arena = disk.arenaBase(), lay = disk.arenaLayout();
  var table = arena + REC * lay.records;

  disk.programsInOrder().forEach(function (p) {
    var kgs = disk.keygroups(p), body = disk.readFile(p), start = lay.first[p.slot];

    if ((body[18] | (body[19] << 8)) !== arena + REC * start)
      bad(p.name.trim() + ' header load address wrong');
    if (body[23] !== kgs.length)
      bad(p.name.trim() + ' header says ' + body[23] + ' keygroups, file holds ' + kgs.length);

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

  // samples sit back to back in RAM in directory order
  var prev = null;
  disk.samplesInOrder().forEach(function (s) {
    if (s.length !== 60 + 1.5 * s.sampleCount) bad(s.name.trim() + ' length vs word count');
    if (s.sampleCount % 2) bad(s.name.trim() + ' odd word count');
    if (prev && s.memoryAddress !== prev.memoryAddress + ramSize(prev.sampleCount))
      bad('RAM chain breaks at ' + s.name.trim());
    prev = s;
  });

  // every block claimed once
  var owner = {};
  disk.entries.forEach(function (e) {
    disk.chain(e.startBlock).forEach(function (b) {
      if (owner[b] !== undefined) bad('block ' + b + ' claimed by two files');
      owner[b] = e.name;
    });
  });
}

fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).sort().forEach(function (f) {
  var disk;
  try { disk = Akai.load(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))); }
  catch (e) { return; }

  var progs = disk.programsInOrder();
  if (!progs.length) return;

  // Pick whichever sample actually chops - the longest is usually a sustained note,
  // and a detector returning one slice for it is right, not a test case.
  var victim = null, victimCuts = null;
  disk.samplesInOrder().forEach(function (s) {
    var w = disk.sampleWords12(s);
    if (!w.length) return;
    var c = Audio.detectSlices(w, s.sampleRate, { sensitivity: 50 });
    if (!victimCuts || c.length > victimCuts.length) { victim = s; victimCuts = c; }
  });
  if (!victim || !victimCuts || victimCuts.length < 2) return;

  totals.disks++;
  audit(disk, f, 'as loaded');

  var words = disk.sampleWords12(victim);
  if (!words.length) return;

  var cuts = victimCuts;
  var plan = disk.planSlices(victim, cuts, { program: progs[0] });

  if (!plan.ok) { totals.refused++; return; }        // refusing is a correct outcome

  var before = disk.entries.length;
  var r;
  try { r = disk.sliceSample(victim, cuts, { program: progs[0], rootKey: 36 }); }
  catch (err) { totals.problems.push(f + ': sliceSample threw - ' + err.message); return; }

  totals.sliced++;
  totals.slices += r.added.length;
  totals.keygroups += r.keygroups;

  if (disk.entries.length !== before + r.added.length)
    totals.problems.push(f + ': file count ' + before + ' -> ' + disk.entries.length +
                         ' after adding ' + r.added.length);
  if (r.keygroups !== r.added.length)
    totals.problems.push(f + ': ' + r.added.length + ' slices but ' + r.keygroups + ' keygroups');

  audit(disk, f, 'after slicing');

  // each slice must read back at the length it was cut to
  plan.slices.forEach(function (s) {
    var e = null;
    disk.entries.forEach(function (x) { if (x.type === 'S' && x.name.trim() === s.name) e = x; });
    if (!e) { totals.problems.push(f + ': slice ' + s.name + ' is missing'); return; }
    if (e.sampleCount !== s.count)
      totals.problems.push(f + ': ' + s.name + ' holds ' + e.sampleCount + ' words, cut ' + s.count);
    if (disk.sampleWords12(e).length !== s.count)
      totals.problems.push(f + ': ' + s.name + ' reads back short');
  });

  // and it all survives the round trip to an image and back
  var again = Akai.load(f, disk.save());
  if (again.badCrc || again.missing)
    totals.problems.push(f + ': after save ' + again.badCrc + ' bad-CRC, ' + again.missing + ' unreadable');
  if (again.entries.length !== disk.entries.length)
    totals.problems.push(f + ': after save ' + again.entries.length + ' files, expected ' + disk.entries.length);
  audit(again, f, 'after save and reload');
});

console.log('');
console.log('disks tested     : ' + totals.disks);
console.log('disks sliced     : ' + totals.sliced + '   (refused for want of room: ' + totals.refused + ')');
console.log('slices created   : ' + totals.slices);
console.log('keygroups mapped : ' + totals.keygroups);
console.log('problems         : ' + totals.problems.length);

if (totals.problems.length) {
  console.log('');
  totals.problems.slice(0, 20).forEach(function (p) { console.log('  ' + p); });
  process.exit(1);
}
