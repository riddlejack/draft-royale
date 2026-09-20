/** NTP-style midpoint samples; retain recent low-RTT samples over delayed snapshots. */
const samples: { serverAtReceive: number; received: number; rtt: number }[] = [];
export function recordArenaClock(serverNow: number, sent: number, received: number) {
  if (!Number.isFinite(serverNow) || received < sent) return;
  const rtt = received - sent;
  samples.push({ serverAtReceive: serverNow + rtt / 2, received, rtt });
  while (samples.length > 12 || (samples[0] && received - samples[0].received > 90_000)) samples.shift();
}
export function estimatedArenaServerNow(): number | null {
  const best = samples.reduce<(typeof samples)[number] | null>((chosen, sample) => !chosen || sample.rtt < chosen.rtt ? sample : chosen, null);
  return best ? best.serverAtReceive + performance.now() - best.received : null;
}
