/*
 * The LFO calibration run, described once.
 *
 * The disk, the MIDI file and the analysis are all generated from this, so the three
 * cannot drift apart - which matters more here than it did for the filter, because the
 * analysis identifies a clip by where it falls in the take and by nothing else.
 *
 * WHAT IS BEING SETTLED
 *
 * Nothing yet. A keygroup stores an LFO as three numbers - delay (byte 15), rate (16)
 * and depth (17) - plus a desync flag and two bytes saying how far the modwheel and
 * aftertouch may add to the depth. Every one of them is 0..99 and none of them is in any
 * unit. The emulation has no LFO at all, and writing one from guesses would stand five
 * more invented constants next to the filter's measured ones. So: play known settings
 * into a recorder, measure what came back, and let the numbers come from the machine.
 *
 * WHY IT IS ALL ONE PROGRAMME, AGAIN
 *
 * Same reason as benchplan.js: Ableton Live will not carry program change in a clip, so
 * every test is a keygroup of one programme - LFOCAL - on its own key. Changing test
 * means playing a different note.
 *
 * WHY A TONE AND NOT NOISE
 *
 * The filter run measures a spectrum, so noise was the ideal source. An LFO moves pitch,
 * and noise has none. These clips play a steady looped tone instead - a sawtooth for the
 * ladders, because its harmonics are strong and evenly spaced, and a sine and a pulse as
 * cross-checks so that a reading which depends on the timbre shows itself as one.
 *
 * WHY EVERY CLIP IS A DIFFERENT PITCH
 *
 * The first version of this run transposed each zone back towards the root, so that every
 * clip sounded at the same 250 Hz whichever key it was on. It seemed tidy. It ruined a
 * take: the first recording came back with 25 of its 26 clips at the wrong pitch, some of
 * them three octaves out and aliasing badly, and the only clip that played what it was
 * asked to play was the one on the root key, whose transpose was zero.
 *
 * The library never asks for more than it has to: across 3816 zones the transpose spans
 * -4 to +3, and it is zero in 3416 of them. This run was asking for -14 to +14, which is
 * outside anything the corpus demonstrates, and the machine evidently does something
 * drastic with it - the two clips clean enough to read were both at exactly three octaves
 * from where the key alone would have put them, which is a sampler hitting its stop.
 *
 * So the transpose is zero everywhere now and every clip simply sounds at its own key's
 * pitch. The measurement never needed them to match: a depth in cents and a rate in hertz
 * are both ratios, and the analysis is told what each clip should sound at. The tone is
 * 400 Hz rather than 250 so that the spread across the keys lands between 140 Hz and 540,
 * which is high enough for the tracker to follow a fast LFO and low enough not to alias.
 */

var VEL = 100;
var TONE_HZ = 400;          // the pitch the tone is recorded at, on the root key
var ROOT = 60;              // the pitch the tone samples are recorded at
var FIRST_KEY = 42;         // keys run upward from here, one per keygroup

/*
 * Keygroup bytes, by offset. 43/44/45 sit inside zone 1's span but belong to the
 * keygroup as far as this run is concerned.
 *
 *    3..6  VCA attack / decay / sustain / release      7  vel -> filter
 *       8  key -> filter          9  vel -> attack    10  vel -> release
 *      11  vel -> loudness       15  LFO delay        16  LFO rate
 *      17  LFO depth             18  flags            21  LFO depth -> aftertouch
 *      22  LFO depth -> modwheel 23  VCF amount       43  zone 1 transpose
 *      44  zone 1 filter         45  zone 1 loudness
 */
var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04, FLAG_ONE_SHOT = 0x08;

/*
 * What every keygroup starts from, so that a clip differs from its neighbours in exactly
 * the setting its test is about.
 *
 * The gate is flat - instant attack, no decay, full sustain, no release - so the tone
 * holds steady for the whole note and a wobble in the level can only have come from the
 * LFO. The filter is wide open with an envelope amount of nothing, so it cannot colour
 * the tone as the pitch moves past it. Velocity drives nothing.
 *
 * Desync is on, which is both the library's common case - 1652 keygroups of 1908 - and
 * the one that makes a single note easiest to read: if each voice runs its own LFO then
 * a note starts it, and the delay measurement has a known zero. The desync section is
 * where that assumption gets tested rather than relied on.
 */
var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  15: 0, 16: 60, 17: 0,
  18: FLAG_DESYNC,
  21: 0, 22: 0,
  23: 0,
  43: 0,                     // no transpose: see the note at the top
  44: 99, 45: 0
};

// The rate the other ladders sit at when rate is not the thing being measured. High
// enough that a five-second clip holds plenty of cycles, low enough to be nowhere near
// wherever a vibrato stops sounding like one.
var MID_RATE = 60;

var TIMING = {
  lead: 2.0,              // silence at the very start
  gap: 1.5,               // between clips - there is no release to outlast
  sectionGap: 3.0,        // a longer pause where a section starts, visible in a take
  channel: 0              // MIDI channel 1
};

// ------------------------------------------------------------------ the tests

var TESTS = [];
var nextKey = FIRST_KEY;

/**
 * One test: one keygroup on its own key, and usually one clip.
 *
 * `set` overrides BASE. `hold` is how long the note is held, which varies a great deal:
 * a clip has to be long enough to hold several cycles of whatever it measures, and the
 * slowest rate on the ladder may take ten seconds to show two.
 *
 * `clip: false` builds the keygroup without giving it a clip of its own - the upper
 * voice of a desync pair is played as part of the lower voice's clip.
 *
 * `key` places the keygroup somewhere other than the next free key, which the desync
 * pairs need: their two voices have to be exactly two octaves apart.
 */
function test(spec) {
  var key = spec.key === undefined ? nextKey++ : spec.key;
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(spec.set || {}).forEach(function (k) { set[k] = spec.set[k]; });

  TESTS.push({
    section: spec.section, analysis: spec.analysis, label: spec.label,
    sample: spec.sample || 'SAW', key: key, velocity: VEL,
    hold: spec.hold || 0, set: set, why: spec.why, setting: spec.setting,
    cc: spec.cc || null, pairWith: spec.pairWith === undefined ? null : spec.pairWith,
    stagger: spec.stagger || 0,
    sounds: TONE_HZ * Math.pow(2, (key - ROOT) / 12),
    hasClip: spec.clip !== false
  });
  return key;
}

/* --- the rate ladder -------------------------------------------------------
 *
 * Depth is held at 50 rather than 99: enough movement to read easily, far enough from
 * the top of the range that if depth saturates the reading does not go with it.
 *
 * The two slowest settings get twelve seconds instead of six. If rate 0 turns out to
 * mean "stopped" that is twelve seconds wasted; if it means one cycle every eight
 * seconds then six would have measured nothing at all, and there is no way to know
 * which before the take.
 */
[0, 10, 25, 40, 55, 70, 85, 99].forEach(function (r) {
  test({
    section: 'rate ladder', analysis: 'rate', label: 'rate ' + r, setting: r,
    hold: r <= 10 ? 12 : 6,
    set: { 16: r, 17: 50 },
    why: 'rate ladder, ' + r
  });
});

/* --- the depth ladder ------------------------------------------------------
 *
 * Depth 0 is the control and the reference both: it is the clip that says what the
 * unmodulated pitch is, so the others can be read as a deviation from that rather than
 * from their own average - which would hide an LFO that bends pitch only one way.
 */
[0, 20, 40, 60, 80, 99].forEach(function (d) {
  test({
    section: 'depth ladder', analysis: 'depth', label: 'depth ' + d, setting: d,
    hold: 5,
    set: { 16: MID_RATE, 17: d },
    why: 'depth ladder, ' + d
  });
});

/* --- the delay ladder ------------------------------------------------------
 *
 * Twelve seconds each, because the whole question is how long the machine waits and a
 * clip has to outlast the answer. Delay 0 keeps its place as the section's own
 * reference: it costs five seconds, and it means the section can be recognised without
 * trusting the clip count of everything before it.
 */
[0, 25, 50, 75, 99].forEach(function (d) {
  test({
    section: 'delay ladder', analysis: 'delay', label: 'delay ' + d, setting: d,
    hold: d === 0 ? 5 : 12,
    set: { 15: d, 16: MID_RATE, 17: 99 },
    why: 'delay ladder, ' + d
  });
});

/* --- the shape -------------------------------------------------------------
 *
 * A slow, deep wobble, held long enough to average a dozen cycles of it - which is what
 * it takes to say whether the LFO is a sine, a triangle, or something with corners.
 * Nothing else in the run can answer that: at six cycles a second the shape is lost in
 * whatever the tracker's own smoothing does to it.
 */
test({
  section: 'shape', analysis: 'shape', label: 'slow and deep',
  hold: 16, set: { 16: 10, 17: 99 },
  why: 'the LFO waveform, slowly enough to see it'
});

/* --- what the LFO actually moves -------------------------------------------
 *
 * Assuming it is vibrato and then measuring only the pitch would find pitch modulation
 * whether or not that is all there is. A sine has one partial and no shape to hide
 * behind, so a level that wobbles along with the pitch shows up plainly beside it.
 */
test({
  section: 'what it moves', analysis: 'what', label: 'sine, full depth',
  sample: 'SINE', hold: 5, set: { 16: MID_RATE, 17: 99 },
  why: 'pitch or level: a sine says which'
});

/* --- the same setting through a different timbre ---------------------------
 *
 * Depth 50 on a pulse should read exactly what depth 50 on the sawtooth read. If it
 * does not, the disagreement is in the measurement rather than in the machine, and
 * every number in the report is worth less than it looks.
 */
test({
  section: 'timbre check', analysis: 'timbre', label: 'pulse, depth 60', setting: 60,
  sample: 'PULSE', hold: 5, set: { 16: MID_RATE, 17: 60 },
  why: 'depth 60 again, on a different waveform'
});

/* --- the modwheel ----------------------------------------------------------
 *
 * Byte 22 is 50 by default and 427 of the library's 1908 keygroups change it, so an
 * emulation that ignores it is wrong about a fifth of the time anyone touches a wheel.
 *
 * The keygroup's own depth is zero here, so everything heard was added by the wheel.
 * One long note with the wheel climbing in steps gives the whole curve in a single
 * clip; the second clip repeats the top of it at the default 50, which says whether
 * byte 22 scales the depth proportionally or does something less obliging.
 */
var wheelSteps = [];
for (var i = 0; i <= 8; i++) wheelSteps.push({ at: 0.2 + i * 1.3, value: Math.min(127, i * 16) });

test({
  section: 'modwheel', analysis: 'wheel', label: 'wheel 0..127 at depth->wheel 99',
  hold: 12, set: { 16: MID_RATE, 17: 0, 22: 99 }, cc: wheelSteps,
  why: 'the wheel adds depth: how much, across its travel'
});
test({
  section: 'modwheel', analysis: 'wheelhalf', label: 'wheel 127 at depth->wheel 50',
  setting: 50, hold: 5, set: { 16: MID_RATE, 17: 0, 22: 50 },
  cc: [{ at: 0, value: 127 }],
  why: 'the same wheel at the default byte 22, for the shape of that law'
});

/* --- desync ----------------------------------------------------------------
 *
 * The flag is set in 1652 keygroups of 1908, so whatever it does is the normal case and
 * the emulation has to get it right. The guess is that it gives each voice its own LFO
 * instead of sharing one across the programme - which is testable: start two notes a
 * second and a half apart and see whether their wobbles line up.
 *
 * The two notes are two octaves apart, which is not for the ear: the tracker isolates one
 * tone by averaging over exactly one period of it, and that puts a null on every multiple
 * of its own frequency, so two octaves up lands the second voice exactly on one of them.
 * Twenty-four keys apart gives that interval exactly, with no tuning of any kind - which
 * is what the first version of this run used a zone transpose for, and should not have.
 *
 * This is the speculative part of the run. If the two voices turn out to be
 * indistinguishable it settles nothing, and the report says so rather than fitting a
 * number to noise.
 */
[{ flag: 0, name: 'desync off' }, { flag: FLAG_DESYNC, name: 'desync on' }].forEach(function (v) {
  // The lower voice takes the next free key and the upper one sits two octaves above it,
  // clear of everything else. Both keys are worked out here rather than as they are handed
  // out, so the clip can name its partner before the partner exists.
  var lower = nextKey++, upper = lower + 24;

  test({
    section: 'desync', analysis: 'desync', label: v.name, key: lower,
    sample: 'SINE', hold: 8, stagger: 1.5, pairWith: upper,
    set: { 16: MID_RATE, 17: 99, 18: v.flag },
    why: v.name + ': the lower of two voices, started first'
  });

  test({
    section: 'desync', analysis: 'desyncpair', label: v.name + ', upper voice', key: upper,
    sample: 'SINE', clip: false,
    set: { 16: MID_RATE, 17: 99, 18: v.flag },
    why: v.name + ': the upper of two voices, two octaves up'
  });
});

// ------------------------------------------------------------------ the walk

/**
 * The running order, as times.
 *
 * Both the MIDI file and the analysis come from this one walk, so the file cannot say
 * one thing while the analysis expects another. A clip's window runs from its note-on
 * to the last note-off it contains - for a desync pair that is the second voice's.
 */
function schedule() {
  var events = [{ at: 0, kind: 'cc', controller: 1, value: 0 }];
  var clips = [];
  var at = TIMING.lead;
  var section = null;

  TESTS.forEach(function (c) {
    if (!c.hasClip) return;

    var first = c.section !== section;
    if (clips.length) at += first ? TIMING.sectionGap : TIMING.gap;
    section = c.section;

    var from = at;
    events.push({ at: at, kind: 'on', note: c.key, velocity: c.velocity });

    (c.cc || []).forEach(function (p) {
      events.push({ at: at + p.at, kind: 'cc', controller: 1, value: p.value });
    });

    if (c.pairWith !== null) {
      events.push({ at: at + c.stagger, kind: 'on', note: c.pairWith, velocity: c.velocity });
      events.push({ at: at + c.stagger + c.hold, kind: 'off', note: c.pairWith });
    }

    events.push({ at: at + c.hold, kind: 'off', note: c.key });

    var to = at + c.hold + (c.pairWith !== null ? c.stagger : 0);

    // Leave the wheel where it was found. Everything after a wheel clip would otherwise
    // carry whatever the ramp ended on, and byte 22 is zero elsewhere only because this
    // run sets it so - a hand left on the wheel is exactly the kind of thing that ruins
    // a take quietly.
    if (c.cc) events.push({ at: to + 0.05, kind: 'cc', controller: 1, value: 0 });

    clips.push({
      section: c.section, analysis: c.analysis, label: c.label, setting: c.setting,
      sample: c.sample, note: c.key, velocity: c.velocity, hold: c.hold,
      first: first, from: from, to: to, sounds: c.sounds,
      pairWith: c.pairWith, stagger: c.stagger, cc: c.cc
    });

    at = to;
  });

  events.sort(function (a, b) { return a.at - b.at; });
  return { events: events, clips: clips, seconds: at + 1.0 };
}

/** Every keygroup the programme needs, in the order it needs them. */
function keygroups() {
  return TESTS.map(function (t) {
    return { key: t.key, sample: t.sample, set: t.set, why: t.why };
  });
}

function clips() { return schedule().clips; }

/** The distinct samples the run plays, in the order they are first asked for. */
function samplesUsed() {
  var seen = [];
  TESTS.forEach(function (t) { if (seen.indexOf(t.sample) < 0) seen.push(t.sample); });
  return seen;
}

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE,
  TONE_HZ: TONE_HZ, ROOT: ROOT, VEL: VEL, MID_RATE: MID_RATE,
  FLAG_CONSTANT_PITCH: FLAG_CONSTANT_PITCH, FLAG_DESYNC: FLAG_DESYNC,
  FLAG_ONE_SHOT: FLAG_ONE_SHOT,
  schedule: schedule, clips: clips, keygroups: keygroups, samplesUsed: samplesUsed
};
