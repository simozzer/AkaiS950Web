/*
 * The fifteenth run: POSITIONAL CROSSFADE.
 *
 *   node envdisk.js  build ENVCAL15           --plan envplan15.js
 *   node envmidi.js  AkaiEnvCalibration15.mid --plan envplan15.js
 *   node envcal.js   take.wav ENVCAL15.img    --plan envplan15.js
 *
 * Program header byte 21, a boolean: 0 in 327 of the library's 390 programmes and 255 in the
 * other 63. No engine reads it, so where the machine fades one keygroup into the next across
 * a shared stretch of keyboard, all three sound BOTH at full level - about 6 dB too loud in
 * the overlap, with two different recordings of the same note beating against each other.
 *
 * It is the largest unmodelled thing left, and the 48 programmes where it is on AND keygroups
 * overlap are exactly the multi-sampled instruments: GRAND-PNO1 and GRAND-PNO2 with nine
 * keygroups each, GRANDX, CB CEL VL. Anyone comparing a real piano against the plugin meets
 * this before they meet anything else.
 *
 * FOUR QUESTIONS, AND THE FOURTH IS THE AWKWARD ONE
 *
 *   A  THE CURVE      Across a two-keygroup overlap, which is 2566 of the keys where this is
 *                     on. Linear in amplitude, linear in decibels, or equal-power?
 *   B  THE WIDTH      A seven-key overlap and a thirteen-key one. The same shape stretched to
 *                     fit, or something fixed in semitones that a wide overlap leaves flat in
 *                     the middle?
 *   C  A STACK        53 keys in the library carry three or four keygroups at once, and
 *                     "fade between them" stops meaning one thing when there are three.
 *   D  SAME RANGE     Two keygroups covering exactly the same keys. The library has 17 pairs
 *                     like it - the ARP2600 patches on DSKA0041, keys 24-127 on both with the
 *                     velocity switch off - and they are plainly LAYERS rather than a split.
 *                     If the machine fades them by position, one of the two is silent at each
 *                     end of the keyboard, which would be a strange thing for a layer to do.
 *                     A rule that gets A right and D wrong is worse than no rule.
 *
 * HOW TWO KEYGROUPS ARE READ FROM ONE NOTE
 *
 * Run 6's trick, widened. Every keygroup here plays a pure tone at its own frequency and has
 * CONSTANT PITCH set, so the frequency does not move with the key - and a Goertzel at each
 * tone reads each keygroup's contribution out of the same clip, independently, however they
 * are mixed.
 *
 * Which means the run calibrates itself. Keys outside an overlap sound one keygroup alone and
 * give that tone's full level; keys inside it are read against those. No crossfade-off control
 * is needed, and nothing depends on the recording level being the same as any other run's.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

/*
 * Three tones, deliberately not harmonically related.
 *
 * 2200 is not a whole multiple of 1000, nor 4700 of either, so no tone's harmonics land in
 * another's bin. A fade read 30 dB down is only believable if what is being measured there is
 * the tone and not the second harmonic of its neighbour.
 */
var TONES = [1000, 2200, 4700];

var SAMPLES = [
  { name: 'T1', kind: 'tone', hz: TONES[0], frames: 4410, loopMode: 'L', loopLength: 4410 },
  { name: 'T2', kind: 'tone', hz: TONES[1], frames: 4410, loopMode: 'L', loopLength: 4410 },
  { name: 'T3', kind: 'tone', hz: TONES[2], frames: 4410, loopMode: 'L', loopLength: 4410 }
];

/// Byte 21 of the programme header: the crossfade, on.
var HEADER = { 21: 255 };

/*
 * Nothing may move but the mix.
 *
 * Constant pitch so the tones stay where the analysis looks for them. A flat envelope so every
 * level in the recording is the crossfade's doing. No filter, no LFO, no warp, and none of the
 * velocity sensitivities - every note is struck at 127 anyway, but a keygroup that responded
 * to velocity would make the two halves of an overlap answer differently for a reason that has
 * nothing to do with position.
 */
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

var TIMING = {
  hold: 1.5,
  gap: 1.0,
  sectionGap: 2.0,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var KEYGROUPS = [];

function keygroup(low, high, sample) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  set[0] = high; set[1] = low;
  KEYGROUPS.push({ low: low, high: high, set: set, sample: sample,
                   why: sample + ' over keys ' + low + ' to ' + high });
}

function play(section, keys, why) {
  keys.forEach(function (key) {
    TESTS.push({
      section: section, analysis: 'mix', label: section + ', key ' + key,
      key: key, velocity: 127, hold: TIMING.hold, gapAfter: TIMING.gap,
      setting: key, watch: 'mix', why: why
    });
  });
}

/*
 * A. A seven-key overlap, 42 to 48.
 *
 * Keys 36 and 39 sound T1 alone and 51 and 54 sound T2 alone - those four are what every
 * level inside the overlap is measured against.
 */
keygroup(36, 48, 'T1');
keygroup(42, 54, 'T2');
play('narrow', [36, 39, 42, 43, 44, 45, 46, 47, 48, 51, 54],
     'the shape of the fade across a seven-key overlap');

/*
 * B. A thirteen-key overlap, 72 to 84, with everything else the same.
 *
 * If the fade is the same shape stretched, these land on the same curve when the key is read
 * as a fraction of the overlap. If it is fixed in semitones, a wider overlap is flat in the
 * middle and the two do not agree.
 */
keygroup(60, 84, 'T1');
keygroup(72, 96, 'T2');
play('wide', [60, 66, 72, 74, 76, 78, 80, 82, 84, 90, 96],
     'whether the width stretches the curve or leaves a flat middle');

/*
 * C. Three keygroups, overlapping two at a time and all three between 108 and 112.
 *
 * 100 and 118 are the single-keygroup references at either end.
 */
keygroup(100, 112, 'T1');
keygroup(104, 116, 'T2');
keygroup(108, 120, 'T3');
play('stack', [100, 102, 106, 108, 110, 112, 114, 118],
     'what a fade does when three keygroups answer one key');

/*
 * D. Two keygroups over exactly the same keys, which is what the ARP2600 layers are.
 *
 * Below everything else so it cannot overlap another section. Narrower than 24-127 because
 * the question is about IDENTICAL ranges rather than about full ones, and thirteen keys read
 * as clearly as a hundred.
 *
 * There is no single-keygroup reference here - both sound on every key - so these are read
 * against the same tones' full levels from sections A and B, which is what makes using the
 * same two samples throughout worth the bookkeeping.
 */
keygroup(20, 32, 'T1');
keygroup(20, 32, 'T2');
play('same range', [20, 23, 26, 29, 32],
     'whether two keygroups on the same keys are faded, which would silence a layer');

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

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, HEADER: HEADER, LOOPING: true, SAMPLES: SAMPLES,
  TONES: TONES,
  FROM: 99, OPEN_FROM: 99, CLOSE_FROM: 99, RELEASE_FROM: 99, AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
