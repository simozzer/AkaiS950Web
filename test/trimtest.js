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

var dir = process.argv[2] || 'C:\\Users\\simon\\AkaiS950Images';
if (fs.existsSync(dir)) {
  var looked = 0, wouldTrim = 0, broke = 0, held = 0;

  fs.readdirSync(dir).filter(function (f) { return /\.hfe$/i.test(f); }).forEach(function (f) {
    var disk;
    try { disk = Akai.load(f, new Uint8Array(fs.readFileSync(path.join(dir, f)))); }
    catch (err) { return; }

    disk.entries.filter(function (x) { return x.type === 'S' && x.loopMode !== 'O'; })
      .forEach(function (s) {
        looked++;
        var p = disk.planTrim(s, THRESHOLD);
        if (!p.anything) return;
        wouldTrim++;
        if (p.heldByLoop) held++;

        // what survives has to still contain the whole loop
        var keptTo = s.sampleCount - p.back;
        var newEnd = s.loopEnd >= s.sampleCount ? p.newWords
                                                : Math.min(s.loopEnd - p.front, p.newWords);
        if (keptTo < s.loopEnd || newEnd - Math.min(s.loopLength, p.newWords) < 0) broke++;
      });
  });

  console.log('\n  the library: ' + looked + ' looped samples, ' + wouldTrim +
              ' with silence to trim, ' + held + ' where the loop held the cut');
  check('no loop is ever cut into', broke === 0, broke + ' would have been');
} else {
  console.log('\n  (no disk library at ' + dir + ' - skipped the corpus pass)');
}

console.log(fails ? '\n' + fails + ' FAILED' : '\nall good');
process.exit(fails ? 1 : 0);
