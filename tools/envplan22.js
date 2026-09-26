/*
 * The twenty-second run: where a voice comes out, the last envelope stage nobody has
 * traced, and a constant that was rounded rather than measured.
 *
 *   node envdisk.js  build ENVCAL22           --plan envplan22.js
 *   node envmidi.js  AkaiEnvCalibration22.mid --plan envplan22.js
 *   node envcal.js   take.wav ENVCAL22.img    --plan envplan22.js
 *
 *   A  OUTPUT ROUTING, byte 19. The eight individual outputs are played CENTRED, which is
 *      a guess and has always been labelled one. 253 library keygroups are routed to them.
 *      If the machine drops those voices out of the main stereo pair - as many samplers of
 *      that era do - then every one of them should be silent there instead.
 *   B  THE FILTER'S ATTACK, which is the one envelope stage never traced. Run 21 measured
 *      the filter's decay and release and found both to be rates on a shared clock; the
 *      attack has only ever been assumed to match.
 *   C  WARP'S DEPTH CONSTANT. 6.25 cents per unit of byte 13 is used because it is a
 *      sixteenth of a semitone exactly. The fit gives 6.21 and cannot separate 6.0 from 6.5
 *      - and it was fitted to runs 10, 11 and 12, which at 30%, 26% and 28% pinned are the
 *      three most heavily limited takes in the whole set.
 *
 * NO CABLES ARE NEEDED IN THE INDIVIDUAL OUTPUTS
 *
 * The question section A asks is not what comes out of the MONO 1 socket. It is whether the
 * voice has LEFT the main pair, and that is read on the outputs already connected.
 *
 * Reading it as levels rather than by ear separates three answers instead of two: a voice
 * ATTENUATED into the main mix rather than removed from it sounds present and would pass a
 * listening test, and shows up here as a number.
 *
 * LEFT AND RIGHT ARE IN SECTION A AS CONTROLS, NOT AS MEASUREMENTS
 *
 * Every take in this project is mono, so it is one socket of a stereo pair or a sum of the
 * two, and which of those it is changes what section A means. LEFT and RIGHT say so
 * directly: if one reads full and the other silent, the recording is a single socket and a
 * silent MONO reading might only mean "not on this side". If both read about 3 dB down, it
 * is a sum and a silent MONO reading means the voice is genuinely gone. The controls have
 * to be in the same take as the thing they qualify.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var TONE_HZ = 1000;
var TONES = [TONE_HZ];

/*
 * The noise is one-shot and full length, because section B finds CORNERS and a corner is
 * found by dividing the clip's spectrum by the source's own - which only works while the
 * two are of the same noise. See envplan20.js, where looping it made every corner in the
 * run read the same wrong number.
 */
var SAMPLES = [
  { name: 'NOISE', kind: 'noise', frames: 132300, loopMode: 'O' },
  { name: 'TONE', kind: 'tone', hz: TONE_HZ, frames: 4410, loopMode: 'L', loopLength: 4410 }
];

/*
 * Byte 19 holds the panel's setting less one, so 0xFF is ALL, 0 to 7 are MONO 1 to 8, and
 * 8 and 9 are LEFT and RIGHT.
 */
var PORTS = [
  [0xFF, 'ALL'],
  [0, 'MONO 1'], [1, 'MONO 2'], [2, 'MONO 3'], [3, 'MONO 4'],
  [4, 'MONO 5'], [5, 'MONO 6'], [6, 'MONO 7'], [7, 'MONO 8'],
  [8, 'LEFT'], [9, 'RIGHT']
];

/// Section B, at the settings run 21 used for the decay so the two stages can be compared.
var STORED = [50, 55, 60, 65, 70, 75];
var DECAY_REF = [55, 65, 75];

/// Section C. Byte 13 is signed, and both signs are asked for because the sign is what
/// decides whether the note starts sharp and falls to pitch or starts flat and rises to it.
var WARP_DEPTHS = [-50, -40, -30, -20, -10, 10, 20, 30, 40, 50];

var FROM = 50;
var AMOUNT = 15;

var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,          // the amplitude flat and held
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  12: 0, 13: 0, 14: 0,
  15: 0, 16: 0, 17: 0,              // the LFO off - it modulates what section C measures
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  19: 0xFF,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,
  43: 0,
  44: 99, 45: 0
};

var TIMING = {
  hold: 1.0,
  gap: 0.8,          // the SHORTEST gap in the run - what the note splitter is tuned to
  sectionGap: 2.0,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var KEYGROUPS = [];

function signed(v) { return ((v % 256) + 256) % 256; }

function keygroup(low, high, sample, extra) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(extra || {}).forEach(function (k) { set[k] = extra[k]; });
  set[0] = high; set[1] = low;
  KEYGROUPS.push({ low: low, high: high, set: set, sample: sample,
                   why: sample + ' over keys ' + low + ' to ' + high });
}

function note(spec) {
  TESTS.push({
    section: spec.section, analysis: spec.analysis, label: spec.label,
    key: spec.key, velocity: spec.velocity === undefined ? 127 : spec.velocity,
    hold: spec.hold, gapAfter: spec.gapAfter,
    setting: spec.setting, rising: !!spec.rising, watch: spec.analysis, why: spec.why
  });
}

/*
 * A. WHERE A VOICE COMES OUT.
 *
 * Eleven keygroups on one tone, identical in every byte but 19, one key each, read as
 * levels against one another. ALL is the reference the rest are measured from.
 */
var keyA = 24;
PORTS.forEach(function (p) {
  // The mix table prints `setting` in its leftmost column, so it carries the PANEL number
  // rather than the key: 0 for ALL, 1 to 8 for the individual outputs, 9 and 10 for LEFT
  // and RIGHT. That is the scale on the front of the machine, and byte 19 is one less.
  keygroup(keyA, keyA, 'TONE', { 19: p[0] });
  note({ section: 'output', analysis: 'mix', label: p[1],
         key: keyA, hold: 1.0, gapAfter: 0.8,
         setting: p[0] === 0xFF ? 0 : p[0] + 1,
         why: p[1] === 'ALL' ? 'the reference every other routing is read against'
            : /MONO/.test(p[1]) ? 'does an individual output leave the main pair, or not?'
            : 'a control: what this recording does with one side of the stereo pair' });
  keyA++;
});

/*
 * B. THE FILTER'S ATTACK - the last envelope stage nobody has traced.
 *
 * VCF sustain 99 so the envelope goes up and stays up, and the amplitude held dead flat
 * underneath it, exactly as run 21 held it for the decay. The cutoff RISES from the base to
 * base plus the amount, which is why these clips are marked rising: the trajectory analysis
 * normalises a sweep as a fraction of its own travel and would otherwise fit it backwards.
 *
 * The same six settings run 21 used for the decay, so the two stages can be set against
 * each other - and three decay clips repeated here as well, because comparing across takes
 * is what made VCF_TIME_SCALE a guess for so long. Those three carry the comparison; the
 * rest of the ladder says whether the attack reads the same ENV_TIME curve.
 */
var keyB = 40;
STORED.forEach(function (s) {
  keygroup(keyB, keyB, 'NOISE', { 44: FROM, 23: AMOUNT, 34: s, 36: 99 });
  note({ section: 'vcf attack', analysis: 'trajectory', label: 'VCF attack ' + s,
         key: keyB, hold: 2.5, gapAfter: 1.0, setting: s, rising: true,
         why: 'the one envelope stage that has only ever been assumed' });
  keyB++;
});

var keyB2 = 48;
DECAY_REF.forEach(function (s) {
  keygroup(keyB2, keyB2, 'NOISE', { 44: FROM, 23: AMOUNT, 35: s, 36: 0 });
  note({ section: 'vcf decay', analysis: 'trajectory', label: 'VCF decay ' + s,
         key: keyB2, hold: 2.5, gapAfter: 1.0, setting: s,
         why: 'run 21 repeated in this take, so the attack is compared within one recording' });
  keyB2++;
});

/*
 * C. WARP'S DEPTH, ON A TAKE THAT IS NOT BEING LIMITED.
 *
 * Byte 13 is the depth and it is signed; byte 12 is left at 0, which means "always full
 * depth" rather than "no depth", so velocity does not come into it. Byte 14 is the time
 * constant, at 50 - long enough to see the bend decay and short enough to be over well
 * inside the note.
 *
 * Ten depths rather than the three the constant was fitted to. 6.25 cents a unit puts the
 * deepest of them at 312 cents, where 6.0 would put it at 300 and 6.5 at 325 - so the
 * question is whether the slope can be pinned to better than four per cent, and the answer
 * depends mostly on the take. Runs 10, 11 and 12 had 30%, 26% and 28% of their samples
 * pinned against a limiter, which is the worst in the whole project, and pitch is measured
 * by counting zero crossings on a tone that the limiter is flattening.
 *
 * Both signs, because the sign decides whether the note starts sharp and falls to pitch or
 * starts flat and rises to it, and a slope fitted through zero from one side only would not
 * notice an offset.
 *
 * THIS SECTION HAS NO NEGATIVE CONTROL, and it is worth knowing which way that cuts.
 * envrender.js resamples each clip at one fixed rate, so it cannot produce a pitch that
 * moves and reads every one of these clips as dead flat - the same blind spot it has for
 * overlapping keygroups, which it does not layer. The disk is right: its keygroups carry
 * warpDepth -50 through +50 with warpTime 50, read straight back off the image.
 *
 * So a flat reading here from the HARDWARE would mean something has gone wrong with the
 * disk or the machine, and cannot be checked against a render that is flat by construction.
 * The pitch analysis itself was validated against hardware in runs 10 to 12; what those
 * runs could not do is measure through a limiter, which is the only thing this section
 * changes.
 */
var keyC = 56;
WARP_DEPTHS.forEach(function (d) {
  keygroup(keyC, keyC, 'TONE', { 12: 0, 13: signed(d), 14: 50 });
  note({ section: 'warp', analysis: 'pitch', label: 'depth ' + (d > 0 ? '+' : '') + d,
         key: keyC, hold: 4.0, gapAfter: 2.0, setting: d,
         why: 'the cents a unit of byte 13 is worth, on audio that is not being flattened' });
  keyC++;
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
      note: c.key, velocity: c.velocity, first: first, rising: c.rising, watch: c.watch,
      from: at, releasedAt: at + c.hold, hold: c.hold, gapAfter: c.gapAfter
    });

    at += c.hold;
  });

  return { events: events, clips: clips, seconds: at + 3.0 };
}

/// Section A has no overlapping keygroups, so there is nothing to fade and nothing to map.
function overlaps() { return []; }

function keygroups() { return KEYGROUPS; }
function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE, LOOPING: false, SAMPLES: SAMPLES,
  TONES: TONES, TONE_HZ: TONE_HZ, overlaps: overlaps,
  PORTS: PORTS, STORED: STORED, WARP_DEPTHS: WARP_DEPTHS,
  FROM: FROM, OPEN_FROM: FROM, CLOSE_FROM: FROM, RELEASE_FROM: FROM, AMOUNT: AMOUNT,
  schedule: schedule, keygroups: keygroups, clips: clips
};
