export class DownloadRate {
  private readonly now: () => number;
  private readonly started: number;
  private readonly samples: { at: number; bytes: number }[];

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.started = now();
    this.samples = [{ at: this.started, bytes: 0 }];
  }

  measure(transferred: number, remaining?: number): { bytesPerSecond?: number; etaSeconds?: number } {
    const at = this.now();
    if (this.samples.length > 1 && at - this.samples.at(-1)!.at < 250) this.samples[this.samples.length - 1] = { at, bytes: transferred };
    else this.samples.push({ at, bytes: transferred });
    while (this.samples.length > 2 && this.samples[1]!.at <= at - 8_000) this.samples.shift();
    if (at - this.started < 1_000) return {};
    const baseline = this.samples[0]!;
    const bytesPerSecond = Math.max(0, (transferred - baseline.bytes) * 1_000 / (at - baseline.at));
    return { bytesPerSecond, ...(remaining !== undefined && bytesPerSecond > 0 ? { etaSeconds: Math.ceil(Math.max(0, remaining) / bytesPerSecond) } : {}) };
  }
}
