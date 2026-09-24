/*
 * Velocity, against the desktop version's numbers.
 *
 * The keyboard used to strike at a fixed 100 in both programs. That is not a neutral
 * choice: velocity opens the filter, 8.34 octaves across the range about a pivot of 65,
 * so a fixed strike hides most of what the filter does. Both now take it from a strip
 * beside the keyboard, and both have to arrive at the same cutoff for the same strike -
 * they are the same instrument or they are not.
 *
 * The expected figures were printed by the C# side (AkaiS950Engine's Cal and Voice) for
 * the LFOCAL programme after its synth keygroups were set to filter 40, vel->filter 40.
 *
 *   node veltest.js [disk.hfe]
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');
var Audio = require('../audio.js');

var fails = 0, checks = 0;

function check(what, ok) {
  checks++;
  if (!ok) { fails++; console.log('  FAIL ' + what); }
}

function near(a, b, tol) { return Math.abs(a - b) <= tol; }

var image = process.argv[2];
if (!image || !fs.existsSync(image)) {
  console.log('needs a disk image: node veltest.js <disk.hfe>');
  process.exit(1);
}

var disk = Akai.load(path.basename(image), new Uint8Array(fs.readFileSync(image)));

var prog = null;
disk.entries.forEach(function (e) {
  if (e.type === 'P' && e.name.trim().toUpperCase() === 'LFOCAL') prog = e;
});

if (!prog) { console.log('no LFOCAL on that disk'); process.exit(1); }

var kgs = disk.keygroups(prog);

/*
 * Velocity has to move the cutoff, and move it the right way. Checked on a keygroup whose
 * ceiling is high enough that neither end is clamped, so the comparison is of the law
 * rather than of the limit.
 */
var open = null, idx = -1;
for (var i = 0; i < kgs.length; i++) {
  var k = kgs[i];
  var name = k.zone1 ? k.zone1.name.trim() : '';
  if (name !== 'SINE' && name !== 'SAW' && name !== 'PULSE') continue;
  if (k.velToFilter < 10) continue;
  open = k; idx = i;                    // the last one: highest key, highest ceiling
}

check('found a synth keygroup with velocity tracking', !!open);

if (open) {
  var s = null;
  disk.entries.forEach(function (e) {
    if (e.type === 'S' && e.name.trim() === open.zone1.name.trim()) s = e;
  });

  check('its sample is on the disk', !!s);

  if (s) {
    var note = open.lowKey;

    /*
     * The rate the audio LEAVES at, not the rate it was recorded at: the filter is also
     * the reconstruction filter, so its travel moves with playback speed. app.js passes
     * `rate * speed` for the same reason.
     */
    var semis = open.zone1.transpose + open.zone1.fine / 256 + (note - s.nominalPitch);
    var leave = s.sampleRate * Math.pow(2, semis / 12);

    // vcfEnvelope hands back a function of time; a fifth of a second in is past the
    // attack and into the sustain on these keygroups.
    var softHz = Audio.vcfEnvelope(open, open.zone1, note, 40, leave)(0.2);
    var hardHz = Audio.vcfEnvelope(open, open.zone1, note, 100, leave)(0.2);

    check('a soft strike gives a cutoff (' + softHz + ')', softHz > 0);
    check('a hard strike gives a cutoff (' + hardHz + ')', hardHz > 0);
    check('harder is brighter: ' + Math.round(softHz) + ' Hz -> ' + Math.round(hardHz) + ' Hz',
          hardHz > softHz);

    // The desktop version reaches 719 Hz at velocity 40 on these keygroups, the cutoff
    // being flat across them at that strike because the base is well below every ceiling.
    check('and the soft end matches the desktop version (719 Hz, got ' + Math.round(softHz) + ')',
          near(softHz, 719, 25));
  }
}

// The calibration both sides work from has to be the same, or nothing above means much.
check('VEL_OCTAVES is the measured 8.34', Audio.CAL.VEL_OCTAVES === 8.34);
check('VEL_PIVOT is the measured 65', Audio.CAL.VEL_PIVOT === 65);

console.log('');
console.log(checks + ' checks, ' + (fails === 0 ? 'ALL PASSED' : fails + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);
