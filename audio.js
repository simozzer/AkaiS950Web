/*
 * Audio conversion for the browser build.
 *
 * Decoding and rate conversion are left to the platform - decodeAudioData reads
 * whatever the browser reads, and an OfflineAudioContext resamples better than
 * anything worth hand-writing. Time stretching has no platform equivalent, so
 * that one is implemented here.
 */
var AkaiAudio = (function () {
  'use strict';

  /** Rates the corpus shows the S950 writing, minus the one-off oddities. */
  var RATES = [12500, 17500, 20000, 22050, 22500, 23750, 25000, 27500, 30000,
               32500, 33750, 35000, 36250, 37500, 38750, 40000, 44100];

  // The slowest the S950 will run. Confirmed on the hardware; the library's own samples
  // bottom out at 11,773 Hz but the sampler itself goes lower.
  var MIN_RATE = 7500;

  var SILENCE_THRESHOLD = 8;          // about -48 dB of the 12-bit range

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function offline(channels, frames, rate) {
    var C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    return new C(channels, Math.max(1, Math.round(frames)), rate);
  }

  /** Decodes any format the browser supports into an AudioBuffer. */
  function decode(ac, arrayBuffer) {
    return ac.decodeAudioData(arrayBuffer);
  }

  /**
   * Mixes to mono and converts to the target rate, taking only the first
   * `seconds` of the source. The output frame count is chosen here rather than
   * inferred, so the size shown in the dialog is exactly what gets written.
   */
  function toMono(buffer, rate, seconds, frames) {
    var want = frames !== undefined ? frames
             : Math.floor(Math.min(seconds, buffer.duration) * rate) & ~1;

    var off = offline(1, Math.max(2, want), rate);
    var src = off.createBufferSource();
    src.buffer = buffer;
    src.connect(off.destination);
    src.start();
    return off.startRendering();
  }

  /** Quantises to signed 12-bit, optionally normalising first. */
  function to12Bit(data, normalise) {
    var peak = 0;
    for (var i = 0; i < data.length; i++) {
      var a = Math.abs(data[i]);
      if (a > peak) peak = a;
    }
    var gain = (normalise && peak > 1e-7) ? 1 / peak : 1;

    var out = new Int16Array(data.length & ~1);
    for (i = 0; i < out.length; i++)
      out[i] = clamp(Math.round(data[i] * gain * 2047), -2048, 2047);
    return out;
  }

  /** Wraps stored 12-bit words as an AudioBuffer, for resampling or playback. */
  function bufferOf(ac, words, rate) {
    var buf = ac.createBuffer(1, Math.max(1, words.length), clamp(rate, 3000, 96000));
    var ch = buf.getChannelData(0);
    for (var i = 0; i < words.length; i++) ch[i] = words[i] / 2048;
    return buf;
  }

  /**
   * Halves a sample's rate: half the words for half the disk space, with the
   * resampler's filter keeping the discarded top octave from folding back.
   */
  function halveRate(words, rate) {
    var off = offline(1, Math.ceil(words.length / 2), Math.max(3000, rate / 2));
    var src = off.createBufferSource();
    src.buffer = bufferOf(off, words, rate);
    src.connect(off.destination);
    src.start();
    return off.startRendering().then(function (r) {
      return to12Bit(r.getChannelData(0), false);
    });
  }

  /** Resamples stored words to a new rate, keeping the same duration. */
  function resample(words, fromRate, toRate) {
    var frames = Math.max(2, Math.round(words.length * toRate / fromRate)) & ~1;
    var off = offline(1, frames, clamp(toRate, 3000, 96000));
    var src = off.createBufferSource();
    src.buffer = bufferOf(off, words, fromRate);
    src.connect(off.destination);
    src.start();
    return off.startRendering().then(function (r) {
      return to12Bit(r.getChannelData(0), false);
    });
  }

  /**
   * Stretches or compresses in time without moving the pitch, by overlap-adding
   * windowed frames at a different spacing than they were taken. Each frame is
   * nudged within a search window to the offset that best continues the waveform
   * already written, which is what stops the joins phasing (WSOLA).
   * `ratio` is output length over input length.
   */
  function timeStretch(words, ratio) {
    if (!words.length) return new Int16Array(0);
    if (Math.abs(ratio - 1) < 1e-9) return words.slice();

    var src = new Float32Array(words.length);
    for (var i = 0; i < src.length; i++) src[i] = words[i] / 2048;

    var FRAME = 1024, SEEK = 256;
    var hopOut = FRAME / 2;
    var hopIn = hopOut / ratio;

    var outLen = Math.max(2, Math.floor(src.length * ratio));
    var acc = new Float32Array(outLen + FRAME);
    var win = hann(FRAME);

    var inPos = 0, follow = 0;

    for (var outPos = 0; outPos + FRAME <= acc.length; outPos += hopOut) {
      var at = Math.round(inPos);
      if (outPos > 0) at = bestJoin(src, follow, at, SEEK, hopOut);

      if (at < 0) at = 0;
      if (at + FRAME > src.length) break;

      for (var k = 0; k < FRAME; k++) acc[outPos + k] += src[at + k] * win[k];

      follow = at + hopOut;
      inPos += hopIn;
    }

    var out = new Int16Array(outLen & ~1);
    for (i = 0; i < out.length; i++)
      out[i] = clamp(Math.round(acc[i] * 2048), -2048, 2047);
    return out;
  }

  /**
   * The offset near `centre` whose waveform best continues what the previous
   * frame was about to do. Sampled rather than summed over every point: the peak
   * is broad, and this runs while a dialog is open.
   */
  function bestJoin(src, follow, centre, seek, len) {
    if (follow + len > src.length) return centre;

    var best = centre, bestScore = -Infinity;
    for (var d = -seek; d <= seek; d += 2) {
      var c = centre + d;
      if (c < 0 || c + len > src.length) continue;

      var sum = 0;
      for (var i = 0; i < len; i += 4) sum += src[follow + i] * src[c + i];
      if (sum > bestScore) { bestScore = sum; best = c; }
    }
    return best;
  }

  /**
   * Where a sample can loop.
   *
   * The S950 holds a loop as an end point and a length and plays end-length .. end over
   * and over - the library bears that out: of its 324 looped samples the loop start field
   * is simply 0 in 250 of them, and the length is what says where the loop begins. So the
   * only thing to find is how far back it restarts.
   *
   * The join the ear hears is the one from the loop end back to that point, so the point
   * to look for is the one whose approach looks like the approach to the end. That is a
   * normalised cross-correlation of the window ending at the loop end against the window
   * ending at each candidate: coarse over a decimated stride first, then exact around the
   * best few. Normalised, so a decaying tail is compared on shape rather than on level.
   *
   * Returns { length, from, end, match, tried }. `match` is -1..1 and is what the summary
   * reports: a sustained note joins inaudibly around 0.95 and up, while a sample with no
   * steady part in it cannot do better than its own noise and says so by scoring low.
   */
  function findLoop(words, opts) {
    opts = opts || {};
    var end = Math.min(opts.end === undefined ? words.length : opts.end, words.length);
    var minLen = Math.max(32, Math.floor(opts.minLength || 64));
    var maxLen = Math.floor(opts.maxLength || end);

    // the window has to fit behind the earliest candidate, and be long enough that a
    // match means the shape agrees rather than a couple of samples agreeing
    var win = Math.min(2048, Math.max(128, minLen >> 1));
    var lowest = Math.max(minLen, win);
    var highest = Math.min(maxLen, end - win);
    if (end < win * 2 || highest < lowest) return null;

    /** Normalised correlation of the two windows ending at `end` and at `at`. */
    function score(buf, at, endAt, w) {
      var dot = 0, ea = 0, eb = 0;
      for (var i = 0; i < w; i++) {
        var x = buf[endAt - w + i], y = buf[at - w + i];
        dot += x * y; ea += x * x; eb += y * y;
      }
      var d = Math.sqrt(ea * eb);
      return d > 0 ? dot / d : -1;
    }

    // The coarse pass runs on a properly decimated copy - each point the mean of D
    // samples, not every Dth sample. Striding instead aliases, and on bright material
    // that turned a clean loop into noise and hid it: a bird call in the library has a
    // 0.97 join at 805 words that a strided search walked straight past.
    var D = 8;
    var small = new Float32Array(Math.floor(end / D));
    for (var j = 0; j < small.length; j++) {
      var sum = 0;
      for (var k = 0; k < D; k++) sum += words[j * D + k];
      small[j] = sum / D;
    }

    // short enough to stay cheap, long enough to mean something: sixteen points of a
    // decimated bird call correlate with almost anything
    var smallWin = Math.max(64, Math.floor(win / D));
    var smallEnd = Math.floor(end / D);
    var peaks = [], tried = 0;
    for (var len = lowest; len <= highest; len += D) {
      var at = Math.floor((end - len) / D);
      if (at < smallWin) continue;
      peaks.push({ len: len, r: score(small, at, smallEnd, smallWin) });
      tried++;
    }
    if (!peaks.length) return null;

    // Take the best few, but from different hills. Sorting and slicing gathers up the
    // neighbours of one peak - adjacent candidates score alike - so the exact pass would
    // polish a single region and never look at the rest. Keeping them apart is what
    // finds a short clean loop hiding under a long mediocre one.
    peaks.sort(function (x, y) { return y.r - x.r; });
    var apart = Math.max(4 * D, win >> 1), keep = [];
    for (var p = 0; p < peaks.length && keep.length < 24; p++) {
      var far = true;
      for (var q = 0; q < keep.length; q++)
        if (Math.abs(keep[q].len - peaks[p].len) < apart) { far = false; break; }
      if (far) keep.push(peaks[p]);
    }
    peaks = keep;

    // exact: every candidate around each of the best few, at full rate
    var best = null;
    peaks.forEach(function (p) {
      for (var len = p.len - D; len <= p.len + D; len++) {
        if (len < lowest || len > highest) continue;
        var r = score(words, end - len, end, win);
        tried++;
        if (!best || r > best.r) best = { len: len, r: r };
      }
    });
    if (!best) return null;

    // A sample count must be even, and so must the point a loop restarts at: the sampler
    // reads words in pairs. Round to whichever even length joins better.
    if (best.len % 2) {
      var up = best.len + 1 <= highest ? score(words, end - best.len - 1, end, win) : -2;
      var down = best.len - 1 >= lowest ? score(words, end - best.len + 1, end, win) : -2;
      best = up >= down ? { len: best.len + 1, r: up } : { len: best.len - 1, r: down };
    }

    return { length: best.len, from: end - best.len, end: end, match: best.r, tried: tried };
  }

  /**
   * Where a complex sample should be cut into one-shots.
   *
   * A peak envelope on a short hop, tracked by a decaying peak-follower. A slice starts
   * where the envelope jumps above the follower by more than the rise ratio, is loud
   * enough in absolute terms, and is far enough from the previous slice. No FFT: on a
   * mono 12-bit break, an energy rise is what the ear is calling a hit anyway.
   *
   * `sensitivity` is 0..100 and moves two things at once - how big a jump has to be, and
   * how quiet a hit may be - because separating them gives the user two dials that only
   * make sense together. 50 lands on the eighths and sixteenths of a breakbeat.
   *
   * Returns the start of each slice, always beginning at 0 and always even, since a
   * sample's word count must be.
   */
  function detectSlices(words, rate, opts) {
    opts = opts || {};
    var sens = clamp(opts.sensitivity === undefined ? 50 : opts.sensitivity, 0, 100);
    var minMs = opts.minSliceMs === undefined ? 40 : opts.minSliceMs;

    var hop = Math.max(8, Math.round(rate * 0.004));           // ~4 ms
    var minGap = Math.max(hop, Math.round(rate * minMs / 1000));
    var rise = 3.0 - 2.3 * (sens / 100);                       // 3.0x at 0, 0.7x at 100
    var floorFrac = 0.16 - 0.14 * (sens / 100);                // of the overall peak

    var n = Math.floor(words.length / hop);
    if (n < 2) return [0];

    var env = new Float64Array(n), peak = 0;
    for (var i = 0; i < n; i++) {
      var m = 0;
      for (var j = i * hop; j < (i + 1) * hop; j++) {
        var a = words[j] < 0 ? -words[j] : words[j];
        if (a > m) m = a;
      }
      env[i] = m;
      if (m > peak) peak = m;
    }

    var decay = Math.exp(-hop / (rate * 0.090));               // ~90 ms follower
    var floorAbs = peak * floorFrac;
    var out = [], follow = 0, last = -minGap;

    for (var i = 0; i < n; i++) {
      var at = i * hop;
      if (env[i] > floorAbs && env[i] > follow * rise && at - last >= minGap) {
        // walk back to where the hit actually starts rising, so the transient is kept
        var st = at;
        while (st > 0 && st > at - hop * 3 &&
               (words[st - 1] < 0 ? -words[st - 1] : words[st - 1]) < env[i] * 0.25) st--;
        out.push(st & ~1);
        last = at;
      }
      follow = Math.max(env[i], follow * decay);
    }

    if (!out.length || out[0] > minGap) out.unshift(0); else out[0] = 0;
    return out;
  }

  // ------------------------------------------------------------------- the VCF
  //
  // The S950's filter is a 6th-order Butterworth low-pass, 36 dB per octave. That much is
  // exactly reproducible: three cascaded biquads whose Q values are the Butterworth pole
  // Qs, 0.5176, 0.7071 and 1.9319. vcftest.js measures the result - flat passband, -3.01 dB
  // at cutoff, -36 dB per octave below it.
  //
  // What is NOT known is the frequency axis. The disks store the cutoff as 0..99 per zone,
  // the envelope amount as +/-50 and the two tracking amounts as 0..99, and nothing on any
  // disk says what those mean in hertz or seconds. Every constant in CAL below is therefore
  // a stated assumption, not a measured fact - the shape of the filter is right, where it
  // sits is approximate. vcfcal.js derives the real numbers from recordings of the hardware;
  // until that is done, treat this as a guide to the character rather than a replica.
  //
  // It is a monitoring filter only. The sampler applies its own filter live from the stored
  // parameters, so nothing here is ever written to a sample.

  // Measured on the hardware, from one take of AkaiCalibration.mid played through the
  // CALIB programme. What the ladder showed is that the cutoff does not sweep freely
  // across the stored 0..99 at all - it runs into a stop at each end:
  //
  //     stored    0     20     40      60      80      99
  //     corner  311    310   1139    4813   16312   16309  Hz
  //
  // 0 and 20 give an identical curve and so do 80 and 99, because the filter will not
  // close below about 311 Hz nor open past the reconstruction limit. Between those it
  // moves 0.104 octaves per stored unit, which is 10.3 octaves over the range - far",
  // wider than the travel, so most of the control does nothing at either end.
  //
  // BASE_HZ and OCT_PER_UNIT describe that notional line; FLOOR_HZ and MAX_RATIO are the
  // stops. Together they reproduce all six measurements.
  //
  // KEY_FULL is the firmest result of the lot: playing one keygroup at C3, C4 and C5 with
  // keyToFilter at 50 moved the cutoff 0.987 octaves per octave of keyboard, over three
  // points lying on a straight line to within 0.05 of an octave. So 50 is one-for-one
  // tracking, and the panel reading 0 as "Off" fits: the value is a percentage in halves.
  // An earlier reading of this project had it at 99, inferred from how the library uses
  // the byte, and that was simply wrong.
  var CAL = {
    MAX_RATIO: 0.37,      // measured: 16311 Hz at 44100, and 16232 on an earlier take
    FLOOR_HZ: 311,        // measured: the cutoff will not close below this
    // Measured points, not a formula. Fitting one exponential through the ladder's two
    // unsaturated points put a stored 50 at 2355 Hz; the key-tracking clip, which uses
    // exactly that setting, measured 1878. The curve steepens as it climbs - 0.072
    // octaves per unit from 40 to 50, then 0.136 from 50 to 60 - so a straight line in
    // log space is the wrong shape and a table of what was actually measured is right.
    //
    // Between points it interpolates in log frequency, which is the least-wrong thing to
    // do where nothing was measured. The gaps at 20-40 and 60-80 are the places to aim a
    // finer ladder if this is ever worth another take.
    // null means "as far open as it goes" - the reconstruction limit, which moves with
    // the sample rate. The 80 and 99 points measured 16310 Hz, but that is simply what
    // the ceiling was at 44.1 kHz; writing the number would wrongly cap a 48 kHz sample
    // below what its own ceiling allows.
    CURVE: [[0, 311], [20, 311], [40, 1139], [50, 1878], [60, 4808], [80, null], [99, null]],
    KEY_FULL: 50,         // measured: keyToFilter 50 is 1:1 tracking

    // Velocity does not only open the filter - it pivots about a middling velocity and
    // CLOSES it below that. Measured on a keygroup based at stored 40 (1139 Hz) with
    // velToFilter 99: velocity 70 read 1434 Hz, a third of an octave above the base,
    // and velocity 120 read 13965 Hz, 3.62 above. That is 0.0657 octaves per velocity
    // step - 8.34 over the full 127 - crossing the base at velocity 65. Velocity 20 is
    // then predicted 2.95 octaves BELOW the base, which is under the 311 Hz floor, and
    // the clip duly measured 312: at the stop, exactly as it should be.
    //
    // The span was already right. Modelling it as opening only, from silence upward,
    // was what put the emulation at its ceiling by velocity 70 where the machine was
    // still down at 1434 Hz.
    VEL_OCTAVES: 8.34,    // measured: octaves across the full velocity range
    VEL_PIVOT: 65,        // measured: the velocity that leaves the filter where it is
    // 3.08 octaves at amount 25, doubled. Rendering the model through the same
    // measurement reads 2.24 for the same setting, and the difference is shape rather
    // than depth: at 0.13 s the hardware is still near its peak where this model has
    // already begun falling. The segments here are straight lines; the machine holds and
    // then drops, as its amplitude envelope does in decibels. That is the largest thing
    // still wrong with the emulation.
    // BOTH clips start against the ceiling, so neither shows its own peak - the run bases
    // the test at stored 40, 1139 Hz, which leaves only 3.8 octaves of headroom below the
    // 16.3 kHz stop and the envelope needs twice that. Reading the traces where they start
    // saying anything, they are 15671 Hz at both amounts, which is the stop and not a
    // measurement.
    //
    // The depth still comes out, from the slope rather than the peak. Below the stop the
    // sweep falls in a straight line in octaves and reaches its base at 2.25 s either way,
    // so slope x time is the depth:
    //
    //     amount 25   1.72 octaves/s over 2.25 s  ->  3.87, so 7.7 at full
    //     amount 50   3.36 octaves/s over 2.25 s  ->  7.56 at full
    //
    // Two independent readings agreeing to 2% - and settling in passing that the depth IS
    // linear in the amount, which the report doubts only because it compares the two
    // clipped peaks. The next take should base this test near the floor instead, where
    // there is room to see the whole sweep.
    ENV_OCTAVES: 7.6,     // measured: from the slope, both amounts agreeing

    // The whole envelope scale sits about 1.7x slower than first assumed. That earlier
    // reading measured time from where the clip was trimmed, and the trimmer looks for a
    // run of sound rather than an edge - it reports a note about 0.3 s after it began,
    // which on a two-second envelope is a sixth of the answer. Timed from the note-on:
    //
    //     VCA decay 80   2.86 s to the sustain floor
    //     VCF decay 80   2.25 s to the base
    //     attack 70      1.39 s to full, or 1.66 from the -6 dB crossing
    //
    // The 10000:1 span is still an assumption - one decay cannot show the curve, only
    // where it sits - so it is kept and the bottom of it fitted to the VCA decay.
    ENV_MIN_MS: 1.68,     // measured: VCA decay 80 at 2.86 s
    ENV_MAX_MS: 16800,    // assumed: the same 10000:1 span, moved with the bottom

    // Attack still does not sit on the decay's curve. A stored 70 predicts 1.13 s and
    // measures 1.39 to 1.66 depending on whether you read where it reaches full or where
    // it passes -6 dB; 1.33x splits them. Smaller than the 1.6 this used to carry, which
    // was that 0.3 s timing error in disguise.
    ATTACK_SCALE: 1.33,   // measured: attack 70 between 1.39 s and 1.66 s

    // The filter's envelope runs quicker than the VCA's for the same stored number:
    // decay 80 reached the base in 2.25 s against the VCA's 2.86. One measurement each,
    // so provisional - but a measurement, where sharing the VCA's scale was a guess.
    VCF_TIME_SCALE: 0.78, // measured: 2.25 s against the VCA's 2.86

    // Sustain is NOT a fraction of the amplitude. A stored 50 measured 19.7 dB down,
    // where a plain 50/99 of the amplitude would be 5.9 dB down - a 14 dB error, and
    // sustain varies in half the library's keygroups. It behaves as a straight count in
    // decibels: 99 is full, and each step down costs about 0.4 dB.
    SUSTAIN_DB: 39.6,     // measured: a stored 50 read 19.6 dB down

    // Zone loudness, which this model used to ignore entirely. A stored +20 measured
    // 5.7 dB up on the hardware, so it is a trim of about 0.29 dB per step. An earlier
    // figure of 0.21 came from the emulation measuring itself.
    LOUDNESS_DB_PER_UNIT: 0.29,   // measured

    // Velocity to loudness was wrong in the same way sustain was - modelled as a
    // fraction of the amplitude, where the machine counts decibels. At full depth,
    // velocity 70 measured 31.6 dB below velocity 120: 0.63 dB per velocity step, where
    // a proportional law would have predicted 4.7 dB for the same span.
    //
    // The run also asks for velocity 20, and that note is not in the take at all: at
    // 0.63 dB a step it lands near 82 dB down, below the noise floor of the recording
    // and very likely of the machine. The plan asks for something the S950 cannot play.
    VEL_DB_PER_STEP: 0.63         // measured, at velToLoudness 99
  };

  /**
   * A stored 0..99 cutoff as a frequency, exponential between the ends of its travel.
   * The top end depends on the sample rate, so a sample recorded at 12.5 kHz is only
   * ever filtered up to 5 kHz however wide open the setting is.
   */
  function cutoffHz(stored, sampleRate) {
    var ceiling = CAL.MAX_RATIO * (sampleRate || 48000);
    var floor = Math.min(CAL.FLOOR_HZ, ceiling);
    var v = clamp(stored, 0, 99);

    var c = CAL.CURVE;
    function at(i) { return c[i][1] === null ? ceiling : c[i][1]; }

    var hz = at(c.length - 1);
    for (var i = 1; i < c.length; i++) {
      if (v > c[i][0]) continue;

      var lo = at(i - 1), hi = at(i);
      var t = c[i][0] === c[i - 1][0] ? 0 : (v - c[i - 1][0]) / (c[i][0] - c[i - 1][0]);
      hz = lo * Math.pow(hi / lo, t);                // straight in log frequency
      break;
    }

    return hz < floor ? floor : hz > ceiling ? ceiling : hz;
  }

  /** A stored 0..99 envelope time in seconds. */
  function envSeconds(stored) {
    var v = clamp(stored, 0, 99) / 99;
    return (CAL.ENV_MIN_MS * Math.pow(CAL.ENV_MAX_MS / CAL.ENV_MIN_MS, v)) / 1000;
  }

  /**
   * The three biquad sections of a 6th-order Butterworth low-pass, as
   * { b: [b0,b1,b2], a: [1,a1,a2] } with the coefficients already normalised.
   */
  function butterworth(fc, fs) {
    var nyq = fs / 2;
    var f = clamp(fc, 10, nyq * 0.995);
    var w = 2 * Math.PI * f / fs, cw = Math.cos(w), sw = Math.sin(w);
    var out = [];

    for (var k = 0; k < 3; k++) {
      var q = 1 / (2 * Math.cos(Math.PI * (2 * k + 1) / 12));
      var al = sw / (2 * q);
      var a0 = 1 + al;
      out.push({
        b: [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0],
        a: [1, -2 * cw / a0, (1 - al) / a0]
      });
    }
    return out;
  }

  /**
   * Run words through the cascade, with the cutoff free to move.
   *
   * `cutoffAt(seconds)` returns the cutoff in hertz; coefficients are recomputed every
   * `block` samples, which at the default is far finer than the ear resolves and costs
   * nothing on preview-length audio. State carries across blocks, so there is no click.
   */
  function filterWords(words, fs, cutoffAt, block) {
    block = block || 64;

    var out = new Float32Array(words.length);
    var z = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];   // x1,x2,y1,y2 per section
    var i = 0;

    while (i < words.length) {
      var n = Math.min(block, words.length - i);
      var secs = butterworth(cutoffAt(i / fs), fs);

      for (var j = 0; j < n; j++) {
        var x = words[i + j] / 2048;

        for (var s = 0; s < 3; s++) {
          var c = secs[s], st = z[s];
          var y = c.b[0] * x + c.b[1] * st[0] + c.b[2] * st[1] - c.a[1] * st[2] - c.a[2] * st[3];
          st[1] = st[0]; st[0] = x;
          st[3] = st[2]; st[2] = y;
          x = y;
        }
        out[i + j] = x;
      }
      i += n;
    }
    return out;
  }

  /**
   * Where the cutoff sits over time for one keygroup zone, as a function of seconds.
   *
   * base cutoff, shifted by key tracking and velocity, then swept by the VCF envelope
   * scaled by the signed amount. All four scalings come from CAL and are assumptions.
   */
  function vcfEnvelope(kg, zone, note, velocity, sampleRate) {
    var base = cutoffHz(zone && zone.filter !== undefined ? zone.filter : 99, sampleRate);

    // key->filter is read as a depth counting up from none: 0 is no tracking, 99 is the
    // filter following the keyboard one for one. The library sits at 50 in 74% of its
    // keygroups and at 0 in 19%, and it is that 19% which decides the reading - a fifth
    // of all keygroups choosing *inverted* tracking would be very strange, whereas a
    // fifth choosing none is ordinary. So 50, the library's default, is half tracking.
    //
    // This is the assumption I would most like to be rid of, and it is also the cheapest
    // to test: one take of the same keygroup played an octave or two apart settles it.
    var track = clamp(kg.keyToFilter === undefined ? 0 : kg.keyToFilter, 0, 99) / CAL.KEY_FULL;
    var keyShift = ((note === undefined ? 60 : note) - 60) / 12 * track;
    // about the pivot, not up from zero - see CAL.VEL_PIVOT
    var velShift = (((velocity === undefined ? 100 : velocity) - CAL.VEL_PIVOT) / 127) *
                   ((kg.velToFilter || 0) / 99) * CAL.VEL_OCTAVES;

    // No filter envelope written means no filter envelope, not one set to 32. In the
    // library this never bites, because none of the 1684 keygroups with blank bytes sets
    // an amount - but it would the moment anyone did.
    var written = kg.vcfWritten === undefined ? true : kg.vcfWritten;

    var a = written ? envSeconds(kg.vcf[0]) * CAL.VCF_TIME_SCALE : 0;
    var d = written ? envSeconds(kg.vcf[1]) * CAL.VCF_TIME_SCALE : 0;
    var sustain = written ? clamp(kg.vcf[2], 0, 99) / 99 : 1;
    var depth = written ? ((kg.vcfAmount || 0) / 50) * CAL.ENV_OCTAVES : 0;

    // The filter is also the reconstruction filter, so its cutoff cannot go above the
    // top of its travel however much the modulation asks for - that is a limit of the
    // hardware rather than a modelling choice, and without it a wide-open keygroup with
    // any velocity depth at all previews brighter than the machine can physically be.
    var ceiling = CAL.MAX_RATIO * (sampleRate || 48000);
    var floor = Math.min(CAL.FLOOR_HZ, ceiling);

    return function (t) {
      var env;
      if (t < a) env = a > 0 ? t / a : 1;
      else if (t < a + d) env = d > 0 ? 1 - (1 - sustain) * ((t - a) / d) : sustain;
      else env = sustain;

      var hz = base * Math.pow(2, keyShift + velShift + env * depth);
      return hz > ceiling ? ceiling : hz < floor ? floor : hz;
    };
  }

  /**
   * The keygroup's amplitude envelope, in seconds and gain.
   *
   * The decay is a straight line in DECIBELS from the peak to the sustain level, not in
   * amplitude - measured, see CAL. Callers schedule that themselves: in the browser it
   * is an exponential ramp, which is the same thing, and emulate.js interpolates the
   * logarithm. The attack is left linear in amplitude, which is what its trace looks
   * like and is the one shape here still taken on trust.
   *
   * The four stored values are the panel's 0..99 attack, decay, sustain and release.
   * Sustain is a level, the other three are times, and the times use the same assumed
   * 1 ms .. 10 s scale as the filter envelope. velToLoudness is read as how much a soft
   * note is quietened - another assumption, though a harmless one, since the tool always
   * plays at a fixed velocity.
   */
  function dbToGain(db) { return Math.pow(10, db / 20); }

  function vcaEnvelope(kg, zone, velocity) {
    var vel = clamp(velocity === undefined ? 100 : velocity, 0, 127);
    var depth = clamp(kg.velToLoudness || 0, 0, 99) / 99;

    // everything below is in decibels, because that is what the machine turned out to
    // be counting - see CAL
    var velDb = -(127 - vel) * CAL.VEL_DB_PER_STEP * depth;
    var zoneDb = (zone && zone.loudness ? zone.loudness : 0) * CAL.LOUDNESS_DB_PER_UNIT;
    var sustainDb = -(1 - clamp(kg.vca[2], 0, 99) / 99) * CAL.SUSTAIN_DB;

    return {
      attack: envSeconds(kg.vca[0]) * CAL.ATTACK_SCALE,
      decay: envSeconds(kg.vca[1]),
      sustain: dbToGain(sustainDb),
      release: envSeconds(kg.vca[3]),
      peak: clamp(dbToGain(velDb + zoneDb), 0, 4)
    };
  }

  /** The whole thing: a keygroup zone's filter applied to a sample, for monitoring. */
  function applyVcf(words, fs, kg, zone, note, velocity) {
    return filterWords(words, fs, vcfEnvelope(kg, zone, note, velocity, fs));
  }

  function hann(n) {
    var w = new Float32Array(n);
    for (var i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    return w;
  }

  return {
    RATES: RATES,
    MIN_RATE: MIN_RATE,
    SILENCE_THRESHOLD: SILENCE_THRESHOLD,
    detectSlices: detectSlices,
    CAL: CAL,
    cutoffHz: cutoffHz,
    envSeconds: envSeconds,
    butterworth: butterworth,
    filterWords: filterWords,
    vcfEnvelope: vcfEnvelope,
    vcaEnvelope: vcaEnvelope,
    applyVcf: applyVcf,
    decode: decode,
    toMono: toMono,
    to12Bit: to12Bit,
    bufferOf: bufferOf,
    halveRate: halveRate,
    resample: resample,
    timeStretch: timeStretch,
    findLoop: findLoop
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AkaiAudio;
