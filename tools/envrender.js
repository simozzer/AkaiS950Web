/*
 * Render the filter envelope run through the emulation, as a WAV.
 *
 *   node envrender.js [out.wav] [disk image]
 *
 * The point is to put the ANALYSIS through a take whose answers are already known. If
 * envcal.js reads this file and reports the constants the model was built from, then the
 * rig measures what it claims to and a real take can be trusted. If it does not, the fault
 * is in the measurement and would otherwise have been blamed on the sampler - which is the
 * expensive way to find out, an afternoon of recording later.
 *
 * It renders from the same disk and the same plan the sampler will be given, so a mistake
 * in either shows up here rather than in the take.
 */
var fs = require('fs');
var path = require('path');
var Akai = require('../akai.js');
var Audio = require('../audio.js');

// --plan envplan2.js renders the second run instead; see the note in envdisk.js
var args = process.argv.slice(2);
var planFile = './envplan.js';
for (var ai = 0; ai < args.length; ai++) {
  if (args[ai] === '--plan') { planFile = './' + args[ai + 1].split(/[\\/]/).pop(); args.splice(ai, 2); break; }
}
var plan = require(planFile);

var out = args[0] || path.join(__dirname, 'envrendered.wav');
var image = args[1] || path.join(__dirname, 'ENVCAL.img');

var disk = Akai.load('x', new Uint8Array(fs.readFileSync(image)));

var prog = null;
disk.programsInOrder().forEach(function (p) { if (p.name.trim() === 'ENVCAL') prog = p; });
if (!prog) { console.log('no ENVCAL programme in ' + image); process.exit(1); }

var kgs = disk.keygroups(prog);

/*
 * The samples on the disk, by name.
 *
 * This used to find the one called NOISE and play it for every note, which is right for a run
 * carrying a single sample and wrong for one whose whole question is WHICH sample sounded.
 */
function sampleNamed (name) {
  var found = null;
  disk.entries.forEach(function (e) {
    if (e.type === 'S' && e.name.trim().toUpperCase() === String (name).trim().toUpperCase())
      found = e;
  });
  return found;
}

var smp = sampleNamed ('NOISE');
if (!smp) disk.entries.forEach(function (e) { if (!smp && e.type === 'S') smp = e; });
if (!smp) { console.log('no sample at all in ' + image); process.exit(1); }

var RATE = smp.sampleRate;
// the note picks its own sample now - see renderNote

function keygroupFor(note) {
  for (var i = 0; i < kgs.length; i++) {
    var kg = kgs[i];
    if (note >= Math.min(kg.lowKey, kg.highKey) && note <= Math.max(kg.lowKey, kg.highKey))
      return kg;
  }
  return null;
}

/*
 * One note, filtered and shaped as the machine would.
 *
 * The filter is retuned every 8 samples rather than the default 64. The release section
 * closes the cutoff five octaves in a millisecond, and a cascade stepped that far at once
 * rings loudly enough to be mistaken for the sampler doing something - see audio.js.
 */
function renderNote(clip, seconds) {
  var n = Math.round(seconds * RATE);
  var kg = keygroupFor(clip.note);
  if (!kg) return new Float32Array(n);

  /*
   * The velocity switch decides which sample, exactly as the engines do.
   *
   * This took zone 1 always, which was harmless while every run had one sample on the disk
   * and nothing in zone 2 - and useless the moment a run measures the switch itself, since
   * the render would have answered every velocity with the soft sample and "proved" a
   * boundary that was really just the renderer.
   */
  var zone = Akai.zoneForVelocity (kg, clip.velocity);

  // and the sample that zone names, not whichever one the disk happened to list first
  var entry = sampleNamed (zone.name) || smp;
  var words = disk.sampleWords12 (entry);
  var env = Audio.vcfEnvelope(kg, zone, clip.note, clip.velocity, RATE);
  var closing = env.withRelease(clip.hold);

  /*
   * A looping sample has to be looped BEFORE it is filtered, not after.
   *
   * The envelope keeps moving across the loop join - that is the whole point of a long note -
   * so filtering three seconds and then repeating the result would replay the same three
   * seconds of sweep over and over. Laid end to end first, the filter runs down the whole
   * note once, exactly as the machine does.
   *
   * Without this the renderer quietly capped every note at the sample's own length, which is
   * what the plan looping is meant to escape.
   */
  var source = words;
  if (entry.loopMode !== 'O' && n > words.length) {
    source = new Int16Array(n);
    for (var k = 0; k < n; k++) source[k] = words[k % words.length];
  }

  var filtered = Audio.filterWords(source, RATE, closing, 8);
  var vca = Audio.vcaEnvelope(kg, zone, clip.velocity);

  var buf = new Float32Array(n);
  var held = vca.peak * vca.sustain;

  for (var i = 0; i < n && i < filtered.length; i++) {
    var t = i / RATE, gain;

    if (t < vca.attack) gain = vca.peak * (vca.attack > 0 ? t / vca.attack : 1);
    else if (t < vca.attack + vca.decay) {
      var u = (t - vca.attack) / vca.decay;
      gain = vca.peak * Math.pow(Math.max(held, 1e-6) / Math.max(vca.peak, 1e-6), u);
    } else gain = held;

    // the amplitude release, from the key coming up
    if (t >= clip.hold && vca.release > 0.0005) {
      var r = Math.min(1, (t - clip.hold) / vca.release);
      gain *= Math.pow(1e-4, r);
    } else if (t >= clip.hold && vca.release <= 0.0005) {
      gain = 0;
    }

    buf[i] = filtered[i] * gain;
  }
  return buf;
}

// --- lay the run out on the timeline the MIDI file uses
var run = plan.schedule();
var total = Math.round((run.seconds + 1.0) * RATE);
var all = new Float32Array(total);

run.clips.forEach(function (c) {
  // enough room for the note to run out past the key coming up
  var span = c.hold + plan.TIMING.gap * 0.9;
  var piece = renderNote(c, span);
  var at = Math.round(c.from * RATE);

  for (var i = 0; i < piece.length && at + i < total; i++) all[at + i] += piece[i];
});

var peak = 0;
for (var i = 0; i < total; i++) peak = Math.max(peak, Math.abs(all[i]));
var gain = peak > 0 ? 0.7 / peak : 1;

var b = Buffer.alloc(44 + total * 2);
b.write('RIFF', 0, 'ascii'); b.writeUInt32LE(36 + total * 2, 4); b.write('WAVE', 8, 'ascii');
b.write('fmt ', 12, 'ascii'); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20);
b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28);
b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
b.write('data', 36, 'ascii'); b.writeUInt32LE(total * 2, 40);

for (var k = 0; k < total; k++)
  b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(all[k] * gain * 32767))), 44 + k * 2);

fs.writeFileSync(out, b);

console.log('');
console.log('wrote ' + out + '  (' + (total / RATE).toFixed(1) + 's, ' +
            run.clips.length + ' notes at ' + RATE + ' Hz)');
console.log('');
console.log('now run:  node envcal.js ' + out);
console.log('and it should report ENV_OCTAVES ' + Audio.CAL.ENV_OCTAVES +
            ' both ways, and a symmetry of 1.000.');
console.log('');
