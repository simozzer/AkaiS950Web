/*
 * Write the LFO calibration run as a Standard MIDI File.
 *
 *   node lfomidi.js [out.mid]
 *
 * Load LFOCAL on the sampler, put this in a sequencer pointed at it, press record on
 * whatever is capturing the audio, and play.
 *
 * Notes and one controller - no program changes, for the reason in lfoplan.js. The
 * controller is the modwheel, CC 1, which every sequencer will carry in a clip. It is
 * set to zero at the top of the file and put back to zero after the section that uses
 * it, so a take cannot be spoiled by a wheel left somewhere.
 *
 * Format 0, one track, 480 ticks per quarter at 120 bpm - a tick is then 1/960 of a
 * second, and every time in lfoplan.js lands on a tick boundary, so the analysis knows
 * where each clip should be to the millisecond.
 */
var fs = require('fs');
var path = require('path');
var plan = require('./lfoplan.js');

// beside this script rather than in whatever directory it was run from, so the file and
// the test that reads it always agree
var out = process.argv[2] || path.join(__dirname, 'AkaiLfoCalibration.mid');

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

// tempo, so a sequencer shows the run at 120 bpm rather than guessing
at(0, [0xFF, 0x51, 0x03,
       (USEC_PER_QUARTER >> 16) & 0xFF, (USEC_PER_QUARTER >> 8) & 0xFF, USEC_PER_QUARTER & 0xFF]);

var title = 'Akai S950 LFO calibration run';
at(0, [0xFF, 0x03, title.length].concat(title.split('').map(function (c) { return c.charCodeAt(0); })));

run.events.forEach(function (e) {
  if (e.kind === 'on') at(e.at, [0x90 | ch, e.note & 0x7F, e.velocity & 0x7F]);
  else if (e.kind === 'off') at(e.at, [0x80 | ch, e.note & 0x7F, 0]);
  else if (e.kind === 'cc') at(e.at, [0xB0 | ch, e.controller & 0x7F, e.value & 0x7F]);
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
  var extra = c.pairWith !== null && c.pairWith !== undefined
                ? '  + note ' + c.pairWith + ' (two octaves up) after ' +
                  c.stagger.toFixed(1) + 's'
                : (c.cc ? '  + wheel' : '');
  console.log('      ' + c.from.toFixed(1).padStart(6) + 's  note ' +
              String(c.note).padStart(3) + '  ' + c.hold.toFixed(0).padStart(2) + 's  ' +
              c.sample.padEnd(5) + ' ' + c.label + extra);
});

console.log('');
console.log('MIDI channel ' + (ch + 1) + ' - select ' + 'LFOCAL' + ' on the sampler first.');
console.log('Record from the note before the first clip to a second after the last:');
console.log('  ' + Math.round(run.seconds) + ' seconds, ' + run.clips.length + ' clips.');
