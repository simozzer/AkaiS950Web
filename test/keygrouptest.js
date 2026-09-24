/*
 * Copying a keygroup onto another program, within a disk and across disks.
 *
 * A keygroup is not a file, so this writes differently from copytest: the target program
 * grows by 70 bytes in place, and the keygroup arena moves under every program on the
 * disk. That makes the pointer check the important one here rather than a formality.
 *
 * Asserted on every copy:
 *
 *   - the keygroup arrived and says the same things. Key range, velocity switch, both
 *     envelopes and the zone settings identical to the source, with the zones naming the
 *     samples they named - following any rename the plan had to make
 *   - every sample the copied keygroup names is on the target disk
 *   - the target program's existing keygroups say exactly what they said before
 *   - every other file on the target is unchanged
 *   - the rebuilt image reloads with nothing left for rebuildPointers to fix
 *
 * Both directions are covered: from another disk, and from one program to another on the
 * same disk, which a file copy refuses but a keygroup copy has to allow.
 *
 * The desktop version does the same work from the same disks - KeygroupCopyCheck.cs in
 * the VirtualS950 repository is the other half of this pair.
 *
 *   node keygrouptest.js [directory of .hfe]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');

var PROG_HEADER = 38, KEYGROUP = 70, KG_NAME = 24, KG_ZONE_STRIDE = 22, KG_CHAIN = 68;

var dir = process.argv[2] || '.';
var fails = 0, checks = 0, clashRenames = 0;
var problems = [];

function check(what, ok) {
  checks++;
  if (!ok) { fails++; if (problems.length < 25) problems.push(what); }
}

function fixes(r) { return r.chains + r.zones + r.headers; }

function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/*
 * Two keygroups compared as the sampler hears them, ignoring the chain and the zone
 * pointers - both are recomputed from the layout whenever anything on the disk changes,
 * so neither says anything about the keygroup itself.
 */
function sameKeygroup(a, b) {
  if (!a || !b || a.length !== b.length) return false;

  var skip = {};
  skip[KG_CHAIN] = skip[KG_CHAIN + 1] = true;
  for (var z = 0; z < 2; z++) {
    var po = KG_NAME + z * KG_ZONE_STRIDE + 16;
    skip[po] = skip[po + 1] = true;
  }

  for (var i = 0; i < a.length; i++)
    if (a[i] !== b[i] && !skip[i]) return false;

  return true;
}

function sameProgramContent(a, b) {
  if (!a || !b || a.length !== b.length) return false;

  var skip = {};
  skip[18] = skip[19] = true;

  var count = a.length > 23 ? a[23] : 0;
  for (var k = 0; k < count; k++) {
    var kg = PROG_HEADER + k * KEYGROUP;
    skip[kg + KG_CHAIN] = skip[kg + KG_CHAIN + 1] = true;

    for (var z = 0; z < 2; z++) {
      var po = kg + KG_NAME + z * KG_ZONE_STRIDE + 16;
      skip[po] = skip[po + 1] = true;
    }
  }

  for (var i = 0; i < a.length; i++)
    if (a[i] !== b[i] && !skip[i]) return false;

  return true;
}

function zoneNames(record) {
  var names = [];
  for (var z = 0; z < 2; z++) {
    var at = KG_NAME + z * KG_ZONE_STRIDE;
    var s = '';
    for (var i = 0; i < 10; i++) s += String.fromCharCode(record[at + i]);
    s = s.replace(/\0/g, ' ').trim();

    if (!s || s === '2 SAMPLE') continue;
    if (names.map(function (n) { return n.toUpperCase(); }).indexOf(s.toUpperCase()) < 0) names.push(s);
  }
  return names;
}

function snapshot(d) {
  var map = {};
  d.entries.forEach(function (e) { map[e.type + ':' + e.name.trim()] = d.readFile(e); });
  return map;
}

function checkUntouched(who, before, after, skipSlot) {
  Object.keys(before).forEach(function (key) {
    var type = key.charAt(0), name = key.substring(2);

    var e = null;
    for (var i = 0; i < after.entries.length; i++) {
      var x = after.entries[i];
      if (x.type === type && x.name.trim() === name) { e = x; break; }
    }

    if (!e) { check(who + ': "' + name + '" disappeared from the target', false); return; }
    if (e.slot === skipSlot) return;

    var now = after.readFile(e);
    var ok = type === 'P' ? sameProgramContent(before[key], now) : same(before[key], now);
    check(who + ': "' + name + '" on the target was altered', ok);
  });
}

function keygroupsOf(d, program) {
  var list = [];
  var n = d.keygroupCount(program);
  for (var k = 0; k < n; k++) list.push(d.keygroupRecord(program, k));
  return list;
}

var files = fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).sort();
if (files.length < 2) {
  console.log('needs at least two disk images');
  process.exit(1);
}

var raw = {};
files.forEach(function (f) { raw[f] = fs.readFileSync(path.join(dir, f)); });
function load(f) { return Akai.load(f, new Uint8Array(raw[f])); }

var across = 0, within = 0, brought = 0, renamed = 0, tooBig = 0;

function run(kind, sourceFile, source, sourceProg, index, target, targetProg) {
  var who = kind + '  ' + sourceFile.replace(/\.hfe$/i, '') + '/' + sourceProg.name.trim() +
            ' kg1 -> ' + targetProg.name.trim();

  var wantRecord = source.keygroupRecord(sourceProg, index);
  var beforeFiles = snapshot(target);
  var beforeKgs = keygroupsOf(target, targetProg);
  var beforeCount = target.keygroupCount(targetProg);
  var targetSlot = targetProg.slot;

  var plan = target.planCopyKeygroup(source, sourceProg, index, targetProg);

  if (!plan.ok) {
    var space = plan.problems.some(function (p) {
      return p.indexOf('Needs') >= 0 || p.indexOf('limit') >= 0;
    });
    check(who + ': refused for a reason other than room - ' + plan.problems.join('; '), space);
    if (space) tooBig++;
    return false;
  }

  brought += plan.writes.length;
  renamed += plan.samples.filter(function (i) { return i.renamed; }).length;

  var number = target.applyCopyKeygroup(plan);
  check(who + ': it is the last keygroup', number === beforeCount + 1);

  var prog = target.entryInSlot(targetSlot);
  check(who + ': the program is still there', !!prog && prog.type === 'P');
  if (!prog) return true;

  check(who + ': the program has one more keygroup',
        target.keygroupCount(prog) === beforeCount + 1);

  var after = keygroupsOf(target, prog);

  // 1. The keygroups already there still say what they said.
  for (var k = 0; k < beforeKgs.length && k < after.length; k++)
    check(who + ': keygroup ' + (k + 1) + ' of the target was disturbed',
          sameKeygroup(beforeKgs[k], after[k]));

  // 2. The arrival matches the source, allowing for the pointers.
  if (after.length === beforeCount + 1) {
    var got = after[after.length - 1];

    check(who + ': key range carried over', got[0] === wantRecord[0] && got[1] === wantRecord[1]);
    check(who + ': velocity switch carried over', got[2] === wantRecord[2]);
    check(who + ': the settings carried over', sameKeygroup(wantRecord, got));

    // 3. Every sample it names is on the target disk.
    var hopeless = {};
    zoneNames(wantRecord).forEach(function (n) {
      var here = source.entries.some(function (e) {
        return e.type === 'S' && e.name.trim().toUpperCase() === n.toUpperCase();
      });
      if (!here) hopeless[n.toUpperCase()] = true;
    });

    zoneNames(got).forEach(function (named) {
      if (hopeless[named.toUpperCase()]) return;

      var here = target.entries.some(function (e) {
        return e.type === 'S' && e.name.trim().toUpperCase() === named.toUpperCase();
      });
      check(who + ': zone names "' + named + '", which is not on the target', here);
    });
  }

  // 4. Nothing else on the target moved.
  checkUntouched(who, beforeFiles, target, targetSlot);

  // 5. The sampler would believe the result.
  var rebuilt = Akai.load('rebuilt.hfe', new Uint8Array(target.save('hfe')));
  var left = fixes(rebuilt.rebuildPointers());
  check(who + ': ' + left + ' pointer(s) still wrong after the copy', left === 0);

  return true;
}

for (var a = 0; a < files.length; a++) {
  var targetFile = files[(a + 1) % files.length];
  var source = load(files[a]);

  source.entries.filter(function (e) { return e.type === 'P'; }).forEach(function (sourceProg) {
    if (source.keygroupCount(sourceProg) === 0) return;

    // ---- across two disks ----
    var target = load(targetFile);
    var targetProg = target.entries.filter(function (e) { return e.type === 'P'; })[0];
    if (targetProg && run('across', files[a], source, sourceProg, 0, target, targetProg)) across++;

    // ---- within one disk ----
    var disk = load(files[a]);
    var from = disk.entries.filter(function (e) { return e.type === 'P' && e.slot === sourceProg.slot; })[0];
    var into = disk.entries.filter(function (e) { return e.type === 'P' && e.slot !== sourceProg.slot; })[0];
    if (from && into && run('within', files[a], disk, from, 0, disk, into)) within++;
  });
}

/*
 * The corpus never collides, so the rename path has to be set up by hand: a sample is
 * planted on the target under the name a zone of the incoming keygroup needs, holding
 * different audio. The copy must rename what it brings, repoint the keygroup's zone at
 * the new name, and leave the planted file alone.
 */
for (var s = 0; s < files.length; s++) {
  var src = load(files[s]);

  var prog = null, wanted = null, index = -1;

  src.entries.filter(function (e) { return e.type === 'P'; }).some(function (p) {
    var n = src.keygroupCount(p);
    for (var k = 0; k < n; k++) {
      var names = zoneNames(src.keygroupRecord(p, k));
      for (var i = 0; i < names.length; i++) {
        var here = src.entries.some(function (e) {
          return e.type === 'S' && e.name.trim().toUpperCase() === names[i].toUpperCase();
        });
        if (here) { prog = p; wanted = names[i]; index = k; return true; }
      }
    }
    return false;
  });
  if (!prog) continue;

  var tFile = files[(s + 1) % files.length];
  var target2 = load(tFile);
  var targetProg2 = target2.entries.filter(function (e) { return e.type === 'P'; })[0];
  if (!targetProg2) continue;

  var words = new Int16Array(4096);
  for (var w = 0; w < words.length; w++) words[w] = (w % 512) - 256;

  var planted;
  try { planted = target2.addSample(wanted, words, 20000, 60, 0, 'O'); }
  catch (err) { continue; }

  var mine = target2.readFile(planted);
  var plantedSlot = planted.slot, targetSlot2 = targetProg2.slot;

  var who2 = 'clash  ' + files[s].replace(/\.hfe$/i, '') + '/' + prog.name.trim() + ' kg' + (index + 1);

  var plan2 = target2.planCopyKeygroup(src, prog, index, targetProg2);
  if (!plan2.ok) continue;

  var item = null;
  plan2.samples.forEach(function (i) {
    if (i.from.toUpperCase() === wanted.toUpperCase()) item = i;
  });

  check(who2 + ': the clashing sample is in the plan', !!item);
  if (!item) continue;

  check(who2 + ': "' + wanted + '" was renamed rather than overwriting', item.renamed);
  if (item.renamed) clashRenames++;

  target2.applyCopyKeygroup(plan2);

  var still = target2.entryInSlot(plantedSlot);
  check(who2 + ': the target kept its own "' + wanted + '"',
        !!still && still.name.trim().toUpperCase() === wanted.toUpperCase());
  if (still) check(who2 + ': the target own copy is untouched', same(mine, target2.readFile(still)));

  var arrived = target2.entries.filter(function (e) { return e.type === 'S' && e.name.trim() === item.to; })[0];
  check(who2 + ': the renamed copy "' + item.to + '" is there', !!arrived);
  if (arrived) check(who2 + ': "' + item.to + '" holds the source audio',
                     same(src.sampleWords12(item.source), target2.sampleWords12(arrived)));

  var prog2 = target2.entryInSlot(targetSlot2);
  if (prog2) {
    var last = target2.keygroupRecord(prog2, target2.keygroupCount(prog2) - 1);
    var names2 = zoneNames(last).map(function (n) { return n.toUpperCase(); });

    check(who2 + ': its zone follows the rename to "' + item.to + '"',
          names2.indexOf(item.to.toUpperCase()) >= 0);
    check(who2 + ': no zone still names the target own "' + wanted + '"',
          names2.indexOf(wanted.toUpperCase()) < 0);
  }

  var rebuilt2 = Akai.load('rebuilt.hfe', new Uint8Array(target2.save('hfe')));
  check(who2 + ': pointers consistent after a renaming keygroup copy',
        fixes(rebuilt2.rebuildPointers()) === 0);
}

console.log('');
console.log(across + ' keygroup copies across disks, ' + within + ' within one disk, ' +
            brought + ' sample(s) brought along, ' + (renamed + clashRenames) + ' renamed, ' +
            tooBig + ' refused for want of room');
console.log(checks + ' checks, ' + (fails === 0 ? 'ALL PASSED' : fails + ' FAILED'));
problems.forEach(function (p) { console.log('  ' + p); });
process.exit(fails === 0 ? 0 : 1);
