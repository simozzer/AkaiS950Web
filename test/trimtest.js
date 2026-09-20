/*
 * Trimming the silence off both ends.
 *
 * The front is easy. The end is not: the tail of a sample is where a loop lives, and a
 * cut that reached into one would leave the sampler looping over audio that is no longer
 * there. So the rule is that the end is cut back to the loop end and no further, and this
 * checks it - first on made-up samples where the answer is known exactly, then across
 * every looped sample in the library, where the loop must survive whatever the audio does.
 *
 *   node test/trimtest.js [directory of .hfe]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');
var Audio = require('../audio.js');

var THRESHOLD = Audio.SILENCE_THRESHOLD;
var fails = 0;

function check(what, ok, detail) {
  console.log((ok ? '  ok   ' : '  FAIL ') + what + (detail ? '   ' + detail : ''));
  if (!ok) fails++;
}

/* --- samples where the answer is known -------------------------------------- */

function madeUp(leadWords, tailWords, mode) {
  var d = Akai.blank('trim.img');
  var rate = 10000, tone = 4000;
  var n = leadWords + tone + tailWords;
  var w = new Int16Array(n);                      // silence is already zero
  for (var i = 0; i < tone; i++)
    w[leadWords + i] = Math.round(1200 * Math.sin(2 * Math.PI * 220 * i / rate));
  d.addSample('TRIMME', w, rate, 60, 0, mode || 'O');
  return d;
}

var d = madeUp(3000, 5000);
var e = d.entries[0];
var plan = d.planTrim(e, THRESHOLD);

check('it finds the silence at the front', Math.abs(plan.front - 3000) <= 2, plan.front + ' words');
check('and the silence at the end', Math.abs(plan.back - 5000) <= 2, plan.back + ' words');
check('leaving the audio', Math.abs(plan.newWords - 4000) <= 4, plan.newWords + ' words');
check('and it frees blocks for it', plan.blocksFreed > 0, plan.blocksFreed + ' blocks');

var freed = d.trimSample(e, THRESHOLD);
var after = d.entries.filter(function (x) { return x.type === 'S'; })[0];
check('the sample is rewritten at the new length',
      Math.abs(after.sampleCount - 4000) <= 4, after.sampleCount + ' words');
check('the audio that is left is not silent', (function () {
  var w = d.sampleWords12(after), loud = 0;
  for (var i = 0; i < w.length; i++) if (Math.abs(w[i]) > THRESHOLD) loud++;
  return loud > w.length / 2;
}()), freed + ' blocks freed');

check('trimming again finds nothing left to do',
      !d.planTrim(after, THRESHOLD).anything);

/* --- a loop in the tail holds the cut ---------------------------------------- */

var d2 = madeUp(1000, 6000, 'L');
var s2 = d2.entries[0];
// a loop that ends well inside the trailing silence
var loopEnd = s2.sampleCount - 3000;
d2.setLoop(s2, loopEnd - (loopEnd % 2), 1000, 'L');
s2 = d2.entryAt(s2.slot);

var plan2 = d2.planTrim(s2, THRESHOLD);
check('a loop in the tail holds the cut back', plan2.heldByLoop,
      'keeps ' + plan2.newWords + ' words for a loop ending at ' + s2.loopEnd);
check('  and nothing past the loop end is kept',
      s2.sampleCount - plan2.back === s2.loopEnd,
      'kept to ' + (s2.sampleCount - plan2.back) + ', loop ends ' + s2.loopEnd);

d2.trimSample(s2, THRESHOLD);
var t2 = d2.entries.filter(function (x) { return x.type === 'S'; })[0];
check('  the loop still fits inside the sample',
      t2.loopEnd <= t2.sampleCount && t2.loopEnd - t2.loopLength >= 0,
      'end ' + t2.loopEnd + ', length ' + t2.loopLength + ', words ' + t2.sampleCount);

/* --- and across the library --------------------------------------------------- */
//
// A trim shortens a file, which moves things that other things point at. Samples sit
// back to back in the sampler's RAM in directory order, and their loop descriptors sit
// in one table the same way, so shortening one moves every sample after it. What must
// NOT move is the zone pointers: those are a sample's position in directory order, and
// trimming changes no order at all. This trims for real and checks both.

var dir = process.argv[2] || 'C:\\Users\\simon\\AkaiS950Images';

function ramSize(words) { return Math.floor((2 * words + 15) / 16) * 16; }
function loopRecords(words, mode) {
  var pages = Math.floor(2 * words / 131072);
  return mode === 'L' ? 3 + pages : mode === 'A' ? 3 * (1 + pages) : 2 + pages;
}

/** Everything a keygroup zone says about where its sample lives. */
function zonesOf(disk) {
  var out = [];
  disk.entries.forEach(function (e) {
    if (e.type !== 'P') return;
    disk.keygroups(e).forEach(function (kg, k) {
      [kg.zone1, kg.zone2].forEach(function (z, zi) {
        out.push({ prog: e.name, kg: k, zone: zi, name: z.name, ptr: z.pointer, inUse: z.inUse });
      });
    });
  });
  return out;
}

/**
 * Everything about this disk that is not as the format says it should be.
 *
 * Returned as a list rather than a verdict, because nine of the library's own disks
 * already have a loop descriptor pointer that does not follow the one before it - see
 * fsck, which reports them as worth knowing rather than as damage. A test that asked
 * "is this disk perfect?" after an edit would blame the edit for them. The question is
 * "did the edit break anything that was not already broken", so the caller takes this
 * before and after and compares.
 */
function problemsOf(disk) {
  var samples = disk.entries.filter(function (e) { return e.type === 'S'; })
                            .sort(function (a, b) { return a.slot - b.slot; });
  var bad = [];

  for (var i = 1; i < samples.length; i++) {
    var prev = samples[i - 1];
    if (samples[i].memoryAddress !== prev.memoryAddress + ramSize(prev.sampleCount))
      bad.push('RAM address of ' + samples[i].name.trim() + ' does not follow ' + prev.name.trim());
    var wantPtr = prev.loopDescriptorPtr + 10 * loopRecords(prev.sampleCount, prev.loopMode);
    if (samples[i].loopDescriptorPtr !== wantPtr)
      bad.push('loop descriptor of ' + samples[i].name.trim() + ' does not follow ' + prev.name.trim());
  }

  // the directory keeps its shape: same slots, no holes opened
  var slots = disk.entries.map(function (e) { return e.slot; }).sort(function (a, b) { return a - b; });
  slots.forEach(function (slot, i) { if (slot !== i) bad.push('directory has a hole at ' + i); });

  // every zone points where the directory order says its sample now sits
  zonesOf(disk).forEach(function (z) {
    if (!z.inUse) return;
    var want = disk.sampleTableAddress() + 70 * disk.sampleIndex(z.name);
    if (z.ptr !== want)
      bad.push('zone pointer for ' + z.name.trim() + ' is 0x' + z.ptr.toString(16) +
               ', the directory order says 0x' + want.toString(16));
  });

  // and every file still reads back at the length its entry claims
  disk.entries.forEach(function (e) {
    if (!e.chainOk) bad.push(e.name.trim() + ': chain too short');
    if (disk.readFile(e).length !== e.length) bad.push(e.name.trim() + ': short read');
  });

  return bad;
}

/** What is wrong now that was not wrong before. */
function newProblems(before, after) {
  var seen = {};
  before.forEach(function (b) { seen[b] = (seen[b] || 0) + 1; });
  return after.filter(function (a) {
    if (seen[a]) { seen[a]--; return false; }
    return true;
  });
}

/** The zone names, which a trim must not touch at all. */
function namesOf(disk) {
  return zonesOf(disk).map(function (z) { return z.name; }).join('|');
}

if (fs.existsSync(dir)) {
  var disks = 0, trimmed = 0, held = 0, moved = 0, clean = 0, wereOdd = 0;

  fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).forEach(function (f) {
    var disk;
    try { disk = Akai.load(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))); }
    catch (err) { return; }
    disks++;

    // the first sample with anything to trim that is not last in the directory - the
    // point is to disturb the samples that come after it
    var samples = disk.entries.filter(function (e) { return e.type === 'S'; })
                              .sort(function (a, b) { return a.slot - b.slot; });
    var pick = null;
    for (var i = 0; i < samples.length - 1 && !pick; i++)
      if (disk.planTrim(samples[i], THRESHOLD).anything) pick = samples[i];
    if (!pick) return;

    var before = problemsOf(disk);
    var namesBefore = namesOf(disk);
    if (before.length) wereOdd++;

    var plan = disk.planTrim(pick, THRESHOLD);
    var following = samples.filter(function (s2) { return s2.slot > pick.slot; });
    var ramBefore = following.length ? following[0].memoryAddress : 0;

    try { disk.trimSample(pick, THRESHOLD); }
    catch (err) { console.log('  FAIL ' + f + ': ' + err.message); fails++; return; }

    trimmed++;
    if (plan.heldByLoop) held++;

    var nowFirst = disk.entries.filter(function (e) {
      return e.type === 'S' && e.slot > pick.slot;
    }).sort(function (a, b) { return a.slot - b.slot; })[0];
    if (nowFirst && nowFirst.memoryAddress !== ramBefore) moved++;

    var broke = newProblems(before, problemsOf(disk));
    var renamed = namesOf(disk) !== namesBefore;

    // and it all has to survive being written out and read back
    var again = Akai.load(f, disk.save());
    var brokeToo = newProblems(before, problemsOf(again));

    if (!broke.length && !brokeToo.length && !renamed) { clean++; return; }

    console.log('  FAIL ' + f + ' after trimming ' + pick.name.trim());
    if (renamed) console.log('         a zone name changed');
    broke.concat(brokeToo).slice(0, 3).forEach(function (b) {
      console.log('         ' + b);
    });
    fails++;
  });

  console.log('\n  trimmed a sample on ' + trimmed + ' of ' + disks + ' disks:');
  console.log('    ' + held + ' had the cut held back by a loop');
  console.log('    ' + moved + ' moved the samples that came after them in RAM');
  console.log('    ' + wereOdd + ' had a descriptor pointer the library itself left odd');
  check('no disk was left worse than it started, saved and reloaded', clean === trimmed,
        clean + ' of ' + trimmed);
} else {
  console.log('\n  (no disk library at ' + dir + ' - skipped the corpus pass)');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);
