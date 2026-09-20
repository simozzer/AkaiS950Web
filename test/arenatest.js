/*
 * The keygroup / sample arena, under editing.
 *
 * Keygroup chain pointers and zone pointers live in one shared RAM arena whose
 * layout is fixed by the number of programs and keygroups. Adding or removing
 * either moves the sample descriptor table, so every zone pointer moves too.
 * An earlier version shifted these by a delta and drifted; this checks that
 * repeated edits leave the arena exactly where the layout says it should be.
 *
 *   node arenatest.js [directory]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');

var dir = process.argv[2] || 'E:' + String.fromCharCode(92);
var REC = 70;
var totals = { disks: 0, edits: 0, problems: [] };

function audit(disk, f, when) {
  var arena = disk.arenaBase(), lay = disk.arenaLayout();
  var table = arena + REC * lay.records;

  disk.programsInOrder().forEach(function (p) {
    var kgs = disk.keygroups(p), start = lay.first[p.slot];

    // the header restates the count and the load address; the sampler believes it
    var body = disk.readFile(p);
    var wantLoad = arena + REC * start;
    if (body.length > 19 && (body[18] | (body[19] << 8)) !== wantLoad)
      totals.problems.push(f + ' ' + when + ': ' + p.name.trim() + ' header loads at 0x' +
        (body[18] | (body[19] << 8)).toString(16) + ', layout says 0x' + wantLoad.toString(16));
    if (body.length > 23 && body[23] !== kgs.length)
      totals.problems.push(f + ' ' + when + ': ' + p.name.trim() + ' header says ' + body[23] +
        ' keygroups, file holds ' + kgs.length);

    kgs.forEach(function (kg, k) {
      var want = (k === kgs.length - 1) ? 0 : arena + REC * (start + k + 1);
      if (kg.nextKeygroup !== want)
        totals.problems.push(f + ' ' + when + ': ' + p.name.trim() + ' kg' + (k + 1) +
          ' links to 0x' + kg.nextKeygroup.toString(16) + ', layout says 0x' + want.toString(16));

      [kg.zone1, kg.zone2].forEach(function (z, zi) {
        if (!z.inUse) return;
        var i = disk.sampleIndex(z.name);
        if (i < 0) return;
        var w = table + REC * i;
        if (z.pointer !== w)
          totals.problems.push(f + ' ' + when + ': ' + p.name.trim() + ' kg' + (k + 1) +
            ' zone ' + (zi + 1) + ' -> 0x' + z.pointer.toString(16) + ', layout says 0x' + w.toString(16));
      });
    });
  });

  // no two programs may share a record, and none may land in the sample table
  var seen = {};
  disk.programsInOrder().forEach(function (p) {
    var start = lay.first[p.slot];
    for (var k = 0; k < disk.keygroupCount(p); k++) {
      var r = start + k;
      if (seen[r] !== undefined)
        totals.problems.push(f + ' ' + when + ': record ' + r + ' shared by ' + seen[r] + ' and ' + p.name.trim());
      seen[r] = p.name.trim();
      if (arena + REC * r >= table)
        totals.problems.push(f + ' ' + when + ': ' + p.name.trim() + ' kg' + (k + 1) + ' sits inside the sample table');
    }
  });
}

fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).sort().forEach(function (f) {
  var disk;
  try { disk = Akai.load(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))); } catch (e) { return; }

  var progs = disk.programsInOrder();
  if (progs.length < 1) return;

  var arenaWas = disk.arenaBase();
  totals.disks++;
  audit(disk, f, 'as loaded');

  // churn: add a keygroup to the first program, then to the last, then delete both
  var seq = [
    ['add to first', function () { disk.addKeygroup(disk.programsInOrder()[0], 0); }],
    ['add to last', function () { var a = disk.programsInOrder(); disk.addKeygroup(a[a.length - 1], 0); }],
    ['delete from first', function () { disk.deleteKeygroup(disk.programsInOrder()[0], 0); }],
    ['delete from last', function () { var a = disk.programsInOrder(); var p = a[a.length - 1];
                                       disk.deleteKeygroup(p, disk.keygroupCount(p) - 1); }]
  ];

  seq.forEach(function (step) {
    try { step[1](); } catch (e) { return; }        // at the 64-keygroup limit, say
    totals.edits++;
    disk.parseDirectory();
    if (disk.arenaBase() !== arenaWas)
      totals.problems.push(f + ': the arena base moved from 0x' + arenaWas.toString(16) +
                           ' to 0x' + disk.arenaBase().toString(16) + ' after ' + step[0]);
    audit(disk, f, 'after ' + step[0]);
  });

  // and it must survive a save / reload
  var again = Akai.load(f, disk.save());
  audit(again, f, 'after save and reload');
  if (again.arenaBase() !== arenaWas)
    totals.problems.push(f + ': arena base changed across a save');
});

console.log('');
console.log('disks exercised : ' + totals.disks);
console.log('keygroup edits  : ' + totals.edits);
console.log('problems        : ' + totals.problems.length);
if (totals.problems.length) {
  console.log('');
  totals.problems.slice(0, 20).forEach(function (p) { console.log('  ' + p); });
  process.exit(1);
}
