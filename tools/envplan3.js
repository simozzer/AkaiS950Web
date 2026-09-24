/*
 * The third filter run: what SHAPE the envelope falls in, and inversion where it shows.
 *
 *   node envdisk.js  build ENVCAL3          --plan envplan3.js
 *   node envmidi.js  AkaiEnvCalibration3.mid --plan envplan3.js
 *   node envcal.js   take.wav ENVCAL3.img    --plan envplan3.js
 *
 * WHY A THIRD RUN
 *
 * The depth is settled: 8.3 octaves at full amount, straight, and symmetric to 1%. What is
 * not settled is the SHAPE of the fall, and that turned out to matter more than it sounds.
 *
 * The release measurements from run 2 disagreed with run 1 by two and a half times for the
 * same stored value. That is not scatter. Both runs turned "when did the sweep pass this
 * frequency" into a release time by assuming the envelope falls in a straight line in
 * octaves - and if it does not, two sweeps of different depths convert differently and
 * disagree by exactly this sort of factor. So the disagreement is itself evidence about the
 * shape, and the shape is what this run measures.
 *
 * HOW, WITHOUT ASSUMING THE ANSWER
 *
 * If the cutoff falls in a straight line in octaves, then the moment it passes any frequency
 * is a straight-line function of the logarithm of that frequency. So: watch a handful of
 * fixed frequencies, note when the response at each drops 3 dB, and see whether those times
 * lie on a line against log frequency. Straight means linear in octaves; curved means it is
 * something else, and which way it curves says what.
 *
 * That needs neither the start nor the end of the sweep, which is the point - both of those
 * are hard to measure while the thing is moving, and both were where the earlier attempts
 * came unstuck.
 *
 * THREE BANDS, NOT ONE
 *
 * A sweep watched only between 2.5 and 8 kHz tells you the shape between 2.5 and 8 kHz.
 * That is where the measurement is easiest - a twelfth of a second has plenty of cycles up
 * there - and it is not where the question lives. If the envelope generator is doing the
 * curving then the shape is the same everywhere; if the FILTER is doing it, the low end will
 * differ, because that is where its own floor is.
 *
 * So the same decay is swept three times, low, middle and high, each with its own probes
 * sitting inside its own range. Comparing the three answers a question one of them cannot.
 */

var VEL = 100;
var FLAG_CONSTANT_PITCH = 0x01, FLAG_DESYNC = 0x04;

var BASE = {
  3: 0, 4: 0, 5: 99, 6: 0,
  7: 0, 8: 0, 9: 0, 10: 0, 11: 0,
  15: 0, 16: 0, 17: 0,
  18: FLAG_CONSTANT_PITCH | FLAG_DESYNC,
  21: 0, 22: 0,
  23: 0,
  34: 0, 35: 99, 36: 99, 37: 0,
  43: 0,
  44: 99, 45: 0
};

/*
 * Stored 50 - measured at 2210 Hz - for everything here.
 *
 * It is the one setting with room in both directions: 2.88 octaves to the ceiling and 2.83
 * to the floor. A positive amount can open without hitting the stop and a negative one can
 * close without hitting the floor, which is what "a programme where inversion is meaningful"
 * comes down to. The library's own three negative keygroups sit at 332 Hz and invert into
 * the floor, moving a tenth of an octave and proving nothing.
 */
var FROM = 50;

/*
 * Amounts, the same magnitudes each way, stopping where the headroom does.
 *
 * At the measured 8.3 octaves an amount of 16 is 2.66 octaves - inside both stops with a
 * little to spare. Four points each way is enough to see a line and to catch the dead zone
 * near zero that run 1 found.
 */
var AMOUNTS = [4, 8, 12, 16];

/*
 * The three bands a sweep is read in, each with probes inside its own range.
 *
 * The amounts are chosen so each sweep spans about one and a half octaves and stops clear of
 * both stops: at the measured 8.3 octaves an amount of 8 is 1.33 octaves, 12 is 1.99 and 9
 * is 1.49. The probes are plain frequencies, evenly spaced in log, so that "are the crossings
 * evenly spaced in time" is the whole of the linearity test.
 *
 * The low band is the interesting one and the hardest. 544 Hz needs a longer window to
 * measure than 8 kHz does, so its crossings will be coarser - but it is the only place the
 * filter's own floor could bend the shape, which is exactly what needs ruling in or out.
 */
/*
 * Every probe sits a third of an octave clear of both ends of its own sweep.
 *
 * A probe close to where the sweep comes to rest never really crosses: it settles a couple
 * of decibels down and hovers there, so the -3 dB point lands wherever the noise puts it.
 * One at 2700 Hz, against a sweep resting at 2210, read 1.69 s where the line said 1.24.
 * A probe close to where the sweep STARTS has the same trouble at the other end.
 *
 * Sweep, rest and the range the probes may occupy, at the measured 8.3 octaves:
 *
 *     low      1367 -> 544     probes 1090..680
 *     middle   8790 -> 2210    probes 6990..2780
 *     high    13430 -> 4779    probes 10600..6010
 */
var BANDS = [
  { name: 'low',    filter: 30, amount:  8,
    probes: [1080, 1000, 930, 860, 800, 740, 690],
    why: 'near the floor, where the filter itself might bend the shape' },

  { name: 'middle', filter: 50, amount: 12,
    probes: [6950, 6200, 5550, 4950, 4400, 3950, 3500, 3150, 2820],
    why: 'the easy band, where the measurement is most trustworthy' },

  { name: 'high',   filter: 60, amount:  9,
    probes: [10600, 9900, 9200, 8600, 8000, 7450, 6950, 6450, 6010],
    why: 'near the ceiling, the other end of the travel' }
];

/*
 * The decays whose shape is being read, in the middle band.
 *
 * Slow enough to cross the probes with room between the crossings and short enough to finish
 * inside a three-second sample. Under the model these are 0.89, 1.41 and 2.24 seconds; if
 * the time scale is wrong these say so too, because a line fitted to the crossings gives the
 * rate whether or not the model expected it.
 */
var DECAYS = [70, 75];

/*
 * And the same shape on the way up.
 *
 * With a negative amount the envelope starts BELOW the keygroup's own cutoff and climbs back
 * to it as the envelope falls away - the same movement inverted. If the shape belongs to the
 * envelope generator then these curve the same way as the downward ones; if they do not, it
 * is the filter doing it rather than the envelope.
 */
var UP_DECAYS = [75, 80];

/*
 * Releases, timed the same way as the decays so the two can be compared directly.
 *
 * This is the question run 2 could not answer. Held open by a long decay, then let go, with
 * the amplitude given a long release so there is still a note to measure while the filter
 * moves.
 */
var RELEASES = [50, 60, 70, 80];

var TIMING = {
  hold: 3.0,
  releaseHold: 1.0,
  gap: 2.5,
  sectionGap: 4.0,
  lead: 1.0,
  channel: 0
};

var TESTS = [];
var nextKey = 36;

function test(spec) {
  var set = {};
  Object.keys(BASE).forEach(function (k) { set[k] = BASE[k]; });
  Object.keys(spec.set || {}).forEach(function (k) { set[k] = spec.set[k]; });

  TESTS.push({
    section: spec.section, analysis: spec.analysis, label: spec.label,
    key: nextKey++, velocity: VEL, hold: spec.hold || TIMING.hold,
    set: set, why: spec.why, setting: spec.setting,
    rising: spec.rising === true, probes: spec.probes || null
  });
}

/*
 * 1 and 2. The amounts, held open so the corner stands still.
 *
 * A negative amount is written as the two's complement of the byte.
 */
AMOUNTS.forEach(function (a) {
  test({
    section: 'opening', analysis: 'opening', label: 'amount +' + a, setting: a,
    set: { 44: FROM, 23: a },
    why: 'depth upward, from a base with room above it'
  });
});

AMOUNTS.forEach(function (a) {
  test({
    section: 'closing', analysis: 'closing', label: 'amount -' + a, setting: -a,
    set: { 44: FROM, 23: (256 - a) & 0xFF },
    why: 'depth downward, from the same base with room below it'
  });
});

/*
 * 3. The shape of the fall, the same decay read in three bands.
 *
 * Sustain at nothing, so the envelope runs its whole way rather than stopping part-down.
 */
BANDS.forEach(function (b) {
  test({
    section: 'falling', analysis: 'shape', label: b.name + ' band', setting: 80,
    probes: b.probes,
    set: { 44: b.filter, 23: b.amount, 34: 0, 35: 80, 36: 0, 37: 0 },
    why: b.why
  });
});

/*
 * 4. Two more decays in the middle band, for the rate as well as the shape.
 */
DECAYS.forEach(function (d) {
  test({
    section: 'falling', analysis: 'shape', label: 'middle, decay ' + d, setting: d,
    probes: BANDS[1].probes,
    set: { 44: BANDS[1].filter, 23: BANDS[1].amount, 34: 0, 35: d, 36: 0, 37: 0 },
    why: 'the rate, from a line fitted to the crossings'
  });
});

/*
 * 5. The same shape inverted - the cutoff climbing back to the keygroup's own setting.
 *
 * Based high, because an inverted envelope starts BELOW the keygroup's cutoff and needs room
 * underneath. From stored 60 an amount of -9 starts at 1.5 octaves down, which is 1700 Hz,
 * and climbs back to 4779 - straight through the middle band's probes.
 */
UP_DECAYS.forEach(function (d) {
  test({
    section: 'rising', analysis: 'shape', label: 'inverted, decay ' + d, setting: d,
    // 1700 -> 4779 on the way up, so the probes live between 2150 and 3800
    rising: true, probes: [2150, 2400, 2700, 3000, 3350, 3800],
    set: { 44: 60, 23: (256 - 9) & 0xFF, 34: 0, 35: d, 36: 0, 37: 0 },
    why: 'whether an inverted envelope has the same shape'
  });
});

/*
 * 5. The release, read the same way as the decays so the two are comparable.
 */
RELEASES.forEach(function (r) {
  test({
    section: 'release', analysis: 'shape', label: 'release ' + r, setting: r,
    hold: TIMING.releaseHold, probes: BANDS[1].probes,
    set: { 44: FROM, 23: 12, 34: 0, 35: 99, 36: 99, 37: r, 6: 80 },
    why: 'the release, on the same footing as the decay'
  });
});

function schedule() {
  var events = [];
  var clips = [];
  var at = TIMING.lead;
  var section = null;

  TESTS.forEach(function (c) {
    var first = c.section !== section;
    if (clips.length) at += first ? TIMING.sectionGap : TIMING.gap;
    section = c.section;

    events.push({ at: at, kind: 'on', note: c.key, velocity: c.velocity });
    events.push({ at: at + c.hold, kind: 'off', note: c.key });

    clips.push({
      section: c.section, analysis: c.analysis, label: c.label, setting: c.setting,
      note: c.key, velocity: c.velocity, first: first, rising: c.rising,
      probes: c.probes,
      from: at, releasedAt: at + c.hold, hold: c.hold
    });

    at += c.hold;
  });

  return { events: events, clips: clips, seconds: at + TIMING.gap };
}

function keygroups() {
  return TESTS.map(function (c) {
    return { low: c.key, high: c.key, set: c.set, why: c.why, sample: 'NOISE' };
  });
}

function clips() { return schedule().clips; }

module.exports = {
  TESTS: TESTS, TIMING: TIMING, BASE: BASE,
  FROM: FROM, OPEN_FROM: FROM, CLOSE_FROM: FROM, RELEASE_FROM: FROM,
  AMOUNTS: AMOUNTS, DECAYS: DECAYS, RELEASES: RELEASES, BANDS: BANDS,
  schedule: schedule, keygroups: keygroups, clips: clips
};
