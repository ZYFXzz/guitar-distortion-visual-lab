(() => {
  const sampleRate = 44100;
  const durationSec = 2.0;
  const fftSize = 2048;

  const $ = (id) => document.getElementById(id);
  const els = {
    sourceType: $("sourceType"),
    sineFreq: $("sineFreq"),
    sineFreqNum: $("sineFreqNum"),
    inputFileChord: $("inputFileChord"),
    inputFileSingle: $("inputFileSingle"),
    gainDb: $("gainDb"),
    gainDbNum: $("gainDbNum"),
    distOn: $("distOn"),
    algo: $("algo"),
    threshold: $("threshold"),
    thresholdNum: $("thresholdNum"),
    drive: $("drive"),
    driveNum: $("driveNum"),
    asymToggle: $("asymToggle"),
    timeWindowMs: $("timeWindowMs"),
    timeWindowMsNum: $("timeWindowMsNum"),
    timeOffsetMs: $("timeOffsetMs"),
    timeOffsetMsNum: $("timeOffsetMsNum"),
    splitView: $("splitView"),
    btnRender: $("btnRender"),
    btnPlayIn: $("btnPlayIn"),
    btnPlayOut: $("btnPlayOut"),
    btnStop: $("btnStop"),
    timeCanvas: $("timeCanvas"),
    timeOutCanvas: $("timeOutCanvas"),
    freqCanvas: $("freqCanvas"),
  };

  const ctxTime = els.timeCanvas.getContext("2d");
  const ctxTimeOut = els.timeOutCanvas.getContext("2d");
  const ctxFreq = els.freqCanvas.getContext("2d");

  const state = {
    inputRaw: null,
    inputGained: null,
    output: null,
    chordBuffer: null,
    singleBuffer: null,
    audioCtx: null,
    sourceNode: null,
  };

  function ensureAudioCtx() {
    if (!state.audioCtx) state.audioCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate });
    return state.audioCtx;
  }

  function setSize() {
    for (const c of [els.timeCanvas, els.timeOutCanvas, els.freqCanvas]) {
      c.width = c.clientWidth * devicePixelRatio;
      c.height = c.clientHeight * devicePixelRatio;
      c.getContext("2d").setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    }
    renderAll();
  }

  function bindPair(rangeEl, numEl) {
    const sync = (v) => { rangeEl.value = v; numEl.value = v; };
    rangeEl.addEventListener("input", () => { numEl.value = rangeEl.value; renderAll(); });
    numEl.addEventListener("input", () => { sync(numEl.value); renderAll(); });
    sync(rangeEl.value);
  }

  function dbToLin(db) { return Math.pow(10, db / 20); }
  function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

  function generateSine(freq) {
    const n = Math.floor(sampleRate * durationSec);
    const out = new Float32Array(n);
    const w = 2 * Math.PI * freq / sampleRate;
    for (let i = 0; i < n; i++) out[i] = Math.sin(w * i);
    return out;
  }

  // Synthetic placeholders until user loads real guitar files.
  function generateGuitarSingle() {
    const n = Math.floor(sampleRate * durationSec);
    const out = new Float32Array(n);
    const f0 = 110;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-3.5 * t) * (1 - Math.exp(-120 * t));
      const s =
        0.75 * Math.sin(2 * Math.PI * f0 * t) +
        0.28 * Math.sin(2 * Math.PI * f0 * 2 * t + 0.2) +
        0.14 * Math.sin(2 * Math.PI * f0 * 3 * t + 0.5);
      out[i] = env * s;
    }
    return out;
  }

  function generateGuitarChord() {
    const n = Math.floor(sampleRate * durationSec);
    const out = new Float32Array(n);
    const notes = [82.41, 110.0, 146.83, 196.0, 246.94, 329.63]; // EADGBE-ish
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const env = Math.exp(-2.6 * t) * (1 - Math.exp(-85 * t));
      let s = 0;
      for (let k = 0; k < notes.length; k++) {
        const f = notes[k];
        s += (0.12 + k * 0.015) * Math.sin(2 * Math.PI * f * t + k * 0.2);
        s += (0.03 + k * 0.004) * Math.sin(2 * Math.PI * f * 2 * t + k * 0.4);
      }
      out[i] = env * s;
    }
    return out;
  }

  function toMonoFloat32(audioBuffer) {
    const len = audioBuffer.length;
    const channels = audioBuffer.numberOfChannels;
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
      const p = i * ratio;
      const a = Math.floor(p);
      const b = Math.min(a + 1, input.length - 1);
      const t = p - a;
      const va = input[Math.min(a, input.length - 1)] || 0;
      const vb = input[b] || 0;
      out[i] = va + (vb - va) * t;
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

  function thresholds(baseTh, asymOn) {
    const pos = clamp(baseTh, 0.05, 1.5);
    const neg = asymOn ? 2.0 : pos; // asymmetric mode: mainly clip positive half-wave
    return { pos, neg };
  }

  function applyDistortion(x, cfg) {
    const y = new Float32Array(x.length);
    const drive = dbToLin(cfg.driveDb);
    const { pos, neg } = thresholds(cfg.threshold, cfg.asymOn);
    const on = cfg.distOn;
    const algo = cfg.algo;

    for (let i = 0; i < x.length; i++) {
      let s = x[i];
      if (on) {
        const d = s * drive;
        if (algo === "hardclip") {
          s = d > pos ? pos : d < -neg ? -neg : d;
        } else if (algo === "softclip") {
          s = d >= 0 ? pos * Math.tanh(d / pos) : -neg * Math.tanh((-d) / neg);
        } else if (algo === "distortion") {
          s = d >= 0 ? (2 / Math.PI) * pos * Math.atan(d / pos * 2.2) : -(2 / Math.PI) * neg * Math.atan((-d) / neg * 2.2);
        } else if (algo === "overdrive") {
          const t = d >= 0 ? pos : neg;
          const sign = d >= 0 ? 1 : -1;
          const a = Math.abs(d) / t;
          let o;
          if (a < 1) o = a - (a * a * a) / 3; // soft knee
          else o = 2 / 3 + (1 - Math.exp(-(a - 1) * 2.5)) / 3;
          s = sign * t * o;
        } else if (algo === "mosfet") {
          // soft positive, harder negative style
          if (d >= 0) s = pos * (1 - Math.exp(-d / pos));
          else s = -Math.min(neg, Math.abs(d) * 0.75 + Math.pow(Math.abs(d), 2) * 0.08);
        } else if (algo === "fuzz") {
          const sign = d >= 0 ? 1 : -1;
          const a = Math.pow(Math.abs(d), 0.35);
          s = sign * (d >= 0 ? pos : neg) * clamp(a, 0, 1.2);
          s = clamp(s, -neg, pos);
        } else if (algo === "rectifier") {
          const r = Math.abs(d);
          s = d >= 0 ? r : -0.35 * r; // half/partial rectifier feel
          s = clamp(s, -neg, pos);
        }
      }
      y[i] = s;
    }
    return { output: y, pos, neg };
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
    src.buffer = b;
    src.connect(ac.destination);
    src.start();
    state.sourceNode = src;
  }

  function stopPlayback() {
    if (state.sourceNode) {
      try { state.sourceNode.stop(); } catch (_) {}
      state.sourceNode.disconnect();
      state.sourceNode = null;
    }
  }

  function fftMag(signal, n = fftSize) {
    const N = n;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    const win = new Float32Array(N);
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    for (let i = 0; i < N; i++) re[i] = (signal[i] || 0) * win[i];

    // Cooley–Tukey radix-2 iterative
    let j = 0;
    for (let i = 1; i < N; i++) {
      let bit = N >> 1;
      while (j & bit) { j ^= bit; bit >>= 1; }
      j ^= bit;
      if (i < j) {
        [re[i], re[j]] = [re[j], re[i]];
        [im[i], im[j]] = [im[j], im[i]];
      }
    }
    for (let len = 2; len <= N; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wlenRe = Math.cos(ang);
      const wlenIm = Math.sin(ang);
      for (let i = 0; i < N; i += len) {
        let wRe = 1, wIm = 0;
        for (let k = 0; k < len / 2; k++) {
          const uRe = re[i + k], uIm = im[i + k];
          const vRe = re[i + k + len / 2] * wRe - im[i + k + len / 2] * wIm;
          const vIm = re[i + k + len / 2] * wIm + im[i + k + len / 2] * wRe;
          re[i + k] = uRe + vRe; im[i + k] = uIm + vIm;
          re[i + k + len / 2] = uRe - vRe; im[i + k + len / 2] = uIm - vIm;
          const nwRe = wRe * wlenRe - wIm * wlenIm;
          const nwIm = wRe * wlenIm + wIm * wlenRe;
          wRe = nwRe; wIm = nwIm;
        }
      }
    }

    const half = N >> 1;
    const mag = new Float32Array(half);
    for (let i = 0; i < half; i++) mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) / half;
    return mag;
  }

  function drawGrid(ctx, w, h) {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = "#0f131a";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#1f2a38";
    ctx.lineWidth = 1;
    for (let i = 1; i < 10; i++) {
      const x = (w * i) / 10;
      const y = (h * i) / 10;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    }
  }

  function getTimeWindowIndices(totalSamples) {
    const windowMs = +els.timeWindowMs.value;
    const offsetMs = +els.timeOffsetMs.value;
    const samplesToShow = Math.max(64, Math.floor((windowMs / 1000) * sampleRate));
    const start = clamp(Math.floor((offsetMs / 1000) * sampleRate), 0, Math.max(0, totalSamples - samplesToShow));
    const end = Math.min(totalSamples, start + samplesToShow);
    return { start, end };
  }

  function drawThresholdLines(ctx, w, segmentH, yOffset, posThr, negThr, yScale) {
    const toY = (v) => yOffset + segmentH * 0.5 * (1 - v / yScale);
    ctx.setLineDash([8, 6]);
    ctx.strokeStyle = "rgba(255,180,120,0.9)";
    if (Math.abs(posThr) <= yScale) {
      ctx.beginPath(); ctx.moveTo(0, toY(posThr)); ctx.lineTo(w, toY(posThr)); ctx.stroke();
    }
    if (Math.abs(negThr) <= yScale) {
      ctx.beginPath(); ctx.moveTo(0, toY(-negThr)); ctx.lineTo(w, toY(-negThr)); ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  function drawWaveSlice(ctx, sig, color, width, start, end, yOffset, segmentH, yScale) {
    const w = ctx.canvas.clientWidth;
    const len = Math.max(1, end - start);
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    for (let i = 0; i < len; i++) {
      const sampleIdx = start + i;
      const x = (i / (len - 1 || 1)) * w;
      const y = yOffset + (segmentH * 0.5) * (1 - sig[sampleIdx] / yScale);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function drawTime(inputSig, outputSig, posThr, negThr) {
    const w = els.timeCanvas.clientWidth;
    const h = els.timeCanvas.clientHeight;
    const yScale = 2.0; // fixed axis
    drawGrid(ctxTime, w, h);
    const { start, end } = getTimeWindowIndices(Math.min(inputSig.length, outputSig.length));

    if (els.splitView.checked) {
      const half = h * 0.5;
      ctxTime.strokeStyle = "rgba(120,140,170,0.5)";
      ctxTime.beginPath(); ctxTime.moveTo(0, half); ctxTime.lineTo(w, half); ctxTime.stroke();

      // top: input
      drawWaveSlice(ctxTime, inputSig, "rgba(0,255,120,0.95)", 1.4, start, end, 0, half, yScale);
      drawThresholdLines(ctxTime, w, half, 0, posThr, negThr, yScale);

      // bottom: output
      drawWaveSlice(ctxTime, outputSig, "rgba(100,170,255,0.95)", 1.6, start, end, half, half, yScale);
      drawThresholdLines(ctxTime, w, half, half, posThr, negThr, yScale);
    } else {
      drawThresholdLines(ctxTime, w, h, 0, posThr, negThr, yScale);
      drawWaveSlice(ctxTime, inputSig, "rgba(0,255,120,0.95)", 1.4, start, end, 0, h, yScale);
      drawWaveSlice(ctxTime, outputSig, "rgba(100,170,255,0.95)", 1.6, start, end, 0, h, yScale);
    }
  }

  function drawTimeOutput(outputSig, posThr, negThr) {
    const w = els.timeOutCanvas.clientWidth;
    const h = els.timeOutCanvas.clientHeight;
    const yScale = 2.0; // fixed axis
    drawGrid(ctxTimeOut, w, h);
    const { start, end } = getTimeWindowIndices(outputSig.length);
    drawThresholdLines(ctxTimeOut, w, h, 0, posThr, negThr, yScale);
    drawWaveSlice(ctxTimeOut, outputSig, "rgba(100,170,255,0.95)", 1.7, start, end, 0, h, yScale);
  }

  function drawFreq(inputSig, outputSig) {
    const w = els.freqCanvas.clientWidth;
    const h = els.freqCanvas.clientHeight;
    drawGrid(ctxFreq, w, h);

    const inMag = fftMag(inputSig);
    const outMag = fftMag(outputSig);
    const maxBinHz = sampleRate / 2;
    const viewHz = 5000;
    const maxBins = Math.floor((viewHz / maxBinHz) * inMag.length);

    let maxV = 1e-9;
    for (let i = 0; i < maxBins; i++) {
      maxV = Math.max(maxV, inMag[i], outMag[i]);
    }
    const toY = (v) => h - (v / maxV) * (h - 18);

    const draw = (mag, color) => {
      ctxFreq.strokeStyle = color;
      ctxFreq.lineWidth = 1.5;
      ctxFreq.beginPath();
      for (let i = 0; i < maxBins; i++) {
        const x = (i / (maxBins - 1)) * w;
        const y = toY(mag[i]);
        if (i === 0) ctxFreq.moveTo(x, y);
        else ctxFreq.lineTo(x, y);
      }
      ctxFreq.stroke();
    };
    draw(inMag, "rgba(0,255,120,0.95)");
    draw(outMag, "rgba(100,170,255,0.95)");
  }

  async function getInputSignal() {
    const mode = els.sourceType.value;
    if (mode === "sine") return generateSine(+els.sineFreq.value);

    if (mode === "guitar_chord") {
      if (state.chordBuffer) return state.chordBuffer;
      return generateGuitarChord();
    }
    if (mode === "guitar_single") {
      if (state.singleBuffer) return state.singleBuffer;
      return generateGuitarSingle();
    }
    return generateSine(220);
  }

  async function renderAll() {
    const raw = await getInputSignal();
    const gain = dbToLin(+els.gainDb.value);
    const gained = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) gained[i] = raw[i] * gain;

    const cfg = {
      distOn: els.distOn.checked,
      algo: els.algo.value,
      threshold: +els.threshold.value,
      driveDb: +els.drive.value,
      asymOn: els.asymToggle.checked,
    };
    const { output, pos, neg } = applyDistortion(gained, cfg);

    state.inputRaw = raw;
    state.inputGained = gained;
    state.output = output;

    drawTime(gained, output, pos, neg);
    drawTimeOutput(output, pos, neg);
    drawFreq(gained, output);
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
    bindPair(els.gainDb, els.gainDbNum);
    bindPair(els.threshold, els.thresholdNum);
    bindPair(els.drive, els.driveNum);
    bindPair(els.timeWindowMs, els.timeWindowMsNum);
    bindPair(els.timeOffsetMs, els.timeOffsetMsNum);

    [
      els.sourceType, els.distOn, els.algo, els.asymToggle, els.splitView,
    ].forEach((el) => el.addEventListener("change", renderAll));

    els.btnRender.addEventListener("click", renderAll);
    els.btnPlayIn.addEventListener("click", () => state.inputGained && play(state.inputGained));
    els.btnPlayOut.addEventListener("click", () => state.output && play(state.output));
    els.btnStop.addEventListener("click", stopPlayback);
    window.addEventListener("resize", setSize);
  }

  async function boot() {
    bindEvents();
    await initFileHandlers();
    setSize();
    renderAll();
  }

  boot();
})();
