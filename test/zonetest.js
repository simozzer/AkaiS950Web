/*
 * Which of a keygroup's two samples a strike reaches.
 *
 *   node zonetest.js
 *
 * The two zones are alternatives rather than layers: the velocity switch splits the range and
 * exactly one of them answers. Three implementations of this instrument are supposed to agree
 * on where that split falls - the plugin, the desktop engine and this page - and until now
 * this page did not implement it at all. It played zone 1 and reached for zone 2 only when
 * zone 1's sample was missing from the disk, so a two-zone programme never sounded its hard
 * sample however hard you played.
 *
 * The rule, as the plugin and the editor both have it:
 *
 *     zone 1   velocity  0 .. switch-1
 *     zone 2   velocity  switch .. 127
 *     switch 128, or a second zone not in use, means zone 1 takes everything
 *
 * TWO ASSUMPTIONS ARE BAKED IN HERE AND NEITHER HAS BEEN MEASURED
 *
 * That byte 2 is read as MIDI velocity, and that the boundary is inclusive at the bottom of
 * zone 2 - that a switch of 90 means 90 is the first velocity to reach the hard sample rather
 * than the last to reach the soft one. The editor clamps the byte to 1..128, which hints the
 * panel counts from one, and if it does then this is out by a velocity step.
 *
 * Nothing has yet played a real S950 either side of a switch point to find out. These checks
 * hold the three implementations to the same answer; they do not claim it is the machine's.
 */
var Akai = require('../akai.js');

var checks = 0, fails = 0;

function check(what, ok, detail) {
  checks++;
  if (!ok) { fails++; console.log('  FAIL ' + what + (detail ? '   ' + detail : '')); }
  else console.log('  ok   ' + what + (detail ? '   ' + detail : ''));
}

/// A keygroup as the rule sees it: two named zones and a switch.
function keygroup(velocitySwitch, secondZoneInUse) {
  return {
    velocitySwitch: velocitySwitch,
    zone1: { name: 'SOFT', inUse: true },
    zone2: { name: 'HARD', inUse: secondZoneInUse !== false }
  };
}

function nameAt(kg, velocity) { return Akai.zoneForVelocity(kg, velocity).name; }

console.log('');
console.log('the velocity switch, against the rule the plugin and the editor use:');
console.log('');

// --------------------------------------------------------------- the boundary itself

var kg = keygroup(90);

check('one below the switch is the soft sample',   nameAt(kg, 89) === 'SOFT', 'velocity 89');
check('the switch value itself is STILL the soft', nameAt(kg, 90) === 'SOFT', 'velocity 90');
check('one above it is the hard sample',           nameAt(kg, 91) === 'HARD', 'velocity 91');
check('and it stays hard',                         nameAt(kg, 92) === 'HARD', 'velocity 92');

// The whole range, so nothing falls through a gap or answers twice.
var soft = 0, hard = 0;
for (var v = 0; v <= 127; v++) (nameAt(kg, v) === 'SOFT' ? soft++ : hard++);

check('every velocity from 0 to 127 reaches exactly one zone', soft + hard === 128,
      soft + ' soft, ' + hard + ' hard');
// 0..90 inclusive is 91 velocities, 91..127 is 37
check('and the split is where the switch puts it', soft === 91 && hard === 37,
      soft + ' soft, ' + hard + ' hard');

// ------------------------------------------------------------------- the switch off

var off = keygroup(128);
check('a switch of 128 gives zone 1 the whole range',
      nameAt(off, 0) === 'SOFT' && nameAt(off, 127) === 'SOFT');

var lonely = keygroup(64, false);
check('a keygroup whose second zone is unused plays zone 1 however hard',
      nameAt(lonely, 0) === 'SOFT' && nameAt(lonely, 127) === 'SOFT');

/*
 * A byte outside 1..128 is not a switch. The editor clamps what it writes, but a disk
 * written by something else - or a keygroup never set up - can hold anything, and the answer
 * has to be the safe one rather than an accidental split at velocity 0.
 */
[0, -1, 200, 255].forEach(function (odd) {
  var strange = keygroup(odd);
  check('a switch of ' + odd + ' is treated as off',
        nameAt(strange, 0) === 'SOFT' && nameAt(strange, 127) === 'SOFT');
});

// ------------------------------------------------------------- the extremes of a split

/*
 * Both ends were measured on the hardware in run 6, and both were the wrong way round here.
 */
var low = keygroup(1);
check('a switch of 1 leaves velocity 1 to the soft sample, and 2 up to the hard',
      nameAt(low, 1) === 'SOFT' && nameAt(low, 2) === 'HARD',
      'the machine played the sine at 1 and noise from 2');

var high = keygroup(127);
check('a switch of 127 puts the hard sample out of reach entirely',
      nameAt(high, 126) === 'SOFT' && nameAt(high, 127) === 'SOFT',
      'the machine played the sine at 125, 126 and 127 alike');

console.log('');
console.log(checks + ' checks, ' + (fails === 0 ? 'ALL PASSED' : fails + ' FAILED'));
process.exit(fails === 0 ? 0 : 1);
