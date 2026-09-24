/*
 * Copying samples and programs between disk images, across every pair of disks available.
 *
 * This writes to a disk image, so the checks are less about the copy arriving and more
 * about what it must not disturb. Four things are asserted every time:
 *
 *   - the copy is the same sound. Decoded audio identical to the source, and the header
 *     fields that describe it - rate, tuning, loop markers, loop mode - carried over
 *   - every zone of a copied program names a sample that is actually on the target,
 *     following any rename the plan had to make
 *   - nothing already on the target changed. Every file that was there before is still
 *     there, byte for byte, allowing for the pointers the disk recomputes around any
 *     arrival
 *   - the result is a disk the sampler would believe. The image is rebuilt and reloaded,
 *     and rebuildPointers on the reloaded copy must report NOTHING left to fix - a
 *     pointer this code failed to recompute would show up there as a non-zero count
 *
 * A plan that does not fit is not a failure; an 800K disk fills up, and refusing is the
 * correct answer.
 *
 * The desktop version does the same work from the same disks - AkaiS950Tests\CopyCheck.cs
 * in the VirtualS950 repository is the other half of this pair.
 *
 *   node copytest.js [directory of .hfe]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');

var PROG_HEADER = 38, KEYGROUP = 70, KG_NAME = 24, KG_ZONE_STRIDE = 22, KG_CHAIN = 68;

var dir = process.argv[2] || '.';
var fails = 0, checks = 0;
var problems = [];

function check(what, ok) {
  checks++;
  if (!ok) { fails++; if (problems.length < 25) problems.push(what); }
}

function same(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/*
 * A program compared as the sampler hears it, ignoring the pointers the disk recomputes
 * around any change: the load address, the chain, and the zone pointers.
 */
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

function fixes(r) { return r.chains + r.zones + r.headers; }

function snapshot(d) {
  var map = {};
  d.entries.forEach(function (e) { map[e.type + ':' + e.name.trim()] = d.readFile(e); });
  return map;
}

function checkUntouched(who, before, after) {
  Object.keys(before).forEach(function (key) {
    var type = key.charAt(0);
    var name = key.substring(2);

    var e = null;
    for (var i = 0; i < after.entries.length; i++) {
      var x = after.entries[i];
      if (x.type === type && x.name.trim() === name) { e = x; break; }
    }

    if (!e) { check(who + ': "' + name + '" disappeared from the target', false); return; }

    var now = after.readFile(e);
    var ok = type === 'P' ? sameProgramContent(before[key], now) : same(before[key], now);
    check(who + ': "' + name + '" on the target was altered', ok);
  });
}

var files = fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).sort();
if (files.length < 2) {
  console.log('needs at least two disk images to copy between');
  process.exit(1);
}

var raw = {};
files.forEach(function (f) { raw[f] = fs.readFileSync(path.join(dir, f)); });

function load(f) { return Akai.load(f, new Uint8Array(raw[f])); }

var copiedSamples = 0, copiedPrograms = 0, tooBig = 0, renames = 0, skipped = 0;

for (var a = 0; a < files.length; a++) {
  var targetFile = files[(a + 1) % files.length];
  var source = load(files[a]);

  var toCopy = source.entries.filter(function (e) { return e.type === 'S' || e.type === 'P'; });

  toCopy.forEach(function (what) {
    var target = load(targetFile);
    var before = snapshot(target);
    var freeBefore = target.freeBlocks();

    var plan = target.planCopy(source, what);
    var who = files[a].replace(/\.hfe$/i, '') + '/' + what.name.trim();

    if (!plan.ok) {
      var space = plan.problems.some(function (p) { return p.indexOf('Needs') >= 0; });
      check(who + ': refused for a reason other than room - ' + plan.problems.join('; '), space);
      if (space) tooBig++;
      return;
    }

    var landed = target.applyCopy(plan);

    renames += plan.items.filter(function (i) { return i.renamed; }).length;
    skipped += plan.items.filter(function (i) { return i.alreadyHere; }).length;
    if (what.type === 'S') copiedSamples++; else copiedPrograms++;

    check(who + ': something landed', landed.length === plan.writes.length);

    // 1. Nothing that was already there changed.
    checkUntouched(who, before, target);

    // 2. The copy is the same sound.
    plan.items.forEach(function (item) {
      if (item.alreadyHere || item.type !== 'S') return;

      var got = null;
      for (var i = 0; i < target.entries.length; i++) {
        var x = target.entries[i];
        if (x.type === 'S' && x.name.trim() === item.to) { got = x; break; }
      }

      if (!got) { check(who + ': sample "' + item.to + '" is not there', false); return; }

      var want = source.sampleWords12(item.source);
      var have = target.sampleWords12(got);

      check(who + ': "' + item.to + '" audio length', want.length === have.length);
      check(who + ': "' + item.to + '" audio identical', same(want, have));
      check(who + ': "' + item.to + '" rate', got.sampleRate === item.source.sampleRate);
      check(who + ': "' + item.to + '" tuning', got.tuning === item.source.tuning);
      check(who + ': "' + item.to + '" loop mode', got.loopMode === item.source.loopMode);
      check(who + ': "' + item.to + '" loop start', got.loopStart === item.source.loopStart);
      check(who + ': "' + item.to + '" loop end', got.loopEnd === item.source.loopEnd);
      check(who + ': "' + item.to + '" loop length', got.loopLength === item.source.loopLength);
    });

    // 3. A copied program's zones resolve on the target.
    if (what.type === 'P') {
      var item = plan.items[plan.items.length - 1];
      var prog = null;
      for (var i = 0; i < target.entries.length; i++) {
        var x = target.entries[i];
        if (x.type === 'P' && x.name.trim() === item.to) { prog = x; break; }
      }

      if (!prog) {
        check(who + ': the program is not there', false);
      } else {
        check(who + ': keygroup count carried over',
              target.keygroupCount(prog) === source.keygroupCount(what));

        // Names the source could not resolve either are not this copy's fault.
        var hopeless = {};
        source.zoneSampleNames(what).forEach(function (n) {
          var here = source.entries.some(function (e) {
            return e.type === 'S' && e.name.trim().toUpperCase() === n.toUpperCase();
          });
          if (!here) hopeless[n.toUpperCase()] = true;
        });

        target.zoneSampleNames(prog).forEach(function (named) {
          if (hopeless[named.toUpperCase()]) return;

          var here = target.entries.some(function (e) {
            return e.type === 'S' && e.name.trim().toUpperCase() === named.toUpperCase();
          });
          check(who + ': zone names "' + named + '", which is not on the target', here);
        });
      }
    }

    // 4. The blocks add up.
    check(who + ': free blocks fell by what the plan said',
          target.freeBlocks() === freeBefore - plan.blocks);

    // 5. The sampler would believe the result.
    var rebuilt = Akai.load('rebuilt.hfe', new Uint8Array(target.save('hfe')));
    check(who + ': the rebuilt image has the same files',
          rebuilt.entries.length === target.entries.length);

    var left = fixes(rebuilt.rebuildPointers());
    check(who + ': ' + left + ' pointer(s) still wrong after the copy', left === 0);
  });
}

/*
 * The corpus never collides - its disks name their files differently - so the two policies
 * that only fire on a clash have to be set up by hand. They are the whole of what makes a
 * copy safe to repeat, so they cannot go unchecked.
 */
for (var s = 0; s < files.length; s++) {
  var src = load(files[s]);

  var prog = null, wanted = null;
  src.entries.filter(function (e) { return e.type === 'P'; }).some(function (p) {
    return src.zoneSampleNames(p).some(function (n) {
      var here = src.entries.some(function (e) {
        return e.type === 'S' && e.name.trim().toUpperCase() === n.toUpperCase();
      });
      if (here) { prog = p; wanted = n; }
      return here;
    });
  });
  if (!prog) continue;

  var tFile = files[(s + 1) % files.length];
  var who2 = files[s].replace(/\.hfe$/i, '') + '/' + prog.name.trim();

  // ---- a different sample already holding the name the program needs ----
  (function () {
    var target = load(tFile);

    var words = new Int16Array(4096);
    for (var i = 0; i < words.length; i++) words[i] = (i % 512) - 256;

    var planted;
    try { planted = target.addSample(wanted, words, 20000, 60, 0, 'O'); }
    catch (err) { return; }

    var mine = target.readFile(planted);

    var plan = target.planCopy(src, prog);
    if (!plan.ok) return;

    var item = null;
    plan.items.forEach(function (i) {
      if (i.from.toUpperCase() === wanted.toUpperCase()) item = i;
    });

    check(who2 + ': the clashing sample is in the plan', !!item);
    if (!item) return;

    check(who2 + ': "' + wanted + '" was renamed rather than overwriting', item.renamed);
    check(who2 + ': it was not treated as already present', !item.alreadyHere);

    target.applyCopy(plan);

    var still = null, brought = null, copied = null;
    target.entries.forEach(function (e) {
      if (e.type === 'S' && e.name.trim().toUpperCase() === wanted.toUpperCase()) still = e;
      if (e.type === 'S' && e.name.trim() === item.to) brought = e;
      if (e.type === 'P' && e.name.trim() === plan.items[plan.items.length - 1].to) copied = e;
    });

    check(who2 + ': the target kept its own "' + wanted + '"', !!still);
    if (still) check(who2 + ': the target"s "' + wanted + '" is untouched',
                     same(mine, target.readFile(still)));

    check(who2 + ': the renamed copy "' + item.to + '" is there', !!brought);
    if (brought) check(who2 + ': "' + item.to + '" holds the source audio',
                       same(src.sampleWords12(item.source), target.sampleWords12(brought)));

    check(who2 + ': the copied program is there', !!copied);
    if (copied) {
      var names = target.zoneSampleNames(copied).map(function (n) { return n.toUpperCase(); });
      check(who2 + ': its zones follow the rename to "' + item.to + '"',
            names.indexOf(item.to.toUpperCase()) >= 0);
      check(who2 + ': no zone still names the target"s "' + wanted + '"',
            names.indexOf(wanted.toUpperCase()) < 0);
    }

    var rebuilt = Akai.load('rebuilt.hfe', new Uint8Array(target.save('hfe')));
    check(who2 + ': pointers consistent after a renaming copy', fixes(rebuilt.rebuildPointers()) === 0);
  })();

  // ---- the same program copied twice ----
  (function () {
    var target = load(tFile);

    var first = target.planCopy(src, prog);
    if (!first.ok) return;
    target.applyCopy(first);

    var samplesAfterFirst = target.entries.filter(function (e) { return e.type === 'S'; }).length;
    var entriesAfterFirst = target.entries.length;

    var again = target.planCopy(src, prog);
    if (!again.ok) return;

    again.items.filter(function (i) { return i.type === 'S'; }).forEach(function (i) {
      check(who2 + ': "' + i.from + '" recognised as already there on a second copy', i.alreadyHere);
    });

    /*
     * The program is identical too - the fields that differ between disks are the ones
     * sameFile ignores - so the whole second copy is recognised as already present and
     * writes nothing at all. Copying twice is a no-op rather than a way to get a second
     * numbered copy, which is what "skip if identical" has to mean if it means anything.
     */
    check(who2 + ': the program is recognised as already there too',
          again.items[again.items.length - 1].alreadyHere);
    check(who2 + ': a second copy writes nothing', again.writes.length === 0);
    check(who2 + ': and costs nothing', again.blocks === 0 && again.slots === 0);

    target.applyCopy(again);

    check(who2 + ': no duplicate samples were written',
          target.entries.filter(function (e) { return e.type === 'S'; }).length === samplesAfterFirst);
    check(who2 + ': the directory did not grow', target.entries.length === entriesAfterFirst);

    var rebuilt = Akai.load('rebuilt.hfe', new Uint8Array(target.save('hfe')));
    check(who2 + ': pointers consistent after copying twice', fixes(rebuilt.rebuildPointers()) === 0);
  })();
}

console.log('');
console.log(files.length + ' disks: ' + copiedSamples + ' sample copies, ' + copiedPrograms +
            ' program copies, ' + renames + ' renamed, ' + skipped + ' already present, ' +
            tooBig + ' refused for want of room');
console.log(checks + ' checks, ' + (fails === 0 ? 'ALL PASSED' : fails + ' FAILED'));
problems.forEach(function (p) { console.log('  ' + p); });
process.exit(fails === 0 ? 0 : 1);
