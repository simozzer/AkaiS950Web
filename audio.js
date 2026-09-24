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
   * Where the sustain gives way to the release.
   *
   * A sample meant to be held has a tail after its loop - the release you hear when the
   * key comes up - and looping to the end of the sample plays across it. The level is
   * what marks it: a short-time RMS envelope holds a plateau through the sustain and
   * then falls away, so the last frame within `dropDb` of the loudest is where the note
   * stops being held.
   *
   * What this is NOT is the loop end somebody would choose. Of the library's 324 looped
   * samples only 30 stop short by more than 50 ms, and on those this lands about 200 ms
   * later than the person did, at every threshold tried - they left a margin so the loop
   * would not eat into the release. So this is offered as a starting point for the eye
   * and the ear, not as an answer: the dialog lets the end be moved.
   */
  function sustainEnd(words, rate, opts) {
    opts = opts || {};
    var dropDb = opts.dropDb === undefined ? -2 : opts.dropDb;
    var hop = Math.max(64, Math.round(rate * (opts.hopMs || 10) / 1000));
    var frames = Math.floor(words.length / hop);
    if (frames < 8) return words.length;

    var rms = new Float64Array(frames), loudest = 0;
    for (var f = 0; f < frames; f++) {
      var sum = 0, at = f * hop;
      for (var i = 0; i < hop; i++) { var v = words[at + i]; sum += v * v; }
      rms[f] = Math.sqrt(sum / hop);
      if (rms[f] > loudest) loudest = rms[f];
    }
    if (loudest <= 0) return words.length;

    var floor = loudest * Math.pow(10, dropDb / 20);
    for (var g = frames - 1; g >= 0; g--)
      if (rms[g] >= floor) return Math.min(words.length, (g + 1) * hop);
    return words.length;
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
    // Nine points now rather than the original ladder's six. The five in between came from a
    // run built for the purpose, with key tracking, velocity and the envelope all off, so
    // nothing but the stored byte could reach the cutoff.
    //
    // The 50 point moved from 1878 to 2210 - a quarter of an octave, in the middle of the
    // range where most of the library sits. The old figure came from a clip with keyToFilter
    // at 50, and tracking does not pivot where this assumed; see KEY_PIVOT. Two later takes,
    // on two disks, measured 2211 and 2210 with tracking off, the second at five keys with a
    // spread of 0.000 octaves.
    CURVE: [[0, 311], [20, 311], [30, 544], [40, 1138], [50, 2210],
            [60, 4779], [70, 8783], [80, null], [99, null]],
    KEY_FULL: 50,         // measured: keyToFilter 50 is 1:1 tracking

    /*
     * Measured: the note at which key tracking adds nothing.
     *
     * NOT 60, which is what this assumed for as long as it had a tracking term. The same
     * keygroup played at five keys four octaves apart tracked 0.980 octaves per octave and
     * crossed its own untracked value at note 62.0 - with the five untracked controls flat
     * to 0.000 octaves, so there was nothing else it could have been.
     *
     * It matters beyond the tracking: a pivot in the wrong place quietly offsets every
     * cutoff read from a keygroup with tracking on, which is where the old 1878 came from.
     */
    KEY_PIVOT: 62,

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
    /*
     * Measured: how far the filter envelope moves the cutoff at full amount.
     *
     * Five amounts each way, from bases chosen to leave room in the direction under test,
     * with the envelope held open so the corner stands still and can be read properly
     * rather than traced through a moving sweep:
     *
     *     opening   0.167  0.171  0.168  0.162  octaves per unit  ->  8.37
     *     closing   0.170  0.163  0.164                           ->  8.28
     *
     * Straight to within 0.013 octaves both ways, and the two agree to 1.1% - so a negative
     * amount really does invert the envelope and go exactly as far, which this had assumed
     * without evidence. It also starts a unit or two off zero rather than at it; that dead
     * zone is real and measured but not modelled, being worth less than the 9% this fixes.
     */
    ENV_OCTAVES: 8.5,     // measured

    /*
     * Measured points, not a formula - see envSeconds.
     *
     * This replaces a pair of constants, one measured and one assumed: a shortest time of
     * 1.68 ms taken from a single VCA decay at stored 80, and a 10000:1 span across the
     * range that nothing had ever checked. The span is the part that was wrong. The real one
     * is nearer 1400:1, so the old curve ran half as fast as the machine below stored 70 and
     * nearly twice as fast above stored 85.
     *
     * Nine settings, measured on the filter envelope where a moving cutoff can be watched
     * all the way down a fourteen-second note. Attack, decay and release are three separate
     * readings of this one curve, and where they overlap they agree to 1.07x - so it really
     * is one curve, and it is this one.
     *
     *     stored      50     55     60     65     70     80     85     90     95
     *     measured  0.357  0.418  0.722  0.881  1.404  2.814  4.037  4.117  8.095
     *     old model 0.176  0.280  0.446  0.711  1.131  2.868  4.567  7.272 11.580
     *
     * Measured twice over, because the analysis has a bias of its own - a window averages the
     * sweep passing through it - and that bias is found by putting a RENDER of the model
     * through the same analysis, where the answer is known. The first pass used a model that
     * was out by up to 2x, so its biases were taken at the wrong sweep rates; adopting its
     * table and measuring again moved every point by less than 8%. A third pass against THIS
     * table reads every setting back at 0.95 to 1.04 of it, and the points oscillate rather
     * than drift - so what is left is the measurement's own repeatability and not an error
     * still to be chased.
     *
     * Stored 50 only appears at all on the second pass: under the old curve the render was
     * over inside one analysis window, so there was nothing to take a bias from.
     *
     * The VCA decay confirms it independently, from the same take and a different envelope:
     * measured against a fixed depth it gives 3.96 s at stored 85 against this table's 4.04,
     * and 8.49 s at stored 95 against 8.09.
     *
     * Stored 90 is the odd one. Everything else sits within a few per cent of a plain
     * exponential through these points; 90 sits 41% off it, and all three of attack, decay
     * and release put it there, agreeing to 1.03x. Kept as measured rather than smoothed
     * away - but it is the one point a second take should be asked about first.
     *
     * The ends are extrapolated, not measured: nothing reaches below 50 or above 95, so both
     * continue at the slope fitted across every measured point. Extrapolating from the two
     * nearest points instead put stored 0 at 320 ms, which every percussive sample refutes.
     */
    ENV_TIME: [
      [0, 0.01040], [50, 0.3565], [55, 0.4184], [60, 0.7224], [65, 0.8806],
      [70, 1.4037], [80, 2.8136], [85, 4.0370], [90, 4.1172], [95, 8.0947],
      [99, 10.7401]
    ],

    /*
     * The VCA attack is a counter, and this is how long it takes at one step per tick.
     *
     * It was ATTACK_SCALE - a single multiplier on the shared envelope curve - and no
     * multiplier can be right, because the attack does not follow that curve and does not
     * follow any smooth curve at all. Thirteen settings measured on the hardware:
     *
     *     stored     30    40    50    55    60    65    70    75    80    85  90  95  99
     *     seconds  .209  .362  .603  .766  .906 1.081 1.350 1.350 1.796 1.797 2.70 2.70 2.70
     *     5.4 / n    26    15     9     7     6     5     4     4     3     3   2   2   2
     *
     * Every one of them is 5.4/n for a whole number n, to within 0.7%. That is not a fit, it
     * is the mechanism: an envelope counter adding n units a tick across a fixed span. It is
     * also why stored 70 and 75 come back identical to four digits, and 80 and 85, and 90, 95
     * and 99 - they share an n. And it is why the attack STOPS getting slower at 2.70 s: n
     * bottoms out at 2, where the shared curve wanted 10.74 s at stored 99.
     *
     * Only the VCA attack is known to do this. The filter attack was measured in an earlier
     * run to about 5%, too coarse to see a 0.7% quantisation, so it keeps the shared curve -
     * not because it is smooth but because nothing has looked.
     */
    VCA_ATTACK_SPAN: 5.4,

    /*
     * An attack this short is a step, and is rendered as one.
     *
     * A counter whose increment covers the whole span arrives on the first tick, so there is
     * no ramp left to render and the right answer is zero rather than a very small number. A
     * millisecond is well inside one control block.
     *
     * This is what makes attack 0 a hard gate. That is not a measurement - nothing in any run
     * reaches below stored 30 - it is how envelope generators are built. The bottom of an
     * attack range means no attack stage at all rather than a very short one, and a sampler
     * that could not gate a drum would be the exception rather than the rule.
     *
     * The only thing that ever argued otherwise was an extrapolation: the slope from stored
     * 30 to 40, carried thirty units down, put stored 0 at 40 ms - a soft attack on every
     * percussive sample there is. A guess reaching that far loses to how the things are made.
     */
    VCA_ATTACK_GATE: 0.001,

    /*
     * How many units a tick, by stored byte. The measured points are exact; between them n is
     * interpolated and rounded, so each whole number gets its own stretch of the range.
     *
     * Below stored 30 nothing is measured. The entry at 0 is the count that crosses
     * VCA_ATTACK_GATE, so stored 0 and 1 are steps and the ramp climbs from about a
     * millisecond at 2 to the measured 0.209 s at 30. That shape is a guess; that the two
     * ends of it are a gate and 0.209 s is not.
     */
    VCA_ATTACK_STEPS: [
      [0, 7000], [30, 26], [40, 15], [50, 9], [55, 7], [60, 6], [65, 5],
      [70, 4], [75, 4], [80, 3], [85, 3], [90, 2], [95, 2], [99, 2]
    ],

    // The filter's envelope runs quicker than the VCA's for the same stored number:
    // decay 80 reached the base in 2.25 s against the VCA's 2.86. One measurement each,
    // so provisional - but a measurement, where sharing the VCA's scale was a guess.
    VCF_TIME_SCALE: 0.78, // measured: 2.25 s against the VCA's 2.86

    /*
     * THE RELEASE IS A RATE, NOT A DURATION.
     *
     * The release byte sets how fast the envelope falls, not how long it takes to get there,
     * so a release from half depth is over in half the time. This used to do the opposite for
     * the filter - fall from wherever you are TO ZERO over the release time, which makes a
     * shallow release crawl - while doing the right thing for the amplitude in the same
     * voice. One generator, two rules, neither measured.
     *
     * Nothing caught it because every release ever measured started from a sustain of 99 and
     * fell the whole depth, which is the one case where the two agree. Three sustains at one
     * release setting separate them:
     *
     *     depth        2.04 oct   1.24 oct   0.72 oct
     *     measured       3.13 s     1.88 s     1.13 s
     *     a rate         3.15       1.91       1.11
     *     a duration     3.15       3.15       3.15
     *
     * Within 2% of a rate at every depth. Nothing measured before it changes: at full depth
     * the two rules agree, and every earlier release measurement was taken there.
     */
    RELEASE_IS_A_RATE: true,


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

  /*
   * The LFO, measured on the machine. See README, "Calibrating the LFO".
   *
   * Every number here came off a recording of an S950 playing a run written for the
   * purpose, and every one of them is a surprise of some kind:
   *
   *   - the RATE is linear in the stored byte, where the filter's cutoff is exponential
   *     and this was expected to be too. Two takes, different disks, different keys,
   *     agreeing to 0.2%;
   *   - the WAVEFORM is a sine, r 1.000 over 41 cycles, not the triangle a guess would
   *     reach for;
   *   - the DELAY is a fade-in rather than a wait, and its length is a constant divided
   *     by how far the setting is from the top, which fits at r2 0.99999 across seven
   *     rungs where a straight line fits at 0.24;
   *   - the DESYNC flag does what its name says, and it was worth proving: with the bit
   *     clear, two voices held a phase difference of 80 degrees to within 3 over six
   *     seconds and ran at the same rate to four figures - one oscillator, shared. With
   *     it set they ran at 7.15 and 7.40 Hz and drifted a full turn apart in the same
   *     six seconds - one oscillator each;
   *   - and it moves pitch and nothing else. At full depth the level moved 0.23 dB.
   */
  var LFO = {
    RATE_HZ_AT_ZERO: 1.785,       // measured: 8 rungs on a straight line, r2 0.99998
    RATE_HZ_PER_UNIT: 0.08917,

    DEPTH_CENTS_PER_UNIT: 1.527,  // measured: r2 0.9999, so depth 99 is +-150 cents

    /*
     * The fade, as the whole ramp rather than the part that was measured.
     *
     * Seven rungs put nine tenths of full depth at 7.496/(100-byte) seconds, r2 0.99999.
     * The climb is a straight line - at byte 99 the fifth, quarter, half and nine-tenth
     * marks came at 0.354, 2.173, 4.126 and 7.503 seconds, against 0.42, 2.08, 4.17 and
     * 7.50 for a ramp - so the whole ramp is that constant over nine tenths.
     */
    DELAY_FADE_CONSTANT: 8.33,

    // measured: 72.3 cents at the top of the wheel with byte 22 at 99, r2 0.999, and
    // byte 22 = 50 gave 0.509 of that where proportional would be 0.505.
    WHEEL_CENTS_AT_FULL: 72.3
  };

  /**
   * What one keygroup's LFO does, in units a synthesiser can use.
   *
   * `wheel` is the modwheel, 0..127. Returns null when there is nothing to hear, so the
   * caller can skip building an oscillator for the 90% of keygroups whose depth is zero
   * and whose wheel is down.
   */
  function lfo(kg, wheel) {
    if (!kg) return null;

    var own = (kg.lfoDepth || 0) * LFO.DEPTH_CENTS_PER_UNIT;
    var added = LFO.WHEEL_CENTS_AT_FULL *
                ((kg.lfoDepthToWheel === undefined ? 50 : kg.lfoDepthToWheel) / 99) *
                (Math.max(0, Math.min(127, wheel || 0)) / 127);
    var cents = own + added;
    if (cents < 0.5) return null;

    return {
      hz: LFO.RATE_HZ_AT_ZERO + (kg.lfoRate || 0) * LFO.RATE_HZ_PER_UNIT,
      cents: cents,
      // the delay byte is a fade, and at 99 it is an eight-second one
      fadeSeconds: LFO.DELAY_FADE_CONSTANT / Math.max(1, 100 - (kg.lfoDelay || 0)),
      fromWheel: added,
      // bit 2 of the flags: set means this voice runs its own oscillator, clear means
      // it shares the programme's. 1652 keygroups of 1908 set it.
      ownOscillator: kg.lfoDesync !== false
    };
  }

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

  /**
   * A stored 0..99 envelope time in seconds, read off CAL.ENV_TIME.
   *
   * Straight in log time between the measured points, the same way cutoffHz is straight in
   * log frequency between its own: the quantity is exponential in the stored byte, so a
   * straight line in the log is what "between two measurements" means here.
   */
  function envSeconds(stored) {
    var T = CAL.ENV_TIME;
    var v = clamp(stored, 0, 99);
    var seconds = T[T.length - 1][1];

    for (var i = 1; i < T.length; i++) {
      if (v > T[i][0]) continue;

      var lo = T[i - 1][1], hi = T[i][1];
      var span = T[i][0] - T[i - 1][0];
      var t = span === 0 ? 0 : (v - T[i - 1][0]) / span;
      seconds = lo * Math.pow(hi / lo, t);       // straight in log time
      break;
    }

    return seconds;
  }

  /**
   * The VCA attack in seconds, from CAL.VCA_ATTACK_STEPS.
   *
   * The count is interpolated in the log and then rounded to a whole number, because a
   * counter can only add whole units - so the answer steps, and steps widely at the top where
   * n is 4, 3, 2. That is the machine: two settings sharing an n really do give the same
   * attack to four digits.
   */
  function vcaAttackSeconds(stored) {
    var S = CAL.VCA_ATTACK_STEPS;
    var v = clamp(stored, 0, 99);
    var steps = S[S.length - 1][1];

    for (var i = 1; i < S.length; i++) {
      if (v > S[i][0]) continue;

      var lo = S[i - 1][1], hi = S[i][1];
      var span = S[i][0] - S[i - 1][0];
      var t = span === 0 ? 0 : (v - S[i - 1][0]) / span;
      steps = lo * Math.pow(hi / lo, t);
      break;
    }

    var seconds = CAL.VCA_ATTACK_SPAN / Math.max(2, Math.round(steps));
    return seconds < CAL.VCA_ATTACK_GATE ? 0 : seconds;
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
    var keyShift = ((note === undefined ? 60 : note) - CAL.KEY_PIVOT) / 12 * track;
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
    var rel = written ? envSeconds(kg.vcf[3]) * CAL.VCF_TIME_SCALE : 0;
    var depth = written ? ((kg.vcfAmount || 0) / 50) * CAL.ENV_OCTAVES : 0;

    // The filter is also the reconstruction filter, so its cutoff cannot go above the
    // top of its travel however much the modulation asks for - that is a limit of the
    // hardware rather than a modelling choice, and without it a wide-open keygroup with
    // any velocity depth at all previews brighter than the machine can physically be.
    var ceiling = CAL.MAX_RATIO * (sampleRate || 48000);
    var floor = Math.min(CAL.FLOOR_HZ, ceiling);

    /** The envelope while the key is down: attack, decay, then sustain. */
    function held(t) {
      if (t < a) return a > 0 ? t / a : 1;
      if (t < a + d) return d > 0 ? 1 - (1 - sustain) * ((t - a) / d) : sustain;
      return sustain;
    }

    /*
     * `releaseAt` is when the key came up, in seconds from the note starting, or undefined
     * for a note still held.
     *
     * The release runs the envelope's contribution back to nothing in a straight line - the
     * same shape the decay has - so the filter returns to the keygroup's own cutoff as the
     * note dies rather than keeping whatever brightness it had when the key was let go. The
     * level it falls FROM is wherever the envelope had reached, which is why it is read at
     * the moment of release rather than assumed to be the sustain.
     */
    var shape = function (t, releaseAt) {
      var env;

      // A fixed RATE, not a fixed time: the release byte sets how fast the envelope falls,
      // so a release from half depth is over in half the time. Measured three ways at three
      // sustains - see the note beside VCF_TIME_SCALE.
      if (releaseAt !== undefined && t >= releaseAt)
        env = rel > 0.0005
          ? Math.max(0, held(releaseAt) - (t - releaseAt) / rel)
          : 0;
      else
        env = held(t);

      var hz = base * Math.pow(2, keyShift + velShift + env * depth);
      return hz > ceiling ? ceiling : hz < floor ? floor : hz;
    };

    // Callable as f(t) for a held note, which is what every existing caller does, and the
    // release time is a second argument for the one caller that has let go.
    var f = function (t) { return shape(t, undefined); };
    f.withRelease = function (releaseAt) {
      return function (t) { return shape(t, releaseAt); };
    };
    f.releaseSeconds = rel;

    /// Whether the envelope moves the cutoff at all. If it does not, letting go changes
    /// nothing about the filter and there is no tail worth rendering.
    f.moves = written && depth !== 0;
    return f;
  }

  /*
   * The audio a note makes after the key comes up, filtered with the envelope closing.
   *
   * The web version bakes the filter into the buffer before the note starts, because a
   * 6th-order cascade with a moving cutoff is not something Web Audio's nodes will do. That
   * is fine for attack, decay and sustain, which are all known at the moment the key goes
   * down - and no use at all for a release, which is not. So the tail is rendered when the
   * key comes up and spliced on.
   *
   * `fromWord` is where playback had reached; `loop` is { from, end } or null, so a looped
   * note goes on looping while it fades rather than running off the end of the sample.
   *
   * THE FILTER STATE
   *
   * A filter picked up mid-signal with empty memory clicks. The tail is therefore primed:
   * the samples leading up to the splice are run through it first and thrown away, so it
   * arrives holding the same history the buffer it is joining does. A sixth-order section
   * at the lowest cutoff this machine reaches settles well inside the priming length.
   */
  var RELEASE_PRIME = 4096;

  function releaseTail(words, fs, kg, zone, note, velocity, heldFor, fromWord, loop, maxSeconds) {
    var env = vcfEnvelope(kg, zone, note, velocity, fs);

    // No envelope, or one with no depth, means the cutoff does not move when the key comes
    // up - so the buffer already playing is right and there is nothing to splice.
    if (!env.moves) return null;

    /*
     * The tail lasts as long as the LEVEL does, not as long as the filter's own release.
     *
     * Those are different, and getting it wrong is silent truncation: a keygroup with a
     * filter release of 0 closes its filter in a millisecond and then holds it there for
     * however long the amplitude takes to fade. Sizing the tail by the filter's release
     * would end the note after that millisecond.
     */
    var seconds = maxSeconds > 0 ? maxSeconds : env.releaseSeconds;
    if (seconds > 15) seconds = 15;          // a stall on the main thread nobody can hear

    var closing = env.withRelease(heldFor);
    var count = Math.ceil(seconds * fs) + 1;

    var looping = loop && loop.end > loop.from;
    var span = looping ? loop.end - loop.from : 0;

    /** The word at `k` places after `fromWord`, following the loop if there is one. */
    function wordAt(k) {
      var at = fromWord + k;
      if (looping && at >= loop.end) at = loop.from + ((at - loop.from) % span);
      return at >= 0 && at < words.length ? words[at] : 0;
    }

    var out = new Float32Array(count);
    var z = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

    // Prime on the run-up, held at the cutoff the note had reached, then render the tail.
    var steady = butterworth(closing(heldFor), fs);

    for (var p = -RELEASE_PRIME; p < 0; p++) {
      var xp = wordAt(p) / 2048;
      for (var sp = 0; sp < 3; sp++) {
        var cp = steady[sp], stp = z[sp];
        var yp = cp.b[0] * xp + cp.b[1] * stp[0] + cp.b[2] * stp[1]
               - cp.a[1] * stp[2] - cp.a[2] * stp[3];
        stp[1] = stp[0]; stp[0] = xp;
        stp[3] = stp[2]; stp[2] = yp;
        xp = yp;
      }
    }

    /*
     * Retuned every eight samples, not every sixty-four.
     *
     * This was put in against a ring: moving a sixth-order cascade several octaves in one
     * step, while it keeps the state the old coefficients left behind, injects energy, and a
     * 64-sample block was measured peaking at nearly ten times full scale on the fastest
     * release the model then had - about 1.3 ms.
     *
     * The envelope curve has since been measured properly and the fastest release is 6.1 ms,
     * not 1.3, and at that speed the step size no longer matters. A sawtooth swept five and a
     * half octaves, peak output by block:
     *
     *     sweep      64    32    16     8     1
     *     1.31 ms   1.18  1.18  1.18  1.18  1.07
     *     6.12 ms   1.39  1.41  1.21  1.20  1.20
     *      500 ms   1.39  1.39  1.39  1.39  1.38
     *
     * The 1.4 is not an artefact - it is there at a block of one and at a sweep three orders
     * of magnitude slower, which is a Butterworth's outer section having a Q of 1.9 and
     * lifting the harmonics it passes over. Eight is kept anyway: it costs almost nothing,
     * it is the more correct integration of a moving filter, and it is the only thing
     * standing between a future faster release and the pop this was written for.
     */
    var block = 8;
    for (var i = 0; i < count; i += block) {
      var n = Math.min(block, count - i);
      var secs = butterworth(closing(heldFor + i / fs), fs);

      for (var j = 0; j < n; j++) {
        var x = wordAt(i + j) / 2048;
        for (var s = 0; s < 3; s++) {
          var c = secs[s], st = z[s];
          var y = c.b[0] * x + c.b[1] * st[0] + c.b[2] * st[1] - c.a[1] * st[2] - c.a[2] * st[3];
          st[1] = st[0]; st[0] = x;
          st[3] = st[2]; st[2] = y;
          x = y;
        }
        out[i + j] = x;
      }
    }
    return out;
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
      attack: vcaAttackSeconds(kg.vca[0]),
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
    vcaAttackSeconds: vcaAttackSeconds,
    butterworth: butterworth,
    filterWords: filterWords,
    vcfEnvelope: vcfEnvelope,
    releaseTail: releaseTail,
    vcaEnvelope: vcaEnvelope,
    lfo: lfo,
    LFO: LFO,
    applyVcf: applyVcf,
    decode: decode,
    toMono: toMono,
    to12Bit: to12Bit,
    bufferOf: bufferOf,
    halveRate: halveRate,
    resample: resample,
    timeStretch: timeStretch,
    findLoop: findLoop,
    sustainEnd: sustainEnd
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = AkaiAudio;
