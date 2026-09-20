/*
 * The calibration run, described once.
 *
 * Both the MIDI file and the analysis are generated from this, so the running order they
 * assume cannot drift apart - which matters, because the analysis identifies each clip by
 * its position in the take and nothing else.
 *
 * WHY IT IS ALL ONE PROGRAMME
 *
 * The obvious arrangement is one programme per test, selected by MIDI program change.
 * Ableton Live will not carry that: its clips hold notes, velocity and CC, and program
 * change is a per-track I/O setting rather than clip data, so an imported file arrives
 * with the notes and none of the switching. Rather than fight it, every test lives in a
 * single programme - CALIB - as its own keygroup on its own key. Changing test then means
 * playing a different note, which every sequencer in the world can do.
 *
 * The only manual step left is selecting CALIB on the sampler once.
 */

var VEL = 100;

var SECTIONS = [
  {
    name: 'filter ladder',
    settles: 'MIN_HZ - the bottom of the filter sweep',
    analysis: 'ladder',
    clips: [
      { note: 24, velocity: VEL, label: 'filter 0',  filter: 0 },
      { note: 26, velocity: VEL, label: 'filter 20', filter: 20 },
      { note: 28, velocity: VEL, label: 'filter 40', filter: 40 },
      { note: 30, velocity: VEL, label: 'filter 60', filter: 60 },
      { note: 32, velocity: VEL, label: 'filter 80', filter: 80 },
      { note: 34, velocity: VEL, label: 'filter 99', filter: 99 }
    ]
  },
  {
    name: 'key tracking',
    settles: 'KEY_FULL - what keyToFilter 50 means',
    analysis: 'keytrack',
    // one keygroup spanning 60..96, so these three notes differ only by the key
    clips: [
      { note: 60, velocity: VEL, label: 'C3' },
      { note: 72, velocity: VEL, label: 'C4' },
      { note: 84, velocity: VEL, label: 'C5' }
    ]
  },
  {
    name: 'filter envelope',
    settles: 'ENV_OCTAVES and the envelope time scale',
    analysis: 'filterenv',
    // Two amounts, not one. The first attempt used a base of 20, which the ladder has
    // since shown sits on the 311 Hz floor - so the sweep had nowhere to land and the
    // trace was noise. Base 40 is 1144 Hz, clear of both stops. Half amount as well as
    // full, so the depth can be checked for linearity rather than assumed, and so that
    // if full amount slams into the ceiling there is still a usable measurement.
    clips: [
      { note: 38, velocity: VEL, label: 'amount 25' },
      { note: 40, velocity: VEL, label: 'amount 50' }
    ]
  },
  {
    name: 'amplitude envelope',
    settles: 'the time scale, from the VCA side',
    analysis: 'vcaenv',
    clips: [{ note: 42, velocity: VEL, label: 'decay' }]
  },
  {
    name: 'velocity to filter',
    settles: 'VEL_OCTAVES',
    analysis: 'velocity',
    clips: [
      { note: 44, velocity: 20,  label: 'soft' },
      { note: 44, velocity: 70,  label: 'medium' },
      { note: 44, velocity: 120, label: 'hard' }
    ]
  },

  // The level side, which is where the model is weakest: sustain is treated as a plain
  // amplitude fraction on no evidence, and zone loudness is ignored altogether. These
  // need only the loudness of each clip, not its spectrum, so they are cheap to measure
  // - but they vary in 38-49% of the library's keygroups, so they matter.
  //
  // Note 46 is the reference the other level clips are read against: everything neutral,
  // filter wide open, a flat gate at full sustain.
  {
    name: 'levels',
    settles: 'what sustain and zone loudness mean in dB',
    analysis: 'levels',
    clips: [
      { note: 46, velocity: VEL, label: 'reference' },
      { note: 48, velocity: VEL, label: 'sustain 50' },
      { note: 52, velocity: VEL, label: 'zone loudness +20' }
    ]
  },

  {
    name: 'velocity to loudness',
    settles: 'how velocity scales the level at velToLoudness 99',
    analysis: 'velloud',
    clips: [
      { note: 50, velocity: 20,  label: 'soft' },
      { note: 50, velocity: 70,  label: 'medium' },
      { note: 50, velocity: 120, label: 'hard' }
    ]
  },

  // vel->release is left out on purpose: 1936 of the library's 1956 keygroups leave it
  // at zero, so modelling it would be effort spent on 1% of cases. vel->attack varies in
  // only 8% and is left out too, but the plain attack time is worth one clip since the
  // same scale governs every envelope on the machine.
  {
    name: 'attack time',
    settles: 'the envelope time scale, from the attack side',
    analysis: 'attack',
    clips: [{ note: 54, velocity: VEL, label: 'attack 70' }]
  }
];

/**
 * The keygroups CALIB needs, one per key or key range. `set` is keygroup byte offsets:
 *   0/1 high/low key   3..6 VCA A/D/S/R   7 vel->filter   8 key->filter
 *   23 VCF amount      34..37 VCF A/D/S/R                 44 zone 1 filter
 */
var KEYGROUPS = [
  { low: 24, high: 24, set: { 44: 0 },  why: 'filter ladder, 0' },
  { low: 26, high: 26, set: { 44: 20 }, why: 'filter ladder, 20' },
  { low: 28, high: 28, set: { 44: 40 }, why: 'filter ladder, 40' },
  { low: 30, high: 30, set: { 44: 60 }, why: 'filter ladder, 60' },
  { low: 32, high: 32, set: { 44: 80 }, why: 'filter ladder, 80' },
  { low: 34, high: 34, set: { 44: 99 }, why: 'filter ladder, 99' },

  { low: 38, high: 38, set: { 44: 40, 23: 25, 34: 0, 35: 80, 36: 0, 37: 0 },
    why: 'filter envelope at half amount' },
  { low: 40, high: 40, set: { 44: 40, 23: 50, 34: 0, 35: 80, 36: 0, 37: 0 },
    why: 'filter envelope at full amount' },

  { low: 42, high: 42, set: { 44: 99, 3: 0, 4: 80, 5: 0, 6: 0 },
    why: 'amplitude envelope: level decays to nothing' },

  { low: 44, high: 44, set: { 44: 40, 7: 99 },
    why: 'velocity to filter' },

  { low: 60, high: 96, set: { 44: 50, 8: 50 },
    why: 'key tracking: one keygroup across three octaves' },

  // level tests: filter wide open so it cannot colour the comparison, and a flat gate
  // - instant attack, no decay - so the level is steady and can simply be averaged
  { low: 46, high: 46, set: { 44: 99, 3: 0, 4: 0, 5: 99, 6: 0, 45: 0 },
    why: 'level reference: everything neutral' },
  { low: 48, high: 48, set: { 44: 99, 3: 0, 4: 0, 5: 50, 6: 0, 45: 0 },
    why: 'sustain 50, against the reference' },
  { low: 52, high: 52, set: { 44: 99, 3: 0, 4: 0, 5: 99, 6: 0, 45: 20 },
    why: 'zone loudness +20, against the reference' },

  { low: 50, high: 50, set: { 44: 99, 3: 0, 4: 0, 5: 99, 6: 0, 11: 99, 45: 0 },
    why: 'velocity to loudness at full depth' },

  { low: 54, high: 54, set: { 44: 99, 3: 70, 4: 0, 5: 99, 6: 0, 9: 0, 45: 0 },
    why: 'a long attack, to time the envelope scale' }
];

var TIMING = {
  hold: 3.0,              // the sample is 3 s and one-shot, so hold it all the way
  gap: 1.5,               // silence after each note - outlasts any release, splits cleanly
  sectionGap: 3.0,        // a longer pause between sections, visible when checking a take
  lead: 1.0,              // silence at the very start
  channel: 0              // MIDI channel 1
};

/** Every clip in order, flattened, with the section it belongs to. */
function clips() {
  var out = [];
  SECTIONS.forEach(function (s, si) {
    s.clips.forEach(function (c, ci) {
      out.push({
        section: s.name, analysis: s.analysis, settles: s.settles,
        sectionIndex: si, first: ci === 0, label: c.label,
        note: c.note, velocity: c.velocity, filter: c.filter
      });
    });
  });
  return out;
}

module.exports = { SECTIONS: SECTIONS, KEYGROUPS: KEYGROUPS, TIMING: TIMING, clips: clips };
