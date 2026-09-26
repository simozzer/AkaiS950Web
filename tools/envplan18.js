/*
 * The eighteenth run: is the crossfade independent of everything else?
 *
 *   node envdisk.js  build ENVCAL18           --plan envplan18.js
 *   node envmidi.js  AkaiEnvCalibration18.mid --plan envplan18.js
 *   node envcal.js   take.wav ENVCAL18.img    --plan envplan18.js
 *
 * WHAT RUN 17 SETTLED
 *
 * The positional crossfade, at last. Seven overlap widths from 1 key to 21 collapse onto ONE
 * curve once the position is mapped as
 *
 *     x = (i + 1) / (N + 1)        i the 0-based key in the overlap, N its width
 *
 * - seventeen places where two different widths land on the same x, and they agree to 0.00 dB
 * at every one. The apparent width-dependence in run 15 was that mapping being i/(N-1), which
 * puts the ends at 0 and 1 and is simply wrong. The curve is cos(pi x / 2) ^ 1.44 to 0.51 dB
 * over 38 points, and the mapping predicts the odd cases exactly: a one-key overlap sits at
 * x = 1/2 and splits evenly, which is the -4.5 dB measured.
 *
 * WHAT IT DID NOT SETTLE, AND WHY
 *
 * Whether that fade is independent of the rest of the voice. Run 17 answered half of it:
 * with velocity to loudness at ZERO the balance does not move across five velocities, to
 * 0.1 dB. But velocity to loudness at zero means velocity does nothing at all, so an
 * identical reading is also what a MIDI fault would produce - the section had no positive
 * control of its own and leaned on another to prove velocity was arriving.
 *
 * The section that did have one was set to a depth of 99, which spans some 74 dB, so its two
 * lowest velocities landed at -74 and -60 dB - at and under the noise floor. Two usable
 * velocities gave edge balances 3 dB apart, which is either an interaction or the limit of
 * reading a tone at -36 dB, and there is no telling which.
 *
 * SO BOTH SECTIONS HERE CARRY THEIR OWN POSITIVE CONTROL
 *
 *   H  LOUDNESS   Velocity to loudness at 40, which spans about 29 dB - every velocity well
 *                 clear of the floor, and the level visibly moving so that a silent MIDI
 *                 fault could not be mistaken for a null result. If the BALANCE between the
 *                 two keygroups holds while the level slides underneath it, the crossfade is
 *                 independent of the loudness path.
 *   I  FILTER     Velocity to filter at 50, the other path velocity drives. It belongs here
 *                 for a sharper reason than symmetry: the two tones are 1000 and 2200 Hz, so
 *                 a filter coming down past them attenuates the upper one far harder, and
 *                 the balance MUST move. The question is whether it moves by exactly what the
 *                 filter model predicts - in which case the crossfade is untouched and sits
 *                 before the filter - or by something else.
 *
 * Velocity to filter turns about velocity 65 and does nothing above it, so section I uses
 * velocities below the pivot: at 50 depth and velocity 1 the cutoff falls about 4.2 octaves
 * from 16.3 kHz to roughly 880 Hz, which is under both tones.
 *
 * AND A CONSTANT WORTH CHECKING WHILE THE DISK IS IN THE MACHINE
 *
 * Run 17's loudness section, read between its two reliable velocities, gives 0.585 dB per
 * velocity step where CAL.VEL_DB_PER_STEP says 0.63 - seven per cent, from a section that was
 * not built to measure it. Section H's two reference keys sound one keygroup alone at five
 * velocities, which measures it properly and costs nothing extra.
 */

var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var TONES = [1000, 2200];

var SAMPLES = [
  { name: 'T1', kind: 'tone', hz: TONES[0], frames: 4410, loopMode: 'L', loopLength: 4410 },
  { name: 'T2', kind: 'tone', hz: TONES[1], frames: 4410, loopMode: 'L', loopLength: 4410 }
];

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
  keys.forEach(function (key) {
    TESTS.push({
      section: section, analysis: 'mix',
      label: section + ' key ' + key + ' at ' + velocity,
      key: key, velocity: velocity, hold: TIMING.hold, gapAfter: TIMING.gap,
      setting: key, watch: 'mix', why: why
    });
  });
}

/*
 * H: the loudness path. Overlap 40-42, three keys, so x is 1/4, 1/2 and 3/4 - which run 17
 * puts at -1.2, -4.5 and -11.5 dB. Those are the numbers the balance has to keep.
 *
 * Keys 36 and 46 sound one keygroup alone. At five velocities they are both the per-velocity
 * reference the balance is read against AND the measurement of how far a velocity step moves
 * the level, which is a constant this project has at 0.63 dB and has never measured directly.
 */
keygroup(36, 42, 'T1', { 11: 40 });
keygroup(40, 46, 'T2', { 11: 40 });

[1, 32, 64, 96, 127].forEach(function (v) {
  play('H loudness', [36, 40, 41, 42, 46],
       'does the balance hold while the level slides underneath it', v);
});

/*
 * I: the filter path. Overlap 56-58, the same three positions.
 *
 * THE ZONE FILTER IS 60 HERE, NOT 99, AND THAT MATTERS.
 *
 * Velocity to filter turns about velocity 65 and shifts the cutoff in octaves from wherever
 * the zone filter puts it. From 99 the cutoff is already at the machine's ceiling, and a
 * velocity of 1 only brings it down to 3747 Hz - above both tones, so nothing moves and the
 * section would measure nothing at all. The dry run said exactly that: flat at every
 * velocity.
 *
 * From 60 the sweep lands where it is wanted: 1097 Hz at velocity 1, which is between the
 * two tones, through 2238 at velocity 32 to 4670 at 64, by which point both are well inside
 * the passband. Velocities above the pivot are left out because they do nothing from here.
 *
 * The balance MUST move here - 2200 Hz is 1.14 octaves above 1000 and a sixth-order filter
 * takes it down some 40 dB harder once the cutoff is below both. That is the point: the
 * filter's own effect is predictable from the model, so what matters is the residual after
 * it is taken out. A residual of nothing means the crossfade is untouched by the filter path
 * and sits before it.
 */
keygroup(52, 58, 'T1', { 7: 50, 44: 60 });
keygroup(56, 62, 'T2', { 7: 50, 44: 60 });

[1, 16, 32, 48, 64].forEach(function (v) {
  play('I filter', [52, 56, 57, 58, 62],
       'whether the balance moves by exactly what the filter predicts, or by more', v);
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

function overlaps() {
  return [
    { section: 'H loudness', from: 40, to: 42 },
    { section: 'I filter',   from: 56, to: 58 }
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
