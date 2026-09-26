/*
 * The fourteenth run: TIME DIRECTION, asked properly this time.
 *
 *   node envdisk.js  build ENVCAL14           --plan envplan14.js
 *   node envmidi.js  AkaiEnvCalibration14.mid --plan envplan14.js
 *   node envcal.js   take.wav ENVCAL14.img    --plan envplan14.js
 *
 * Sample header byte 0x2B: 'N' normal, 'R' reverse - the sample page's other setting, next to
 * the loop mode. Nothing in any of the three codebases reads it and addSample hardcodes 'N'.
 * Exactly ONE of the 1110 samples on the real disks is 'R': PHONE 3 on DSKA0083.
 *
 * WHY RUN 13 DID NOT ANSWER THIS, THOUGH IT TRIED
 *
 * Run 13 carried a direction test as a passenger and got it wrong in two ways at once.
 *
 * It CONFLATED DIRECTION WITH LOOPING. Both its direction samples were loop mode 'L', so what
 * it actually tested was reverse on a LOOPING sample. It read no effect - and a loop can mask
 * one perfectly well, so "0x2B does nothing" and "0x2B does nothing once a loop has taken
 * over" are both consistent with what came back. Two settings on two different pages, tested
 * as though they were one.
 *
 * And it used the WRONG CONTENT. Its source was two sustained tones at a flat level. A
 * reversal changes the order of things, and the strongest order a sample has is its own
 * envelope - so the detector that was available and unused is a struck note, which reversed
 * swells into a cut-off instead of hitting and fading. A flat sample has no envelope to
 * reverse. The best evidence was thrown away before the recording started.
 *
 * Both faults are the same fault: testing a setting without asking what else has to be true
 * for it to show.
 *
 * WHAT THIS RUN ASKS
 *
 *   A  ONE-SHOT       A struck note, 'N' against 'R', not looping. If the level trace hits and
 *                     fades it played as written; if it swells and stops dead it played
 *                     backwards. Nothing else on the machine makes a sample swell.
 *   B  LOOPING        The same content and the same pair, looping. Whether a loop is what hid
 *                     the answer in run 13 - and this is the combination PHONE 3 actually
 *                     uses, so it is the case that matters for the library.
 *   C  THE ENVELOPE   The reversed one again, under a VCA decay. Multiplication commutes, so
 *                     "audio and envelope both reversed" is not the same as "neither" - the
 *                     first is the whole forward product played backwards. Three hypotheses,
 *                     three different SLOPES, set out at section C below.
 *
 * WHAT THE LIKELY ANSWER MEANS
 *
 * If the panel's Reverse is a DESTRUCTIVE edit - it rewrites the sample data backwards and
 * 0x2B is a record of what was done - then no engine should reverse anything at playback,
 * PHONE 3's audio is already backwards on its disk, and one sample in 1110 is exactly the rate
 * you would expect for something a person did once on purpose. Section A settles that: a flag
 * that reverses playback turns THIS sample round, because its data is written forwards.
 *
 * Getting it wrong is not neutral. Implementing reverse-at-playback when the data is already
 * reversed plays PHONE 3 backwards from correct.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var RATE = 44100;

/*
 * Half a second, struck at 1 kHz and decaying over 80 ms.
 *
 * Six time constants inside the sample, so it falls to a quarter of a per cent of its peak
 * well before the end - which is what makes the reversal unmistakable rather than merely
 * visible. Played backwards it starts at that quarter of a per cent and climbs 52 dB.
 */
var FRAMES = 22050;
var TAU = 0.08;

var SAMPLES = [
  { name: 'HITN', kind: 'perc', hz: 1000, tau: TAU, direction: 'N',
    loopMode: 'O', frames: FRAMES },
  { name: 'HITR', kind: 'perc', hz: 1000, tau: TAU, direction: 'R',
    loopMode: 'O', frames: FRAMES },
  { name: 'LOOPN', kind: 'perc', hz: 1000, tau: TAU, direction: 'N',
    loopMode: 'L', loopLength: FRAMES, frames: FRAMES },
  { name: 'LOOPR', kind: 'perc', hz: 1000, tau: TAU, direction: 'R',
    loopMode: 'L', loopLength: FRAMES, frames: FRAMES }
];

/*
 * The envelope must not move, except in section C where moving it is the question.
 *
 * Attack 0 and sustain 99 means the note is at full level from the first sample to the last,
 * so every rise and fall in the recording belongs to the SAMPLE and not to the machine. That
 * is the whole basis of reading direction off the level trace.
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

/*
 * Two seconds, against a sample of half a second.
 *
 * The one-shots stop when they run out and the rest is silence, which is itself worth seeing.
 * The looping pair get four passes, so whether each repeat hits or swells is read four times
 * over rather than once.
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

function add(spec) {
  var key = nextKey++;
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(spec.set || {}).forEach(function (k) { set[k] = spec.set[k]; });

  TESTS.push({
    section: spec.section, analysis: 'level', label: spec.label,
    key: key, velocity: 127, hold: TIMING.hold, gapAfter: TIMING.gap,
    setting: 0, rising: false, watch: 'level', why: spec.why
  });

  KEYGROUPS.push({ low: key, high: key, set: set, sample: spec.sample, why: spec.why });
}

/* A. One-shot. The test run 13 should have written. */
add({ section: 'one-shot N', label: 'one-shot, 0x2B = N', sample: 'HITN',
      why: 'the reference: struck and fading, exactly as the sample was written' });

add({ section: 'one-shot R', label: 'one-shot, 0x2B = R', sample: 'HITR',
      why: 'if 0x2B reverses playback this swells and stops dead instead' });

/* B. The same pair, looping - which is what run 13 tested and what PHONE 3 is. */
add({ section: 'looping N', label: 'looping, 0x2B = N', sample: 'LOOPN',
      why: 'four passes, each hitting and fading' });

add({ section: 'looping R', label: 'looping, 0x2B = R', sample: 'LOOPR',
      why: 'whether a loop is what hid the answer in run 13' });

/*
 * C. Does the machine's own envelope run forward while the audio runs backward?
 *
 * A decay of 40 with no sustain, over the reversed one-shot, and the answer is a slope.
 *
 * The sample covers 52 dB in its half second, so it moves at about 104 dB/s - down played as
 * written, up played backwards. A decay of 40 to a sustain of nothing covers SustainDb in
 * 0.17 s, about 229 dB/s down. Both are straight lines in decibels, so the product is their
 * sum and the three possibilities separate cleanly:
 *
 *     nothing reverses            -104 - 229  =  -333 dB/s   steepest fall
 *     the AUDIO reverses          +104 - 229  =  -125 dB/s   a fall, but a third as steep
 *     the WHOLE VOICE reverses                    +333 dB/s   a swell
 *
 * The middle line is the one that says the envelope generator runs forward from the strike
 * while the audio runs backwards - which is what an envelope generator does, and what nobody
 * here has checked. The third would mean the machine reverses the voice rather than the data.
 *
 * There is no bump to look for: two exponentials multiplied is a third exponential, so what
 * distinguishes them is how steeply the line falls and which way, not its shape.
 */
add({ section: 'envelope', label: 'reversed, under a VCA decay', sample: 'HITR',
      set: { 4: 40, 5: 0 },
      why: 'a forward envelope over backward audio makes a bump; anything else does not' });

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
      note: c.key, velocity: c.velocity, first: first, rising: c.rising, watch: c.watch,
      from: at, releasedAt: at + c.hold, hold: c.hold
    });

    at += c.hold;
  });

  return { events: events, clips: clips, seconds: at + TIMING.gap };
}

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, LOOPING: false, SAMPLES: SAMPLES,
  RATE: RATE, FRAMES: FRAMES, TAU: TAU,
  FROM: 99, OPEN_FROM: 99, CLOSE_FROM: 99, RELEASE_FROM: 99, AMOUNT: 0,
  schedule: schedule, keygroups: keygroups, clips: clips
};
