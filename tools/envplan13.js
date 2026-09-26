/*
 * The thirteenth run: what an ALTERNATING loop does with its own end frames.
 *
 *   node envdisk.js  build ENVCAL13           --plan envplan13.js
 *   node envmidi.js  AkaiEnvCalibration13.mid --plan envplan13.js
 *   node envcal.js   take.wav ENVCAL13.img    --plan envplan13.js
 *
 * A sample's header byte 0x1A holds its loop mode: 'O' one-shot, 'L' looping, 'A' alternating.
 * All three codebases read it, the editor writes it back correctly including the loop
 * descriptor's direction word - and every engine then collapses 'A' to a plain forward loop,
 * because the mode reaches playback as a boolean and the direction is dropped there.
 *
 * 18 of the 1110 samples on the real disks are alternating, and they are exactly the ones
 * where it is audible: CYMBAL 1, OP-HIHAT, CRASH 1, PIANO C3, CELLO B2 and B3, J STR C5 and
 * C6, and a shelf of ambient beds - WIND, RAIN, THUNDER, WATER, INSECTS, TRAFFIC, JET,
 * ENGINE 2, LIGHTNING. Alternating exists to hide the seam on a long texture, so playing one
 * forward-only reintroduces the click it was chosen to avoid.
 *
 * WHY MEASURE BEFORE WRITING THE CODE
 *
 * A ping-pong loop of N frames is either 2N frames long or 2N-2, depending on whether the
 * frame at each end is played twice as the direction turns or only once. Both are ordinary
 * ways to build one and the difference is invisible in the file format. At a loop of 4410
 * frames nobody would hear it; at the short loops that give a sampler its pitch it is a
 * tenth of a semitone, and a wrong guess is wrong in every one of those 18 samples forever.
 *
 * HOW A SAWTOOTH ANSWERS IT IN ONE NUMBER
 *
 * The source is a sawtooth of exactly N frames a cycle, which is asymmetric on purpose: a
 * symmetric waveform reversed is the same waveform, so a sine would sound identical played
 * backwards and measure nothing at all. A ramp reversed is the other ramp, so:
 *
 *     forward only                  a SAW,      at rate / N
 *     alternating, ends repeated    a TRIANGLE, at rate / (2N)
 *     alternating, ends played once a TRIANGLE, at rate / (2N - 2)
 *
 * Three different pitches, and the pitch analysis added in run 10 reads a tone to under a
 * tenth of a cent. At N = 20 the two alternating answers are 1102.5 Hz and 1160.5 Hz, which
 * is 89 cents apart - not a fine judgement, an unmissable one.
 *
 * FOUR LENGTHS, BECAUSE ONE WOULD PROVE LESS THAN IT LOOKS
 *
 * The whole method rests on the loop being exactly the length the header says. If the machine
 * rounds a loop length, or has a minimum, or counts from somewhere unexpected, a single N
 * would give a clean wrong answer with nothing to contradict it. Four lengths across a factor
 * of six have to agree on the SAME rule, and the "ends repeated" and "ends once" predictions
 * diverge differently at each - 89 cents at N=20, down to 14 at N=128 - so a constant offset
 * from some other cause cannot imitate either.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var RATE = 44100;

/// The loop lengths under test, in frames.
var LENGTHS = [20, 32, 50, 128];

/*
 * The samples: a sawtooth apiece, alternating, plus forward-looping controls.
 *
 * The controls matter more than they look. They say that the loop really is N frames and
 * really is where the header puts it - a control reading rate/N is the measurement's own
 * calibration, and one that does not means the alternating clips are measuring something
 * else entirely and nothing below should be believed.
 */
/*
 * A tenth of a second each, not the usual three.
 *
 * The sample is not the sound here - the LOOP is, and the loop is at most 128 frames. All the
 * sample has to do is hold one and give the note somewhere to start. Six three-second samples
 * do not fit on a floppy anyway: the first alone wants 194 of the disk's 200 blocks.
 */
var FRAMES = 6400;      // 2^8 * 25: a whole number of cycles of 20, 32, 50 and 128 alike

var SAMPLES = [];

LENGTHS.forEach(function (n) {
  SAMPLES.push({ name: 'ALT' + n, kind: 'ramp', period: n,
                 loopMode: 'A', loopLength: n, frames: FRAMES });
});

[20, 50].forEach(function (n) {
  SAMPLES.push({ name: 'FWD' + n, kind: 'ramp', period: n,
                 loopMode: 'L', loopLength: n, frames: FRAMES });
});

/*
 * AND, SINCE THE DISK IS GOING IN THE MACHINE ANYWAY: TIME DIRECTION
 *
 * Header byte 0x2B, 'N' normal or 'R' reverse - the sample page's other setting. Nothing
 * reads it in any of the three codebases and addSample hardcodes 'N', so it has never been
 * measured or modelled.
 *
 * It is worth seven seconds rather than worth a run of its own: exactly ONE of the 1110
 * samples on the real disks is reversed - PHONE 3 on DSKA0083 - and that one is also loop
 * mode 'L', so the case that actually exists is a reversed sample that loops. These two are
 * therefore looping as well, differing in nothing but the one byte.
 *
 * The source is half a second of 500 Hz followed by half a second of 1500 Hz. A reversal
 * changes the ORDER of things and nothing else, so the detector has to have an order: played
 * normally the pitch trace steps UP in the middle, reversed it steps DOWN, and no other
 * setting on the machine could produce either.
 */
var REV_FRAMES = 22050;        // half a second: two quarters, 125 cycles in the slower one

['N', 'R'].forEach(function (dir) {
  SAMPLES.push({ name: dir === 'R' ? 'REVERSED' : 'NORMAL', kind: 'twotone',
                 lowHz: 500, highHz: 1500, direction: dir,
                 loopMode: 'L', loopLength: REV_FRAMES, frames: REV_FRAMES });
});

/*
 * Nothing may move except the loop.
 *
 * Constant pitch, so every note sounds at the sample's own rate whatever key carries it and
 * the frequencies above are the frequencies to expect. No envelope movement, no filter, no
 * LFO - the LFO especially, since it modulates pitch and pitch is the measurement.
 */
var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  12: 0, 13: 0, 14: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  19: 0xFF,                      // output port ALL
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,
  43: 0,
  44: 99, 45: 0
};

/*
 * Two seconds is generous for reading a steady pitch, and the run is short enough that there
 * is no reason to trim it: six notes at three and a half seconds is twenty-one.
 */
var TIMING = {
  hold: 2.0,
  gap: 1.5,
  sectionGap: 2.5,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var KEYGROUPS = [];
var nextKey = 36;

SAMPLES.forEach(function (s) {
  var key = nextKey++;
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });

  var alt = s.loopMode === 'A';
  var twoTone = s.kind === 'twotone';

  if (twoTone)
    TESTS.push({
      section: 'direction ' + s.direction,
      analysis: 'pitch',
      label: s.name + ' (0x2B = ' + s.direction + ')',
      key: key, velocity: 127, hold: TIMING.hold, gapAfter: TIMING.gap,
      setting: 0, watch: 'pitch',
      why: s.direction === 'R'
             ? 'if 0x2B reverses playback the pitch steps DOWN where the normal one steps up'
             : 'the control: played as written, 500 Hz then 1500'
    });
  else
    TESTS.push({
      section: (alt ? 'alternating ' : 'forward ') + s.period,
      analysis: 'pitch',
      label: (alt ? 'ALT' : 'FWD') + ' loop of ' + s.period + ' frames',
      key: key, velocity: 127, hold: TIMING.hold, gapAfter: TIMING.gap,
      setting: s.period, watch: 'pitch',
      why: alt ? 'saw at rate/N means forward only; a triangle at rate/2N or rate/(2N-2) '
               + 'means alternating, and says which way it turns'
               : 'the control: a forward loop of N frames must read rate/N exactly'
    });

  KEYGROUPS.push({ low: key, high: key, set: set, sample: s.name,
                   why: 'one keygroup per loop under test' });
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

/// What each clip should read under each of the three possible rules.
function expected() {
  return TESTS.filter(function (t) { return t.setting > 0; }).map(function (t) {
    var n = t.setting, alt = /^alternating/.test(t.section);
    return {
      label: t.label,
      forwardOnly: RATE / n,
      endsRepeated: alt ? RATE / (2 * n) : RATE / n,
      endsOnce: alt ? RATE / (2 * n - 2) : RATE / n
    };
  });
}

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, LOOPING: true, SAMPLES: SAMPLES,
  LENGTHS: LENGTHS, RATE: RATE, expected: expected,
  FROM: 99, OPEN_FROM: 99, CLOSE_FROM: 99, RELEASE_FROM: 99, AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
