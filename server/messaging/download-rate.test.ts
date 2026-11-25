import { expect, it } from "vitest";
import { DownloadRate } from "./download-rate.ts";

it("warms up before reporting a recent transfer rate and estimates remaining time", () => {
  let at = 0;
  const rate = new DownloadRate(() => at);
  at = 200;
  expect(rate.measure(100, 900)).toEqual({});
  at = 1000;
  expect(rate.measure(1000, 4000)).toEqual({ bytesPerSecond: 1000, etaSeconds: 4 });
  at = 2000;
  expect(rate.measure(2000)).toEqual({ bytesPerSecond: 1000 });
});

it("shows zero after a stalled transfer ages out of the window and omits an ETA", () => {
  let at = 0;
  const rate = new DownloadRate(() => at);
  at = 1000; rate.measure(1000);
  at = 2000; rate.measure(2000);
  for (at = 3000; at <= 10000; at += 1000) rate.measure(2000, 8000);
  expect(rate.measure(2000, 8000)).toEqual({ bytesPerSecond: 0 });
});

it("responds to changing bandwidth and starts a fresh measurement after a paused transfer", () => {
  let at = 0;
  const rate = new DownloadRate(() => at);
  for (at = 1000; at <= 8000; at += 1000) rate.measure(at, 100000);
  let total = 8000;
  for (at = 9000; at <= 16000; at += 1000) { total += 2000; rate.measure(total); }
  at = 16000;
  expect(rate.measure(total).bytesPerSecond).toBeCloseTo(2000);
  at = 100000;
  expect(new DownloadRate(() => at).measure(0, 1000)).toEqual({});
});
