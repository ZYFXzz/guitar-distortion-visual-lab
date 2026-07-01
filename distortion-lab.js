(() => {
  const sampleRate = 44100;
  const durationSec = 2.0;
  const FIXED_INPUT_GAIN_DB = 0;
  const FFT_VIEW_MAX_HZ = 5000;
  const FFT_DB_MIN = -110;
  const FFT_DB_MAX = 10;

  const $ = (id) => document.getElementById(id);
  const els = {
    sourceType: $("sourceType"), sineFreq: $("sineFreq"), sineFreqNum: $("sineFreqNum"),
    inputFileChord: $("inputFileChord"), inputFileSingle: $("inputFileSingle"),
    gainDb: $("gainDb"), gainDbNum: $("gainDbNum"), gainRow: $("gainRow"),
    distOn: $("distOn"), algo: $("algo"),
    threshold: $("threshold"), thresholdNum: $("thresholdNum"),
    drive: $("drive"), driveNum: $("driveNum"),
    asymToggle: $("asymToggle"),
    timeWindowMs: $("timeWindowMs"), timeWindowMsNum: $("timeWindowMsNum"),
    timeOffsetMs: $("timeOffsetMs"), timeOffsetMsNum: $("timeOffsetMsNum"),
    splitView: $("splitView"),
    btnRender: $("btnRender"), btnPlayIn: $("btnPlayIn"),
    btnPlayOut: $("btnPlayOut"), btnStop: $("btnStop"),
    timeCanvas: $("timeCanvas"), timeOutCanvas: $("timeOutCanvas"), freqCanvas: $("freqCanvas"),
    threshRow: $("threshRow"), asymRow: $("asymRow"),
    fftModeEco: $("fftModeEco"), fftModeBalanced: $("fftModeBalanced"), fftModeDetail: $("fftModeDetail"),
  };

  const ctxTime    = els.timeCanvas.getContext("2d");
  const ctxTimeOut = els.timeOutCanvas.getContext("2d");
  const ctxFreq    = els.freqCanvas.getContext("2d");

  const state = {
    inputRaw: null, inputGained: null, output: null,
    chordBuffer: null, singleBuffer: null,
    audioCtx: null, sourceNode: null,
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

  function getFftMode() {
    if (els.fftModeEco?.checked) return "eco";
    if (els.fftModeDetail?.checked) return "detail";
    return "balanced";
  }

  function getFftConfig() {
    const mode = getFftMode();
    if (mode === "eco") return { fftLen: 1024, hop: 512, oversample: 1 };
    if (mode === "detail") return { fftLen: 4096, hop: 2048, oversample: 4 };
    return { fftLen: 2048, hop: 1024, oversample: 2 };
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
            s = pos * (1 - Math.exp(-d / pos));
          } else {
            const a = -d / neg;
            // Soft knee up to threshold, then hard limit
            s = -(a < 1
              ? neg * (a - a * a * a / 3)
              : neg * Math.min(1.0, 0.667 + 0.2 * (a - 1)));
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
          s = d >= 0
            ? pos * Math.tanh(d / pos)          // positive: very gentle tanh (pos=1.10)
            : -neg * Math.tanh(-d / neg * 1.4); // negative: sharper clip at neg=0.45
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
  function play(buffer) {
    stopPlayback();
    const ac = ensureAudioCtx();
    const b = ac.createBuffer(1, buffer.length, sampleRate);
    b.copyToChannel(normalizeForPlayback(buffer), 0);
    const src = ac.createBufferSource();
    src.buffer = b; src.connect(ac.destination); src.start();
    state.sourceNode = src;
  }
  function stopPlayback() {
    if (state.sourceNode) { try { state.sourceNode.stop(); } catch(_) {} state.sourceNode.disconnect(); state.sourceNode = null; }
  }

  // ─── File loading ─────────────────────────────────────────────────────────
  function toMonoFloat32(audioBuffer) {
    const len = audioBuffer.length, channels = audioBuffer.numberOfChannels;
    const out = new Float32Array(len);
    for (let ch = 0; ch < channels; ch++) {
      const d = audioBuffer.getChannelData(ch);
      for (let i = 0; i < len; i++) out[i] += d[i] / channels;
    }
    return resampleLinear(out, audioBuffer.sampleRate, sampleRate, Math.floor(sampleRate * durationSec));
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
  async function loadFile(file) {
    if (!file) return null;
    const arr = await file.arrayBuffer();
    const ac = ensureAudioCtx();
    const decoded = await ac.decodeAudioData(arr.slice(0));
    return toMonoFloat32(decoded);
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
    const rect = c.parentElement.getBoundingClientRect();
    const dpr = devicePixelRatio || 1;
    const w = Math.floor(rect.width), h = Math.floor(rect.height);
    if (w === 0 || h === 0) return false;
    if (c.width === w*dpr && c.height === h*dpr) return false;
    c.width = w*dpr; c.height = h*dpr;
    c.style.width = w+"px"; c.style.height = h+"px";
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
    ctx.fillText("Voltage (norm)", 6, area.t + 10);
    ctx.fillText("Time (ms)", area.l + area.w - 48, area.t + area.h + 24);
    ctx.fillText(`+${yScale.toFixed(1)}`, area.l - 32, area.t + 4);
    ctx.fillText("0", area.l - 16, area.t + area.h * 0.5 + 3);
    ctx.fillText(`-${yScale.toFixed(1)}`, area.l - 34, area.t + area.h - 2);
    for (let i = 0; i <= 4; i++) {
      const x = area.l + (area.w * i) / 4;
      const t = (windowMs * i) / 4;
      ctx.fillText(`${t.toFixed(0)}`, x - 7, area.t + area.h + 14);
    }
  }

  function drawAxisLabelsFreq(ctx, area) {
    ctx.fillStyle = "#9eb1cc";
    ctx.font = "10px system-ui, sans-serif";
    ctx.fillText("Magnitude (dBFS)", 6, area.t + 10);
    ctx.fillText("Frequency (Hz)", area.l + area.w - 66, area.t + area.h + 24);
    const yTicks = [-100, -80, -60, -40, -20, 0];
    for (const t of yTicks) {
      const y = area.t + area.h * (1 - (t - FFT_DB_MIN) / (FFT_DB_MAX - FFT_DB_MIN));
      ctx.fillText(`${t}`, area.l - 30, y + 3);
    }
    const xTicks = [0, 1000, 2000, 3000, 4000, 5000];
    for (const f of xTicks) {
      const x = area.l + area.w * (f / FFT_VIEW_MAX_HZ);
      ctx.fillText(`${f}`, x - 10, area.t + area.h + 14);
    }
  }

  function drawTime(inSig, outSig, pos, neg) {
    const w = els.timeCanvas.clientWidth, h = els.timeCanvas.clientHeight;
    const yS = 2.0;
    const fullArea = { l: 52, t: 26, w: Math.max(10, w - 68), h: Math.max(10, h - 58) };
    drawGrid(ctxTime, fullArea, 10, 8);
    const {start, end} = getTimeWindow(Math.min(inSig.length, outSig.length));
    const windowMs = +els.timeWindowMs.value;
    if (els.splitView.checked) {
      const half = fullArea.h * 0.5;
      const topArea = { l: fullArea.l, t: fullArea.t, w: fullArea.w, h: half };
      const botArea = { l: fullArea.l, t: fullArea.t + half, w: fullArea.w, h: half };
      ctxTime.strokeStyle = "rgba(100,120,150,0.4)"; ctxTime.lineWidth=1;
      ctxTime.beginPath(); ctxTime.moveTo(fullArea.l, fullArea.t + half); ctxTime.lineTo(fullArea.l + fullArea.w, fullArea.t + half); ctxTime.stroke();
      drawThreshLines(ctxTime, topArea, pos, neg, yS);
      drawWave(ctxTime, topArea, inSig,  "rgba(0,230,110,0.9)",  1.4, start,end, yS);
      drawThreshLines(ctxTime, botArea, pos, neg, yS);
      drawWave(ctxTime, botArea, outSig, "rgba(90,160,255,0.9)", 1.5, start,end, yS);
    } else {
      drawThreshLines(ctxTime, fullArea, pos, neg, yS);
      drawWave(ctxTime, fullArea, inSig,  "rgba(0,230,110,0.9)",  1.4, start,end, yS);
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
    drawThreshLines(ctxTimeOut, area, pos, neg, yS);
    drawWave(ctxTimeOut, area, outSig, "rgba(90,160,255,0.9)", 1.7, start,end, yS);
    drawAxisLabelsTime(ctxTimeOut, area, +els.timeWindowMs.value, yS);
  }

  function drawFreq(inSig, outSig) {
    const w = els.freqCanvas.clientWidth, h = els.freqCanvas.clientHeight;
    const area = { l: 56, t: 26, w: Math.max(10, w - 76), h: Math.max(10, h - 60) };
    drawGrid(ctxFreq, area, 10, 8);
    const cfg = getFftConfig();
    const inMag = fftMagAveraged(inSig, cfg.fftLen, cfg.hop);
    const outMag = fftMagAveraged(outSig, cfg.fftLen, cfg.hop);
    const maxBins = Math.floor((FFT_VIEW_MAX_HZ / (sampleRate / 2)) * inMag.length);
    const toY = db => area.t + area.h * (1 - (db - FFT_DB_MIN) / (FFT_DB_MAX - FFT_DB_MIN));
    const drawMag = (mag, color) => {
      ctxFreq.strokeStyle = color; ctxFreq.lineWidth = 1.5; ctxFreq.beginPath();
      for (let i = 0; i < maxBins; i++) {
        const freq = (i / (mag.length - 1)) * (sampleRate / 2);
        const x = area.l + area.w * (freq / FFT_VIEW_MAX_HZ);
        const y = toY(clamp(linToDb(mag[i]), FFT_DB_MIN, FFT_DB_MAX));
        i===0 ? ctxFreq.moveTo(x,y) : ctxFreq.lineTo(x,y);
      }
      ctxFreq.stroke();
    };
    drawMag(inMag,  "rgba(0,230,110,0.9)");
    drawMag(outMag, "rgba(90,160,255,0.9)");
    drawAxisLabelsFreq(ctxFreq, area);
  }

  // ─── Render pipeline ──────────────────────────────────────────────────────
  async function getInputSignal() {
    const mode = els.sourceType.value;
    if (mode === "guitar_chord")  return state.chordBuffer  || generateGuitarChord();
    if (mode === "guitar_single") return state.singleBuffer || generateGuitarSingle();
    return generateSine(+els.sineFreq.value);
  }

  async function renderAll() {
    const raw = await getInputSignal();
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
    const { output, pos, neg } = processDistortionWithAA(gained, cfg, fftCfg.oversample);
    state.inputRaw=raw; state.inputGained=gained; state.output=output;
    drawTime(gained, output, pos, neg);
    drawTimeOut(output, pos, neg);
    drawFreq(gained, output);
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
    els.inputFileChord.addEventListener("change", async () => {
      state.chordBuffer = await loadFile(els.inputFileChord.files?.[0] || null);
      if (els.sourceType.value === "guitar_chord") renderAll();
    });
    els.inputFileSingle.addEventListener("change", async () => {
      state.singleBuffer = await loadFile(els.inputFileSingle.files?.[0] || null);
      if (els.sourceType.value === "guitar_single") renderAll();
    });
  }

  function bindEvents() {
    bindPair(els.sineFreq, els.sineFreqNum);
    bindPair(els.threshold, els.thresholdNum);
    bindPair(els.drive, els.driveNum);
    bindPair(els.timeWindowMs, els.timeWindowMsNum);
    bindPair(els.timeOffsetMs, els.timeOffsetMsNum);

    els.algo.addEventListener("change", () => { updateAlgoUI(); renderAll(); });
    [els.sourceType, els.distOn, els.asymToggle, els.splitView]
      .forEach(el => el.addEventListener("change", renderAll));
    [els.fftModeEco, els.fftModeBalanced, els.fftModeDetail]
      .forEach(el => el?.addEventListener("change", renderAll));

    els.btnRender.addEventListener("click", renderAll);
    els.btnPlayIn.addEventListener("click", () => state.inputGained && play(state.inputGained));
    els.btnPlayOut.addEventListener("click", () => state.output && play(state.output));
    els.btnStop.addEventListener("click", stopPlayback);

    const ro = new ResizeObserver(() => resizeAll());
    ro.observe(els.timeCanvas.parentElement);
    ro.observe(els.timeOutCanvas.parentElement);
    ro.observe(els.freqCanvas.parentElement);
  }

  async function boot() {
    bindEvents();
    await initFileHandlers();
    updateAlgoUI();
    requestAnimationFrame(() => resizeAll());
  }

  boot();
})();
