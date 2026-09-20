/*
 * The loop finder, against the loops the library was shipped with.
 *
 * 324 of the original 1,110 samples carry a loop somebody chose by ear on the machine.
 * They are not the only right answers - a sustained note has many good loops - so this
 * does not demand the same number back. What it checks is that the finder lands on a
 * join at least as clean as the shipped one, measured the same way for both: the
 * normalised correlation of the window approaching the loop end with the window
 * approaching the point the loop restarts, which is the join the ear hears.
 *
 * It also checks the arithmetic the file format cares about - an even length that fits
 * inside the sample - and, with `modes`, that changing a loop mode keeps the descriptor
 * table consistent.
 *
 *   node looptest.js [directory] [modes]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('./akai.js');
var Audio = require('./audio.js');

var dir = process.argv[2] || 'C:' + String.fromCharCode(92) + 'Users' +
          String.fromCharCode(92) + 'simon' + String.fromCharCode(92) + 'AkaiS950Images';
var alsoModes = process.argv[3] === 'modes';

var totals = { samples: 0, looped: 0, found: 0, better: 0, same: 0, worse: 0,
               problems: [], modeChecked: 0, modeBad: 0 };
var scores = [];

/** The same measure for both loops: how well the approach to the join matches. */
function joinMatch(words, end, len) {
  var win = Math.min(2048, Math.max(128, len >> 1));
  var from = end - len;
  if (from < win || end > words.length || len < 2) return null;
  var dot = 0, ea = 0, eb = 0;
  for (var i = 0; i < win; i++) {
    var a = words[end - win + i], b = words[from - win + i];
    dot += a * b; ea += a * a; eb += b * b;
  }
  var d = Math.sqrt(ea * eb);
  return d > 0 ? dot / d : null;
}

fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).sort()
  .forEach(function (f) {
  var disk;
  try { disk = Akai.load(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))); }
  catch (e) { totals.problems.push(f + ': ' + e.message); return; }

  disk.entries.filter(function (e) { return e.type === 'S'; }).forEach(function (e) {
    totals.samples++;
    if (e.loopMode === 'O') return;
    totals.looped++;

    var words = disk.sampleWords12(e);
    var end = Math.min(e.loopEnd || words.length, words.length);
    var theirs = joinMatch(words, end, e.loopLength);

    var got = Audio.findLoop(words, { end: end, minLength: Math.max(64, e.sampleRate / 50) });
    if (!got) return;
    totals.found++;

    // the format's own arithmetic, which a bad answer here would take onto a disk
    if (got.length % 2) totals.problems.push(e.name.trim() + ': odd loop length ' + got.length);
    if (got.from < 0 || got.end > words.length)
      totals.problems.push(e.name.trim() + ': loop ' + got.from + '..' + got.end +
                           ' outside a sample of ' + words.length);

    var ours = joinMatch(words, end, got.length);
    if (theirs === null || ours === null) return;
    scores.push({ name: e.name.trim(), disk: f, theirs: theirs, ours: ours,
                  theirLen: e.loopLength, ourLen: got.length });
    if (ours > theirs + 0.01) totals.better++;
    else if (ours < theirs - 0.01) totals.worse++;
    else totals.same++;
  });

  // Changing a loop mode changes how many 10-byte descriptors the sample takes, so the
  // pointers of every sample after it move. The chain is the check.
  if (alsoModes) {
    var ss = disk.entries.filter(function (e) { return e.type === 'S'; })
                         .sort(function (a, b) { return a.slot - b.slot; });
    if (ss.length >= 2) {
      var before = chainOk(disk);
      var target = ss[0];
      disk.setLoopMode(target, target.loopMode === 'O' ? 'L' : 'O');
      totals.modeChecked++;
      var after = chainOk(disk);
      if (after < before) {
        totals.modeBad++;
        totals.problems.push(f + ': changing ' + target.name.trim() + "'s loop mode broke " +
                             (before - after) + ' descriptor pointer(s)');
      }
    }
  }
});

/** How many samples' descriptor pointers follow on from the one before. */
function chainOk(disk) {
  var ss = disk.entries.filter(function (e) { return e.type === 'S'; })
                       .sort(function (a, b) { return a.slot - b.slot; });
  var ok = 0;
  for (var i = 1; i < ss.length; i++) {
    var p = ss[i - 1];
    var pages = Math.floor(2 * p.sampleCount / 131072);
    var recs = p.loopMode === 'L' ? 3 + pages : p.loopMode === 'A' ? 3 * (1 + pages) : 2 + pages;
    if (ss[i].loopDescriptorPtr === p.loopDescriptorPtr + 10 * recs) ok++;
  }
  return ok;
}

scores.sort(function (a, b) { return a.ours - b.ours; });
var mean = function (pick) {
  return scores.reduce(function (t, s) { return t + pick(s); }, 0) / Math.max(1, scores.length);
};

console.log(totals.samples + ' samples, ' + totals.looped + ' looped, ' +
            totals.found + ' the finder could answer for');
console.log('join match  -  shipped ' + mean(function (s) { return s.theirs; }).toFixed(3) +
            '   found ' + mean(function (s) { return s.ours; }).toFixed(3));
console.log('better ' + totals.better + '   as good ' + totals.same + '   worse ' + totals.worse);
if (alsoModes)
  console.log('loop mode changed on ' + totals.modeChecked + ' disks, ' +
              totals.modeBad + ' broke the descriptor chain');

console.log('\nthe five it did worst on:');
scores.slice(0, 5).forEach(function (s) {
  console.log('  ' + s.name.padEnd(12) + ' ours ' + s.ours.toFixed(3) + ' (' + s.ourLen +
              ')   shipped ' + s.theirs.toFixed(3) + ' (' + s.theirLen + ')   ' + s.disk);
});

if (totals.problems.length) {
  console.log('\nPROBLEMS (' + totals.problems.length + '):');
  totals.problems.slice(0, 20).forEach(function (p) { console.log('  ' + p); });
  process.exit(1);
}
console.log('\nno problems');
