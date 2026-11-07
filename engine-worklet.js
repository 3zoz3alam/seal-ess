/* Seal ESS engine: drivetrain model + procedural synth, ported 1:1 from the tested Kotlin
 * (android/app/src/main/kotlin/com/sealess/app/engine/). Runs inside an AudioWorklet in the
 * browser; also loadable from Node for tests (module.exports at the bottom). */
'use strict';

// ---------------- DSP ----------------
class Svf {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 1; this.lp = 0; this.bp = 0; }
  set(fc, q, sr) {
    fc = Math.min(Math.max(fc, 10), sr * 0.45);
    const g = Math.tan(Math.PI * fc / sr);
    this.k = 1 / Math.max(q, 0.1);
    this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2;
  }
  process(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = this.k * v1;
  }
}
class DcBlocker {
  constructor(r = 0.995) { this.r = r; this.x1 = 0; this.y1 = 0; }
  process(x) { const y = x - this.x1 + this.r * this.y1; this.x1 = x; this.y1 = y; return y; }
}
class Rng { // mulberry32
  constructor(seed = 0x5EA1E55) { this.s = seed >>> 0; }
  uniform() { let t = (this.s += 0x6D2B79F5) >>> 0; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
  white() { return this.uniform() * 2 - 1; }
}
const decayCoef = (tau, sr) => tau <= 0 ? 0 : Math.exp(-1 / (tau * sr));
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (x, a, b) => Math.min(Math.max(x, a), b);
const smoothstep = t => { const x = clamp(t, 0, 1); return x * x * (3 - 2 * x); };

// ---------------- Presets ----------------
const even = n => Array.from({ length: n }, (_, i) => i / n);
const V8 = {
  id: 'v8', name: 'American V8', cylinders: 8, firingOffsets: even(8),
  bankOf: [0, 1, 0, 0, 1, 0, 1, 1], pulseGain: [1.0, 0.82, 0.95, 1.08, 0.86, 1.0, 0.9, 1.12],
  idleRpm: 720, redlineRpm: 6500, limiterRpm: 6700, gearRatios: [3.6, 2.2, 1.55, 1.2, 1.0, 0.82], finalDrive: 3.2,
  revRate: 9000, launchRpm: 3200, lightUpshiftRpm: 2100,
  bodyHz: [95, 110], bodyQ: 1.4, raspHz: 750, raspQ: 1.6, raspGain: 0.45, pulseDecay: 0.55, noiseMix: 0.35,
  tonalGain: 0.35, harmonics: [1.0, 0.45, 0.25, 0.12], subHarmonic: 0.55, turbo: 0, supercharger: 0, pops: 0.6, loudness: 1.0,
};
const PRESETS = [
  V8,
  { ...V8, id: 'v8sc', name: 'Supercharged V8', idleRpm: 750, redlineRpm: 6800, limiterRpm: 7000, finalDrive: 3.3,
    revRate: 9500, launchRpm: 3300, bodyHz: [100, 115], bodyQ: 1.3, raspHz: 850, raspQ: 1.7, raspGain: 0.55, pulseDecay: 0.5,
    noiseMix: 0.4, tonalGain: 0.4, harmonics: [1.0, 0.5, 0.3, 0.15], subHarmonic: 0.45, supercharger: 0.8, pops: 0.7 },
  { id: 'i6t', name: 'Inline-6 Turbo', cylinders: 6, firingOffsets: even(6), bankOf: [0, 1, 0, 1, 0, 1],
    pulseGain: [1.0, 0.98, 1.02, 0.99, 1.01, 1.0], idleRpm: 750, redlineRpm: 7000, limiterRpm: 7200,
    gearRatios: [4.1, 2.5, 1.7, 1.3, 1.05, 0.85], finalDrive: 3.15, revRate: 10000, launchRpm: 3000, lightUpshiftRpm: 2000,
    bodyHz: [140, 150], bodyQ: 1.2, raspHz: 1300, raspQ: 2.2, raspGain: 0.55, pulseDecay: 0.45, noiseMix: 0.3,
    tonalGain: 0.5, harmonics: [1.0, 0.6, 0.35, 0.2, 0.1], subHarmonic: 0.05, turbo: 0.9, supercharger: 0, pops: 0.35, loudness: 0.95 },
  { id: 'v12', name: 'V12 Grand Tourer', cylinders: 12, firingOffsets: even(12), bankOf: [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1],
    pulseGain: Array(12).fill(1.0), idleRpm: 800, redlineRpm: 8500, limiterRpm: 8700,
    gearRatios: [3.9, 2.4, 1.7, 1.3, 1.05, 0.86, 0.72], finalDrive: 3.0, revRate: 12000, launchRpm: 3500, lightUpshiftRpm: 2400,
    bodyHz: [200, 215], bodyQ: 1.1, raspHz: 2000, raspQ: 1.8, raspGain: 0.6, pulseDecay: 0.4, noiseMix: 0.2,
    tonalGain: 0.7, harmonics: [1.0, 0.7, 0.5, 0.3, 0.2, 0.1], subHarmonic: 0, turbo: 0, supercharger: 0, pops: 0.25, loudness: 0.9 },
  { id: 'f6', name: 'Flat-6 Sports', cylinders: 6, firingOffsets: even(6), bankOf: [0, 1, 0, 1, 0, 1],
    pulseGain: [1.0, 0.93, 1.05, 0.95, 1.02, 0.97], idleRpm: 850, redlineRpm: 9000, limiterRpm: 9200,
    gearRatios: [3.75, 2.4, 1.8, 1.4, 1.15, 0.97, 0.84], finalDrive: 3.4, revRate: 14000, launchRpm: 4000, lightUpshiftRpm: 2500,
    bodyHz: [160, 175], bodyQ: 1.6, raspHz: 1600, raspQ: 2.6, raspGain: 0.7, pulseDecay: 0.4, noiseMix: 0.35,
    tonalGain: 0.45, harmonics: [1.0, 0.5, 0.45, 0.25, 0.15], subHarmonic: 0.15, turbo: 0, supercharger: 0, pops: 0.5, loudness: 0.95 },
  { id: 'i4t', name: '4-Cyl Turbo', cylinders: 4, firingOffsets: even(4), bankOf: [0, 1, 1, 0],
    pulseGain: [1.0, 0.96, 1.03, 0.98], idleRpm: 800, redlineRpm: 7000, limiterRpm: 7200,
    gearRatios: [3.8, 2.3, 1.6, 1.25, 1.0, 0.82], finalDrive: 3.6, revRate: 11000, launchRpm: 3500, lightUpshiftRpm: 2200,
    bodyHz: [120, 130], bodyQ: 1.3, raspHz: 1100, raspQ: 2.0, raspGain: 0.55, pulseDecay: 0.5, noiseMix: 0.4,
    tonalGain: 0.35, harmonics: [1.0, 0.5, 0.3, 0.15], subHarmonic: 0.1, turbo: 1.0, supercharger: 0, pops: 0.7, loudness: 0.9 },
];
const presetById = id => PRESETS.find(p => p.id === id) || V8;

// ---------------- Drivetrain model ----------------
// lever: 'P' | 'N' | 'R' | 'D' | 'U' (unknown)
class EngineModel {
  constructor(preset) { this.tyreCirc = 2.0; this.setPreset(preset); this.thr = 0; this.shifting = false; this.shiftFromRpm = 0;
    this.shiftT = 0; this.shiftDur = 0.2; this.sinceShift = 10; this.limiterTimer = 0; this.overrunTime = 0; this.boost = 0;
    this.bovArmed = false; this.shiftSeq = 0; this.blowoffSeq = 0; this.loadBeforeShift = 0; this.freeRev = true; }
  setPreset(p) { this.preset = p; this.gear = 1; this.rpm = p.idleRpm; }
  rpmInGear(v, g) { return v / this.tyreCirc * 60 * this.preset.gearRatios[g - 1] * this.preset.finalDrive; }
  update(dt, speedKmh, throttleIn, lever, aggr = 0.5) {
    const p = this.preset;
    const target = clamp(throttleIn, 0, 1);
    const rate = target > this.thr ? 18 + 20 * aggr : 10;
    this.thr += (target - this.thr) * Math.min(1, rate * dt);
    const thr = this.thr;
    const v = Math.max(0, speedKmh) / 3.6;
    this.sinceShift += dt;
    const wantFreeRev = lever === 'P' || lever === 'N' || (v < 0.4 && lever === 'U');
    let load, limiterCut = false;
    if (wantFreeRev) {
      if (!this.freeRev) this.shifting = false;
      this.freeRev = true; this.gear = 0;
      if (this.limiterTimer > 0) this.limiterTimer -= dt;
      const cut = this.limiterTimer > 0;
      const rpmTarget = cut ? p.idleRpm : p.idleRpm + Math.pow(thr, 1.3) * (p.limiterRpm + 200 - p.idleRpm);
      this.rpm = rpmTarget > this.rpm ? Math.min(rpmTarget, this.rpm + p.revRate * (0.25 + thr) * dt)
                                      : Math.max(rpmTarget, this.rpm - 3500 * dt);
      if (this.rpm >= p.limiterRpm && !cut) { this.limiterTimer = 0.07; this.rpm -= 120; }
      limiterCut = cut; load = cut ? 0 : thr;
    } else {
      if (this.freeRev) { this.freeRev = false; this.gear = this.pickGear(v, thr); this.sinceShift = 0; }
      const nG = p.gearRatios.length;
      if (lever === 'R') this.gear = 1;
      if (this.shifting) {
        this.shiftT += dt;
        const k = smoothstep(this.shiftT / this.shiftDur);
        const coupled = Math.max(p.idleRpm, this.rpmInGear(v, this.gear));
        this.rpm = lerp(this.shiftFromRpm, coupled, k);
        load = 0;
        if (this.shiftT >= this.shiftDur) this.shifting = false;
      } else {
        const coupled = this.rpmInGear(v, this.gear);
        const upAt = lerp(p.lightUpshiftRpm + 600 * aggr, p.redlineRpm - 150, Math.pow(thr, 1.5));
        const downAt = lerp(p.idleRpm * 1.35, p.redlineRpm * 0.55, thr * thr);
        if (lever !== 'R' && this.sinceShift > 0.5 && this.gear < nG && coupled > upAt) {
          this.startShift(this.gear + 1, 0.16 + 0.08 * (1 - aggr));
        } else if (lever !== 'R' && this.sinceShift > 0.5 && this.gear > 1 && coupled < downAt &&
                   this.rpmInGear(v, this.gear - 1) < p.redlineRpm - 400) {
          this.startShift(this.gear - 1, 0.2);
        }
        const coupledNow = this.rpmInGear(v, this.gear);
        const slip = clamp(1 - v / 6, 0, 1);
        const launch = p.idleRpm + thr * (p.launchRpm - p.idleRpm);
        const slipped = lerp(coupledNow, Math.max(coupledNow, launch), slip);
        const raw = Math.max(p.idleRpm, slipped);
        if (!this.shifting) this.rpm = lerp(this.rpm, raw, Math.min(1, 25 * dt));
        if (this.limiterTimer > 0) this.limiterTimer -= dt;
        if (this.rpm >= p.limiterRpm && this.limiterTimer <= 0) this.limiterTimer = 0.07;
        limiterCut = this.limiterTimer > 0;
        load = (this.shifting || limiterCut) ? 0 : thr;
        if (limiterCut) this.rpm = Math.min(this.rpm, p.limiterRpm);
      }
    }
    const overrun = thr < 0.06 && this.rpm > 1800 && !limiterCut;
    this.overrunTime = overrun ? this.overrunTime + dt : 0;
    if (overrun) load = 0;
    const boostTarget = thr * clamp((this.rpm - 1800) / 2500, 0, 1) * (this.shifting ? 0.3 : 1);
    this.boost += (boostTarget - this.boost) * Math.min(1, (boostTarget > this.boost ? 1.8 : 7) * dt);
    if (target > 0.5 && this.boost > 0.4) this.bovArmed = true;
    if (this.bovArmed && target < 0.15) { this.bovArmed = false; if (this.boost > 0.3) this.blowoffSeq++; }
    return { rpm: this.rpm, load, throttle: thr, gear: this.gear, speedKmh, shifting: this.shifting, limiterCut, overrun,
      overrunTime: this.overrunTime, boost: this.boost, shiftSeq: this.shiftSeq, blowoffSeq: this.blowoffSeq,
      loadBeforeShift: this.loadBeforeShift };
  }
  startShift(g, dur) { this.loadBeforeShift = this.thr; this.shiftFromRpm = this.rpm; this.gear = g; this.shifting = true;
    this.shiftT = 0; this.shiftDur = dur; this.sinceShift = 0; this.shiftSeq++; }
  pickGear(v, thr) { const p = this.preset; const target = lerp(p.lightUpshiftRpm * 0.75, p.redlineRpm * 0.6, thr);
    for (let g = 1; g <= p.gearRatios.length; g++) if (this.rpmInGear(v, g) <= target) return g; return p.gearRatios.length; }
}

// ---------------- Synth ----------------
class EngineSynth {
  constructor(preset, sr) {
    this.preset = preset; this.sr = sr; this.rng = new Rng();
    this.cyclePhase = 0; this.tonalPhase = 0; this.subPhase = 0;
    this.env = new Float64Array(16); this.envGain = new Float64Array(16);
    this.body = [new Svf(), new Svf()]; this.rasp = [new Svf(), new Svf()]; this.lowp = [new Svf(), new Svf()];
    this.whooshF = new Svf(); this.bovF = new Svf(); this.popF = new Svf(); this.popLow = new Svf();
    this.dcL = new DcBlocker(); this.dcR = new DcBlocker();
    this.whinePhase = 0; this.scPhase = 0; this.bovEnv = 0; this.popEnv = 0; this.popGain = 0;
    this.sRpm = preset.idleRpm; this.sLoad = 0; this.sBoost = 0; this.sGain = 0;
    this.lastShiftSeq = 0; this.lastBovSeq = 0; this.crackleBoost = 3.2; this.running = true;
  }
  firePop(s) { this.popEnv = 1; this.popGain = s; }
  static softLimit(x) { const a = Math.abs(x); return a <= 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2)); }

  /** Render `frames` samples into outL/outR (Float32Array). */
  render(outL, outR, frames, st, volume, aggr) {
    const p = this.preset, sr = this.sr, n = p.cylinders, rng = this.rng;
    if (st.blowoffSeq !== this.lastBovSeq) { this.lastBovSeq = st.blowoffSeq; if (p.turbo > 0) this.bovEnv = 1; }
    if (st.shiftSeq !== this.lastShiftSeq) { this.lastShiftSeq = st.shiftSeq; if (st.loadBeforeShift > 0.6) this.firePop(1.0); }

    const rpm0 = this.sRpm, rpm1 = st.rpm, load0 = this.sLoad, load1 = st.load;
    const boost0 = this.sBoost, boost1 = st.boost, gain0 = this.sGain;
    const gain1 = this.running ? volume * p.loudness : 0;
    const rpmNorm = clamp((rpm1 - p.idleRpm) / (p.redlineRpm - p.idleRpm), 0, 1);
    const fireRate = rpm1 / 120 * n;
    const pulseDecayK = decayCoef(p.pulseDecay / fireRate, sr);
    for (let b = 0; b < 2; b++) {
      this.body[b].set(p.bodyHz[b] * (1 + 0.35 * rpmNorm), p.bodyQ, sr);
      this.rasp[b].set(p.raspHz * (1 + 0.4 * load1 + 0.3 * rpmNorm), p.raspQ, sr);
      this.lowp[b].set(250 + 2200 * load1 * (0.6 + 0.6 * aggr) + 1800 * rpmNorm, 0.8, sr);
    }
    this.whooshF.set(2200 + 2500 * boost1, 1.2, sr);
    this.bovF.set(1600 + 1400 * this.bovEnv, 1.3, sr);
    this.popF.set(1400, 1.0, sr); this.popLow.set(160, 1.5, sr);
    const bovK = decayCoef(0.28, sr), popK = decayCoef(0.014, sr);
    const popRate = (st.overrun && st.overrunTime < 1.6 && rpm1 > 2600)
      ? p.pops * (2 + 10 * aggr) * (1 - st.overrunTime / 1.6) : 0;  // original count; loudness boosted separately
    const popProb = popRate / sr;
    const noiseMix = Math.min(p.noiseMix + 0.2 * aggr, 0.9);
    const raspGain = p.raspGain * (0.6 + 0.8 * aggr);
    const drive = 1.4 + 1.6 * aggr, driveNorm = 1 / Math.tanh(drive);
    const popAmp = Math.max(p.pops, 0.75) * this.crackleBoost;
    const hs = p.harmonics, TWO_PI = 2 * Math.PI;

    for (let i = 0; i < frames; i++) {
      const t = (i + 1) / frames;
      const rpm = rpm0 + (rpm1 - rpm0) * t, load = load0 + (load1 - load0) * t;
      const boost = boost0 + (boost1 - boost0) * t, gain = gain0 + (gain1 - gain0) * t;

      const prev = this.cyclePhase;
      let now = prev + rpm / 120 / sr;
      const wrapped = now >= 1; if (wrapped) now -= 1;
      this.cyclePhase = now;
      const strength = 0.35 + 0.65 * load;
      for (let c = 0; c < n; c++) {
        const off = p.firingOffsets[c];
        const crossed = wrapped ? (off > prev || off <= now) : (off > prev && off <= now);
        if (crossed) { this.env[c] = 1; this.envGain[c] = p.pulseGain[c] * strength * (1 + 0.08 * rng.white()); }
      }
      let bank0 = 0, bank1 = 0;
      for (let c = 0; c < n; c++) {
        const e = this.env[c];
        if (e > 1e-4) {
          const src = e * this.envGain[c] * ((1 - noiseMix) + noiseMix * rng.white());
          if (p.bankOf[c] === 0) bank0 += src; else bank1 += src;
          this.env[c] = e * pulseDecayK;
        }
      }
      const B = this.body, R = this.rasp, L = this.lowp;
      B[0].process(bank0); R[0].process(bank0); L[0].process(bank0);
      B[1].process(bank1); R[1].process(bank1); L[1].process(bank1);
      const rg = raspGain * (0.25 + load);
      const exh0 = B[0].bp * 1.3 + R[0].bp * rg + L[0].lp * 0.7;
      const exh1 = B[1].bp * 1.3 + R[1].bp * rg + L[1].lp * 0.7;

      const ff = rpm / 120 * n;
      this.tonalPhase += ff / sr; if (this.tonalPhase >= 1) this.tonalPhase -= 1;
      this.subPhase += ff * 0.5 / sr; if (this.subPhase >= 1) this.subPhase -= 1;
      let tonal = 0;
      for (let h = 0; h < hs.length; h++) {
        if (ff * (h + 1) < sr * 0.45) tonal += hs[h] * Math.sin(TWO_PI * this.tonalPhase * (h + 1)) * (h === 0 ? 1 : (0.4 + 0.6 * load));
      }
      tonal = tonal * p.tonalGain * (0.4 + 0.6 * load) + p.subHarmonic * 0.5 * Math.sin(TWO_PI * this.subPhase) * (0.5 + 0.5 * load);

      let fi = 0;
      if (p.turbo > 0) {
        const wf = 2800 + 5500 * boost;
        this.whinePhase += wf / sr; if (this.whinePhase >= 1) this.whinePhase -= 1;
        this.whooshF.process(rng.white());
        fi += p.turbo * (0.05 * boost * boost * Math.sin(TWO_PI * this.whinePhase) + 0.12 * boost * this.whooshF.bp);
        if (this.bovEnv > 1e-4) { this.bovF.process(rng.white()); fi += p.turbo * 0.45 * this.bovEnv * this.bovF.bp; this.bovEnv *= bovK; }
      }
      if (p.supercharger > 0) {
        const sf = rpm / 60 * 14;
        this.scPhase += sf / sr; if (this.scPhase >= 1) this.scPhase -= 1;
        const rn = clamp((rpm - p.idleRpm) / (p.redlineRpm - p.idleRpm), 0, 1);
        fi += p.supercharger * 0.05 * (0.3 + 0.7 * load) * Math.sqrt(rn) * Math.sin(TWO_PI * this.scPhase);
      }

      if (popProb > 0 && rng.uniform() < popProb) this.firePop(0.6 + 0.4 * rng.uniform());
      let pop = 0;
      if (this.popEnv > 1e-4) {
        const nz = rng.white() * this.popEnv * this.popGain;
        this.popF.process(nz); this.popLow.process(nz);
        pop = (this.popF.bp * 0.9 + this.popLow.bp * 1.6) * popAmp;
        this.popEnv *= popK;
      }

      const common = tonal + fi + pop * 0.5;
      const mixL = exh0 * 0.6 + exh1 * 0.4 + common;
      const mixR = exh0 * 0.4 + exh1 * 0.6 + common;
      const popPost = pop * 0.9;
      outL[i] = EngineSynth.softLimit(this.dcL.process(Math.tanh(drive * mixL * 0.9) * driveNorm * 0.85 + popPost)) * gain;
      outR[i] = EngineSynth.softLimit(this.dcR.process(Math.tanh(drive * mixR * 0.9) * driveNorm * 0.85 + popPost)) * gain;
    }
    this.sRpm = rpm1; this.sLoad = load1; this.sBoost = boost1; this.sGain = gain1;
  }
}

// ---------------- AudioWorklet processor ----------------
if (typeof AudioWorkletProcessor !== 'undefined') {
  class EngineProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      this.preset = V8; this.model = new EngineModel(V8); this.synth = new EngineSynth(V8, sampleRate);
      this.input = { speedKmh: 0, throttle: 0, lever: 'U' };
      this.volume = 0.7; this.aggr = 0.5; this.on = false; this.reportEvery = 0; this.state = null;
      this.port.onmessage = e => {
        const m = e.data;
        if (m.type === 'input') this.input = m;
        else if (m.type === 'settings') {
          if (m.preset && m.preset !== this.preset.id) { this.preset = presetById(m.preset); this.model.setPreset(this.preset); this.synth.preset = this.preset; }
          if (m.volume != null) this.volume = m.volume;
          if (m.aggr != null) this.aggr = m.aggr;
        } else if (m.type === 'run') { this.on = !!m.on; this.synth.running = this.on; }
      };
    }
    process(_inputs, outputs) {
      const out = outputs[0]; const L = out[0]; const R = out[1] || out[0]; const frames = L.length;
      const dt = frames / sampleRate;
      const st = this.model.update(dt, this.input.speedKmh, this.input.throttle, this.input.lever, this.aggr);
      this.synth.render(L, R, frames, st, this.volume, this.aggr);
      if (++this.reportEvery >= 12) { // ~30 Hz at 128-frame blocks
        this.reportEvery = 0;
        this.port.postMessage({ rpm: st.rpm, gear: st.gear, throttle: st.throttle, speedKmh: st.speedKmh, limiter: st.limiterCut });
      }
      return true;
    }
  }
  registerProcessor('engine', EngineProcessor);
}

if (typeof module !== 'undefined') module.exports = { EngineModel, EngineSynth, PRESETS, presetById };
