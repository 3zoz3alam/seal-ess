/* Seal ESS sensor fusion: iPhone motion sensor + GPS -> speed and estimated throttle.
 *
 * Why: GPS speed arrives ~1 Hz and lags ~1 s, so a GPS-only simulator (teslasound) reacts late.
 * The accelerometer feels acceleration the instant the car surges. We:
 *   1. track gravity (low-pass) so we can keep only the horizontal part of the acceleration;
 *   2. learn which horizontal direction is "car forward" in the phone's frame by correlating it
 *      with GPS speed changes (works in any mount orientation, no calibration step needed);
 *   3. integrate forward acceleration for instant speed changes, corrected by every GPS fix;
 *   4. turn forward acceleration into an estimated pedal position.
 * Pure logic, no browser APIs: unit-tested in Node (test/fusion.test.js). */
'use strict';

const v3 = {
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2],
  len: a => Math.hypot(a[0], a[1], a[2]),
  scale: (a, s) => [a[0] * s, a[1] * s, a[2] * s],
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  norm: a => { const l = Math.hypot(a[0], a[1], a[2]); return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0]; },
};

class MotionFusion {
  constructor() {
    this.g = null;            // gravity estimate (device frame)
    this.gAtLearn = null;     // gravity direction when forward axis was learned
    this.h = [0, 0, 0];       // smoothed horizontal linear acceleration
    this.fwd = null;          // unit forward axis (device frame)
    this.fwdConfidence = 0;   // number of agreeing GPS events
    this.hist = [];           // [{t, h}] last ~4 s of horizontal accel
    this.v = 0;               // fused speed m/s
    this.aFwd = 0;            // forward accel m/s² (smoothed)
    this.gps = null;          // last fix {t, speed, acc}
    this.prevGps = null;
    this.gpsAccel = 0;        // accel from consecutive GPS fixes (fallback before fwd is learned)
    this.lastTick = null;
    this.motionSeen = false;
    this.GPS_LAG = 0.6;       // s, typical iPhone GPS speed latency
  }

  /** acc: linear accel without gravity (m/s²) or null; accG: including gravity (m/s²); t: seconds */
  onMotion(acc, accG, t) {
    if (!accG) return;
    this.motionSeen = true;
    const dt = this.lastMotionT == null ? 0.016 : Math.min(0.1, Math.max(0.001, t - this.lastMotionT));
    this.lastMotionT = t;
    // gravity low-pass (tau 0.8 s)
    if (!this.g) this.g = accG.slice();
    else { const k = Math.min(1, dt / 0.8); this.g = v3.add(this.g, v3.scale(v3.sub(accG, this.g), k)); }
    const gUnit = v3.norm(this.g);
    // Phone moved in its mount (gravity direction changed > ~25°) -> forget learned forward axis
    if (this.fwd && this.gAtLearn && v3.dot(gUnit, this.gAtLearn) < 0.9) { this.fwd = null; this.fwdConfidence = 0; }
    const lin = acc || v3.sub(accG, this.g);
    const horiz = v3.sub(lin, v3.scale(gUnit, v3.dot(lin, gUnit)));
    const k = Math.min(1, dt / 0.12); // ~1.3 Hz low-pass removes road vibration
    this.h = v3.add(this.h, v3.scale(v3.sub(horiz, this.h), k));
    this.hist.push({ t, h: this.h });
    while (this.hist.length && this.hist[0].t < t - 4) this.hist.shift();
  }

  /** speed in m/s (or null/negative if unavailable); acc = horizontal accuracy (m); t seconds */
  onGps(speed, acc, t) {
    if (speed == null || speed < 0 || !isFinite(speed)) return;
    this.prevGps = this.gps;
    this.gps = { t, speed, acc };
    if (this.prevGps) {
      const dt = t - this.prevGps.t;
      if (dt > 0.3 && dt < 3.5) {
        const dv = (speed - this.prevGps.speed) / dt;
        this.gpsAccel = dv;
        this.learnForward(dv, this.prevGps.t - this.GPS_LAG, t - this.GPS_LAG, Math.max(speed, this.prevGps.speed));
      }
    }
    // Correct fused speed toward GPS (projected forward by its lag)
    const target = Math.max(0, speed + (this.fwd ? this.aFwd : this.gpsAccel) * this.GPS_LAG);
    const kGps = this.fwdConfidence >= 2 ? 0.35 : 0.8;
    this.v += (target - this.v) * kGps;
  }

  learnForward(dv, t0, t1, speed) {
    if (Math.abs(dv) < 0.6 || speed < 2) return;     // need a clear speed change while moving
    const win = this.hist.filter(s => s.t >= t0 && s.t <= t1);
    if (win.length < 5) return;
    let m = [0, 0, 0];
    for (const s of win) m = v3.add(m, s.h);
    m = v3.scale(m, 1 / win.length);
    const mag = v3.len(m);
    if (mag < 0.35) return;
    const cand = v3.scale(v3.norm(m), Math.sign(dv));
    if (!this.fwd) { this.fwd = cand; this.fwdConfidence = 1; }
    else {
      const agree = v3.dot(this.fwd, cand);
      if (agree > 0.5) this.fwdConfidence++;
      else if (agree < -0.3) this.fwdConfidence = Math.max(0, this.fwdConfidence - 1);
      this.fwd = v3.norm(v3.add(v3.scale(this.fwd, 0.7), v3.scale(cand, 0.3)));
    }
    if (this.g) this.gAtLearn = v3.norm(this.g);
  }

  /** Call ~60 Hz. Returns {speedKmh, throttle, lever, mode}. */
  tick(t) {
    const dt = this.lastTick == null ? 0.016 : Math.min(0.2, Math.max(0, t - this.lastTick));
    this.lastTick = t;
    const gpsFresh = this.gps && t - this.gps.t < 3;
    const useMotion = this.motionSeen && this.fwd && this.fwdConfidence >= 2;
    let a;
    if (useMotion) {
      const raw = v3.dot(this.h, this.fwd);
      this.aFwd += (raw - this.aFwd) * Math.min(1, dt / 0.05);
      a = this.aFwd;
      this.v = Math.max(0, this.v + a * dt);
    } else {
      a = gpsFresh ? this.gpsAccel : 0;
      if (gpsFresh) this.v = Math.max(0, this.gps.speed + a * Math.min(2, t - this.gps.t + this.GPS_LAG));
    }
    if (!gpsFresh && !useMotion) this.v *= Math.exp(-dt / 2);        // no data: drift to stop
    // Stationary clamp: GPS says stopped and motion is quiet
    if (gpsFresh && this.gps.speed < 0.4 && Math.abs(a) < 0.3) this.v *= Math.exp(-dt / 0.3);

    const v = this.v;
    let thr;
    if (v < 0.8 && a < 0.4) thr = 0;
    else if (a > 0.15) thr = Math.min(1, 0.12 + a / 3.2);
    else if (a < -0.5) thr = 0;
    else thr = v > 2.5 ? 0.14 : 0;                                   // holding speed = light throttle
    return {
      speedKmh: v * 3.6, throttle: thr, lever: v < 0.3 ? 'U' : 'D',
      mode: useMotion ? 'motion+gps' : (gpsFresh ? 'gps' : 'waiting'),
    };
  }

  status(t) {
    return {
      motion: this.motionSeen,
      gps: this.gps ? (t - this.gps.t < 3 ? 'ok' : 'stale') : 'none',
      gpsAcc: this.gps ? this.gps.acc : null,
      forward: this.fwd ? (this.fwdConfidence >= 2 ? 'locked' : 'learning') : 'learning',
    };
  }
}

if (typeof module !== 'undefined') module.exports = { MotionFusion };
