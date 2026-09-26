/*
 * Calibrating the VCF against the real machine.
 *
 * The filter's shape is known exactly - 6th-order Butterworth, 36 dB per octave - but the
 * frequency axis is not. The disks store a cutoff as 0..99 and say nothing about hertz, so
 * every constant in AkaiAudio.CAL is currently an assumption. This derives the real ones
 * from recordings.
 *
 * WHAT TO RECORD
 *
 *   1. Put a bright, steady sample on a disk - white noise is ideal, a bright sustained
 *      pad will do. One keygroup, one zone, VCF amount 0, velocity->filter 0,
 *      key->filter 0, so nothing modulates the cutoff.
 *   2. Record the S950's output at filter = 0, 10, 20 ... 90, 99. A second or two each.
 *      Keep the recording level identical throughout - the measurement is a ratio
 *      between clips, so a gain change reads as a filter change.
 *
 *   Either one WAV per setting, named for it - 00.wav, 10.wav ... 99.wav -
 *   or a single WAV holding all eleven in order with a gap of silence between them.
 *
 *   node vcfcal.js <folder>
 *   node vcfcal.js <file.wav>
 *
 * It finds each recording's -3 dB corner relative to the most open one, fits an exponential
 * to the results, and prints the CAL block to paste into audio.js. It also reports how well
 * the fit holds, because a poor fit means the mapping is not exponential and wants a table
 * rather than two end points.
 */
var fs = require('fs');
var path = require('path');

var dir = process.argv[2];
if (!dir && require.main === module) {
  console.log('usage: node vcfcal.js <folder of recordings>');
  console.log('       node vcfcal.js <one.wav holding every setting in order>');
  console.log('       node vcfcal.js <one.wav> 0,30,60,99   (if you recorded fewer)');
  console.log('see the comment at the top of this file for what to record');
  process.exit(1);
}

// ---------------------------------------------------------------- reading WAVs

function readWav(file) {
  var b = fs.readFileSync(file);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE')
    throw new Error('not a WAV file');

  var pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    var id = b.toString('ascii', pos, pos + 4);
    var size = b.readUInt32LE(pos + 4);

    if (id === 'fmt ') {
      fmt = {
        format: b.readUInt16LE(pos + 8),
        channels: b.readUInt16LE(pos + 10),
        rate: b.readUInt32LE(pos + 12),
        bits: b.readUInt16LE(pos + 22)
      };
    } else if (id === 'data') {
      data = b.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('no fmt or data chunk');

  var n = Math.floor(data.length / (fmt.bits / 8) / fmt.channels);
  var out = new Float64Array(n);

  for (var i = 0; i < n; i++) {
    var at = i * fmt.channels * (fmt.bits / 8);
    if (fmt.bits === 16) out[i] = data.readInt16LE(at) / 32768;
    else if (fmt.bits === 24) {
      // Little-endian three-byte signed. The shifts have to be parenthesised and the
      // sign extended by hand: written as one expression it is easy to shift by 24 and
      // back by 8, which silently discards the low byte and mangles the sign.
      var v = data[at] | (data[at + 1] << 8) | (data[at + 2] << 16);
      out[i] = (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
    }
    else if (fmt.bits === 32 && fmt.format === 3) out[i] = data.readFloatLE(at);
    else if (fmt.bits === 32) out[i] = data.readInt32LE(at) / 2147483648;
    else if (fmt.bits === 8) out[i] = (data[at] - 128) / 128;
    else throw new Error(fmt.bits + '-bit WAV is not handled');
  }
  return { rate: fmt.rate, samples: out };
}

// ------------------------------------------------------------------- spectrum

/**
 * Power spectrum by Goertzel at log-spaced probe frequencies - no FFT needed.
 *
 * Averaged over many overlapping windows, which matters more than it might seem: the
 * spectrum of one stretch of noise scatters by several dB per band, and a -3 dB corner
 * read off that lands anywhere. Averaging N windows cuts the scatter by about sqrt(N),
 * and a further smoothing across neighbouring bands takes out what is left. Without
 * both, this tool returns confident nonsense.
 */
function spectrum(x, rate, bands) {
  var from = Math.floor(x.length * 0.1);           // skip the attack
  var usable = x.length - from;

  var win = Math.min(8192, Math.max(1024, 1 << Math.floor(Math.log2(usable / 8))));
  var hop = Math.max(1, win >> 1);
  var starts = [];
  for (var o = from; o + win <= x.length; o += hop) starts.push(o);
  if (!starts.length) starts.push(from);

  // Hann, so the windows do not leak across bands
  var w = new Float64Array(win);
  for (var i = 0; i < win; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (win - 1));

  var raw = bands.map(function (f) {
    var wc = 2 * Math.PI * f / rate, c = 2 * Math.cos(wc), total = 0;

    starts.forEach(function (st) {
      var s1 = 0, s2 = 0;
      for (var i = 0; i < win; i++) {
        var s = x[st + i] * w[i] + c * s1 - s2;
        s2 = s1; s1 = s;
      }
      total += Math.max(s1 * s1 + s2 * s2 - c * s1 * s2, 0);
    });
    return total / starts.length / win;
  });

  // smooth across neighbouring bands - the response is smooth, the estimate is not
  var out = [];
  for (var i = 0; i < raw.length; i++) {
    var lo = Math.max(0, i - 2), hi = Math.min(raw.length - 1, i + 2), sum = 0, n = 0;
    for (var j = lo; j <= hi; j++) { sum += raw[j]; n++; }
    out.push({ f: bands[i], db: 10 * Math.log10(Math.max(sum / n, 1e-30)) });
  }
  return out;
}

var BANDS = [];
for (var f = 80; f < 21000; f *= Math.pow(2, 1 / 24)) BANDS.push(f);

// ------------------------------------------------------------------ splitting

var SETTINGS = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 99];

/**
 * Find the clips in one recording, separated by silence.
 *
 * The trap here is that the clips are not equally loud: at a low cutoff most of the
 * noise has been filtered away, so the quietest clip can sit 30 dB or more below the
 * open one. A threshold set as a fraction of the loudest clip swallows it, every
 * later clip is then matched to the wrong setting, and the fit comes out confidently
 * wrong. So the threshold is placed just above the true silence between clips - found
 * from the quietest frames in the recording - rather than below the loudest clip.
 */
function splitClips(x, rate, want, opts) {
  opts = opts || {};

  var frame = Math.max(64, Math.round(rate * 0.01));       // 10 ms
  var frames = Math.floor(x.length / frame);
  var rms = new Float64Array(frames);

  for (var i = 0; i < frames; i++) {
    var sum = 0;
    for (var j = 0; j < frame; j++) { var v = x[i * frame + j]; sum += v * v; }
    rms[i] = Math.sqrt(sum / frame);
  }

  var sorted = Array.prototype.slice.call(rms).sort(function (a, b) { return a - b; });
  var floorLevel = sorted[Math.floor(frames * 0.1)] || 0;   // the silence
  var peak = sorted[frames - 1] || 1;

  // 12 dB above the noise floor, but never within 40 dB of the loudest clip, so that a
  // recording with no real silence in it fails to split rather than splitting wrongly.
  var threshold = Math.max(floorLevel * 4, peak * 1e-4);

  /** Runs of sound, ending only after `gapSeconds` of quiet. */
  function detect(gapSeconds, minClipSeconds) {
    var minGap = Math.max(1, Math.round(gapSeconds / 0.01));
    var minClip = Math.max(1, Math.round(minClipSeconds / 0.01));
    var runs = [], start = -1, quiet = 0;

    for (var i = 0; i < frames; i++) {
      if (rms[i] > threshold) {
        if (start < 0) start = i;
        quiet = 0;
      } else if (start >= 0) {
        quiet++;
        if (quiet >= minGap) {
          if (i - quiet - start >= minClip) runs.push([start, i - quiet]);
          start = -1; quiet = 0;
        }
      }
    }
    if (start >= 0 && frames - start >= minClip) runs.push([start, frames]);
    return runs;
  }

  /*
   * No single pair of thresholds works for everything, so the pair is searched.
   *
   * THE GAP. Too short and a quiet clip that dips mid-note splits in two - a note at
   * velocity 20 with velocity driving loudness dropped out for nearly half a second. Too
   * long and a take recorded with brief gaps will not split at all.
   *
   * HOW MUCH SOUND COUNTS AS A CLIP. This was fixed at 250 ms and it threw away real
   * measurements: an amplitude decay of stored 15 with the sustain at zero is a CLICK -
   * 74 dB of fall at 2100 dB/s is over in 35 milliseconds - so five rungs of run 19's decay
   * ladder were dropped as too short to be notes. They are the fastest settings on the disk,
   * which is to say the ones the run was built to measure.
   *
   * 250 ms stays FIRST, because shortening it is what lets a dip split a note in two. The
   * shorter values are only reached when the longer ones do not produce the number of clips
   * the plan asked for, and that count is the check on whether the shortening was right.
   */
  var gaps = [opts.minGapSeconds || 0.5, 0.3, 0.7, 0.2, 1.0, 0.15, 1.4];
  var lengths = [opts.minClipSeconds || 0.25, 0.1, 0.04, 0.02];
  var runs = null, closest = null, closestMiss = 1e9;

  for (var L = 0; L < lengths.length && !runs; L++) {
    for (var t = 0; t < gaps.length; t++) {
      var got = detect(gaps[t], lengths[L]);
      if (want && got.length === want) { runs = got; break; }

      var miss = want ? Math.abs(got.length - want) : 0;
      if (miss < closestMiss) { closestMiss = miss; closest = got; }
      if (!want) { runs = got; break; }
    }
  }
  if (!runs) runs = closest || [];

  var zeros = 0;
  for (var i = 0; i < x.length; i++) if (x[i] === 0) zeros++;

  return {
    clips: runs.map(function (r) {
      // trim a tenth off each end, clear of the gate opening and closing
      var f = r[0] * frame, t2 = r[1] * frame;
      var pad = Math.round((t2 - f) * 0.1);
      return { from: f + pad, to: t2 - pad,
               seconds: [(f + pad) / rate, (t2 - pad) / rate] };
    }),
    floorDb: 20 * Math.log10(Math.max(floorLevel, 1e-12) / peak),
    peakDb: 20 * Math.log10(Math.max(peak, 1e-12)),
    zeroFraction: zeros / x.length,
    seconds: x.length / rate,
    wanted: want
  };
}

// ------------------------------------------------------------------- analysis

/** Turn per-setting spectra into a mapping. Common to both ways of supplying them. */
function fit(measured) {
  var ref = measured[measured.length - 1];
  var readings = [], points = [];

  measured.forEach(function (m) {
    if (m === ref) return;

    var corner = null;
    for (var i = 0; i < m.spec.length; i++) {
      var rel = m.spec[i].db - ref.spec[i].db;
      if (rel > -3) continue;

      if (i === 0) { corner = m.spec[0].f; break; }
      var prev = m.spec[i - 1].db - ref.spec[i - 1].db;
      var t = (prev - (-3)) / (prev - rel);            // interpolate between probes
      corner = m.spec[i - 1].f * Math.pow(m.spec[i].f / m.spec[i - 1].f, t);
      break;
    }

    if (corner === null) { readings.push({ setting: m.setting, corner: null }); return; }

    // Near the reference's own corner there is little left to measure against, so
    // those readings are reported but kept out of the fit.
    var shaky = corner > BANDS[BANDS.length - 1] / 3;
    readings.push({ setting: m.setting, corner: corner, used: !shaky });
    if (!shaky) points.push({ v: m.setting / 99, hz: corner });
  });

  if (points.length < 2) throw new Error('not enough corners found to fit a curve');

  var sx = 0, sy = 0, sxx = 0, sxy = 0, n = points.length;
  points.forEach(function (q) {
    var y = Math.log(q.hz);
    sx += q.v; sy += y; sxx += q.v * q.v; sxy += q.v * y;
  });

  var slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
  var intercept = (sy - slope * sx) / n;
  var minHz = Math.exp(intercept), maxHz = Math.exp(intercept + slope);

  var worst = 0;
  points.forEach(function (q) {
    var err = Math.abs(Math.log2(minHz * Math.pow(maxHz / minHz, q.v) / q.hz));
    if (err > worst) worst = err;
  });

  return {
    reference: ref.setting, readings: readings,
    minHz: minHz, maxHz: maxHz,
    worstOctaves: worst, exponential: worst < 0.25
  };
}

/** One WAV holding every setting in order, separated by silence. */
function analyseFile(file, settings) {
  settings = settings || SETTINGS;

  var w = readWav(file);
  var found = splitClips(w.samples, w.rate, settings.length);

  if (found.clips.length !== settings.length) {
    var says = ['found ' + found.clips.length + ' clips in ' + found.seconds.toFixed(1) +
                's, expected ' + settings.length];

    found.clips.forEach(function (c, i) {
      says.push('    clip ' + (i + 1) + ': ' + c.seconds[0].toFixed(2) + 's .. ' +
                c.seconds[1].toFixed(2) + 's');
    });

    says.push('  loudest ' + found.peakDb.toFixed(1) + ' dBFS, floor ' +
              found.floorDb.toFixed(0) + ' dB below that');

    // A take with no dynamic range at all did not capture the sampler: notes and gaps
    // look identical, which happens when the input is recording hiss rather than the
    // instrument. Worth saying plainly - it is otherwise indistinguishable from a
    // splitting problem, and sends people looking in the wrong place.
    if (found.floorDb > -12)
      says.push('  the quietest part of this take is only ' + (-found.floorDb).toFixed(0) +
                ' dB below the loudest, so there are no gaps in it. Nothing was triggered, ' +
                'or the recording is of something other than the sampler.');
    else if (found.zeroFraction > 0.5)
      says.push('  ' + (found.zeroFraction * 100).toFixed(0) + '% of the file is exact ' +
                'digital zero - nothing was reaching the recorder there, so this looks ' +
                'like a timeline longer than the take rather than a quiet sampler');
    else
      says.push('  gaps need 150 ms of silence, clips 250 ms of sound');

    throw new Error(says.join('\n'));
  }

  var measured = found.clips.map(function (c, i) {
    return {
      setting: settings[i],
      rate: w.rate,
      seconds: c.seconds,
      spec: spectrum(w.samples.subarray(c.from, c.to), w.rate, BANDS)
    };
  });

  var out = fit(measured);
  out.clips = measured.map(function (m) { return { setting: m.setting, seconds: m.seconds }; });
  out.floorDb = found.floorDb;
  return out;
}
/**
 * Read a folder of recordings and work out the cutoff mapping.
 *
 * Returns { readings, minHz, maxHz, worstOctaves, exponential }, where `readings` has
 * one entry per recording - its setting, the corner found, and whether it was steady
 * enough to fit. Everything printed by the CLI comes from this.
 */
function analyse(dir) {
  var files = fs.readdirSync(dir).filter(function (f) { return /\.wav$/i.test(f); })
                .map(function (f) {
                  var m = f.match(/(\d{1,2})/);
                  return m ? { file: f, setting: parseInt(m[1], 10) } : null;
                })
                .filter(Boolean)
                .sort(function (a, b) { return a.setting - b.setting; });

  if (files.length < 3) throw new Error(files.length + ' usable recordings; need at least 3');

  var measured = files.map(function (x) {
    var w = readWav(path.join(dir, x.file));
    return { setting: x.setting, rate: w.rate, spec: spectrum(w.samples, w.rate, BANDS) };
  });

  return fit(measured);
}

module.exports = {
  analyse: analyse, analyseFile: analyseFile, splitClips: splitClips,
  readWav: readWav, spectrum: spectrum, fit: fit, BANDS: BANDS, SETTINGS: SETTINGS
};

// ------------------------------------------------------------------------ CLI

if (require.main === module) {
  var r, single = /\.wav$/i.test(dir);

  // A settings list may follow the file, so a shorter run still works. Three or four
  // clips spread across the range fit a curve perfectly well, and insisting on eleven
  // when four would do is a good way to end up with none.
  var settings = null;
  if (process.argv[3]) {
    settings = process.argv[3].split(/[ ,]+/).filter(Boolean).map(Number);
    if (settings.some(isNaN)) {
      console.log('settings must be numbers, e.g.  0,30,60,99');
      process.exit(1);
    }
  }

  try { r = single ? analyseFile(dir, settings) : analyse(dir); }
  catch (e) { console.log(e.message); process.exit(1); }

  if (single) {
    console.log('');
    console.log('one recording, split on silence (floor is ' + r.floorDb.toFixed(0) +
                ' dB below the loudest clip):');
    r.clips.forEach(function (c) {
      console.log('    setting ' + String(c.setting).padStart(3) + '   ' +
                  c.seconds[0].toFixed(2) + 's .. ' + c.seconds[1].toFixed(2) + 's');
    });
    console.log('  check those line up with what you played before trusting the rest.');
  }

  console.log('');
  console.log('using setting ' + r.reference + ' as the open reference');
  console.log('');
  console.log('  setting   -3 dB corner');

  r.readings.forEach(function (x) {
    if (x.corner === null) {
      console.log('    ' + String(x.setting).padStart(3) +
                  '      no corner found - too open, or too quiet to measure');
      return;
    }
    console.log('    ' + String(x.setting).padStart(3) + '      ' +
                x.corner.toFixed(0).padStart(6) + ' Hz' +
                (x.used ? '' : '   (close to the reference - not used in the fit)'));
  });

  console.log('');
  console.log('fitted: exponential from ' + r.minHz.toFixed(0) + ' Hz at 0 to ' +
              r.maxHz.toFixed(0) + ' Hz at 99');
  console.log('worst deviation from that curve: ' + r.worstOctaves.toFixed(2) + ' octaves');
  console.log(r.exponential
    ? '  -> the mapping is exponential; the two end points are enough'
    : '  -> a poor fit. The mapping is not a simple exponential - keep the measured\n' +
      '     corners above and use a lookup table instead of MIN_HZ/MAX_HZ.');

  console.log('');
  console.log('paste into audio.js:');
  console.log('');
  console.log('  var CAL = {');
  console.log('    MIN_HZ: ' + Math.round(r.minHz) + ',          // measured');
  console.log('    MAX_HZ: ' + Math.round(r.maxHz) + ',        // measured');
  console.log('    ENV_OCTAVES: 4,       // still assumed');
  console.log('    VEL_OCTAVES: 2,       // still assumed');
  console.log('    KEY_FULL: 50,         // still assumed');
  console.log('    ENV_MIN_MS: 1,        // still assumed');
  console.log('    ENV_MAX_MS: 10000     // still assumed');
  console.log('  };');
  console.log('');
  console.log('The envelope and tracking depths need their own recordings: repeat with a');
  console.log('fixed cutoff and VCF amount, velocity or key tracking varied instead.');
}
