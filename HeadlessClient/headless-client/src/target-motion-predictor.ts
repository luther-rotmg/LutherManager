export interface MotionPoint {
  x: number;
  y: number;
}

export interface MotionObservation extends MotionPoint {
  objectId: number;
}

interface TimedPoint extends MotionPoint {
  at: number;
}

interface HarmonicAxis {
  offset: number;
  cosine: number;
  sine: number;
}

interface HarmonicModel {
  kind: 'harmonic';
  referenceAt: number;
  omega: number;
  x: HarmonicAxis;
  y: HarmonicAxis;
}

interface TurnModel {
  kind: 'turn';
  speed: number;
  angle: number;
  omega: number;
}

interface CycleModel {
  kind: 'cycle';
  startAt: number;
  periodMs: number;
  points: TimedPoint[];
}

type MotionModel = CycleModel | HarmonicModel | TurnModel;

interface MotionTrack {
  raw: MotionPoint;
  segmentStart: MotionPoint;
  segmentEnd: MotionPoint;
  segmentStartAt: number;
  segmentEndAt: number;
  lastObservedAt: number;
  samples: TimedPoint[];
  model?: MotionModel;
  modelDirty: boolean;
}

const MAX_SAMPLES = 24;
const MAX_MOTION_AGE_MS = 750;
const MAX_EXTRAPOLATION_MS = 2_000;
const MIN_PERIOD_MS = 400;
const MAX_PERIOD_MS = 8_000;
const HARMONIC_SEARCH_STEPS = 160;
const POSITION_EPSILON = 1e-9;

/**
 * Reconstructs the same delayed server-tick motion used by the game client.
 * NEWTICK positions are endpoints to approach over tickTime, not instantaneous
 * positions at packet receipt.
 */
export class TargetMotionPredictor {
  private readonly tracks = new Map<number, MotionTrack>();

  clear(): void {
    this.tracks.clear();
  }

  remove(objectId: number): void {
    this.tracks.delete(objectId);
  }

  snap(objectId: number, position: MotionPoint, now: number): void {
    if (!validObservation(objectId, position, now)) return;
    this.tracks.set(objectId, {
      raw: { x: position.x, y: position.y },
      segmentStart: { x: position.x, y: position.y },
      segmentEnd: { x: position.x, y: position.y },
      segmentStartAt: now,
      segmentEndAt: now,
      lastObservedAt: now,
      samples: [{ ...position, at: now }],
      modelDirty: false,
    });
  }

  observeTick(now: number, tickTime: number, observations: Iterable<MotionObservation>): void {
    if (!Number.isFinite(now)) return;
    const duration = Number.isFinite(tickTime) ? Math.max(0, Math.min(2_000, tickTime)) : 0;
    for (const observation of observations) {
      if (!validObservation(observation.objectId, observation, now)) continue;
      const track = this.tracks.get(observation.objectId);
      if (!track) {
        this.snap(observation.objectId, observation, now);
        const created = this.tracks.get(observation.objectId)!;
        created.samples[0]!.at = now + duration;
        continue;
      }

      const start = segmentPosition(track, now);
      track.raw = { x: observation.x, y: observation.y };
      track.segmentStart = start;
      track.segmentEnd = { x: observation.x, y: observation.y };
      track.segmentStartAt = now;
      track.segmentEndAt = now + duration;
      track.lastObservedAt = now;
      appendSample(track, {
        x: observation.x,
        y: observation.y,
        at: nextSampleTime(track, now + duration, duration),
      });
      track.model = undefined;
      track.modelDirty = true;
    }
  }

  /** Fallback for tests and callers which do not provide NEWTICK boundaries. */
  observeSnapshot(now: number, observations: Iterable<MotionObservation>): void {
    if (!Number.isFinite(now)) return;
    const visible = new Set<number>();
    for (const observation of observations) {
      if (!validObservation(observation.objectId, observation, now)) continue;
      visible.add(observation.objectId);
      const track = this.tracks.get(observation.objectId);
      if (!track) {
        this.snap(observation.objectId, observation, now);
        continue;
      }
      if (samePoint(track.raw, observation)) continue;

      track.raw = { x: observation.x, y: observation.y };
      track.segmentStart = { x: observation.x, y: observation.y };
      track.segmentEnd = { x: observation.x, y: observation.y };
      track.segmentStartAt = now;
      track.segmentEndAt = now;
      track.lastObservedAt = now;
      appendSample(track, { x: observation.x, y: observation.y, at: now });
      track.model = undefined;
      track.modelDirty = true;
    }

    for (const objectId of this.tracks.keys()) {
      if (!visible.has(objectId)) this.tracks.delete(objectId);
    }
  }

  currentPosition(objectId: number, fallback: MotionPoint, now: number): MotionPoint {
    const track = this.tracks.get(objectId);
    if (!track || !Number.isFinite(now) || now - track.lastObservedAt > MAX_MOTION_AGE_MS) {
      return { x: fallback.x, y: fallback.y };
    }
    return segmentPosition(track, now);
  }

  predictPosition(objectId: number, fallback: MotionPoint, now: number, futureMs: number): MotionPoint {
    const track = this.tracks.get(objectId);
    if (!track || !Number.isFinite(now) || now - track.lastObservedAt > MAX_MOTION_AGE_MS) {
      return { x: fallback.x, y: fallback.y };
    }

    const future = Math.max(0, Math.min(MAX_EXTRAPOLATION_MS, Number(futureMs) || 0));
    const queryAt = now + future;
    if (future === 0
      || track.segmentEndAt > track.segmentStartAt && queryAt <= track.segmentEndAt) {
      return segmentPosition(track, queryAt);
    }

    const anchor = track.segmentEnd;
    const beyondMs = queryAt - track.segmentEndAt;
    if (track.modelDirty) {
      track.model = fitMotionModel(track.samples);
      track.modelDirty = false;
    }
    if (track.model?.kind === 'cycle') {
      const atAnchor = cyclePosition(track.model, track.segmentEndAt);
      const predicted = cyclePosition(track.model, queryAt);
      return {
        x: anchor.x + predicted.x - atAnchor.x,
        y: anchor.y + predicted.y - atAnchor.y,
      };
    }
    if (track.model?.kind === 'harmonic') {
      const atAnchor = harmonicPosition(track.model, track.segmentEndAt);
      const predicted = harmonicPosition(track.model, queryAt);
      return {
        x: anchor.x + predicted.x - atAnchor.x,
        y: anchor.y + predicted.y - atAnchor.y,
      };
    }
    if (track.model?.kind === 'turn') {
      return turnPosition(anchor, track.model, beyondMs);
    }

    const velocity = segmentVelocity(track);
    return {
      x: anchor.x + velocity.x * beyondMs,
      y: anchor.y + velocity.y * beyondMs,
    };
  }
}

function validObservation(objectId: number, position: MotionPoint, now: number): boolean {
  return Number.isInteger(objectId)
    && objectId > 0
    && Number.isFinite(position.x)
    && Number.isFinite(position.y)
    && Number.isFinite(now);
}

function samePoint(a: MotionPoint, b: MotionPoint): boolean {
  return Math.abs(a.x - b.x) <= POSITION_EPSILON && Math.abs(a.y - b.y) <= POSITION_EPSILON;
}

function segmentPosition(track: MotionTrack, at: number): MotionPoint {
  const duration = track.segmentEndAt - track.segmentStartAt;
  if (duration <= 0) return { x: track.segmentEnd.x, y: track.segmentEnd.y };
  const ratio = Math.max(0, Math.min(1, (at - track.segmentStartAt) / duration));
  return {
    x: track.segmentStart.x + (track.segmentEnd.x - track.segmentStart.x) * ratio,
    y: track.segmentStart.y + (track.segmentEnd.y - track.segmentStart.y) * ratio,
  };
}

function segmentVelocity(track: MotionTrack): MotionPoint {
  const duration = track.segmentEndAt - track.segmentStartAt;
  if (duration > 0) {
    return {
      x: (track.segmentEnd.x - track.segmentStart.x) / duration,
      y: (track.segmentEnd.y - track.segmentStart.y) / duration,
    };
  }
  const count = track.samples.length;
  if (count < 2) return { x: 0, y: 0 };
  const previous = track.samples[count - 2]!;
  const current = track.samples[count - 1]!;
  const elapsed = current.at - previous.at;
  return elapsed > 0
    ? { x: (current.x - previous.x) / elapsed, y: (current.y - previous.y) / elapsed }
    : { x: 0, y: 0 };
}

function nextSampleTime(track: MotionTrack, requested: number, duration: number): number {
  const previous = track.samples[track.samples.length - 1];
  if (!previous) return requested;
  return Math.max(requested, previous.at + Math.max(1, duration));
}

function appendSample(track: MotionTrack, sample: TimedPoint): void {
  const previous = track.samples[track.samples.length - 1];
  if (previous && sample.at <= previous.at) sample.at = previous.at + 1;
  track.samples.push(sample);
  if (track.samples.length > MAX_SAMPLES) {
    track.samples.splice(0, track.samples.length - MAX_SAMPLES);
  }
}

function fitMotionModel(samples: TimedPoint[]): MotionModel | undefined {
  return fitCycleModel(samples) ?? fitHarmonicModel(samples) ?? fitTurnModel(samples);
}

function fitCycleModel(samples: TimedPoint[]): CycleModel | undefined {
  if (samples.length < 5) return undefined;
  const spread = positionSpread(samples);
  if (spread < 0.2) return undefined;

  let bestPeriod = 0;
  let bestRms = Infinity;
  const maximumPeriod = Math.floor(samples.length / 2);
  for (let period = 2; period <= maximumPeriod; period++) {
    let squaredError = 0;
    for (let offset = 0; offset < period; offset++) {
      const recent = samples[samples.length - 1 - offset]!;
      const previous = samples[samples.length - 1 - period - offset]!;
      squaredError += squaredDistance(recent, previous);
    }
    const rms = Math.sqrt(squaredError / period);
    if (rms < bestRms) {
      bestRms = rms;
      bestPeriod = period;
    }
  }
  if (bestPeriod === 0 || bestRms > Math.max(0.03, spread * 0.08)) return undefined;

  const startIndex = samples.length - 1 - bestPeriod;
  const cycle = samples.slice(startIndex).map((point) => ({ ...point }));
  const startAt = cycle[0]!.at;
  const periodMs = cycle[cycle.length - 1]!.at - startAt;
  return periodMs > 0 ? { kind: 'cycle', startAt, periodMs, points: cycle } : undefined;
}

function fitHarmonicModel(samples: TimedPoint[]): HarmonicModel | undefined {
  if (samples.length < 7) return undefined;
  const firstAt = samples[0]!.at;
  const lastAt = samples[samples.length - 1]!.at;
  const spanMs = lastAt - firstAt;
  if (spanMs < 800) return undefined;

  const spread = positionSpread(samples);
  if (spread < 0.2) return undefined;
  const linearRms = linearResidual(samples);
  if (!Number.isFinite(linearRms) || linearRms < 0.02) return undefined;

  const medianInterval = median(sampleIntervals(samples));
  const minimumPeriod = Math.max(MIN_PERIOD_MS, medianInterval * 2.5);
  const maximumPeriod = Math.min(MAX_PERIOD_MS, Math.max(minimumPeriod, spanMs * 1.5));
  if (maximumPeriod <= minimumPeriod) return undefined;

  let lowOmega = 2 * Math.PI * 1000 / maximumPeriod;
  let highOmega = 2 * Math.PI * 1000 / minimumPeriod;
  let best: ReturnType<typeof fitHarmonicAt> | undefined;
  for (let refinement = 0; refinement < 3; refinement++) {
    const step = (highOmega - lowOmega) / HARMONIC_SEARCH_STEPS;
    for (let index = 0; index <= HARMONIC_SEARCH_STEPS; index++) {
      const fit = fitHarmonicAt(samples, lowOmega + step * index, lastAt);
      if (fit && (!best || fit.rms < best.rms)) best = fit;
    }
    if (!best || step <= 0) break;
    lowOmega = Math.max(1e-6, best.model.omega - step * 2);
    highOmega = best.model.omega + step * 2;
  }

  if (!best
    || best.amplitude < 0.2
    || best.rms > Math.max(0.03, spread * 0.12)
    || best.rms >= linearRms * 0.65) {
    return undefined;
  }
  return best.model;
}

function fitHarmonicAt(
  samples: TimedPoint[],
  omega: number,
  referenceAt: number,
): { model: HarmonicModel; rms: number; amplitude: number } | undefined {
  const matrix = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const rhsX = [0, 0, 0];
  const rhsY = [0, 0, 0];
  for (const sample of samples) {
    const elapsedSeconds = (sample.at - referenceAt) / 1000;
    const basis = [1, Math.cos(omega * elapsedSeconds), Math.sin(omega * elapsedSeconds)];
    for (let row = 0; row < 3; row++) {
      rhsX[row] += basis[row]! * sample.x;
      rhsY[row] += basis[row]! * sample.y;
      for (let column = 0; column < 3; column++) {
        matrix[row]![column] += basis[row]! * basis[column]!;
      }
    }
  }
  const coefficientsX = solve3(matrix, rhsX);
  const coefficientsY = solve3(matrix, rhsY);
  if (!coefficientsX || !coefficientsY) return undefined;

  const model: HarmonicModel = {
    kind: 'harmonic',
    referenceAt,
    omega,
    x: { offset: coefficientsX[0], cosine: coefficientsX[1], sine: coefficientsX[2] },
    y: { offset: coefficientsY[0], cosine: coefficientsY[1], sine: coefficientsY[2] },
  };
  let squaredError = 0;
  for (const sample of samples) {
    const predicted = harmonicPosition(model, sample.at);
    squaredError += squaredDistance(predicted, sample);
  }
  return {
    model,
    rms: Math.sqrt(squaredError / samples.length),
    amplitude: Math.sqrt((Math.sqrt((model.x.cosine) * (model.x.cosine) + (model.x.sine) * (model.x.sine))) * (Math.sqrt((model.x.cosine) * (model.x.cosine) + (model.x.sine) * (model.x.sine))) + (Math.sqrt((model.y.cosine) * (model.y.cosine) + (model.y.sine) * (model.y.sine))) * (Math.sqrt((model.y.cosine) * (model.y.cosine) + (model.y.sine) * (model.y.sine)))),
  };
}

function fitTurnModel(samples: TimedPoint[]): TurnModel | undefined {
  if (samples.length < 5) return undefined;
  const velocities: Array<MotionPoint & { duration: number }> = [];
  for (let index = Math.max(1, samples.length - 6); index < samples.length; index++) {
    const previous = samples[index - 1]!;
    const current = samples[index]!;
    const duration = current.at - previous.at;
    if (duration <= 0) continue;
    const velocity = {
      x: (current.x - previous.x) / duration,
      y: (current.y - previous.y) / duration,
      duration,
    };
    if (Math.sqrt((velocity.x) * (velocity.x) + (velocity.y) * (velocity.y)) > 0.0001) velocities.push(velocity);
  }
  if (velocities.length < 4) return undefined;

  const speeds = velocities.map((velocity) => Math.sqrt((velocity.x) * (velocity.x) + (velocity.y) * (velocity.y)));
  const averageSpeed = average(speeds);
  const speedDeviation = standardDeviation(speeds, averageSpeed);
  if (averageSpeed <= 0 || speedDeviation / averageSpeed > 0.25) return undefined;

  const angularRates: number[] = [];
  for (let index = 1; index < velocities.length; index++) {
    const previous = velocities[index - 1]!;
    const current = velocities[index]!;
    const angleDelta = normalizeAngle(
      Math.atan2(current.y, current.x) - Math.atan2(previous.y, previous.x),
    );
    angularRates.push(angleDelta / Math.max(1, current.duration));
  }
  const omega = average(angularRates);
  const omegaDeviation = standardDeviation(angularRates, omega);
  if (Math.abs(omega) < 0.0002
    || omegaDeviation > Math.max(0.00025, Math.abs(omega) * 0.35)) {
    return undefined;
  }

  const latest = velocities[velocities.length - 1]!;
  return {
    kind: 'turn',
    speed: averageSpeed,
    angle: Math.atan2(latest.y, latest.x) + omega * latest.duration * 0.5,
    omega,
  };
}

function harmonicPosition(model: HarmonicModel, at: number): MotionPoint {
  const elapsedSeconds = (at - model.referenceAt) / 1000;
  const cosine = Math.cos(model.omega * elapsedSeconds);
  const sine = Math.sin(model.omega * elapsedSeconds);
  return {
    x: model.x.offset + model.x.cosine * cosine + model.x.sine * sine,
    y: model.y.offset + model.y.cosine * cosine + model.y.sine * sine,
  };
}

function cyclePosition(model: CycleModel, at: number): MotionPoint {
  const phase = ((at - model.startAt) % model.periodMs + model.periodMs) % model.periodMs;
  const targetAt = model.startAt + phase;
  for (let index = 1; index < model.points.length; index++) {
    const previous = model.points[index - 1]!;
    const current = model.points[index]!;
    if (targetAt > current.at) continue;
    const duration = current.at - previous.at;
    const ratio = duration > 0 ? (targetAt - previous.at) / duration : 1;
    return {
      x: previous.x + (current.x - previous.x) * ratio,
      y: previous.y + (current.y - previous.y) * ratio,
    };
  }
  const final = model.points[model.points.length - 1]!;
  return { x: final.x, y: final.y };
}

function turnPosition(anchor: MotionPoint, model: TurnModel, elapsedMs: number): MotionPoint {
  const angleDelta = model.omega * elapsedMs;
  return {
    x: anchor.x + model.speed / model.omega
      * (Math.sin(model.angle + angleDelta) - Math.sin(model.angle)),
    y: anchor.y - model.speed / model.omega
      * (Math.cos(model.angle + angleDelta) - Math.cos(model.angle)),
  };
}

function linearResidual(samples: TimedPoint[]): number {
  const referenceAt = samples[samples.length - 1]!.at;
  const times = samples.map((sample) => (sample.at - referenceAt) / 1000);
  const fitX = fitLine(times, samples.map((sample) => sample.x));
  const fitY = fitLine(times, samples.map((sample) => sample.y));
  let squaredError = 0;
  for (let index = 0; index < samples.length; index++) {
    const time = times[index]!;
    const dx = samples[index]!.x - (fitX.offset + fitX.slope * time);
    const dy = samples[index]!.y - (fitY.offset + fitY.slope * time);
    squaredError += dx * dx + dy * dy;
  }
  return Math.sqrt(squaredError / samples.length);
}

function fitLine(times: number[], values: number[]): { offset: number; slope: number } {
  const meanTime = average(times);
  const meanValue = average(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < times.length; index++) {
    const centered = times[index]! - meanTime;
    numerator += centered * (values[index]! - meanValue);
    denominator += centered * centered;
  }
  const slope = denominator > 1e-12 ? numerator / denominator : 0;
  return { offset: meanValue - slope * meanTime, slope };
}

function positionSpread(samples: TimedPoint[]): number {
  const meanX = average(samples.map((sample) => sample.x));
  const meanY = average(samples.map((sample) => sample.y));
  return Math.sqrt(average(samples.map((sample) => (
    (sample.x - meanX) ** 2 + (sample.y - meanY) ** 2
  ))));
}

function sampleIntervals(samples: TimedPoint[]): number[] {
  const result: number[] = [];
  for (let index = 1; index < samples.length; index++) {
    result.push(samples[index]!.at - samples[index - 1]!.at);
  }
  return result;
}

function solve3(matrix: number[][], rhs: number[]): [number, number, number] | undefined {
  const rows = matrix.map((row, index) => [...row, rhs[index]!]);
  for (let column = 0; column < 3; column++) {
    let pivot = column;
    for (let row = column + 1; row < 3; row++) {
      if (Math.abs(rows[row]![column]!) > Math.abs(rows[pivot]![column]!)) pivot = row;
    }
    if (Math.abs(rows[pivot]![column]!) < 1e-10) return undefined;
    [rows[column], rows[pivot]] = [rows[pivot]!, rows[column]!];
    const divisor = rows[column]![column]!;
    for (let index = column; index < 4; index++) rows[column]![index] /= divisor;
    for (let row = 0; row < 3; row++) {
      if (row === column) continue;
      const factor = rows[row]![column]!;
      for (let index = column; index < 4; index++) {
        rows[row]![index] -= factor * rows[column]![index]!;
      }
    }
  }
  return [rows[0]![3]!, rows[1]![3]!, rows[2]![3]!];
}

function average(values: number[]): number {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function standardDeviation(values: number[], mean: number): number {
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

function normalizeAngle(angle: number): number {
  let normalized = angle;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}

function squaredDistance(a: MotionPoint, b: MotionPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}
