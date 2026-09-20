/*
 * Write the calibration run as a Standard MIDI File.
 *
 *   node makemidi.js [out.mid]
 *
 * Select the CALIB programme on the sampler, load this in a sequencer pointed at the S950,
 * press record on whatever is capturing the audio, and play.
 *
 * Notes only - no program changes. Ableton Live does not carry program change in a MIDI
 * clip (it is a per-track I/O setting there), so a file that relied on them would import
 * as bare notes and silently test one programme fourteen times. Every test is instead a
 * keygroup of CALIB on its own key, so changing test means playing a different note.
 *
 * Format 0, one track, 480 ticks per quarter at 120 bpm - which makes a tick 1/960 of a
 * second, so the timings in benchplan.js land exactly on tick boundaries and the analysis
 * knows where every clip should be.
 *
 * MIDI channel 1. If the sampler is set to another channel, either change it there or
 * change TIMING.channel in benchplan.js and run this again.
 */
var fs = require('fs');
var path = require('path');
var plan = require('./benchplan.js');

// beside this script rather than in whatever directory it was run from, so the file and
// the test that reads it always agree
var out = process.argv[2] || path.join(__dirname, 'AkaiCalibration.mid');

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

var track = [];
var pending = 0;                          // ticks waiting to be spent on the next event

function wait(seconds) { pending += ticks(seconds); }

function event(bytes) {
  track = track.concat(vlq(pending), bytes);
  pending = 0;
}

var ch = plan.TIMING.channel & 0x0F;

// tempo, so a sequencer shows the run at 120 bpm rather than guessing
event([0xFF, 0x51, 0x03,
       (USEC_PER_QUARTER >> 16) & 0xFF, (USEC_PER_QUARTER >> 8) & 0xFF, USEC_PER_QUARTER & 0xFF]);

// a name, so it is obvious what the file is when it turns up in a sequencer
var title = 'Akai S950 calibration run';
event([0xFF, 0x03, title.length].concat(title.split('').map(function (c) { return c.charCodeAt(0); })));

wait(plan.TIMING.lead);

var list = plan.clips();
var schedule = [];
var at = plan.TIMING.lead;

list.forEach(function (c, i) {
  // a longer pause where a new section starts, so a take can be checked by eye
  if (i > 0 && c.first) { wait(plan.TIMING.sectionGap - plan.TIMING.gap); at += plan.TIMING.sectionGap - plan.TIMING.gap; }

  schedule.push({ clip: c, from: at, to: at + plan.TIMING.hold });

  event([0x90 | ch, c.note & 0x7F, c.velocity & 0x7F]);
  wait(plan.TIMING.hold);
  at += plan.TIMING.hold;

  event([0x80 | ch, c.note & 0x7F, 0]);
  wait(plan.TIMING.gap);
  at += plan.TIMING.gap;
});

event([0xFF, 0x2F, 0x00]);                // end of track

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
            list.length + ' notes, ' + at.toFixed(1) + 's)');
console.log('');
console.log('running order:');

var section = null;
schedule.forEach(function (s) {
  if (s.clip.section !== section) {
    section = s.clip.section;
    console.log('');
    console.log('  ' + section + '  -  settles ' + s.clip.settles);
  }
  console.log('      ' + s.from.toFixed(1).padStart(6) + 's  note ' +
              String(s.clip.note).padStart(3) + '  velocity ' +
              String(s.clip.velocity).padStart(3) + '   ' + s.clip.label);
});

console.log('');
console.log('MIDI channel ' + (ch + 1) + ', notes only - select CALIB on the sampler first.');
