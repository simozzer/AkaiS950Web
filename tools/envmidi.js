/*
 * Write the filter envelope calibration run as a Standard MIDI File.
 *
 *   node envmidi.js [out.mid]
 *
 * Load ENVCAL on the sampler, put this in a sequencer pointed at it, press record on
 * whatever is capturing the audio, and play.
 *
 * Notes only - no program changes, and no controllers either. Ableton Live will not carry
 * a program change in a clip, which is why every test here is a keygroup of one programme
 * on its own key rather than a programme of its own.
 *
 * Format 0, one track, 480 ticks per quarter at 120 bpm - a tick is then 1/960 of a second,
 * and every time in envplan.js lands on a tick boundary, so the analysis knows where each
 * clip should be to the millisecond. It needs that more than the other runs do: the release
 * section is timed from the note OFF, and an off in the wrong place measures the wrong
 * thing rather than nothing.
 */
var fs = require('fs');
var path = require('path');
/*
 * Which run this is for.
 *
 * --plan envplan2.js points the tool at the second run. Without it the first one is used,
 * and that matters: a take already recorded has to stay analysable after the plan has moved
 * on, or the recording becomes the only copy of what it measured.
 */
var args = process.argv.slice(2);
var planFile = './envplan.js';
for (var ai = 0; ai < args.length; ai++) {
  if (args[ai] === '--plan') { planFile = './' + args[ai + 1].split(/[/]/).pop(); args.splice(ai, 2); break; }
}
var plan = require(planFile);

// beside this script rather than in whatever directory it was run from, so the file and
// the analysis that reads it always agree
var out = args[0] || path.join(__dirname, 'AkaiEnvCalibration.mid');

var DIVISION = 480;                       // ticks per quarter note
var USEC_PER_QUARTER = 500000;            // 120 bpm
var TICKS_PER_SECOND = DIVISION * 1e6 / USEC_PER_QUARTER;   // 960

function ticks(seconds) { return Math.round(seconds * TICKS_PER_SECOND); }

/** MIDI's variable-length quantity: seven bits at a time, high bit marks "more". */
function vlq(n) {
  var bytes = [n & 0x7F];
  n >>= 7;
  while (n > 0) { bytes.unshift((n & 0x7F) | 0x80); n >>= 7; }
  return bytes;
}

var ch = plan.TIMING.channel & 0x0F;
var run = plan.schedule();

var track = [];
var lastTick = 0;

function at(seconds, bytes) {
  var t = ticks(seconds);
  track = track.concat(vlq(t - lastTick), bytes);
  lastTick = t;
}

at(0, [0xFF, 0x51, 0x03,
       (USEC_PER_QUARTER >> 16) & 0xFF, (USEC_PER_QUARTER >> 8) & 0xFF, USEC_PER_QUARTER & 0xFF]);

var title = 'Akai S950 filter envelope run';
at(0, [0xFF, 0x03, title.length].concat(title.split('').map(function (c) { return c.charCodeAt(0); })));

run.events.forEach(function (e) {
  if (e.kind === 'on') at(e.at, [0x90 | ch, e.note & 0x7F, e.velocity & 0x7F]);
  else if (e.kind === 'off') at(e.at, [0x80 | ch, e.note & 0x7F, 0]);
});

at(run.seconds, [0xFF, 0x2F, 0x00]);      // end of track

function chunk(id, body) {
  var head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32BE(body.length, 4);
  return Buffer.concat([head, Buffer.from(body)]);
}

var header = [0, 0,                       // format 0
              0, 1,                       // one track
              (DIVISION >> 8) & 0xFF, DIVISION & 0xFF];

fs.writeFileSync(out, Buffer.concat([chunk('MThd', header), chunk('MTrk', track)]));

console.log('');
console.log('wrote ' + out + '  (' + fs.statSync(out).size + ' bytes, ' +
            run.clips.length + ' clips, ' + Math.round(run.seconds) + 's)');
console.log('');
console.log('running order:');

var section = null;
run.clips.forEach(function (c) {
  if (c.section !== section) {
    section = c.section;
    console.log('');
    console.log('  ' + section);
  }
  console.log('      ' + c.from.toFixed(1).padStart(6) + 's  note ' +
              String(c.note).padStart(3) + '  held ' + c.hold.toFixed(1) + 's  ' + c.label);
});

console.log('');
console.log('MIDI channel ' + (ch + 1) + ' - select ENVCAL on the sampler first.');
console.log('Record from before the first note to a second past the last:');
console.log('  ' + Math.round(run.seconds) + ' seconds, ' + run.clips.length + ' clips.');
console.log('');
console.log('then: node envcal.js <take.wav>');
