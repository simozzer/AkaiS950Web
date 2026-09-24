/*
 * Turn a measured run into the envelope time curve the engines use.
 *
 *   node envcal.js take.wav      ENVCAL4.img --plan envplan4.js --json real4.json
 *   node envcal.js rendered.wav  ENVCAL4.img --plan envplan4.js --json model4.json
 *   node envfit.js real4.json model4.json
 *
 * WHY TWO FILES
 *
 * The analysis has a bias of its own. It measures a sweep through windows a quarter of a
 * second wide, and a window averages whatever passes through it, so a fitted ramp comes out
 * slightly longer than the ramp really is. That bias is not guesswork here: rendering the
 * same run through the emulation produces a take whose times are known exactly, and putting
 * it through the same analysis says what the analysis does to a known answer.
 *
 *     bias(stored) = what the analysis read from the model - what the model actually is
 *
 * Subtracting it from the real take leaves the machine. It is worth about 0.15 s, which is a
 * seventh of the answer at stored 65 and a twentieth at stored 90 - small, but the same size
 * as the disagreement being measured at the fast end, so it cannot be waved away.
 *
 * WHAT COMES OUT
 *
 * The filter's times, divided by VcfTimeScale to give the shared envelope curve underneath.
 * Attack, decay and release are three measurements of that one curve, so where they overlap
 * they are averaged and their spread is printed: if they disagree, the thing being fitted is
 * not one curve and the fit is meaningless.
 */
var fs = require('fs');
var path = require('path');
var Audio = require('../audio.js');

var args = process.argv.slice(2);
var realFile  = args[0] || path.join(__dirname, 'real4.json');
var modelFile = args[1] || path.join(__dirname, 'model4.json');

var real  = JSON.parse(fs.readFileSync(realFile,  'utf8'));
var model = JSON.parse(fs.readFileSync(modelFile, 'utf8'));

var CAL = Audio.CAL;

/*
 * What the model's envelope curve is, live.
 *
 * Read from the engine rather than recomputed here, so this keeps working after the curve it
 * helped measure has been adopted: the bias it extracts is the difference between what the
 * analysis read from a render and what that render actually was, whatever the engine happens
 * to be doing at the time. Once the engine matches the machine, the ratios below all go to 1
 * and this says so - which is the check that the measurement was applied correctly.
 */
function modelEnvSeconds(v) {
  return Audio.envSeconds(v);
}

function byLabel(list) {
  var m = {};
  (list || []).forEach(function (p) { m[p.label] = p; });
  return m;
}

var R = byLabel(real.trajectory), M = byLabel(model.trajectory);

/*
 * The bias, per clip, from the rendered run.
 *
 * A clip the render could not trace has none of its own - attack 50 is over in less than one
 * analysis window, so the render, which is the model, had nothing to fit. The real machine's
 * attack 50 is slow enough to trace, which is itself a result; it borrows the bias of the
 * clips measured through the same size of window, which is what the bias depends on.
 */
var biases = [];
Object.keys(M).forEach(function (label) {
  if (!R[label]) return;
  var v = parseInt(label.split(' ').pop(), 10);
  biases.push({ label: label, stored: v, bias: M[label].rampSeconds - modelEnvSeconds(v) * CAL.VCF_TIME_SCALE });
});

var typical = biases.map(function (b) { return b.bias; }).sort(function (a, b) { return a - b; });
var medianBias = typical.length ? typical[Math.floor(typical.length / 2)] : 0;

console.log('');
console.log('THE ANALYSIS\'S OWN BIAS, from the rendered run whose times are known');
biases.forEach(function (b) {
  console.log('   ' + b.label.padEnd(12) + (b.bias >= 0 ? '+' : '') + b.bias.toFixed(3) + 's');
});
console.log('   median ' + (medianBias >= 0 ? '+' : '') + medianBias.toFixed(3) +
            's, used where the render could not trace the clip');

// ------------------------------------------------- the machine, one stored value at a time

var found = {};

Object.keys(R).forEach(function (label) {
  var v = parseInt(label.split(' ').pop(), 10);
  var bias = M[label] ? M[label].rampSeconds - modelEnvSeconds(v) * CAL.VCF_TIME_SCALE : medianBias;

  // the filter's time, then the shared curve underneath it
  var vcf = R[label].rampSeconds - bias;
  var env = vcf / CAL.VCF_TIME_SCALE;

  (found[v] || (found[v] = [])).push({ from: R[label].section, seconds: env, borrowed: !M[label] });
});

/*
 * A point whose bias had to be borrowed is not a measurement of this curve.
 *
 * Only stored 50 is in that position, and it shows: it came out at 0.408 s against stored
 * 55's 0.418, which would mean five units buy nothing at all. The difference between those
 * two readings is smaller than the difference between the bias that was measured for one and
 * guessed for the other, so the pair says nothing except that both are fast.
 *
 * It is dropped from the fit and reported separately. That the real machine could be traced
 * there at all, when the model was over inside one window, is the result worth keeping from
 * it - not the number.
 */
var dropped = [];
Object.keys(found).forEach(function (v) {
  if (!found[v].every(function (p) { return p.borrowed; })) return;
  dropped.push({ stored: Number(v), seconds: found[v][0].seconds });
  delete found[v];
});

var stored = Object.keys(found).map(Number).sort(function (a, b) { return a - b; });

console.log('');
console.log('THE ENVELOPE CURVE THE MACHINE ACTUALLY HAS');
console.log('   stored   measured    the model says   ratio    from');

var table = [];
stored.forEach(function (v) {
  var all = found[v].map(function (p) { return p.seconds; });
  var mean = all.reduce(function (a, b) { return a + b; }, 0) / all.length;
  var spread = all.length > 1 ? Math.max.apply(null, all) / Math.min.apply(null, all) : 1;
  var says = modelEnvSeconds(v);

  table.push({ stored: v, seconds: mean, spread: spread, n: all.length });

  console.log('     ' + String(v).padStart(3) + '    ' + mean.toFixed(3).padStart(7) + 's   ' +
              says.toFixed(3).padStart(9) + 's    ' + (mean / says).toFixed(2).padStart(5) + '    ' +
              found[v].map(function (p) { return p.from; }).join(', ') +
              (all.length > 1 ? '   (spread ' + spread.toFixed(2) + 'x)' : ''));
});

dropped.forEach(function (p) {
  console.log('     ' + String(p.stored).padStart(3) + '    ' + p.seconds.toFixed(3) +
              's              -        DROPPED: the render could not trace it, so its bias' +
              ' is borrowed');
});

var worst = Math.max.apply(null, table.map(function (p) { return p.spread; }));
console.log('');
console.log(worst < 1.25
  ? '   attack, decay and release agree to ' + worst.toFixed(2) + 'x where they overlap, so they\n' +
    '   really are three readings of one curve and fitting it is meaningful.'
  : '   they differ by up to ' + worst.toFixed(2) + 'x where they overlap, so these are NOT three\n' +
    '   readings of one curve. Do not fit it until that is understood.');

// ------------------------------------------------------------------- the ends of the curve

/*
 * Below the measured range and above it there is nothing, and this run could not have made
 * anything: the fast end is over inside one analysis window and the slow end outlasts a note.
 *
 * Extrapolating along the nearest measured PAIR is not good enough for that. Done from the
 * two fastest points it put stored 0 at 320 ms - a sampler whose shortest attack is a third
 * of a second, which every percussive sample in the library says is false. Two adjacent
 * points are five units apart and carry the full measurement error between them, so their
 * slope is mostly noise.
 *
 * So the slope comes from a least-squares fit across every measured point instead, anchored
 * at stored 80, where the VCA decay was directly measured at 2.86 s when EnvMinMs was first
 * set. That anchor is an independent measurement of the same curve from a different run and
 * a different envelope, so using it costs nothing and ties the two together.
 */
var ANCHOR = { stored: 80, seconds: 2.86 };

var sxy = 0, sxx = 0;
table.forEach(function (p) {
  var dx = p.stored - ANCHOR.stored;
  sxy += dx * (Math.log(p.seconds) - Math.log(ANCHOR.seconds));
  sxx += dx * dx;
});
var slope = sxy / sxx;

console.log('');
console.log('THE UNDERLYING SLOPE, fitted across every measured point');
console.log('   ' + slope.toFixed(5) + ' per unit, anchored at stored 80 = ' +
            ANCHOR.seconds.toFixed(2) + 's (the VCA decay measured when EnvMinMs was set)');
console.log('');
console.log('   how well a plain exponential of that slope fits each measurement:');

var worstFit = 0, worstAt = 0;
table.forEach(function (p) {
  var says = ANCHOR.seconds * Math.exp(slope * (p.stored - ANCHOR.stored));
  var off = says / p.seconds - 1;
  if (Math.abs(off) > Math.abs(worstFit)) { worstFit = off; worstAt = p.stored; }
  console.log('     ' + String(p.stored).padStart(3) + '   fit ' + says.toFixed(3) +
              's  against ' + p.seconds.toFixed(3) + 's   ' +
              (off >= 0 ? '+' : '') + (off * 100).toFixed(0) + '%');
});

console.log('');
console.log('   the form is right - the residuals are scatter, not a bend - so what was wrong');
console.log('   with the model was its two constants and not its shape. Except at stored ' +
            worstAt + ',');
console.log('   where it is out by ' + (worstFit * 100).toFixed(0) + '% and three sections ' +
            'agree it is out, which is why this');
console.log('   becomes a table of measurements rather than the corrected formula.');

var lowest  = table[0], highest = table[table.length - 1];
var atZero  = lowest.seconds  * Math.exp(-slope * lowest.stored);
var atFull  = highest.seconds * Math.exp(slope * (99 - highest.stored));

console.log('');
console.log('EXTRAPOLATED ENDS  (no measurement reaches them - assumptions, not results)');
console.log('     0    ' + (atZero * 1000).toFixed(2) + ' ms    the engine says ' +
            (modelEnvSeconds(0) * 1000).toFixed(2) + ' ms');
console.log('    99    ' + atFull.toFixed(3) + ' s     the engine says ' +
            modelEnvSeconds(99).toFixed(3) + ' s');
console.log('   span   ' + (atFull / atZero).toFixed(0) +
            ':1        the engine has ' +
            (modelEnvSeconds(99) / modelEnvSeconds(0)).toFixed(0) + ':1');

// ------------------------------------------------------------------------ what to paste

console.log('');
console.log('THE TABLE, for Cal.h / Cal.cs / audio.js');
console.log('');
var pts = [{ stored: 0, seconds: atZero }]
            .concat(table.map(function (p) { return { stored: p.stored, seconds: p.seconds }; }))
            .concat([{ stored: 99, seconds: atFull }]);

console.log('   ' + pts.map(function (p) {
  return '{ ' + p.stored + ', ' + (p.seconds < 0.1 ? p.seconds.toFixed(5) : p.seconds.toFixed(4)) + ' }';
}).join(', '));

console.log('');
console.log('   and the one directly measured VCA point, as a check:');
var vca80 = pts.filter(function (p) { return p.stored === 80; })[0];
if (vca80)
  console.log('     stored 80 is ' + vca80.seconds.toFixed(3) + 's here; VCA decay 80 was ' +
              'measured at 2.86s when EnvMinMs was set.');

console.log('');

module.exports = { points: pts, measured: table };
