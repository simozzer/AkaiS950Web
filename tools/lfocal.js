/*
 * Read one LFO calibration take and settle what it can.
 *
 *   node lfocal.js <take.wav>
 *
 * The take is the 26 clips of AkaiLfoCalibration.mid played through LFOCAL. Clips are
 * identified by where they fall in the run, so the running order in lfoplan.js has to be
 * the one that was played - and lfodisk.js check has to have passed on the disk that
 * played it.
 *
 * HOW THE PITCH IS READ
 *
 * Every clip is a steady tone whose pitch the LFO moves. Reading that movement by
 * spectrum would be hopeless: the wobble is a few tens of cents at a few cycles a
 * second, which no useful window length can resolve. So the tone is demodulated instead,
 * exactly as an FM receiver does it.
 *
 *   - multiply the recording by a cosine and a sine at the tone's own frequency,
 *   - average each product over precisely one period of that tone,
 *   - take the angle of the pair.
 *
 * The averaging is the part worth understanding. A boxcar average of length T has a null
 * at every multiple of 1/T, so averaging over one period of the tone removes every
 * harmonic of that tone exactly - which is why a sawtooth of 36 harmonics reads as
 * cleanly as a sine, and why the desync pair can be read as two voices at once as long
 * as the averaging is set to null the lower of them. Two of those averages are cascaded,
 * which squares the rejection and costs nothing.
 *
 * What is left is the angle of the tone against a fixed reference, and the rate at which
 * that angle turns is the difference between the tone's frequency and the reference. In
 * cents, against the clip's own mean, that is the LFO.
 *
 * WHY THE CARRIER IS FOUND TWICE
 *
 * The obvious way to find the tone is to look for the loudest thing in the clip, and it
 * is wrong. Frequency modulation spreads a tone into sidebands, and at a modulation
 * index near 2.4 the centre of it disappears entirely - so the loudest thing in a deeply
 * modulated clip is a sideband several hertz off, and the averaging that was meant to
 * land on the harmonics lands between them instead. The mean of the instantaneous
 * frequency, on the other hand, is the carrier by definition. So it is demodulated once
 * to find out where the tone really is, and then again there.
 *
 * WHAT IT WILL NOT TELL YOU
 *
 * Nothing here knows what the S950 is supposed to do. Every number printed is a reading,
 * every reading says how well it was determined, and the ones that cannot be determined
 * say so rather than being fitted anyway.
 */
var fs = require('fs');
var path = require('path');
var cal = require('./vcfcal.js');
var plan = require('./lfoplan.js');

var FRAME_RATE = 500;              // pitch track frames per second
var MAX_LFO_HZ = 40;               // nothing on this machine is going to be faster
var MIN_LFO_HZ = 0.06;             // one cycle in sixteen seconds - the longest clip

/** sin(pi x)/(pi x): the response of a boxcar average of x cycles of whatever. */
function sinc(x) {
  if (Math.abs(x) < 1e-12) return 1;
  return Math.sin(Math.PI * x) / (Math.PI * x);
}

// ------------------------------------------------------------------- the tone

/**
 * Roughly where the tone sits, to start the search from.
 *
 * The peak of the spectrum, which is only roughly right for a modulated tone - see the
 * note above. demodulate corrects it from the track itself.
 */
function findCarrier(x, rate, from, to, hintHz) {
  var n = Math.min(to - from, Math.round(rate * 0.5));
  var at = from + Math.floor(((to - from) - n) / 2);

  function power(f) {
    var re = 0, im = 0, w = 2 * Math.PI * f / rate;
    for (var i = 0; i < n; i++) {
      var a = w * i;
      re += x[at + i] * Math.cos(a);
      im -= x[at + i] * Math.sin(a);
    }
    return re * re + im * im;
  }

  var best = hintHz, bestP = -1, f;
  for (f = hintHz * 0.85; f <= hintHz * 1.18; f += 0.5) {
    var p = power(f);
    if (p > bestP) { bestP = p; best = f; }
  }
  return best;
}

/**
 * The pitch and the level of one tone through one stretch of the take.
 *
 * Returns cents against the stretch's own mean pitch, decibels against its own mean
 * level, the carrier it settled on, and `response` - what this tracker does to a wobble
 * of a given frequency, so that a reading can have the tracker's own smoothing divided
 * back out of it rather than quietly carrying it.
 *
 * `nullHz` overrides what the averaging is set to cancel. It defaults to the carrier,
 * which nulls that tone's own harmonics; the desync pair passes the lower voice, which
 * nulls both voices' harmonics at once.
 */
function demodulate(x, rate, from, to, hintHz, nullHz) {
  var first = pass(findCarrier(x, rate, from, to, hintHz));
  if (!first) return null;

  // the mean instantaneous frequency IS the carrier - so if the spectrum sent us to a
  // sideband, this is where it says the tone actually is
  if (Math.abs(first.meanHz - first.carrier) > first.carrier * 0.002) {
    var second = pass(first.meanHz);
    if (second) return second;
  }
  return first;

  function pass(carrier) {
    /*
     * One period of the tone, which nulls every harmonic of it exactly.
     *
     * Averaging over several periods instead was tried, on the theory that a deep vibrato
     * walks the harmonics off the nulls meant to cancel them - it does - and that this was
     * why one take appeared to have a level swinging by 12 dB where the recording itself
     * moved 3. It was not: that take was clipped across 29% of its samples, and lengthening
     * the average moved the reading by a tenth of a decibel.
     *
     * What it did do is round the corners off the LFO. A longer boxcar reaches down towards
     * the wobble itself, and at 12 cycles a second it took enough of the third and fifth
     * harmonics out of a triangle to make it read as a sine - which is exactly the question
     * the shape section exists to answer. One period, then, and clipping is the caller's
     * problem to avoid rather than the filter's to survive.
     */
    var L = Math.max(2, Math.round(rate / (nullHz || carrier)));
    var n = to - from;
    if (n < 4 * L + 8) return null;

    var mi = new Float64Array(n), mq = new Float64Array(n);
    var w = 2 * Math.PI * carrier / rate;
    for (var i = 0; i < n; i++) {
      var a = w * i;
      mi[i] = x[from + i] * Math.cos(a);
      mq[i] = -x[from + i] * Math.sin(a);
    }

    // two boxcars of one period each: the first nulls every harmonic exactly, the
    // second does it again for whatever leaked through the first one's sidelobes
    boxcar(mi, L); boxcar(mi, L);
    boxcar(mq, L); boxcar(mq, L);

    var hop = Math.max(1, Math.round(rate / FRAME_RATE));
    var skip = 2 * L;                                  // the boxcars' own settling
    var frames = Math.floor((n - skip) / hop);
    if (frames < 8) return null;

    var phase = new Float64Array(frames), amp = new Float64Array(frames);
    var prev = 0, turns = 0;

    for (var f2 = 0; f2 < frames; f2++) {
      var pos = skip + f2 * hop;
      var ph = Math.atan2(mq[pos], mi[pos]);
      if (f2 > 0) {
        var d = ph - prev;
        while (d > Math.PI) { d -= 2 * Math.PI; turns--; }
        while (d < -Math.PI) { d += 2 * Math.PI; turns++; }
      }
      prev = ph;
      phase[f2] = ph + 2 * Math.PI * turns;
      amp[f2] = Math.sqrt(mi[pos] * mi[pos] + mq[pos] * mq[pos]);
    }

    var frameRate = rate / hop;
    var hz = new Float64Array(frames - 1);
    for (var k = 0; k < frames - 1; k++)
      hz[k] = carrier + (phase[k + 1] - phase[k]) * frameRate / (2 * Math.PI);

    var smoothing = Math.max(1, Math.round(frameRate / 100));
    boxcar(hz, smoothing);

    var mean = 0, m;
    for (m = 0; m < hz.length; m++) mean += hz[m];
    mean /= hz.length;

    var meanAmp = 0;
    for (m = 0; m < hz.length; m++) meanAmp += amp[m];
    meanAmp = Math.max(meanAmp / hz.length, 1e-12);

    var cents = new Float64Array(hz.length), db = new Float64Array(hz.length);
    for (var c = 0; c < hz.length; c++) {
      cents[c] = 1200 * Math.log2(Math.max(hz[c], 1e-6) / mean);
      db[c] = 20 * Math.log10(Math.max(amp[c], 1e-12) / meanAmp);
    }

    return {
      carrier: carrier, meanHz: mean, cents: cents, db: db,
      frameRate: frameRate, seconds: cents.length / frameRate,
      startedAt: (from + skip) / rate,

      /*
       * What this chain does to a wobble at f, so it can be divided out.
       *
       * Two boxcars of L samples, one of `smoothing` frames, and the difference that
       * turns phase into frequency, which is itself an average over one frame. None of
       * it matters at half a cycle a second and all of it matters at twelve: the
       * smoothing alone takes 2% off a 12 Hz reading, which is the difference between
       * a depth law that looks linear and one that does not.
       */
      response: function (f) {
        return Math.pow(sinc(f * L / rate), 2) *
               sinc(f * smoothing / frameRate) *
               sinc(f / frameRate);
      }
    };
  }
}

/** A running-sum boxcar of `len`, in place, aligned so sample i is centred on it. */
function boxcar(a, len) {
  if (len < 2) return;
  var n = a.length, out = new Float64Array(n), sum = 0, half = len >> 1;
  for (var i = 0; i < n; i++) {
    sum += a[i];
    if (i >= len) sum -= a[i - len];
    out[Math.max(0, i - half)] = sum / Math.min(len, i + 1);
  }
  for (var j = Math.max(0, n - half); j < n; j++) out[j] = out[Math.max(0, n - half - 1)];
  a.set(out);
}

// ------------------------------------------------------------- reading a track

/**
 * One frequency bin of a track, at an arbitrary frequency.
 *
 * Amplitude and phase of a cosine at `f`: a track holding A.cos(2.pi.f.t + phi) comes
 * back as { amp: A, phase: phi }.
 */
function bin(a, from, to, f, frameRate) {
  var re = 0, im = 0, n = to - from;
  if (n < 2) return { amp: 0, phase: 0 };
  var w = 2 * Math.PI * f / frameRate;
  for (var i = 0; i < n; i++) {
    var ang = w * i;
    re += a[from + i] * Math.cos(ang);
    im -= a[from + i] * Math.sin(ang);
  }
  re *= 2 / n; im *= 2 / n;
  return { amp: Math.sqrt(re * re + im * im), phase: Math.atan2(im, re) };
}

/**
 * The strongest periodicity in a track, and how strongly it stands out.
 *
 * Scanned rather than transformed, because the range wanted spans three decades from
 * one cycle in sixteen seconds to forty a second, and a scan costs nothing at 500 frames
 * a second. The window is then trimmed to a whole number of cycles and the reading taken
 * again: an incomplete last cycle leaks into every neighbouring frequency and inflates
 * the amplitude by up to a third.
 */
function findRate(a, from, to, frameRate, maxHz) {
  var span = (to - from) / frameRate;
  var lowest = Math.max(MIN_LFO_HZ, 1.5 / span);        // need a cycle and a half of it
  var best = null, f;

  for (f = lowest; f <= (maxHz || MAX_LFO_HZ); f *= 1.01) {
    var b = bin(a, from, to, f, frameRate);
    if (!best || b.amp > best.amp) best = { hz: f, amp: b.amp, phase: b.phase };
  }
  if (!best) return null;

  for (f = best.hz * 0.97; f <= best.hz * 1.03; f += best.hz * 0.0008) {
    var b2 = bin(a, from, to, f, frameRate);
    if (b2.amp > best.amp) best = { hz: f, amp: b2.amp, phase: b2.phase };
  }

  var period = frameRate / best.hz;
  var cycles = Math.floor((to - from) / period);
  if (cycles >= 1) {
    var end = from + Math.round(cycles * period);
    var b3 = bin(a, from, end, best.hz, frameRate);
    best = { hz: best.hz, amp: b3.amp, phase: b3.phase, cycles: cycles, from: from, to: end };
  } else {
    best.cycles = 0; best.from = from; best.to = to;
  }

  // how much of the track this one frequency explains - a reading that explains a tenth
  // of what is there is noise wearing a number
  var power = 0, mean = 0, i;
  for (i = from; i < to; i++) mean += a[i];
  mean /= (to - from);
  for (i = from; i < to; i++) power += (a[i] - mean) * (a[i] - mean);
  power /= (to - from);
  best.explains = power > 0 ? Math.min(1, (best.amp * best.amp / 2) / power) : 0;

  return best;
}

/** Peak deviation and shape, from the track folded at its own period. */
function fold(a, from, to, hz, frameRate, bins) {
  bins = bins || 48;
  var period = frameRate / hz;
  var sum = new Float64Array(bins), count = new Float64Array(bins);

  for (var i = from; i < to; i++) {
    var b = Math.floor(((i - from) % period) / period * bins) % bins;
    sum[b] += a[i]; count[b]++;
  }

  var cycle = new Float64Array(bins), mean = 0;
  for (var k = 0; k < bins; k++) { cycle[k] = count[k] ? sum[k] / count[k] : 0; mean += cycle[k]; }
  mean /= bins;

  var lo = Infinity, hi = -Infinity;
  for (var j = 0; j < bins; j++) { lo = Math.min(lo, cycle[j]); hi = Math.max(hi, cycle[j]); }

  return { cycle: cycle, mean: mean, peak: (hi - lo) / 2, min: lo, max: hi };
}

/**
 * Which textbook waveform the folded cycle looks most like, and how big its own
 * fundamental is compared with its peak.
 *
 * That second number is the useful one. Reading a depth as the highest point of the
 * folded cycle is reading two samples out of thousands, and every smoothing in the chain
 * rounds a corner off them - a triangle at 12 Hz loses a seventh of its peak that way.
 * The fundamental loses almost nothing and can be corrected exactly, so the depth is
 * read there and converted back to a peak through the shape.
 */
var SHAPES = {
  sine: { at: function (t) { return Math.sin(2 * Math.PI * t); }, crest: 1 },
  triangle: { at: function (t) { var u = (t + 0.25) % 1; return u < 0.5 ? 4 * u - 1 : 3 - 4 * u; },
              crest: 8 / (Math.PI * Math.PI) },
  square: { at: function (t) { return t % 1 < 0.5 ? 1 : -1; }, crest: 4 / Math.PI },
  saw: { at: function (t) { return 2 * ((t + 0.5) % 1) - 1; }, crest: 2 / Math.PI },
  'saw down': { at: function (t) { return 1 - 2 * ((t + 0.5) % 1); }, crest: 2 / Math.PI }
};

function identify(cycle) {
  var bins = cycle.length;
  var mean = 0, i;
  for (i = 0; i < bins; i++) mean += cycle[i];
  mean /= bins;

  var norm = new Float64Array(bins), energy = 0;
  for (i = 0; i < bins; i++) { norm[i] = cycle[i] - mean; energy += norm[i] * norm[i]; }
  if (energy <= 0) return [];

  var scored = Object.keys(SHAPES).map(function (name) {
    var best = -2;
    for (var shift = 0; shift < bins; shift++) {
      var dot = 0, e2 = 0;
      for (var k = 0; k < bins; k++) {
        var v = SHAPES[name].at((k + shift) / bins);
        dot += norm[k] * v; e2 += v * v;
      }
      var r = dot / Math.sqrt(energy * e2);
      if (r > best) best = r;
    }
    return { name: name, r: best, crest: SHAPES[name].crest };
  });

  scored.sort(function (a, b) { return b.r - a.r; });
  return scored;
}

/** A folded cycle, drawn, because a shape is easier to see than to read about. */
function draw(cycle, rows) {
  rows = rows || 9;
  var bins = cycle.length, lo = Infinity, hi = -Infinity, i;
  for (i = 0; i < bins; i++) { lo = Math.min(lo, cycle[i]); hi = Math.max(hi, cycle[i]); }
  if (hi - lo < 1e-9) return ['    (flat)'];

  var lines = [];
  for (var r = 0; r < rows; r++) {
    var line = '';
    var top = hi - (hi - lo) * r / rows, bot = hi - (hi - lo) * (r + 1) / rows;
    for (i = 0; i < bins; i++) {
      var v = cycle[i];
      line += (v <= top && v >= bot) ? '#' : ((r === Math.floor(rows / 2)) ? '-' : ' ');
    }
    lines.push('    ' + line);
  }
  return lines;
}

/**
 * How the modulation arrives.
 *
 * The delay turned out to be a fade-in rather than a wait, so what matters is when the
 * wobble reaches each fraction of its final depth. The envelope is the largest excursion
 * in each half cycle of the LFO, which is as fine a resolution as the thing itself has.
 *
 * An earlier version measured the amplitude in a two-cycle sliding window, and could not
 * see anything shorter than that window - nearly three tenths of a second at seven cycles
 * a second. Three takes running it reported four of the five delay settings as exactly
 * zero. Four of them really do happen inside a fifth of a second, and this says so.
 */
function onset(a, from, to, hz, frameRate, depth) {
  if (!(depth > 0)) return null;

  var half = Math.max(2, Math.round(frameRate / hz / 2));
  var env = [], times = [];
  for (var at = from; at + half <= to; at += half) {
    var pk = 0;
    for (var i = at; i < at + half; i++) { var v = a[i] < 0 ? -a[i] : a[i]; if (v > pk) pk = v; }
    env.push(pk); times.push((at + half / 2 - from) / frameRate);
  }
  if (env.length < 4) return null;

  var out = { envelope: env, times: times };
  [["leaves", 0.05], ["quarter", 0.25], ["half", 0.5], ["full", 0.9]].forEach(function (want) {
    var target = depth * want[1], found = null;
    for (var k = 0; k < env.length; k++) if (env[k] >= target) {
      found = k === 0 ? 0
            : times[k - 1] + (target - env[k - 1]) /
              Math.max(env[k] - env[k - 1], 1e-9) * (times[k] - times[k - 1]);
      break;
    }
    out[want[0]] = found;
  });
  return out;
}

// ------------------------------------------------------------- one whole clip

/**
 * Everything one clip has to say.
 *
 * `skipSeconds` is how much of the front to ignore. Normally a fraction of a second,
 * clear of the note starting; for the delay ladder it is almost nothing, because the
 * front is the measurement.
 */
function measure(x, rate, clip, offset, opts) {
  opts = opts || {};
  var skip = opts.skipSeconds === undefined ? 0.25 : opts.skipSeconds;
  var from = Math.round((clip.from + offset + skip) * rate);
  var to = Math.round((clip.to + offset - 0.1) * rate);
  if (to > x.length) to = x.length;
  if (from < 0) from = 0;
  if (to - from < rate * 0.3) return { clip: clip, error: 'too short to read' };

  var t = demodulate(x, rate, from, to, opts.hintHz || clip.sounds || plan.TONE_HZ, opts.nullHz);
  if (!t) return { clip: clip, error: 'no tone found' };

  // the steady part, for rate and depth: for a delayed clip that is the back of it
  var start = opts.steadyFrom ? Math.round(opts.steadyFrom * t.frameRate) : 0;
  if (start > t.cents.length - 8) start = 0;

  // The rate is looked for in the pitch AND in the level. Taking it from the pitch alone
  // would find nothing at all in an LFO that turned out to move the level instead, and
  // "found nothing" is exactly the wrong answer to that question.
  var rCents = findRate(t.cents, start, t.cents.length, t.frameRate, opts.maxHz);
  var rDb = findRate(t.db, start, t.db.length, t.frameRate, opts.maxHz);
  var r = rCents;
  var heardIn = 'pitch';
  if (rDb && (!rCents || rDb.explains > rCents.explains + 0.1)) { r = rDb; heardIn = 'level'; }

  var out = { clip: clip, track: t, rate: r, heardIn: heardIn,
              pitchExplains: rCents ? rCents.explains : 0 };

  if (r && r.cycles >= 1) {
    var correction = 1 / Math.max(0.2, t.response(r.hz));
    var f = fold(t.cents, r.from, r.to, r.hz, t.frameRate);
    var atRate = bin(t.cents, r.from, r.to, r.hz, t.frameRate);

    out.fold = f;
    out.peakCents = f.peak;                          // straight off the folded cycle
    out.sineCents = atRate.amp * correction;         // its fundamental, tracker undone
    out.shape = identify(f.cycle);
    out.correction = correction;

    // the depth, through the shape: see the note on SHAPES
    if (out.shape.length && out.shape[0].r > 0.95 && out.pitchExplains > 0.5) {
      out.depthCents = out.sineCents / out.shape[0].crest;
      out.depthFrom = out.shape[0].name;
    } else {
      out.depthCents = f.peak;
      out.depthFrom = 'the folded cycle';
    }

    var levelFold = fold(t.db, r.from, r.to, r.hz, t.frameRate);
    out.levelDb = bin(t.db, r.from, r.to, r.hz, t.frameRate).amp * 2 * correction;
    out.levelPeakDb = levelFold.peak * 2;
  } else {
    out.peakCents = 0; out.sineCents = 0; out.depthCents = 0;
    out.levelDb = 0; out.levelPeakDb = 0;
    out.depthFrom = 'nothing periodic';
  }

  out.meanHz = t.meanHz;
  out.centsOffNominal = 1200 * Math.log2(t.meanHz / (clip.sounds || plan.TONE_HZ));

  /*
   * Did this clip play what it was asked to play?
   *
   * It has to be asked. The first take of this run came back with 25 of its 26 clips at
   * the wrong pitch - some three octaves out and aliasing - and nothing here noticed: the
   * carrier search found SOMETHING within its band every time, demodulated whatever that
   * was, and reported depths of six thousand cents with no more hesitation than it reports
   * a good one. A tool that cannot tell a measurement from a misunderstanding is worse
   * than no tool, because it is believed.
   *
   * Two ways of being wrong, and they catch different failures. A pitch a semitone or more
   * off nominal means the note was not the note. A level that swings wildly across the clip
   * means whatever was demodulated was not a steady tone at all - noise, or a tone drifting
   * in and out of the search band.
   */
  var dbMean = 0, dbVar = 0, q;
  for (q = 0; q < t.db.length; q++) dbMean += t.db[q];
  dbMean /= Math.max(t.db.length, 1);
  for (q = 0; q < t.db.length; q++) dbVar += (t.db[q] - dbMean) * (t.db[q] - dbMean);
  out.levelSpread = Math.sqrt(dbVar / Math.max(t.db.length, 1));

  out.offPitch = Math.abs(out.centsOffNominal) > 100;
  out.unsteady = out.levelSpread > 6;
  out.trustworthy = !out.offPitch && !out.unsteady;
  return out;
}

// -------------------------------------------------------------- placing a take

/**
 * Line the recording up with the plan, roughly.
 *
 * The timeline is known exactly - lfomidi.js writes it from the same walk - so the one
 * unknown is when recording started. Try every offset that would line some detected clip
 * up with some expected one and keep whichever explains the most, exactly as benchcal
 * does. A clip that never sounded then costs one match rather than the take.
 */
function place(found, expected) {
  var best = { offset: 0, matched: -1, error: Infinity };

  found.forEach(function (f) {
    expected.forEach(function (e) {
      var offset = f.seconds[0] - e.from;
      var matched = 0, error = 0;

      expected.forEach(function (e2) {
        var want = e2.from + offset;
        for (var i = 0; i < found.length; i++) {
          if (Math.abs(found[i].seconds[0] - want) < 1.2) {
            matched++; error += Math.abs(found[i].seconds[0] - want); break;
          }
        }
      });

      if (matched > best.matched || (matched === best.matched && error < best.error))
        best = { offset: offset, matched: matched, error: error };
    });
  });

  return best;
}

/**
 * ...and then precisely, from where the notes actually begin.
 *
 * splitClips trims a tenth off each end of every run it finds, which is right for a
 * spectrum and wrong here: a tenth of a twelve-second clip is more than a second, and
 * the delay ladder measures from the note-on. So each note-on is looked for directly -
 * the first moment the level crosses a fifth of what that clip settles at - and the
 * median of what that says is the offset. The median rather than the mean because one
 * clip that failed to sound would otherwise drag every other measurement with it.
 */
function noteOnsets(x, rate, expected, rough) {
  var frame = Math.max(16, Math.round(rate * 0.002));
  var offsets = [];

  function rms(at, frames) {
    var sum = 0, n = 0;
    for (var i = at; i < at + frames * frame && i < x.length; i++) { sum += x[i] * x[i]; n++; }
    return n ? Math.sqrt(sum / n) : 0;
  }

  expected.forEach(function (c) {
    var centre = c.from + rough;
    var inside = rms(Math.round((centre + Math.min(0.8, c.hold * 0.3)) * rate), 200);
    if (inside <= 0) return;

    var from = Math.max(0, Math.round((centre - 1.5) * rate));
    var to = Math.min(x.length - frame, Math.round((centre + 1.5) * rate));

    for (var at = from; at < to; at += frame) {
      if (rms(at, 1) > inside * 0.2) {
        offsets.push(at / rate - c.from);
        return;
      }
    }
  });

  if (!offsets.length) return { offset: rough, from: 0, spread: null };
  offsets.sort(function (a, b) { return a - b; });

  var mid = offsets[Math.floor(offsets.length / 2)];
  return {
    offset: mid, from: offsets.length,
    spread: offsets[offsets.length - 1] - offsets[0]
  };
}

// -------------------------------------------------------------------- the report

function fmt(v, dp, width) {
  var s = (v === null || v === undefined || !isFinite(v)) ? '-' : v.toFixed(dp === undefined ? 2 : dp);
  return width ? s.padStart(width) : s;
}

/** A straight line through points, and how straight they actually were. */
function line(points) {
  var n = points.length;
  if (n < 2) return null;
  var sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
  points.forEach(function (p) {
    sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y;
  });
  var d = n * sxx - sx * sx;
  if (Math.abs(d) < 1e-12) return null;
  var slope = (n * sxy - sx * sy) / d, intercept = (sy - slope * sx) / n;
  var num = n * sxy - sx * sy;
  var den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
  return { slope: slope, intercept: intercept, r2: den > 0 ? Math.pow(num / den, 2) : 0 };
}

function analyse(file) {
  var w = cal.readWav(file);
  var run = plan.schedule();
  var expected = run.clips;
  var x = w.samples, rate = w.rate;

  console.log('');
  console.log(path.basename(file) + '  -  ' + x.length + ' samples at ' + rate +
              ' Hz, ' + (x.length / rate).toFixed(1) + 's');
  console.log('the run is ' + Math.round(run.seconds) + 's of ' + expected.length + ' clips');

  var found = cal.splitClips(x, rate, expected.length,
                             { minGapSeconds: plan.TIMING.gap * 0.5 });
  console.log('found ' + found.clips.length + ' clips, noise floor ' +
              fmt(found.floorDb, 1) + ' dB below the loudest');

  /*
   * How much of the take is against the end stop.
   *
   * Worth knowing before anything else, because clipping is invisible in every number
   * this tool prints. Frequency modulation survives it surprisingly well - a memoryless
   * nonlinearity leaves the zero crossings where they were, so the rate and the depth come
   * through - but everything to do with level is destroyed, and the distortion products
   * leak into the demodulator and make a clip look unsteady when it is not.
   *
   * A second take of this run came back with 29% of its samples at full scale. It still
   * settled the rate and the depth, and it settled nothing at all about the delay, the
   * modwheel or desync.
   */
  var clipped = 0, loud = 0;
  for (var ci = 0; ci < x.length; ci++) {
    var av = x[ci] < 0 ? -x[ci] : x[ci];
    if (av >= 0.99996) clipped++;
    else if (av > 0.891) loud++;                      // within a decibel of the top
  }
  var clippedFraction = clipped / x.length;

  // The worst clip, not the average: one clip flat for three quarters of its length is
  // the one that says how far down to turn it, and an average over a take that also holds
  // silence between the notes hides it.
  // Measured over the clips as DETECTED, which needs no alignment - this runs before the
  // take has been lined up with the plan, because how loud it was recorded is worth knowing
  // even when nothing else about it can be worked out.
  var worst = { fraction: 0, clip: null };
  found.clips.forEach(function (f, fi) {
    var c = found.clips.length === expected.length ? expected[fi] : null;
    var from = f.from, to = f.to;
    var hit = 0, n = 0;
    for (var i = Math.max(0, from); i < to && i < x.length; i++) {
      var a2 = x[i] < 0 ? -x[i] : x[i];
      if (a2 >= 0.99996) hit++;
      n++;
    }
    if (n && hit / n > worst.fraction)
      worst = { fraction: hit / n, clip: c, at: f.seconds[0] };
  });

  if (clipped / x.length > 0.001) {
    // A tone flat-topped for a fraction f of its length was that much too loud: for a ramp,
    // by 1/(1-f). Three decibels on top of that, so the retake has somewhere to put its
    // peaks rather than landing exactly on the line.
    var over = 20 * Math.log10(1 / Math.max(0.05, 1 - worst.fraction)) + 3;
    console.log('');
    console.log('  *** ' + fmt(100 * clipped / x.length, 2) + '% of this take is at or beyond full scale.');
    console.log('  The worst clip is ' + (worst.clip ? worst.clip.label
                                             : 'the one at ' + fmt(worst.at, 0) + 's') +
                ', flat for ' + fmt(100 * worst.fraction, 0) + '% of its length.');
    console.log('  Record it again at least ' + Math.max(6, Math.round(over)) +
                ' dB quieter. Rate and depth may well survive - a');
    console.log('  clipper leaves the zero crossings where they were - but every level reading');
    console.log('  below is meaningless, and the distortion leaks into the pitch track wherever');
    console.log('  the modulation is deep.');
  } else if ((clipped + loud) / x.length > 0.25) {
    console.log('  (peaks are close to full scale but nothing is clipped)');
  }

  var rough = place(found.clips, expected);
  if (rough.matched < expected.length / 2) {
    console.log('');
    console.log('  Fewer than half the clips line up. Either this is not the LFO run, or the');
    console.log('  take is cut short. Nothing below would mean anything.');
    console.log('');
    return null;
  }

  var on = noteOnsets(x, rate, expected, rough.offset);
  console.log('recording starts ' + fmt(on.offset, 3) + 's before the run, from ' +
              on.from + ' note-ons spread over ' + fmt(on.spread, 3) + 's');
  console.log(rough.matched + ' of ' + expected.length + ' clips are where the plan says');
  console.log('');

  var at = { offset: on.offset };
  var by = {};
  expected.forEach(function (c) { (by[c.analysis] = by[c.analysis] || []).push(c); });

  var results = { offset: on.offset, matched: rough.matched, found: found.clips.length,
                  onsetSpread: on.spread, clippedFraction: clippedFraction };

  // ------------------------------------------------- did it play what it was asked to
  //
  // Before any measurement, because a clip at the wrong pitch makes every number taken
  // from it meaningless, and the wrong pitch is not something a reader can see in a
  // depth of 6270 cents unless they are told to look for it.
  console.log('PITCH  (every clip, against what the plan asked for)');
  var wrong = [];
  results.pitch = expected.map(function (c) {
    // A desync clip holds two voices, and the second arriving mid-clip moves the level by
    // twenty decibels - which is not a clip going wrong, it is a clip doing what it was
    // asked. So a paired clip is checked over the stretch before its partner joins.
    var probe = c.pairWith === null || c.pairWith === undefined ? c
              : { from: c.from, to: c.from + c.stagger, sounds: c.sounds, label: c.label, note: c.note };
    var m = measure(x, rate, probe, at.offset, { skipSeconds: 0.3 });
    if (m.error) { wrong.push({ clip: c, why: m.error }); return { clip: c, error: m.error }; }
    if (!m.trustworthy) wrong.push({ clip: c, m: m });
    return { clip: c, hz: m.meanHz, cents: m.centsOffNominal,
             offPitch: m.offPitch, unsteady: m.unsteady };
  });

  if (!wrong.length) {
    console.log('  all ' + expected.length + ' clips within a semitone of the pitch the plan asks for');
  } else {
    console.log('  ' + (expected.length - wrong.length) + ' of ' + expected.length +
                ' clips played what they were asked to. These did not:');
    wrong.forEach(function (bad) {
      if (bad.why) { console.log('    note ' + bad.clip.note + '  ' + bad.why + '   ' + bad.clip.label); return; }
      console.log('    note ' + String(bad.clip.note).padStart(3) + '  asked for ' +
                  fmt(bad.clip.sounds, 1) + ' Hz, sounded at ' + fmt(bad.m.meanHz, 1) +
                  ' (' + fmt(bad.m.centsOffNominal, 0) + ' cents off)' +
                  (bad.m.unsteady ? ', and its level swings ' + fmt(bad.m.levelSpread, 1) + ' dB' : '') +
                  '   ' + bad.clip.label);
    });
    console.log('');
    console.log('  Nothing read from those clips means anything. Depths and shapes taken from');
    console.log('  them are below for completeness and should be ignored; the rate may still');
    console.log('  be right, since a wobble keeps its frequency whatever pitch it sits on.');
  }
  results.wrongPitch = wrong.length;
  console.log('');

  // ----------------------------------------------------------- rate ladder
  console.log('RATE  (byte 16, at depth 50)');
  console.log('  setting      Hz   cycles  explains   depth');
  var ratePoints = [];
  results.rate = by.rate.map(function (c) {
    var m = measure(x, rate, c, at.offset);
    var hz = m.rate ? m.rate.hz : null;
    var ok = m.rate && m.rate.explains > 0.3 && m.rate.cycles >= 2;
    console.log('    ' + String(c.setting).padStart(4) + '  ' + fmt(hz, 3, 8) +
                '  ' + fmt(m.rate ? m.rate.cycles : null, 0, 6) +
                '  ' + fmt(m.rate ? m.rate.explains : null, 2, 8) +
                '  ' + fmt(m.depthCents, 1, 7) + ' cents' + (ok ? '' : '   (not settled)'));
    // y is the rate in hertz; the octave fit below re-reads hz for itself. Storing log2
    // here and fitting THAT as the hertz law was a bug that made both fits identical and
    // printed log-space numbers as though they were hertz.
    if (ok) ratePoints.push({ x: c.setting, y: hz, hz: hz, setting: c.setting });
    return { setting: c.setting, hz: hz, ok: ok, measure: m };
  });

  /*
   * Straight in hertz, or straight in octaves?
   *
   * The filter's cutoff is exponential, so this was fitted in log2 hertz and nothing else
   * was tried. The first real take settled it the other way: in hertz the eight rungs fall
   * on a straight line to better than a fiftieth of a hertz, and in log2 hertz they plainly
   * do not. Both are fitted now and the data is allowed to say which.
   */
  var rateFit = line(ratePoints);
  var rateLog = line(ratePoints.map(function (q) { return { x: q.x, y: Math.log2(q.hz) }; }));
  results.rateFit = rateFit;
  results.rateLogFit = rateLog;
  if (rateFit && rateLog) {
    var straight = rateFit.r2 >= rateLog.r2;
    results.rateLaw = straight ? 'linear' : 'exponential';
    console.log('');
    console.log('  in hertz     a straight line fits at r2 ' + fmt(rateFit.r2, 5) + '  -  ' +
                fmt(rateFit.slope, 5) + ' Hz per unit, ' + fmt(rateFit.intercept, 3) + ' Hz at 0');
    console.log('  in log2 Hz   a straight line fits at r2 ' + fmt(rateLog.r2, 5) + '  -  ' +
                'doubling every ' + fmt(1 / rateLog.slope, 1) + ' units');
    console.log('  the ' + (straight ? 'hertz' : 'octave') + ' fit is the straighter, so the rate is ' +
                (straight ? 'linear in the byte' : 'exponential in the byte') + ':');
    console.log('    byte 0 -> ' + fmt(straight ? rateFit.intercept : Math.pow(2, rateLog.intercept), 3) +
                ' Hz,  byte 99 -> ' +
                fmt(straight ? rateFit.slope * 99 + rateFit.intercept
                             : Math.pow(2, rateLog.intercept + 99 * rateLog.slope), 3) + ' Hz');
    if (Math.max(rateFit.r2, rateLog.r2) < 0.98)
      console.log('  neither fits well: the law is neither, and wants the table rather than a line');
  }
  console.log('');

  // ---------------------------------------------------------- depth ladder
  console.log('DEPTH  (byte 17, at rate ' + plan.MID_RATE + ')');
  console.log('  setting     cents   read from       peak   level       Hz');
  var depthPoints = [];
  results.depth = by.depth.map(function (c) {
    var m = measure(x, rate, c, at.offset);
    console.log('    ' + String(c.setting).padStart(4) + '  ' + fmt(m.depthCents, 2, 9) +
                '  ' + (m.depthFrom || '-').padEnd(15) + fmt(m.peakCents, 2, 6) +
                '  ' + fmt(m.levelPeakDb, 2, 6) + ' dB' + '  ' + fmt(m.rate ? m.rate.hz : null, 2, 6));
    if (c.setting > 0 && m.pitchExplains > 0.3 && m.trustworthy)
      depthPoints.push({ x: c.setting, y: m.depthCents });
    return { setting: c.setting, cents: m.depthCents, measure: m };
  });

  var depthFit = line(depthPoints);
  results.depthFit = depthFit;
  if (depthFit) {
    console.log('');
    console.log('  ' + fmt(depthFit.slope, 3) + ' cents per unit, r2 ' + fmt(depthFit.r2, 4) +
                ', so depth 99 is ' + fmt(depthFit.slope * 99 + depthFit.intercept, 1) + ' cents peak');
    if (Math.abs(depthFit.intercept) > 3)
      console.log('  the line misses zero by ' + fmt(depthFit.intercept, 1) +
                  ' cents, so the law is not proportional');
  }
  console.log('');

  // ---------------------------------------------------------- delay ladder
  console.log('DELAY  (byte 15, at rate ' + plan.MID_RATE + ' and full depth)');
  console.log('  byte   leaves flat   quarter      half      full depth     depth');
  var delayPoints = [];
  results.delay = by.delay.map(function (c) {
    // the front of this clip is the measurement, so almost none of it is skipped, and
    // the rate is read from the back where the modulation is certainly running
    var m = measure(x, rate, c, at.offset, { skipSeconds: 0.01, steadyFrom: c.hold * 0.55 });
    var o = null;
    if (m.track && m.rate)
      o = onset(m.track.cents, 0, m.track.cents.length, m.rate.hz, m.track.frameRate, m.depthCents);
    console.log('  ' + String(c.setting).padStart(4) +
                fmt(o && o.leaves, 3, 13) + 's' + fmt(o && o.quarter, 3, 11) + 's' +
                fmt(o && o.half, 3, 10) + 's' + fmt(o && o.full, 3, 12) + 's' +
                fmt(m.depthCents, 1, 10));
    if (o && o.full !== null && o.full !== undefined && m.trustworthy)
      delayPoints.push({ x: c.setting, y: o.full });
    return { setting: c.setting, leaves: o && o.leaves, half: o && o.half,
             full: o && o.full, measure: m };
  });

  var delayFit = line(delayPoints);
  /*
   * And against one over what is left of the range.
   *
   * A straight line fits the delay at r2 0.52 and the log of it at 0.78, which is to say
   * neither. Against 1/(100 - byte) it fits at r2 0.99998: the fade time is a constant
   * divided by how far the setting is from the top, which is what a control that idles for
   * three quarters of its travel and then runs away looks like when it is written down.
   */
  var delayRecip = line(delayPoints.map(function (q) {
    return { x: 1 / Math.max(1, 100 - q.x), y: q.y };
  }));
  results.delayFit = delayFit;
  results.delayRecipFit = delayRecip;
  if (delayFit) {
    console.log('');
    console.log('  it is a fade-in, not a wait: each column is when the wobble reached that');
    console.log('  fraction of its final depth, so "full depth" is how long the fade takes.');
    console.log('');
    console.log('  against the byte            a straight line fits at r2 ' + fmt(delayFit.r2, 4));
    if (delayRecip)
      console.log('  against 1/(100 - byte)      it fits at r2 ' + fmt(delayRecip.r2, 5) +
                  '   -   ' + fmt(delayRecip.slope, 3) + '/(100-b) + ' +
                  fmt(delayRecip.intercept, 3) + ' seconds');
    if (delayRecip && delayRecip.r2 > Math.max(0.9, delayFit.r2)) {
      console.log('  so the fade time is a constant divided by how far the setting is from the');
      console.log('  top: idle for three quarters of the travel, then away it goes.');
    } else if (delayFit.r2 < 0.9) {
      console.log('  which is not a fit, and nor is the reciprocal. The table above IS the answer.');
    }
  }
  console.log('');

  // ----------------------------------------------------------------- shape
  console.log('SHAPE');
  var shapeClip = by.shape && by.shape[0];
  if (shapeClip) {
    var ms = measure(x, rate, shapeClip, at.offset);
    results.shape = ms;
    if (ms.shape && ms.shape.length) {
      console.log('  ' + fmt(ms.rate ? ms.rate.hz : null, 3) + ' Hz, ' +
                  fmt(ms.depthCents, 1) + ' cents, over ' +
                  (ms.rate ? ms.rate.cycles : 0) + ' cycles');
      console.log('  looks most like a ' + ms.shape[0].name + ' (r ' + fmt(ms.shape[0].r, 3) +
                  '), then ' + ms.shape[1].name + ' (r ' + fmt(ms.shape[1].r, 3) + ')');
      if (ms.shape[0].r < 0.97)
        console.log('  no template fits well - the shape is its own thing, and the cycle below is the answer');
      console.log('');
      draw(ms.fold.cycle).forEach(function (l) { console.log(l); });
      console.log('    one cycle, ' + fmt(ms.fold.min, 1) + ' to ' + fmt(ms.fold.max, 1) + ' cents');
    } else {
      console.log('  nothing periodic found');
    }
  }
  console.log('');

  // ------------------------------------------------------- what it moves
  console.log('WHAT IT MOVES  (a sine at full depth)');
  var whatClip = by.what && by.what[0];
  if (whatClip) {
    var mw = measure(x, rate, whatClip, at.offset);
    results.what = mw;
    console.log('  pitch  ' + fmt(mw.depthCents, 2) + ' cents');
    console.log('  level  ' + fmt(mw.levelPeakDb, 2) + ' dB peak to peak, and ' +
                fmt(mw.levelDb, 2) + ' dB of that at the LFO frequency exactly');
    console.log('  the wobble was found in the ' + mw.heardIn);
    console.log(Math.abs(mw.levelPeakDb) < 0.5
      ? '  so it is vibrato: the level does not follow the pitch'
      : '  the level moves with the pitch (' +
        fmt(mw.depthCents > 0 ? mw.levelPeakDb / mw.depthCents : 0, 3) +
        ' dB per cent) - worth explaining before it is modelled');
  }
  console.log('');

  // ---------------------------------------------------------- timbre check
  console.log('TIMBRE CHECK');
  var tClip = by.timbre && by.timbre[0];
  if (tClip) {
    var mt = measure(x, rate, tClip, at.offset);
    results.timbre = mt;
    var against = results.depth.filter(function (d) { return d.setting === tClip.setting; })[0];
    console.log('  pulse at depth ' + tClip.setting + ': ' + fmt(mt.depthCents, 2) + ' cents, ' +
                fmt(mt.rate ? mt.rate.hz : null, 3) + ' Hz');
    if (against) {
      var diff = mt.depthCents - against.cents;
      var tol = Math.max(1, Math.abs(against.cents) * 0.05);
      console.log('  sawtooth at the same setting read ' + fmt(against.cents, 2) + ' cents');
      if (Math.abs(diff) < tol) {
        console.log('  they agree to ' + fmt(Math.abs(diff), 2) +
                    ' cents, so the reading is of the machine and not of the waveform');
      } else {
        console.log('  they differ by ' + fmt(diff, 2) + ' cents, which is the measurement');
        console.log('  disagreeing with itself - treat every depth here as that uncertain');
      }
    }
  }
  console.log('');

  // -------------------------------------------------------------- modwheel
  console.log('MODWHEEL  (byte 22, keygroup depth 0)');
  var wheelClip = by.wheel && by.wheel[0];
  results.wheel = [];

  // The wheel section reads a fundamental and has to turn it into a peak, which needs
  // the waveform. It used to assume a triangle, which was a guess dressed as a constant;
  // the machine turned out to run a sine, and the difference is 23%. Take the shape the
  // shape section actually found, and say so when there is none to take.
  var wheelShape = (results.shape && results.shape.shape && results.shape.shape.length &&
                    results.shape.shape[0].r > 0.95) ? results.shape.shape[0] : null;
  var wheelCrest = wheelShape ? wheelShape.crest : SHAPES.sine.crest;
  if (wheelClip) {
    var t2 = demodulate(x, rate, Math.round((wheelClip.from + at.offset + 0.02) * rate),
                        Math.round((wheelClip.to + at.offset - 0.1) * rate), wheelClip.sounds);
    if (t2) {
      // the rate, from the back of the clip where the wheel is all the way up
      var steady = findRate(t2.cents, Math.round(t2.frameRate * (wheelClip.hold * 0.6)),
                            t2.cents.length, t2.frameRate);
      var lfoHz = steady ? steady.hz : null;
      if (!lfoHz) {
        console.log('  no steady wobble at the top of the wheel - nothing to read');
      } else {
        var fix = 1 / Math.max(0.2, t2.response(lfoHz));
        console.log('  wheel    cents   (the LFO is at ' + fmt(lfoHz, 2) + ' Hz)');
        wheelClip.cc.forEach(function (step, i) {
          var next = wheelClip.cc[i + 1];
          var s0 = step.at + 0.35, s1 = (next ? next.at : wheelClip.hold) - 0.05;
          if (s1 - s0 < 0.4) return;
          var f0 = Math.round(s0 * t2.frameRate), f1 = Math.round(s1 * t2.frameRate);
          if (f1 > t2.cents.length) f1 = t2.cents.length;
          if (f1 - f0 < 8) return;

          // whole cycles only, for the same reason findRate trims
          var per = t2.frameRate / lfoHz;
          f1 = f0 + Math.max(1, Math.floor((f1 - f0) / per)) * Math.round(per);
          if (f1 > t2.cents.length) return;

          var b = bin(t2.cents, f0, f1, lfoHz, t2.frameRate);
          var cents = b.amp * fix / wheelCrest;
          console.log('    ' + String(step.value).padStart(4) + '  ' + fmt(cents, 2, 8));
          results.wheel.push({ cc: step.value, cents: cents, sine: b.amp * fix });
        });

        var wheelFit = line(results.wheel.map(function (p) { return { x: p.cc, y: p.cents }; }));
        results.wheelFit = wheelFit;
        if (wheelFit)
          console.log('  ' + fmt(wheelFit.slope * 127, 2) +
                      ' cents across the whole wheel at byte 22 = 99, r2 ' + fmt(wheelFit.r2, 3));
        console.log('  (read as a ' + (wheelShape ? wheelShape.name : 'sine, for want of anything better') +
                    ', which is what the shape section found)');
      }
    }
  }

  var halfClip = by.wheelhalf && by.wheelhalf[0];
  if (halfClip) {
    var mh = measure(x, rate, halfClip, at.offset);
    results.wheelHalf = mh;
    console.log('  wheel 127 at byte 22 = 50: ' + fmt(mh.depthCents, 2) + ' cents');
    if (results.wheel.length) {
      var full = results.wheel[results.wheel.length - 1];
      console.log('  against ' + fmt(full.cents, 2) + ' at byte 22 = 99, a ratio of ' +
                  fmt(full.cents > 0 ? mh.depthCents / full.cents : 0, 3) +
                  ' where proportional would be 0.505');
    }
  }
  console.log('');

  // --------------------------------------------------------------- desync
  console.log('DESYNC  (bit 2 of byte 18)');
  results.desync = (by.desync || []).map(function (c) {
    // Both voices over the stretch where they overlap. The averaging is set to null the
    // LOWER of the two for both readings: one period of 250 Hz nulls 250 and 1000 alike,
    // where one period of 1000 would leave the lower voice only 10 dB down.
    // Only where the two overlap. The clip runs until the LATER voice releases, so
    // reading to the end of it would spend the last second and a half demodulating a
    // lower voice that has already stopped - which is what made an earlier version
    // report that there was no steady wobble to compare.
    var from = Math.round((c.from + at.offset + c.stagger + 0.35) * rate);
    var to = Math.round((c.from + at.offset + c.hold - 0.1) * rate);
    var lower = demodulate(x, rate, from, to, c.sounds, c.sounds);
    var upper = demodulate(x, rate, from, to, c.sounds * 4, c.sounds);

    if (!lower || !upper) { console.log('  ' + c.label + ': could not read both voices'); return null; }

    var r = findRate(lower.cents, 0, lower.cents.length, lower.frameRate);
    if (!r || r.explains < 0.3) { console.log('  ' + c.label + ': no steady wobble to compare'); return null; }

    var a = bin(lower.cents, r.from, r.to, r.hz, lower.frameRate);
    var b = bin(upper.cents, r.from, r.to, r.hz, upper.frameRate);
    var deg = (b.phase - a.phase) * 180 / Math.PI;
    while (deg > 180) deg -= 360;
    while (deg < -180) deg += 360;

    var crest = (results.shape && results.shape.shape && results.shape.shape.length &&
                 results.shape.shape[0].r > 0.95) ? results.shape.shape[0].crest : SHAPES.sine.crest;
    console.log('  ' + c.label.padEnd(12) + '  ' + fmt(r.hz, 2) + ' Hz,  lower ' +
                fmt(a.amp / crest, 1) + ' cents, upper ' + fmt(b.amp / crest, 1) + ' cents,  ' +
                fmt(deg, 0) + ' degrees apart' +
                (b.amp / crest < a.amp / crest * 0.3
                   ? '   (the upper voice is barely modulated - it may not have sounded)' : ''));
    return { label: c.label, hz: r.hz, degrees: deg, lower: a.amp, upper: b.amp };
  }).filter(Boolean);

  if (results.desync.length === 2) {
    var offDeg = Math.abs(results.desync[0].degrees), onDeg = Math.abs(results.desync[1].degrees);
    var stagger = by.desync[0].stagger;
    var wouldBe = (360 * results.desync[0].hz * stagger) % 360;
    console.log('');
    if (offDeg < 25 && onDeg > 45)
      console.log('  desync off holds the two voices together and desync on does not.');
    else if (offDeg < 25 && onDeg < 25)
      console.log('  both are in phase: the flag did not change what these two voices did.');
    else if (offDeg > 45 && onDeg > 45) {
      console.log('  neither is in phase, so either both voices free-run or the flag');
      console.log('  means something else entirely.');
    } else
      console.log('  neither reading is clean enough to call.');
    console.log('  the voices started ' + fmt(stagger, 2) + 's apart, which at ' +
                fmt(results.desync[0].hz, 2) + ' Hz is ' + fmt(wouldBe, 0) +
                ' degrees of the LFO - that is what two free-running voices would show.');
  }
  console.log('');

  // ----------------------------------------------------------- what to paste
  console.log('---------------------------------------------------------------');
  console.log('for audio.js, once there is an LFO for it to go in:');
  console.log('');
  console.log('  var LFO = {');
  if (rateFit && rateLog && results.rateLaw === 'linear') {
    console.log('    // measured: ' + ratePoints.length + ' rungs on a straight line in hertz, r2 ' +
                fmt(rateFit.r2, 5));
    console.log('    RATE_HZ_AT_ZERO: ' + rateFit.intercept.toFixed(3) + ',');
    console.log('    RATE_HZ_PER_UNIT: ' + rateFit.slope.toFixed(5) + ',');
  } else if (rateFit) {
    console.log('    // measured: ' + ratePoints.length + ' of the ladder settled, r2 ' + fmt(rateFit.r2, 4));
    console.log('    RATE_CURVE: [' + ratePoints.map(function (q) {
      return '[' + q.setting + ', ' + q.hz.toFixed(3) + ']';
    }).join(', ') + '],');
  } else {
    console.log('    // the rate ladder did not settle - nothing to write');
  }
  if (depthFit) {
    console.log('    // measured: r2 ' + fmt(depthFit.r2, 4) + ' across the ladder');
    console.log('    DEPTH_CENTS_PER_UNIT: ' + depthFit.slope.toFixed(3) + ',');
  }
  if (delayFit && delayFit.r2 >= 0.9) {
    console.log('    // measured: r2 ' + fmt(delayFit.r2, 4) + ' across the ladder');
    console.log('    DELAY_SECONDS_PER_UNIT: ' + delayFit.slope.toFixed(4) + ',');
  } else if (results.delayRecipFit && results.delayRecipFit.r2 > 0.98) {
    console.log('    // measured: the fade time, r2 ' + fmt(results.delayRecipFit.r2, 5) +
                ' against 1/(100 - byte)');
    console.log('    DELAY_FADE_CONSTANT: ' + results.delayRecipFit.slope.toFixed(3) +
                ',   // seconds = this / (100 - byte)');
  } else if (results.delay) {
    console.log('    // measured: seconds for the wobble to fade in. No line fits it, so these');
    console.log('    // are the readings themselves, to interpolate between.');
    console.log('    DELAY_FADE_SECONDS: [' + results.delay.filter(function (d) {
      return d.full !== null && d.full !== undefined;
    }).map(function (d) {
      return '[' + d.setting + ', ' + d.full.toFixed(3) + ']';
    }).join(', ') + '],');
  }
  if (results.wheelFit)
    console.log('    WHEEL_CENTS_AT_FULL: ' + (results.wheelFit.slope * 127).toFixed(2) +
                ',   // at byte 22 = 99');
  if (results.shape && results.shape.shape && results.shape.shape.length)
    console.log("    SHAPE: '" + results.shape.shape[0].name + "',   // r " +
                fmt(results.shape.shape[0].r, 3));
  console.log('  };');
  console.log('');

  return results;
}

module.exports = {
  demodulate: demodulate, findCarrier: findCarrier, findRate: findRate,
  fold: fold, identify: identify, onset: onset, bin: bin, measure: measure,
  place: place, noteOnsets: noteOnsets, line: line, analyse: analyse, draw: draw,
  SHAPES: SHAPES, sinc: sinc, FRAME_RATE: FRAME_RATE
};

if (require.main === module) {
  var file = process.argv[2];
  if (!file) {
    console.log('');
    console.log('usage: node lfocal.js <take.wav>');
    console.log('');
    console.log('the take is AkaiLfoCalibration.mid played through LFOCAL - see lfoplan.js.');
    console.log('build the disk and the file with:');
    console.log('  node tools/lfodisk.js build');
    console.log('  node tools/lfomidi.js');
    console.log('');
    process.exit(1);
  }
  analyse(file);
}
