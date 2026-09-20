/*
 * Read the calibration MIDI file back and check it says what the plan says.
 *
 * A malformed file would waste a recording session before anyone noticed, and the bugs
 * available here are quiet ones: a variable-length quantity encoded wrongly shifts every
 * later event, a missing note-off leaves a note hanging, a program change after its note
 * tests the wrong programme. So this parses the bytes independently of the writer and
 * compares the result against benchplan.js.
 *
 *   node miditest.js [file.mid]
 */
var fs = require('fs');
var path = require('path');
var plan = require('../tools/benchplan.js');

// written by tools/makemidi.js, and kept beside it
var file = process.argv[2] || path.join(__dirname, '..', 'tools', 'AkaiCalibration.mid');
var problems = [];

function check(name, ok, detail) {
  if (!ok) problems.push(name + (detail ? '  -  ' + detail : ''));
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (detail ? '   (' + detail + ')' : ''));
}

var b = fs.readFileSync(file);

console.log('');
console.log('the file itself:');
check('starts with MThd', b.toString('ascii', 0, 4) === 'MThd');

var headerLen = b.readUInt32BE(4);
var format = b.readUInt16BE(8), tracks = b.readUInt16BE(10), division = b.readUInt16BE(12);

check('header is 6 bytes', headerLen === 6, headerLen + '');
check('format 0', format === 0, 'format ' + format);
check('one track', tracks === 1, tracks + '');
check('division is positive ticks per quarter', division > 0 && !(division & 0x8000), division + '');

var pos = 8 + headerLen;
check('track starts with MTrk', b.toString('ascii', pos, pos + 4) === 'MTrk');

var trackLen = b.readUInt32BE(pos + 4);
check('track length matches the file', pos + 8 + trackLen === b.length,
      'says ' + trackLen + ', file has ' + (b.length - pos - 8));

// --- walk the events
pos += 8;
var end = pos + trackLen;
var tick = 0, usecPerQuarter = 500000, running = 0;
var events = [];

function vlq() {
  var v = 0, byte;
  do { byte = b[pos++]; v = (v << 7) | (byte & 0x7F); } while (byte & 0x80);
  return v;
}

while (pos < end) {
  tick += vlq();

  var status = b[pos];
  if (status & 0x80) { running = status; pos++; } else { status = running; }

  var seconds = tick * (usecPerQuarter / 1e6) / division;

  if (status === 0xFF) {
    var type = b[pos++], len = vlq();
    if (type === 0x51) usecPerQuarter = (b[pos] << 16) | (b[pos + 1] << 8) | b[pos + 2];
    events.push({ at: seconds, kind: 'meta', type: type });
    pos += len;
  } else {
    var hi = status & 0xF0, chan = status & 0x0F;
    if (hi === 0xC0) { events.push({ at: seconds, kind: 'program', value: b[pos], chan: chan }); pos += 1; }
    else if (hi === 0x90) {
      var note = b[pos], vel = b[pos + 1];
      events.push({ at: seconds, kind: vel > 0 ? 'on' : 'off', note: note, velocity: vel, chan: chan });
      pos += 2;
    }
    else if (hi === 0x80) { events.push({ at: seconds, kind: 'off', note: b[pos], chan: chan }); pos += 2; }
    else { pos += 2; }
  }
}

console.log('');
console.log('what it contains:');

check('ends with end-of-track',
      events.length > 0 && events[events.length - 1].kind === 'meta' &&
      events[events.length - 1].type === 0x2F);

check('sets a tempo', events.some(function (e) { return e.kind === 'meta' && e.type === 0x51; }));

var ons = events.filter(function (e) { return e.kind === 'on'; });
var offs = events.filter(function (e) { return e.kind === 'off'; });
var pcs = events.filter(function (e) { return e.kind === 'program'; });

var wanted = plan.clips();
check('one note per clip in the plan', ons.length === wanted.length,
      ons.length + ' notes, plan wants ' + wanted.length);
check('every note is released', offs.length === ons.length,
      ons.length + ' on, ' + offs.length + ' off');

// --- each note must match its clip, and be preceded by the right programme
console.log('');
console.log('against the plan:');

var wrongNote = 0, wrongVel = 0;

ons.forEach(function (e, i) {
  var want = wanted[i];
  if (!want) return;
  if (e.note !== want.note) wrongNote++;
  if (e.velocity !== want.velocity) wrongVel++;
});

check('every note is the pitch the plan asks for', wrongNote === 0, wrongNote + ' wrong');
check('every note is the velocity the plan asks for', wrongVel === 0, wrongVel + ' wrong');

// Ableton Live drops program change on import, so a file that needed one would arrive as
// bare notes and test a single programme over and over without saying so. There must be
// none: every test is a keygroup of CALIB reached by playing its own note.
check('no program changes to be stripped', pcs.length === 0, pcs.length + ' present');

// notes must not overlap, or two clips merge into one in the recording
var merged = 0;
for (var i = 1; i < ons.length; i++) {
  var prevOff = offs[i - 1] ? offs[i - 1].at : 0;
  if (ons[i].at <= prevOff + 0.2) merged++;
}
check('every note is clear of the one before it', merged === 0, merged + ' too close');

// the gap has to outlast the release and still leave the splitter 150 ms to find
var tightest = 1e9;
for (var i = 1; i < ons.length; i++)
  tightest = Math.min(tightest, ons[i].at - offs[i - 1].at);
check('gaps are long enough to split on', tightest >= 0.5, 'tightest ' + tightest.toFixed(2) + 's');

// all on one channel, or the sampler hears only some of it
var channels = {};
events.forEach(function (e) { if (e.chan !== undefined) channels[e.chan] = true; });
check('everything on one channel', Object.keys(channels).length === 1,
      'channels ' + Object.keys(channels).map(function (c) { return +c + 1; }).join(', '));

var span = ons.length ? offs[offs.length - 1].at : 0;
console.log('');
console.log('  ' + ons.length + ' notes over ' + span.toFixed(1) + 's, ' +
            pcs.length + ' program changes');
console.log('');
console.log(problems.length ? problems.length + ' FAILED' : 'the MIDI file matches the plan');
if (problems.length) process.exit(1);
