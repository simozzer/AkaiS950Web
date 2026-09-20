/*
 * Deleting a sample, checked against the whole corpus.
 *
 * The risk is not the deletion itself but everything that pointed at it: zones
 * that named it, zones that named a later sample (whose position in the table
 * moves), and the RAM addresses of every sample after it. This deletes one
 * sample from every image and checks the disk is still wholly consistent.
 *
 *   node deltest.js [directory]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');

var dir = process.argv[2] || 'E:\\';
var files = fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).sort();

var totals = { disks: 0, deleted: 0, cleared: 0, repointed: 0, freed: 0, problems: [] };

function ramSize(words) { return Math.floor((2 * words + 15) / 16) * 16; }

files.forEach(function (f) {
  var bytes = new Uint8Array(fs.readFileSync(path.join(dir, f)));
  var disk;
  try { disk = Akai.load(f, bytes); } catch (e) { return; }

  var samples = disk.entries.filter(function (e) { return e.type === 'S'; })
                            .sort(function (a, b) { return a.slot - b.slot; });
  if (samples.length < 3) return;

  // pick one in the middle, so there are samples and references on both sides
  var victim = samples[Math.floor(samples.length / 2)];
  var name = victim.name;

  // what the disk looked like first
  var before = {
    files: disk.entries.length,
    free: disk.freeBlocks(),
    others: [],
    zones: []
  };
  disk.entries.forEach(function (e) {
    if (e.slot !== victim.slot)
      before.others.push({ name: e.name, length: e.length, start: e.startBlock });
  });
  disk.entries.forEach(function (p) {
    if (p.type !== 'P') return;
    disk.keygroups(p).forEach(function (kg, k) {
      [kg.zone1, kg.zone2].forEach(function (z, zi) {
        before.zones.push({ p: p.name, k: k, z: zi, name: z.name, ptr: z.pointer, inUse: z.inUse });
      });
    });
  });

  var r = disk.deleteSample(victim);

  totals.disks++;
  totals.deleted++;
  totals.cleared += r.cleared;
  totals.repointed += r.repointed;
  totals.freed += r.blocksFreed;

  function problem(msg) { totals.problems.push(f + ': ' + msg); }

  // --- 1. it is gone, and nothing else is
  // a program may share the sample's name, so only samples count here
  if (disk.entries.some(function (e) { return e.type === 'S' && e.name === name; }))
    problem(name + ' still listed');
  if (disk.entries.length !== before.files - 1)
    problem('file count ' + before.files + ' -> ' + disk.entries.length);

  disk.entries.forEach(function (e, i) {
    var was = before.others[i];
    if (!was) { problem('unexpected extra entry ' + e.name); return; }
    if (was.name !== e.name || was.length !== e.length || was.start !== e.startBlock)
      problem('entry ' + i + ' changed: ' + was.name + '/' + was.length + '/' + was.start +
              ' -> ' + e.name + '/' + e.length + '/' + e.startBlock);
  });

  // the directory must close up: a hole can stop the sampler reading past it
  disk.entries.forEach(function (e, i) {
    if (e.slot !== i) problem(e.name + ' sits in slot ' + e.slot + ', expected ' + i);
  });

  // --- 2. the blocks came back
  if (disk.freeBlocks() !== before.free + r.blocksFreed)
    problem('free blocks ' + before.free + ' + ' + r.blocksFreed + ' != ' + disk.freeBlocks());

  // --- 3. every remaining file still reads, and its chain is intact
  disk.entries.forEach(function (e) {
    if (!e.chainOk) problem(e.name + ': chain too short after the delete');
    var got = disk.readFile(e);
    if (got.length !== e.length) problem(e.name + ': reads ' + got.length + ' of ' + e.length);
  });

  // --- 4. the sample RAM chain still follows the rule
  var prev = null;
  disk.entries.filter(function (e) { return e.type === 'S'; })
              .sort(function (a, b) { return a.slot - b.slot; })
              .forEach(function (s) {
    if (prev && s.memoryAddress !== prev.memoryAddress + ramSize(prev.sampleCount))
      problem('RAM chain broken at ' + s.name);
    prev = s;
  });

  // --- 5. zones: the deleted one is gone from all of them, and every zone that
  //        still names a sample resolves to one that is present
  var names = {};
  disk.entries.forEach(function (e) { if (e.type === 'S') names[e.name.trim().toUpperCase()] = true; });

  var after = [];
  disk.entries.forEach(function (p) {
    if (p.type !== 'P') return;
    disk.keygroups(p).forEach(function (kg, k) {
      [kg.zone1, kg.zone2].forEach(function (z, zi) {
        after.push({ p: p.name, k: k, z: zi, name: z.name, ptr: z.pointer, inUse: z.inUse });
        if (z.inUse && (z.name || '').trim().toUpperCase() === name.trim().toUpperCase())
          problem('a zone still names the deleted sample');
        if (z.inUse && !names[(z.name || '').trim().toUpperCase()])
          problem('zone now names a missing sample: ' + z.name);
      });
    });
  });

  // --- 6. zones naming an untouched sample kept their name; only pointers moved
  if (after.length !== before.zones.length) problem('zone count changed');
  else for (var i = 0; i < after.length; i++) {
    var a = after[i], b = before.zones[i];
    if (b.name.trim().toUpperCase() === name.trim().toUpperCase()) continue;  // cleared, expected
    if (a.name !== b.name) problem('zone name changed: ' + b.name + ' -> ' + a.name);
  }

  // --- 7. and it all survives a save and reload
  var again = Akai.load(f, disk.save());
  if (again.badCrc || again.missing)
    problem('after save: ' + again.badCrc + ' bad-CRC, ' + again.missing + ' unreadable');
  if (again.entries.length !== disk.entries.length)
    problem('after save: ' + again.entries.length + ' files, expected ' + disk.entries.length);
});

console.log('');
console.log('disks tested       : ' + totals.disks);
console.log('samples deleted    : ' + totals.deleted);
console.log('zones emptied      : ' + totals.cleared);
console.log('pointers adjusted  : ' + totals.repointed);
console.log('blocks recovered   : ' + totals.freed);
console.log('problems           : ' + totals.problems.length);

if (totals.problems.length) {
  console.log('');
  totals.problems.slice(0, 20).forEach(function (p) { console.log('  ' + p); });
  process.exit(1);
}

