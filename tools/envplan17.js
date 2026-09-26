/*
 * The seventeenth run: the crossfade, sampled properly in both axes.
 *
 *   node envdisk.js  build ENVCAL17           --plan envplan17.js
 *   node envmidi.js  AkaiEnvCalibration17.mid --plan envplan17.js
 *   node envcal.js   take.wav ENVCAL17.img    --plan envplan17.js
 *
 * Run 15 established that two keygroups sharing keys are faded symmetrically, and that two
 * covering exactly the same keys are not faded at all - they sit at a constant -3.7 dB
 * apiece, so the ARP2600 layers are safe. It could not pin the curve: a seven-key overlap and
 * a thirteen-key one agreed through the middle third and parted by 3.7 dB at five sixths,
 * and the midpoint was -4.2 dB where equal power gives -3.0 and a linear amplitude fade -6.0.
 *
 * Run 16 was never recorded - the take came back against the previous programme, the disk
 * not having been reloaded, which 32 of 32 keys confirm.
 *
 * WHY THIS ONE IS BIGGER
 *
 * Four widths and one velocity would be enough to fit a curve, and fitting a curve to too few
 * points is how ENV_TIME came to be 20% wrong around stored 45 - interpolated across a gap
 * where nothing had been measured. The crossfade will be interpolated the same way, so the
 * gaps have to be small enough that the interpolation cannot hide anything.
 *
 *   SEVEN WIDTHS   1, 2, 3, 5, 9, 13 and 21 keys, every key played at the five narrowest.
 *                  Run 15's two widths could not distinguish "the same shape stretched to
 *                  fit" from "something fixed in semitones"; seven can, and 1 and 2 are the
 *                  degenerate cases a formula has to survive - the library has 13 pairs
 *                  overlapping by a single key and 3 by two.
 *   SPREAD OUT     The widths sit in order from key 24 to key 125, so an overlap low on the
 *                  keyboard is measured as well as one high up. If the fade turns out to
 *                  depend on absolute key rather than on position within the overlap, that
 *                  shows here and nowhere else.
 *   SIX VELOCITIES for the fade itself, and four for its interaction with loudness - see
 *                  sections E and F. Three would show whether velocity matters at all; six
 *                  shows the shape if it does, which is the difference between knowing there
 *                  is a problem and being able to model it.
 *
 * A hundred notes at a shorter hold, because the measurement is a steady tone and needs a
 * fraction of a second: three minutes, against the two the sparser version would have taken.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var TONES = [1000, 2200];

var SAMPLES = [
  { name: 'T1', kind: 'tone', hz: TONES[0], frames: 4410, loopMode: 'L', loopLength: 4410 },
  { name: 'T2', kind: 'tone', hz: TONES[1], frames: 4410, loopMode: 'L', loopLength: 4410 }
];

/// Byte 21 of the programme header: the crossfade, on.
var HEADER = { 21: 255 };

var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  12: 0, 13: 0, 14: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  19: 0xFF,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,
  43: 0,
  44: 99, 45: 0
};

/*
 * A SECOND OF NOTE AND FOUR FIFTHS OF SILENCE
 *
 * Shorter than any run so far, and it is the measurement that allows it: a Goertzel at a known
 * frequency needs a couple of thousand samples, which is a twentieth of a second, and the mix
 * analysis reads from 0.2 s to 0.8 s into the note. Everything before this run was timing an
 * envelope and needed the note to outlast it.
 *
 * The gap stays generous relative to the note because the splitter still has to find the
 * edges, and a run of a hundred notes has a hundred chances to lose one.
 */
var TIMING = {
  hold: 1.0,
  gap: 0.8,
  sectionGap: 1.5,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var KEYGROUPS = [];

function keygroup(low, high, sample, extra) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(extra || {}).forEach(function (k) { set[k] = extra[k]; });
  set[0] = high; set[1] = low;
  KEYGROUPS.push({ low: low, high: high, set: set, sample: sample,
                   why: sample + ' over keys ' + low + ' to ' + high });
}

function play(section, keys, why, velocity) {
  var vel = velocity === undefined ? 127 : velocity;
  keys.forEach(function (key) {
    TESTS.push({
      section: section, analysis: 'mix',
      label: section + ' key ' + key + ' at ' + vel,
      key: key, velocity: vel, hold: TIMING.hold, gapAfter: TIMING.gap,
      setting: key, watch: 'mix', why: why
    });
  });
}

/*
 * F, first and lowest: velocity against an overlap, with velocity to loudness at FULL.
 *
 * Its own pair because it differs from everything else in one byte, and byte 11 is the one
 * that could make the crossfade and the velocity response interact rather than multiply.
 * 723 of the library's 1908 keygroups set a velocity depth, so a real piano patch drives both
 * paths at once and would be wrong in a way neither measured alone would predict.
 */
keygroup(24, 28, 'T1', { 11: 99 });
keygroup(26, 30, 'T2', { 11: 99 });

[1, 32, 80, 127].forEach(function (v) {
  play('F loud', [24, 26, 27, 28, 30],
       'whether the crossfade and velocity-to-loudness interact or simply multiply', v);
});

/*
 * The seven widths, in order up the keyboard.
 *
 * Every key of the overlap at widths 1 to 9; at 13 and 21 every other key, with both ends and
 * the keys next to them. Each has a key either side where one keygroup sounds alone, which is
 * what that tone's full level is read from - so the sections must not touch, and the gaps
 * between them are deliberate empty ground.
 */
keygroup(32, 36, 'T1');  keygroup(36, 40, 'T2');      // width 1, overlap {36}
play('width 1', [34, 36, 38], 'one shared key - does it fade at all, and to what?');

keygroup(42, 46, 'T1');  keygroup(45, 49, 'T2');      // width 2, overlap 45-46
play('width 2', [43, 45, 46, 48], 'two shared keys, with no middle to sit in');

keygroup(51, 55, 'T1');  keygroup(53, 57, 'T2');      // width 3, overlap 53-55
play('width 3', [51, 53, 54, 55, 57], 'the narrowest overlap that has a middle');

keygroup(59, 65, 'T1');  keygroup(61, 67, 'T2');      // width 5, overlap 61-65
play('width 5', [59, 61, 62, 63, 64, 65, 67], 'five keys, every one of them');

keygroup(69, 79, 'T1');  keygroup(71, 81, 'T2');      // width 9, overlap 71-79
play('width 9', [69, 71, 72, 73, 74, 75, 76, 77, 78, 79, 81], 'nine keys, every one of them');

keygroup(83, 97, 'T1');  keygroup(85, 99, 'T2');      // width 13, overlap 85-97
play('width 13', [83, 85, 86, 87, 89, 91, 93, 95, 96, 97, 99],
     'thirteen keys, dense at the ends where run 15 lost the shape');

keygroup(101, 123, 'T1'); keygroup(103, 125, 'T2');   // width 21, overlap 103-123
play('width 21', [101, 103, 104, 105, 109, 113, 117, 121, 122, 123, 125],
     'twenty-one keys, and the highest overlap on the keyboard');

/*
 * E: velocity against the width-9 overlap, which already has its keygroups.
 *
 * Velocity to loudness is ZERO on this pair, as it is everywhere but F, so nothing except the
 * crossfade can move a level. If the balance between the two tones shifts with velocity here
 * then the fade itself is velocity-dependent; if it is flat here and not in F, the two are
 * interacting.
 *
 * Velocity 127 is already played across the whole overlap above, so only the other five are
 * needed - at both edges, both quarters and the middle.
 */
[1, 16, 32, 48, 96].forEach(function (v) {
  play('E flat', [69, 71, 73, 75, 77, 79, 81],
       'does the balance move with velocity when nothing else can move it', v);
});

function schedule() {
  var events = [];
  var clips = [];
  var at = TIMING.lead;
  var section = null;
  var previous = null;

  TESTS.forEach(function (c) {
    var first = c.section !== section;
    if (clips.length)
      at += first ? Math.max(TIMING.sectionGap, previous.gapAfter) : previous.gapAfter;
    section = c.section;
    previous = c;

    events.push({ at: at, kind: 'on', note: c.key, velocity: c.velocity });
    events.push({ at: at + c.hold, kind: 'off', note: c.key });

    clips.push({
      section: c.section, analysis: c.analysis, label: c.label, setting: c.setting,
      note: c.key, velocity: c.velocity, first: first, watch: c.watch,
      from: at, releasedAt: at + c.hold, hold: c.hold
    });

    at += c.hold;
  });

  return { events: events, clips: clips, seconds: at + TIMING.gap };
}

/// Each section's overlap, for reading a key as a position within it.
function overlaps() {
  return [
    { section: 'F loud',   from: 26,  to: 28 },
    { section: 'width 1',  from: 36,  to: 36 },
    { section: 'width 2',  from: 45,  to: 46 },
    { section: 'width 3',  from: 53,  to: 55 },
    { section: 'width 5',  from: 61,  to: 65 },
    { section: 'width 9',  from: 71,  to: 79 },
    { section: 'width 13', from: 85,  to: 97 },
    { section: 'width 21', from: 103, to: 123 },
    { section: 'E flat',   from: 71,  to: 79 }
  ];
}

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, HEADER: HEADER, LOOPING: true, SAMPLES: SAMPLES,
  TONES: TONES, overlaps: overlaps,
  FROM: 99, OPEN_FROM: 99, CLOSE_FROM: 99, RELEASE_FROM: 99, AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
