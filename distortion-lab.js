(() => {
  const sampleRate = 44100;
  const durationSec = 2.0;
  const FIXED_INPUT_GAIN_DB = 0;
  const FFT_DB_MIN_DEFAULT = -60;
  const FFT_DB_MAX = 10;
  const HPF_CUTOFF_HZ = 50;
  const SOURCE_LABELS = ["无输入", "正弦波", "合成单音", "合成和弦", "文件1", "文件2", "文件3"];

  const $ = (id) => document.getElementById(id);
  const els = {
    inputFold: $("inputFold"),
    sourceKnob: $("sourceKnob"), sourceKnobIdx: $("sourceKnobIdx"), sourceKnobLabel: $("sourceKnobLabel"),
    snap220: $("snap220"), snap440: $("snap440"),
    sineFreq: $("sineFreq"), sineFreqNum: $("sineFreqNum"),
    inputFile1: $("inputFile1"), inputFile2: $("inputFile2"), inputFile3: $("inputFile3"),
    fileStatus1: $("fileStatus1"), fileStatus2: $("fileStatus2"), fileStatus3: $("fileStatus3"),
    gainDb: $("gainDb"), gainDbNum: $("gainDbNum"), gainRow: $("gainRow"),
    distOn: $("distOn"), algo: $("algo"),
    threshold: $("threshold"), thresholdNum: $("thresholdNum"),
    drive: $("drive"), driveNum: $("driveNum"), driveKnob: $("driveKnob"),
    asymToggle: $("asymToggle"),
    timeWindowMs: $("timeWindowMsUi") || $("timeWindowMs"), timeWindowMsNum: $("timeWindowMsUiNum") || $("timeWindowMsNum"),
    timeOffsetMs: $("timeOffsetMsUi") || $("timeOffsetMs"), timeOffsetMsNum: $("timeOffsetMsUiNum") || $("timeOffsetMsNum"),
    splitView: $("splitViewUi") || $("splitView"),
    showThreshMain: $("showThreshMainUi"),
    showThreshOut: $("showThreshOutUi"),
    transportPlayIn: $("transportPlayIn"), transportPlayOut: $("transportPlayOut"), transportStop: $("transportStop"),
    transportPosMs: $("transportPosMs"), transportPosMsNum: $("transportPosMsNum"), transportPosLabel: $("transportPosLabel"),
    loopEnable: $("loopEnable"), returnToStart: $("returnToStart"),
    loopDurationMs: $("loopDurationMs"), loopDurationMsNum: $("loopDurationMsNum"),
    transportCanvas: $("transportCanvas"),
    timeCanvas: $("timeCanvas"), timeOutCanvas: $("timeOutCanvas"), freqCanvas: $("freqCanvas"),
    stage: $("stage"), timeMainCard: $("timeMainCard"), timeOutCard: $("timeOutCard"), freqCard: $("freqCard"),
    timeRow: $("timeRow"),
    threshRow: $("threshRow"), asymRow: $("asymRow"),
    fftMaxHz: $("fftMaxHz"), fftMaxHzNum: $("fftMaxHzNum"), fftLogX: $("fftLogX"),
    fftDbMin: $("fftDbMin"), fftDbMinNum: $("fftDbMinNum"),
    playbackGainDb: $("playbackGainDb"), playbackGainDbNum: $("playbackGainDbNum"),
    showPreClip: $("showPreClipUi"),
    distOnFoot: $("distOnFoot"),
    closeDisclaimerToast: $("closeDisclaimerToast"), algoDisclaimerToast: $("algoDisclaimerToast"),
    foldTimeMain: $("foldTimeMain"), foldTimeOut: $("foldTimeOut"), foldFreq: $("foldFreq"),
  };

  const ctxTime    = els.timeCanvas.getContext("2d");
  const ctxTimeOut = els.timeOutCanvas.getContext("2d");
  const ctxFreq    = els.freqCanvas.getContext("2d");

  const state = {
    inputRaw: null, inputGained: null, preClip: null, output: null,
    fileBuffers: [null, null, null],
    audioCtx: null, sourceNode: null,
    currentPlayBuffer: null,
    currentPlayMode: null, // "in" | "out"
    stopRequested: false,
    isPlaying: false,
    playStartAcTime: null,   // AudioContext.currentTime when current segment started
    playStartOffsetSec: null, // buffer offset (seconds) when current segment started
  };

  // ─── Fixed clipping thresholds modelled after real hardware ───────────────
  // All values are normalised to a ±1 signal range before the drive stage.
  //
  // overdrive  (TS-808): op-amp soft clip via feedback diodes.
  //   1N914 silicon diodes (~0.65V Vf) in anti-parallel in the feedback loop.
  //   The circuit is nearly symmetric; slight asymmetry via gain-stage topology.
  //   pos = 0.65, neg = 0.65 (sym soft tanh)
  //
  // distortion (RAT):  LM308 op-amp hard-limits then two silicon diodes clip.
  //   Symmetric 1N914 diodes: both sides clip at the same threshold.
  //   Harder knee than TS; closer to hard clip. pos = 0.65, neg = 0.65 (atan steep)
  //
  // mosfet     (OCD):  J201 JFET + silicon diode asymmetric clipping.
  //   Positive half: JFET exponential saturation (soft, rolls off gradually).
  //   Negative half: single diode hard clip (sharper, lower threshold).
  //   pos = 0.70, neg = 0.38
  //
  // fuzz       (Fuzz Face / Big Muff):
  //   Fuzz Face: two germanium transistors near saturation, near-square wave.
  //   Big Muff: four cascaded clipping stages – symmetric, near-square.
  //   Both produce extreme limiting. pos = neg = 0.22
  //
  // rectifier  (Mesa Boogie Dual Rectifier):
  //   Named after the 5AR4 tube rectifier in the PSU which "sags" under load.
  //   This causes asymmetric compression: heavy positive peak compression,
  //   harder negative clamp. Modelled as asymmetric tanh + hard clip.
  //   pos = 0.80 (soft), neg = 0.30 (hard)
  //
  // timmy      (Paul Cochrane Timmy – transparent OD):
  //   Single silicon diode clips only the NEGATIVE half; positive passes nearly
  //   clean. This creates strong even harmonics while preserving touch dynamics.
  //   pos = 1.10 (barely clips), neg = 0.45 (clips more decisively)

  const ALGO_FIXED = {
    overdrive:  { pos: 0.65, neg: 0.65 },
    distortion: { pos: 0.65, neg: 0.65 },
    mosfet:     { pos: 0.70, neg: 0.38 },
    fuzz:       { pos: 0.22, neg: 0.22 },
    rectifier:  { pos: 0.80, neg: 0.30 },
    timmy:      { pos: 1.10, neg: 0.45 },
  };

  // ─── Helpers ──────────────────────────────────────────────────────────────
  function dbToLin(db) { return Math.pow(10, db / 20); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
  function linToDb(x) { return 20 * Math.log10(Math.max(1e-9, x)); }

  function getFftConfig() {
    return { fftLen: 4096, hop: 2048, oversample: 4 }; // fixed DETAIL mode
  }

  function getThresholds(algo, userTh, asymOn) {
    if (algo === "hardclip") {
      const th = clamp(userTh, 0.05, 1.5);
      return { pos: th, neg: asymOn ? 2.0 : th };   // asymOn = only clip positive
    }
    return Object.assign({}, ALGO_FIXED[algo] || { pos: 0.65, neg: 0.65 });
  }

  // ─── Signal generation ────────────────────────────────────────────────────
  function generateSine(freq) {
    const n = Math.floor(sampleRate * durationSec);
    const out = new Float32Array(n);
    const w = 2 * Math.PI * freq / sampleRate;
    for (let i = 0; i < n; i++) out[i] = Math.sin(w * i);
    return out;
  }

  function generateGuitarSingle() {
    const n = Math.floor(sampleRate * durationSec);
    const out = new Float32Array(n);
    const f0 = 110;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-3.5 * t) * (1 - Math.exp(-120 * t));
      out[i] = env * (0.75 * Math.sin(2*Math.PI*f0*t) +
                      0.28 * Math.sin(2*Math.PI*f0*2*t + 0.2) +
                      0.14 * Math.sin(2*Math.PI*f0*3*t + 0.5));
    }
    return out;
  }

  function generateGuitarChord() {
    const n = Math.floor(sampleRate * durationSec);
    const out = new Float32Array(n);
    const notes = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63];
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-2.6 * t) * (1 - Math.exp(-85 * t));
      let s = 0;
      for (let k = 0; k < notes.length; k++) {
        s += (0.12 + k*0.015) * Math.sin(2*Math.PI*notes[k]*t + k*0.2);
        s += (0.03 + k*0.004) * Math.sin(2*Math.PI*notes[k]*2*t + k*0.4);
      }
      out[i] = env * s;
    }
    return out;
  }

  function upsampleLinear(input, factor) {
    if (factor <= 1) return input.slice();
    const outLen = input.length * factor;
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const p = i / factor;
      const a = Math.floor(p);
      const b = Math.min(a + 1, input.length - 1);
      const t = p - a;
      const va = input[Math.min(a, input.length - 1)] || 0;
      const vb = input[b] || 0;
      out[i] = va + (vb - va) * t;
    }
    return out;
  }

  function onePoleLowpass(signal, cutoffHz, sr) {
    const out = new Float32Array(signal.length);
    const dt = 1 / sr;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const alpha = dt / (rc + dt);
    out[0] = signal[0] || 0;
    for (let i = 1; i < signal.length; i++) out[i] = out[i - 1] + alpha * (signal[i] - out[i - 1]);
    return out;
  }

  function onePoleHighpass(signal, cutoffHz, sr) {
    const out = new Float32Array(signal.length);
    const dt = 1 / sr;
    const rc = 1 / (2 * Math.PI * cutoffHz);
    const alpha = rc / (rc + dt);
    out[0] = signal[0] || 0;
    for (let i = 1; i < signal.length; i++) out[i] = alpha * (out[i - 1] + signal[i] - signal[i - 1]);
    return out;
  }

  function downsample(signal, factor, outLen) {
    if (factor <= 1) return signal.slice(0, outLen);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) out[i] = signal[Math.min(i * factor, signal.length - 1)] || 0;
    return out;
  }

  // ─── Distortion engine ───────────────────────────────────────────────────
  function applyDistortion(x, cfg) {
    const y = new Float32Array(x.length);
    const drive = dbToLin(cfg.driveDb);
    const { pos, neg } = getThresholds(cfg.algo, cfg.threshold, cfg.asymOn);
    const on   = cfg.distOn;
    const algo = cfg.algo;

    for (let i = 0; i < x.length; i++) {
      let s = x[i];
      if (on) {
        const d = s * drive;

        if (algo === "hardclip") {
          // ── Digital hard clip: flat ceiling, square wave at high drive ──
          s = clamp(d, -neg, pos);

        } else if (algo === "overdrive") {
          // ── TS-808 / Tube Screamer style ──
          // Soft symmetric tanh (diodes in op-amp feedback loop).
          // Rounds off peaks smoothly → warm, compressed character.
          s = d >= 0
            ? pos * Math.tanh(d / pos)
            : -neg * Math.tanh(-d / neg);

        } else if (algo === "distortion") {
          // ── RAT / DS-1 style ──
          // Atan curve with a steeper knee than TS, then hard rail.
          // LM308 goes into saturation abruptly → more aggressive edge.
          const k = 3.5;
          s = d >= 0
            ? pos * (2/Math.PI) * Math.atan(d / pos * k)
            : -neg * (2/Math.PI) * Math.atan(-d / neg * k);
          s = clamp(s, -neg, pos);

        } else if (algo === "mosfet") {
          // ── Fulltone OCD (J201 JFET + diode) style ──
          // Positive: JFET exponential saturation (smooth rollover).
          // Negative: single diode → harder, lower threshold.
          if (d >= 0) {
            s = pos * (1 - Math.exp(-d / pos * 1.6));
          } else {
            const a = -d / neg;
            // Soft knee up to threshold, then hard limit
            s = -(a < 1
              ? neg * (a - a * a * a / 3)
              : neg * Math.min(1.0, 0.7 + 0.4 * (a - 1)));
          }

        } else if (algo === "fuzz") {
          // ── Fuzz Face / Big Muff style ──
          // Extreme clipping → near-square wave.
          // Very steep tanh (k=10) approximates the transistor saturation + cascaded stages.
          const sign = d >= 0 ? 1 : -1;
          s = sign * pos * Math.tanh(Math.abs(d) / pos * 10);
          s = clamp(s, -neg, pos);

        } else if (algo === "rectifier") {
          // ── Mesa Boogie Dual Rectifier style ──
          // Tube rectifier sag: positive peaks compressed softly,
          // negative half meets a harder, lower clip threshold.
          if (d >= 0) {
            s = pos * Math.tanh(d / pos * 2.5);  // soft heavy compression
          } else {
            s = clamp(d, -neg, 0);               // hard clip at lower neg threshold
          }

        } else if (algo === "timmy") {
          // ── Paul Cochrane Timmy (transparent OD) style ──
          // Single diode: only NEGATIVE half clips (at lower threshold).
          // Positive half passes nearly clean through the op-amp.
          // Asymmetry produces even harmonics → "warm" but transparent.
          const clean = d;
          const clipped = d >= 0
            ? d
            : -neg * Math.tanh(-d / neg * 2.1);
          s = 0.72 * clean + 0.28 * clipped; // preserve attack/transparency
        }
      }
      y[i] = s;
    }
    return { output: y, pos, neg };
  }

  function processDistortionWithAA(input, cfg, oversample) {
    if (oversample <= 1) return applyDistortion(input, cfg);
    const up = upsampleLinear(input, oversample);
    const highCfg = { ...cfg };
    const high = applyDistortion(up, highCfg);
    // Anti-aliasing: low-pass before decimation (kept below base Nyquist)
    const cutoff = sampleRate * 0.45;
    let filtered = onePoleLowpass(high.output, cutoff, sampleRate * oversample);
    filtered = onePoleLowpass(filtered, cutoff, sampleRate * oversample);
    const down = downsample(filtered, oversample, input.length);
    return { output: down, pos: high.pos, neg: high.neg };
  }

  // ─── Audio playback ───────────────────────────────────────────────────────
  function ensureAudioCtx() {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    return state.audioCtx;
  }
  function normalizeForPlayback(x) {
    let peak = 1e-8;
    for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
    const g = 0.98 / peak;
    const out = new Float32Array(x.length);
    for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
    return out;
  }
  // (applyFadeInOut removed – fade is now applied inline in play())
  function play(buffer, mode) {
    stopPlayback(); // sets stopRequested = true, clears sourceNode
    state.stopRequested = false; // now we're starting fresh
    state.isPlaying = true;
    state.currentPlayBuffer = buffer;
    state.currentPlayMode = mode;

    const ac = ensureAudioCtx();
    if (ac.state === "suspended") ac.resume();

    const playbackLin = dbToLin(+els.playbackGainDb.value);
    const totalMs = Math.floor((buffer.length / sampleRate) * 1000);
    const loopOn = !!els.loopEnable.checked;

    // ── Calculate play region ────────────────────────────────────────────────
    const transportMs = clamp(+els.transportPosMs.value, 0, Math.max(0, totalMs - 1));
    let startMs, endMs;
    if (loopOn) {
      startMs = transportMs;
      const durMs = Math.max(500, +els.loopDurationMs.value);
      endMs = Math.min(totalMs, startMs + durMs);
      if (endMs - startMs < 50) endMs = Math.min(totalMs, startMs + 50);
    } else {
      startMs = transportMs;
      endMs = totalMs;
    }

    const startSample = Math.floor(startMs / 1000 * sampleRate);
    const endSample   = Math.min(buffer.length, Math.ceil(endMs / 1000 * sampleRate));
    const sliceLen    = Math.max(1, endSample - startSample);

    // ── Extract slice with fade in/out to prevent pops ───────────────────────
    const fadeSamples = Math.min(Math.floor(sliceLen / 8), Math.max(64, Math.floor(sampleRate * 0.01))); // ≈10ms
    const normalized  = normalizeForPlayback(buffer.slice(startSample, endSample));
    for (let i = 0; i < fadeSamples; i++) {
      const g = i / fadeSamples;
      normalized[i] *= g;
      normalized[normalized.length - 1 - i] *= g;
    }
    for (let i = 0; i < normalized.length; i++) normalized[i] *= playbackLin;

    const ab = ac.createBuffer(1, normalized.length, sampleRate);
    ab.copyToChannel(normalized, 0);
    const src = ac.createBufferSource();
    src.buffer = ab;
    src.connect(ac.destination);

    state.playStartAcTime    = ac.currentTime;
    state.playStartOffsetSec = startMs / 1000;

    src.onended = () => {
      state.sourceNode = null;
      if (state.stopRequested) {
        // Explicit stop – do not loop, optionally return to start
        state.isPlaying = false;
        if (els.returnToStart.checked) {
          els.transportPosMs.value    = String(transportMs);
          els.transportPosMsNum.value = String(transportMs);
          syncOffsetToTransport();
        }
        drawTransportWave(); // refresh marker
        return;
      }
      if (loopOn) {
        play(buffer, mode); // seamless loop
      } else {
        state.isPlaying = false;
        if (els.returnToStart.checked) {
          els.transportPosMs.value    = String(transportMs);
          els.transportPosMsNum.value = String(transportMs);
          syncOffsetToTransport();
          renderAll();
        }
        drawTransportWave();
      }
    };

    src.start(0);
    state.sourceNode = src;
    tickPlayhead(); // start playhead animation
  }

  function stopPlayback() {
    state.stopRequested = true;
    state.isPlaying     = false;
    if (state.sourceNode) {
      try { state.sourceNode.stop(); } catch (_) {}
      state.sourceNode.disconnect();
      state.sourceNode = null;
    }
  }

  // ── Mini transport waveform ────────────────────────────────────────────────
  function drawTransportWave(playheadMs) {
    const c = els.transportCanvas;
    if (!c) return;
    const dpr  = devicePixelRatio || 1;
    const rect = c.getBoundingClientRect();
    const cw   = Math.max(1, Math.floor(rect.width));
    const ch   = Math.max(1, Math.floor(rect.height));
    if (c.width !== cw * dpr || c.height !== ch * dpr) {
      c.width = cw * dpr; c.height = ch * dpr;
      c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const ctx = c.getContext("2d");
    const W = cw, H = ch;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#0a0e14";
    ctx.fillRect(0, 0, W, H);

    const buf = (state.currentPlayMode === "out" ? state.output : null) || state.output || state.inputGained;
    if (!buf || buf.length === 0) return;

    const totalMs = (buf.length / sampleRate) * 1000;
    const msToX   = ms => (ms / totalMs) * W;

    // Loop region shading
    if (els.loopEnable.checked) {
      const ls  = clamp(+els.transportPosMs.value, 0, totalMs);
      const dur = Math.max(500, +els.loopDurationMs.value);
      const le  = Math.min(totalMs, ls + dur);
      ctx.fillStyle = "rgba(255,160,50,0.13)";
      ctx.fillRect(msToX(ls), 0, msToX(le) - msToX(ls), H);
      ctx.strokeStyle = "rgba(255,160,50,0.5)";
      ctx.lineWidth = 1;
      [ls, le].forEach(ms => { ctx.beginPath(); ctx.moveTo(msToX(ms), 0); ctx.lineTo(msToX(ms), H); ctx.stroke(); });
    }

    // Waveform overview (downsampled, peak-hold per pixel)
    ctx.strokeStyle = "rgba(0,210,110,0.55)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    const step = buf.length / W;
    for (let px = 0; px < W; px++) {
      const si = Math.floor(px * step);
      const y  = H * 0.5 * (1 - (buf[Math.min(si, buf.length - 1)] || 0) * 0.82);
      px === 0 ? ctx.moveTo(px, y) : ctx.lineTo(px, y);
    }
    ctx.stroke();

    // Transport/playhead marker
    const markerMs = playheadMs !== undefined ? playheadMs : +els.transportPosMs.value;
    const mx = msToX(clamp(markerMs, 0, totalMs));
    ctx.strokeStyle = playheadMs !== undefined ? "#fff" : "rgba(255,255,255,0.45)";
    ctx.lineWidth   = playheadMs !== undefined ? 1.5 : 1;
    ctx.beginPath(); ctx.moveTo(mx, 0); ctx.lineTo(mx, H); ctx.stroke();
  }

  // Animate playhead while playing
  function tickPlayhead() {
    if (!state.isPlaying || !state.audioCtx || state.playStartAcTime === null) return;
    const elapsed   = state.audioCtx.currentTime - state.playStartAcTime;
    const loopOn    = els.loopEnable.checked;
    const loopDurSec = Math.max(0.5, +els.loopDurationMs.value) / 1000;
    const startSec  = state.playStartOffsetSec;
    // wrap elapsed within loop duration when looping
    const withinSec = loopOn ? (elapsed % loopDurSec) : elapsed;
    const playheadMs = (startSec + withinSec) * 1000;
    drawTransportWave(playheadMs);
    requestAnimationFrame(tickPlayhead);
  }

  // ─── File loading ─────────────────────────────────────────────────────────
  function toMonoFloat32(audioBuffer, maxSeconds = 30) {
    const len = audioBuffer.length, channels = audioBuffer.numberOfChannels;
    const out = new Float32Array(len);
    for (let ch = 0; ch < channels; ch++) {
      const d = audioBuffer.getChannelData(ch);
      for (let i = 0; i < len; i++) out[i] += d[i] / channels;
    }
    const outLen = Math.floor(sampleRate * Math.min(maxSeconds, audioBuffer.duration));
    return resampleLinear(out, audioBuffer.sampleRate, sampleRate, outLen);
  }
  function resampleLinear(input, inSR, outSR, outLen) {
    if (inSR === outSR && input.length >= outLen) return input.slice(0, outLen);
    const out = new Float32Array(outLen);
    const ratio = inSR / outSR;
    for (let i = 0; i < outLen; i++) {
      const p = i * ratio, a = Math.floor(p), b = Math.min(a+1, input.length-1), t = p-a;
      out[i] = (input[Math.min(a, input.length-1)] || 0) * (1-t) + (input[b] || 0) * t;
    }
    return out;
  }
  async function loadFile(file, maxSeconds = 30) {
    if (!file) return null;
    const arr = await file.arrayBuffer();
    const ac = ensureAudioCtx();
    const decoded = await ac.decodeAudioData(arr.slice(0));
    if (decoded.duration > maxSeconds) {
      const err = new Error(`文件长度超过 ${maxSeconds}s`);
      err.code = "FILE_TOO_LONG";
      throw err;
    }
    return toMonoFloat32(decoded, maxSeconds);
  }

  // ─── FFT ──────────────────────────────────────────────────────────────────
  function fftMagFrame(signal, n, offset) {
    const re = new Float32Array(n), im = new Float32Array(n), win = new Float32Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    for (let i = 0; i < n; i++) re[i] = (signal[offset + i] || 0) * win[i];
    let j = 0;
    for (let i = 1; i < n; i++) {
      let bit = n >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; } j ^= bit;
      if (i < j) { [re[i],re[j]]=[re[j],re[i]]; [im[i],im[j]]=[im[j],im[i]]; }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2*Math.PI/len, wlRe = Math.cos(ang), wlIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1, wIm = 0;
        for (let k = 0; k < len/2; k++) {
          const uRe=re[i+k], uIm=im[i+k];
          const vRe=re[i+k+len/2]*wRe-im[i+k+len/2]*wIm, vIm=re[i+k+len/2]*wIm+im[i+k+len/2]*wRe;
          re[i+k]=uRe+vRe; im[i+k]=uIm+vIm; re[i+k+len/2]=uRe-vRe; im[i+k+len/2]=uIm-vIm;
          const nwRe=wRe*wlRe-wIm*wlIm; wIm=wRe*wlIm+wIm*wlRe; wRe=nwRe;
        }
      }
    }
    const half = n >> 1, mag = new Float32Array(half);
    for (let i = 0; i < half; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / half;
    return mag;
  }

  function fftMagAveraged(signal, n, hop) {
    const half = n >> 1;
    const acc = new Float32Array(half);
    let frames = 0;
    for (let off = 0; off + n <= signal.length; off += hop) {
      const m = fftMagFrame(signal, n, off);
      for (let i = 0; i < half; i++) acc[i] += m[i];
      frames++;
      if (frames >= 16) break; // cap for UI responsiveness
    }
    if (frames === 0) return fftMagFrame(signal, n, 0);
    for (let i = 0; i < half; i++) acc[i] /= frames;
    return acc;
  }

  // ─── Canvas rendering ─────────────────────────────────────────────────────
  function resizeCanvas(c) {
    // Use canvas' own rendered size (client box), not parent border-box.
    // This avoids feedback loops where setting px width/height changes layout,
    // which then retriggers ResizeObserver and can cause progressive growth.
    const dpr = devicePixelRatio || 1;
    const w = Math.floor(c.clientWidth);
    const h = Math.floor(c.clientHeight);
    if (w <= 0 || h <= 0) return false;
    const targetW = Math.max(1, Math.floor(w * dpr));
    const targetH = Math.max(1, Math.floor(h * dpr));
    if (c.width === targetW && c.height === targetH) return false;
    c.width = targetW;
    c.height = targetH;
    c.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    return true;
  }
  function resizeAll() {
    resizeCanvas(els.timeCanvas); resizeCanvas(els.timeOutCanvas); resizeCanvas(els.freqCanvas);
    renderAll();
  }

  function drawGrid(ctx, area, xDiv = 10, yDiv = 8) {
    ctx.clearRect(0, 0, ctx.canvas.clientWidth, ctx.canvas.clientHeight);
    ctx.fillStyle = "#0f131a";
    ctx.fillRect(0, 0, ctx.canvas.clientWidth, ctx.canvas.clientHeight);
    ctx.strokeStyle = "#1a2230";
    ctx.lineWidth = 1;
    for (let i = 1; i < xDiv; i++) {
      const x = area.l + (area.w * i) / xDiv;
      ctx.beginPath(); ctx.moveTo(x, area.t); ctx.lineTo(x, area.t + area.h); ctx.stroke();
    }
    for (let i = 1; i < yDiv; i++) {
      const y = area.t + (area.h * i) / yDiv;
      ctx.beginPath(); ctx.moveTo(area.l, y); ctx.lineTo(area.l + area.w, y); ctx.stroke();
    }
    ctx.strokeStyle = "#2b3b52";
    ctx.beginPath(); ctx.rect(area.l, area.t, area.w, area.h); ctx.stroke();
  }

  function getTimeWindow(totalSamples) {
    const windowMs = +els.timeWindowMs.value, offsetMs = +els.timeOffsetMs.value;
    const samplesToShow = Math.max(64, Math.floor(windowMs/1000*sampleRate));
    const start = clamp(Math.floor(offsetMs/1000*sampleRate), 0, Math.max(0, totalSamples-samplesToShow));
    return { start, end: Math.min(totalSamples, start+samplesToShow) };
  }

  function drawThreshLines(ctx, area, pos, neg, yScale) {
    const toY = v => area.t + area.h * 0.5 * (1 - v / yScale);
    ctx.setLineDash([7,5]); ctx.strokeStyle = "rgba(255,180,100,0.85)"; ctx.lineWidth = 1.2;
    if (pos <= yScale) { ctx.beginPath(); ctx.moveTo(area.l,toY(pos)); ctx.lineTo(area.l + area.w,toY(pos)); ctx.stroke(); }
    if (neg <= yScale) { ctx.beginPath(); ctx.moveTo(area.l,toY(-neg)); ctx.lineTo(area.l + area.w,toY(-neg)); ctx.stroke(); }
    ctx.setLineDash([]);
  }

  function drawWave(ctx, area, sig, color, lw, start, end, yScale) {
    const len = Math.max(1, end - start);
    ctx.strokeStyle = color; ctx.lineWidth = lw; ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const x = area.l + (i / (len - 1 || 1)) * area.w;
      const y = area.t + area.h * 0.5 * (1 - sig[start + i] / yScale);
      i===0 ? ctx.moveTo(x,y) : ctx.lineTo(x,y);
    }
    ctx.stroke();
  }

  function drawAxisLabelsTime(ctx, area, windowMs, yScale) {
    ctx.fillStyle = "#9eb1cc";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("电压/幅度 Voltage (norm)", 6, area.t + 10);
    ctx.fillText("时间 Time (ms)", area.l + area.w - 72, area.t + area.h + 24);
    ctx.fillText(`+${yScale.toFixed(1)}`, area.l - 32, area.t + 4);
    ctx.fillText("0", area.l - 16, area.t + area.h * 0.5 + 3);
    ctx.fillText(`-${yScale.toFixed(1)}`, area.l - 34, area.t + area.h - 2);
    for (let i = 0; i <= 4; i++) {
      const x = area.l + (area.w * i) / 4;
      const t = (windowMs * i) / 4;
      ctx.fillText(`${t.toFixed(0)}`, x - 7, area.t + area.h + 14);
    }
  }

  function drawAxisLabelsFreq(ctx, area, maxHz, logX, dbMin, xMinHz) {
    ctx.fillStyle = "#9eb1cc";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("幅度 Magnitude (dBr, 参考=输入峰值)", 6, area.t + 10);
    ctx.fillText(`频率 Frequency (Hz) ${logX ? "[log]" : "[linear]"}`, area.l + area.w - 132, area.t + area.h + 24);
    const yTicks = [dbMin, dbMin + 10, dbMin + 20, dbMin + 30, dbMin + 40, dbMin + 50, 0].filter((v, i, a) => v <= 0 && a.indexOf(v) === i);
    for (const t of yTicks) {
      const y = area.t + area.h * (1 - (t - dbMin) / (FFT_DB_MAX - dbMin));
      ctx.fillText(`${t}`, area.l - 30, y + 3);
    }
    const xTicks = logX
      ? [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000].filter(v => v >= xMinHz && v <= maxHz)
      : [xMinHz, xMinHz + (maxHz - xMinHz) * 0.25, xMinHz + (maxHz - xMinHz) * 0.5, xMinHz + (maxHz - xMinHz) * 0.75, maxHz];
    const minLogHz = xMinHz;
    for (const f0 of xTicks) {
      const f = Math.max(minLogHz, f0);
      const x = logX
        ? area.l + area.w * (Math.log10(f / minLogHz) / Math.log10(maxHz / minLogHz))
        : area.l + area.w * ((f - xMinHz) / (maxHz - xMinHz));
      ctx.fillText(`${f}`, x - 10, area.t + area.h + 14);
    }
  }

  function drawTime(inSig, preClipSig, outSig, pos, neg) {
    const w = els.timeCanvas.clientWidth, h = els.timeCanvas.clientHeight;
    const yS = 2.0;
    const fullArea = { l: 52, t: 26, w: Math.max(10, w - 68), h: Math.max(10, h - 58) };
    drawGrid(ctxTime, fullArea, 10, 8);
    const {start, end} = getTimeWindow(Math.min(inSig.length, outSig.length));
    const windowMs = +els.timeWindowMs.value;
    const showPre = els.showPreClip ? !!els.showPreClip.checked : true;
    const showThreshMain = els.showThreshMain ? !!els.showThreshMain.checked : true;
    if (els.splitView.checked) {
      const half = fullArea.h * 0.5;
      const topArea = { l: fullArea.l, t: fullArea.t, w: fullArea.w, h: half };
      const botArea = { l: fullArea.l, t: fullArea.t + half, w: fullArea.w, h: half };
      // divider line
      ctxTime.strokeStyle = "rgba(100,120,150,0.4)"; ctxTime.lineWidth = 1;
      ctxTime.beginPath(); ctxTime.moveTo(fullArea.l, fullArea.t + half); ctxTime.lineTo(fullArea.l + fullArea.w, fullArea.t + half); ctxTime.stroke();
      // Top half: input + pre-clip – clipped to topArea so pre-clip wave can't bleed below
      ctxTime.save();
      ctxTime.beginPath(); ctxTime.rect(topArea.l, topArea.t, topArea.w, topArea.h); ctxTime.clip();
      if (showThreshMain) drawThreshLines(ctxTime, topArea, pos, neg, yS);
      drawWave(ctxTime, topArea, inSig,  "rgba(0,230,110,0.9)",  1.4, start, end, yS);
      if (showPre) {
        ctxTime.setLineDash([6, 4]);
        drawWave(ctxTime, topArea, preClipSig, "rgba(235,220,90,0.9)", 1.2, start, end, yS);
        ctxTime.setLineDash([]);
      }
      ctxTime.restore();
      // Bottom half: output
      ctxTime.save();
      ctxTime.beginPath(); ctxTime.rect(botArea.l, botArea.t, botArea.w, botArea.h); ctxTime.clip();
      if (showThreshMain) drawThreshLines(ctxTime, botArea, pos, neg, yS);
      drawWave(ctxTime, botArea, outSig, "rgba(90,160,255,0.9)", 1.5, start, end, yS);
      ctxTime.restore();
    } else {
      if (showThreshMain) drawThreshLines(ctxTime, fullArea, pos, neg, yS);
      drawWave(ctxTime, fullArea, inSig,  "rgba(0,230,110,0.9)",  1.4, start,end, yS);
      if (showPre) {
        ctxTime.setLineDash([6, 4]);
        drawWave(ctxTime, fullArea, preClipSig, "rgba(235,220,90,0.9)", 1.2, start, end, yS);
        ctxTime.setLineDash([]);
      }
      drawWave(ctxTime, fullArea, outSig, "rgba(90,160,255,0.9)", 1.5, start,end, yS);
    }
    drawAxisLabelsTime(ctxTime, fullArea, windowMs, yS);
  }

  function drawTimeOut(outSig, pos, neg) {
    const w = els.timeOutCanvas.clientWidth, h = els.timeOutCanvas.clientHeight;
    const yS = 2.0;
    const area = { l: 52, t: 26, w: Math.max(10, w - 68), h: Math.max(10, h - 58) };
    drawGrid(ctxTimeOut, area, 8, 8);
    const {start, end} = getTimeWindow(outSig.length);
    const showThreshOut = els.showThreshOut ? !!els.showThreshOut.checked : true;
    if (showThreshOut) drawThreshLines(ctxTimeOut, area, pos, neg, yS);
    drawWave(ctxTimeOut, area, outSig, "rgba(90,160,255,0.9)", 1.7, start,end, yS);
    drawAxisLabelsTime(ctxTimeOut, area, +els.timeWindowMs.value, yS);
  }

  function drawFreq(inSig, outSig) {
    const w = els.freqCanvas.clientWidth, h = els.freqCanvas.clientHeight;
    const area = { l: 56, t: 26, w: Math.max(10, w - 76), h: Math.max(10, h - 60) };
    drawGrid(ctxFreq, area, 10, 8);
    const maxHz = +els.fftMaxHz.value;
    const minHz = 50;
    const logX = !!els.fftLogX.checked;
    const dbMin = +els.fftDbMin.value;
    const cfg = getFftConfig();
    const inMag = fftMagAveraged(inSig, cfg.fftLen, cfg.hop);
    const outMag = fftMagAveraged(outSig, cfg.fftLen, cfg.hop);
    const startBin = Math.max(1, Math.floor((minHz / (sampleRate / 2)) * inMag.length));
    const maxBins = Math.max(startBin + 2, Math.floor((maxHz / (sampleRate / 2)) * inMag.length));
    let refPeak = 1e-9;
    for (let i = startBin; i < maxBins; i++) refPeak = Math.max(refPeak, inMag[i]);
    const minLogHz = minHz;
    const toY = db => area.t + area.h * (1 - (db - dbMin) / (FFT_DB_MAX - dbMin));
    const drawMag = (mag, color) => {
      ctxFreq.strokeStyle = color; ctxFreq.lineWidth = 1.5; ctxFreq.beginPath();
      let first = true;
      for (let i = startBin; i < maxBins; i++) {
        const freq = (i / (mag.length - 1)) * (sampleRate / 2);
        const fx = Math.max(minLogHz, freq);
        const x = logX
          ? area.l + area.w * (Math.log10(fx / minLogHz) / Math.log10(maxHz / minLogHz))
          : area.l + area.w * ((freq - minHz) / (maxHz - minHz));
        const relDb = linToDb(mag[i] / refPeak);
        const y = toY(clamp(relDb, dbMin, FFT_DB_MAX));
        first ? ctxFreq.moveTo(x, y) : ctxFreq.lineTo(x, y);
        first = false;
      }
      ctxFreq.stroke();
    };
    drawMag(inMag,  "rgba(0,230,110,0.9)");
    drawMag(outMag, "rgba(90,160,255,0.9)");
    drawAxisLabelsFreq(ctxFreq, area, maxHz, logX, dbMin, minHz);
  }

  // ─── Render pipeline ──────────────────────────────────────────────────────
  function getSourceMode() {
    const v = Number.parseFloat(els.sourceKnobIdx.value);
    return Number.isFinite(v) ? clamp(Math.round(v), 0, 6) : 0;
  }

  function setSourceMode(idx, rerender = true) {
    els.sourceKnobIdx.value = String(clamp(idx, 0, 6));
    updateSourceKnobUI();
    if (rerender) renderAll();
  }

  // displayVal: continuous value during drag (no snap); omit to use stored integer
  function updateSourceKnobUI(displayVal) {
    const raw = (displayVal !== undefined) ? clamp(displayVal, 0, 6) : clamp(parseFloat(els.sourceKnobIdx.value) || 0, 0, 6);
    const idx = Math.round(raw);
    const deg = -130 + raw * (260 / 6);
    els.sourceKnob.style.transform = `rotate(${deg}deg)`;
    els.sourceKnobLabel.textContent = SOURCE_LABELS[idx] || SOURCE_LABELS[0];
  }

  function setDriveValue(v, rerender = true) {
    const clamped = clamp(v, +els.drive.min, +els.drive.max);
    els.drive.value = clamped.toFixed(1);
    els.driveNum.value = clamped.toFixed(1);
    const norm = (clamped - (+els.drive.min)) / (+els.drive.max - +els.drive.min);
    const deg = -130 + norm * 260;
    if (els.driveKnob) els.driveKnob.style.transform = `rotate(${deg}deg)`;
    if (rerender) renderAll();
  }

  function syncDistFootSwitch() {
    if (!els.distOnFoot) return;
    const on = !!els.distOn.checked;
    els.distOnFoot.textContent = on ? "Dist ON" : "Dist OFF";
    els.distOnFoot.classList.toggle("on", on);
  }

  function syncTransportToOffset() {
    els.transportPosMs.value = els.timeOffsetMs.value;
    els.transportPosMsNum.value = els.timeOffsetMsNum.value;
  }

  function syncOffsetToTransport() {
    els.timeOffsetMs.value = els.transportPosMs.value;
    els.timeOffsetMsNum.value = els.transportPosMsNum.value;
  }

  function updateStageLayout() {
    const mainFolded = els.timeMainCard.classList.contains("folded");
    const outFolded  = els.timeOutCard.classList.contains("folded");
    const freqFolded = els.freqCard.classList.contains("folded");

    // Time row: collapses to 30px header strip when both time cards are folded
    els.timeRow.style.flex = (mainFolded && outFolded) ? "0 0 30px" : "1 1 0";

    // Individual time card widths (horizontal flex)
    if (!mainFolded && !outFolded) {
      els.timeMainCard.style.flex = "2 1 0";
      els.timeOutCard.style.flex  = "1 1 0";
    } else if (mainFolded && !outFolded) {
      els.timeMainCard.style.flex = "0 0 30px";
      els.timeOutCard.style.flex  = "1 1 0";
    } else if (!mainFolded && outFolded) {
      els.timeMainCard.style.flex = "2 1 0";
      els.timeOutCard.style.flex  = "0 0 30px";
    } else {
      els.timeMainCard.style.flex = "0 0 30px";
      els.timeOutCard.style.flex  = "0 0 30px";
    }

    // Freq card: collapses to 30px when folded
    els.freqCard.style.flex = freqFolded ? "0 0 30px" : "1.1 1 0";
  }

  async function getInputSignal() {
    const mode = getSourceMode();
    if (mode === 0) return new Float32Array(Math.floor(sampleRate * durationSec)); // no input
    if (mode === 2) return generateGuitarSingle();
    if (mode === 3) return generateGuitarChord();
    if (mode >= 4) return state.fileBuffers[mode - 4] || generateSine(+els.sineFreq.value);
    return generateSine(+els.sineFreq.value); // mode 1
  }

  async function renderAll() {
    try {
      let raw = await getInputSignal();
      raw = onePoleHighpass(raw, HPF_CUTOFF_HZ, sampleRate); // default 50Hz cleanup to reduce LF noise floor
      const totalMs = Math.max(1, Math.floor((raw.length / sampleRate) * 1000));
      const maxOffset = Math.max(0, totalMs - 1);
      [els.timeOffsetMs, els.timeOffsetMsNum, els.transportPosMs, els.transportPosMsNum].forEach((el) => {
        if (!el) return;
        el.max = String(maxOffset);
      });
      if (els.loopDurationMs) els.loopDurationMs.max = String(totalMs);
      els.transportPosLabel.textContent = getSourceMode() >= 4 ? "走带位置 Transport (ms)" : "时间偏移 Offset (ms)";
      if (+els.transportPosMs.value > maxOffset) {
        els.transportPosMs.value = String(maxOffset);
        els.transportPosMsNum.value = String(maxOffset);
        syncOffsetToTransport();
      }
      const gain = dbToLin(FIXED_INPUT_GAIN_DB);
      const gained = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) gained[i] = raw[i] * gain;
      els.gainDb.value = FIXED_INPUT_GAIN_DB;
      els.gainDbNum.value = FIXED_INPUT_GAIN_DB;
      const cfg = {
        distOn: els.distOn.checked, algo: els.algo.value,
        threshold: +els.threshold.value, driveDb: +els.drive.value,
        asymOn: els.asymToggle.checked,
      };
      const fftCfg = getFftConfig();
      const preClip = new Float32Array(gained.length);
      const driveLin = dbToLin(+els.drive.value);
      for (let i = 0; i < preClip.length; i++) preClip[i] = gained[i] * driveLin;
      const { output, pos, neg } = processDistortionWithAA(gained, cfg, fftCfg.oversample);
      state.inputRaw=raw; state.inputGained=gained; state.preClip = preClip; state.output=output;
      drawTime(gained, preClip, output, pos, neg);
      drawTimeOut(output, pos, neg);
      drawFreq(gained, output);
      drawTransportWave(); // refresh overview
    } catch (e) {
      console.error("renderAll failed:", e);
    }
  }

  // ─── UI helpers ───────────────────────────────────────────────────────────
  function updateAlgoUI() {
    const isHard = els.algo.value === "hardclip";
    els.threshRow.style.display = isHard ? "" : "none";
    els.asymRow.style.display   = isHard ? "" : "none";
  }

  function bindPair(rangeEl, numEl) {
    rangeEl.addEventListener("input", () => { numEl.value = rangeEl.value; renderAll(); });
    numEl.addEventListener("input",  () => { rangeEl.value = numEl.value; renderAll(); });
  }

  async function initFileHandlers() {
    const fileInputs = [els.inputFile1, els.inputFile2, els.inputFile3];
    const statusEls = [els.fileStatus1, els.fileStatus2, els.fileStatus3];
    fileInputs.forEach((input, i) => {
      input?.addEventListener("change", async () => {
        try {
          const f = input.files?.[0] || null;
          if (!f) {
            statusEls[i].textContent = "未加载外部文件";
            state.fileBuffers[i] = null;
            renderAll();
            return;
          }
          const buf = await loadFile(f, 30);
          if (buf && buf.length > 0) {
            state.fileBuffers[i] = buf;
            const sec = (buf.length / sampleRate).toFixed(2);
            statusEls[i].textContent = `已加载: ${f.name} (${sec}s, 最长30s)`;
            setSourceMode(4 + i, false);
          } else {
            statusEls[i].textContent = "未加载外部文件";
          }
          renderAll();
        } catch (e) {
          if (e?.code === "FILE_TOO_LONG") {
            statusEls[i].textContent = "上传失败：音频超过30秒，请裁剪后重试";
          } else {
            statusEls[i].textContent = "加载失败：文件损坏或格式不支持";
          }
        }
      });
    });
  }

  function bindEvents() {
    bindPair(els.sineFreq, els.sineFreqNum);
    bindPair(els.threshold, els.thresholdNum);
    bindPair(els.timeWindowMs, els.timeWindowMsNum);
    bindPair(els.timeOffsetMs, els.timeOffsetMsNum);
    bindPair(els.transportPosMs, els.transportPosMsNum);
    bindPair(els.fftMaxHz, els.fftMaxHzNum);
    bindPair(els.fftDbMin, els.fftDbMinNum);
    bindPair(els.playbackGainDb, els.playbackGainDbNum);
    els.transportPosMs.addEventListener("input", () => { syncOffsetToTransport(); renderAll(); });
    els.transportPosMsNum.addEventListener("input", () => { syncOffsetToTransport(); renderAll(); });
    els.timeOffsetMs.addEventListener("input", () => { syncTransportToOffset(); });
    els.timeOffsetMsNum.addEventListener("input", () => { syncTransportToOffset(); });

    els.algo.addEventListener("change", () => { updateAlgoUI(); renderAll(); });
    [els.distOn, els.asymToggle, els.splitView, els.fftLogX, els.showThreshMain, els.showThreshOut, els.showPreClip]
      .forEach(el => el?.addEventListener("change", renderAll));
    els.distOnFoot?.addEventListener("click", () => {
      els.distOn.checked = !els.distOn.checked;
      syncDistFootSwitch();
      renderAll();
    });
    let sourceDragY = null;
    let sourceRawAccum = 1; // continuous drag accumulator (avoids snap-on-every-move bug)
    els.sourceKnob.addEventListener("mousedown", (e) => {
      sourceDragY = e.clientY;
      sourceRawAccum = clamp(parseFloat(els.sourceKnobIdx.value) || 1, 0, 6);
      e.preventDefault();
    });
    window.addEventListener("mousemove", (e) => {
      if (sourceDragY === null) return;
      const dy = sourceDragY - e.clientY;
      sourceDragY = e.clientY;
      sourceRawAccum = clamp(sourceRawAccum + dy * 0.12, 0, 6);
      updateSourceKnobUI(sourceRawAccum); // visual only, no snap, no rerender
    });
    window.addEventListener("mouseup", () => {
      if (sourceDragY === null) return;
      sourceDragY = null;
      const snapped = Math.round(sourceRawAccum);
      sourceRawAccum = snapped;
      setSourceMode(snapped); // snap + rerender
    });
    els.sourceKnob.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        setSourceMode(getSourceMode() + 1);
      }
      if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        setSourceMode(getSourceMode() - 1);
      }
    });
    els.sourceKnob.addEventListener("wheel", (e) => {
      e.preventDefault();
      const step = e.deltaY > 0 ? -1 : 1;
      sourceRawAccum = clamp(Math.round(sourceRawAccum) + step, 0, 6);
      setSourceMode(sourceRawAccum);
    }, { passive: false });
    els.sourceKnobIdx.addEventListener("input", () => { updateSourceKnobUI(); renderAll(); });

    // Drive circular knob interactions
    els.drive.addEventListener("input", () => setDriveValue(+els.drive.value));
    els.driveNum.addEventListener("input", () => setDriveValue(+els.driveNum.value));
    if (els.driveKnob) {
      els.driveKnob.addEventListener("wheel", (e) => { e.preventDefault(); setDriveValue(+els.drive.value + (e.deltaY > 0 ? -0.3 : 0.3)); }, { passive: false });
      let dragY = null;
      els.driveKnob.addEventListener("mousedown", (e) => { dragY = e.clientY; });
      window.addEventListener("mousemove", (e) => {
        if (dragY === null) return;
        const dy = dragY - e.clientY;
        dragY = e.clientY;
        setDriveValue(+els.drive.value + dy * 0.05);
      });
      window.addEventListener("mouseup", () => { dragY = null; });
      els.driveKnob.addEventListener("keydown", (e) => {
        if (e.key === "ArrowRight" || e.key === "ArrowUp") setDriveValue(+els.drive.value + 0.2);
        if (e.key === "ArrowLeft" || e.key === "ArrowDown") setDriveValue(+els.drive.value - 0.2);
      });
    }

    els.snap220?.addEventListener("click", () => { els.sineFreq.value = "220"; els.sineFreqNum.value = "220"; renderAll(); });
    els.snap440?.addEventListener("click", () => { els.sineFreq.value = "440"; els.sineFreqNum.value = "440"; renderAll(); });

    // ── Transport controls ──────────────────────────────────────────────────
    els.transportPlayIn.addEventListener("click", () => {
      if (state.inputGained) play(state.inputGained, "in"); else renderAll().then(() => state.inputGained && play(state.inputGained, "in"));
    });
    els.transportPlayOut.addEventListener("click", () => {
      if (state.output) play(state.output, "out"); else renderAll().then(() => state.output && play(state.output, "out"));
    });
    els.transportStop.addEventListener("click", () => {
      stopPlayback();
      drawTransportWave();
    });
    [els.loopEnable, els.returnToStart].forEach(el => el?.addEventListener("change", () => { renderAll(); drawTransportWave(); }));
    // Loop duration: redraw transport overview when changed
    if (els.loopDurationMs) {
      els.loopDurationMs.addEventListener("input", () => { els.loopDurationMsNum.value = els.loopDurationMs.value; drawTransportWave(); });
      els.loopDurationMsNum.addEventListener("input", () => { els.loopDurationMs.value = els.loopDurationMsNum.value; drawTransportWave(); });
    }
    // Transport position: sync with offset + redraw transport wave
    els.transportPosMs.addEventListener("input", () => { syncOffsetToTransport(); renderAll(); drawTransportWave(); });
    els.transportPosMsNum.addEventListener("input", () => { syncOffsetToTransport(); renderAll(); drawTransportWave(); });

    els.closeDisclaimerToast?.addEventListener("click", () => { els.algoDisclaimerToast.style.display = "none"; });

    // ── Card fold buttons ────────────────────────────────────────────────────
    function bindFold(btnEl, cardEl, isHorizontal) {
      if (!btnEl || !cardEl) return;
      const toggle = () => {
        cardEl.classList.toggle("folded");
        const isFolded = cardEl.classList.contains("folded");
        btnEl.textContent = isFolded ? (isHorizontal ? "▷" : "△") : "▽";
        updateStageLayout();
        setTimeout(() => resizeAll(), 40); // wait for transition
      };
      btnEl.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
      cardEl.querySelector(".card-header")?.addEventListener("click", (e) => { if (!e.target.closest("button")) toggle(); });
    }
    bindFold(els.foldTimeMain, els.timeMainCard, true);
    bindFold(els.foldTimeOut,  els.timeOutCard,  true);
    bindFold(els.foldFreq,     els.freqCard,     false);

    let resizeQueued = false;
    const queueResize = () => {
      if (resizeQueued) return;
      resizeQueued = true;
      requestAnimationFrame(() => {
        resizeQueued = false;
        resizeAll();
      });
    };
    const ro = new ResizeObserver(queueResize);
    ro.observe(els.stage);
  }

  async function boot() {
    bindEvents();
    await initFileHandlers();
    updateAlgoUI();
    els.fftDbMin.value = String(FFT_DB_MIN_DEFAULT);
    els.fftDbMinNum.value = String(FFT_DB_MIN_DEFAULT);
    setSourceMode(1, false);
    setDriveValue(+els.drive.value, false);
    syncDistFootSwitch();
    updateStageLayout();
    syncTransportToOffset();
    setTimeout(() => {
      if (els.algoDisclaimerToast) els.algoDisclaimerToast.style.display = "none";
    }, 3000);
    requestAnimationFrame(() => resizeAll());
  }

  boot();
})();
