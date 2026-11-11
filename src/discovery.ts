import dgram from "node:dgram";
import os from "node:os";
import { UDP_PORT, ipv4Ifaces, ifaceFor, sleep } from "./util";

export interface Peer {
  id: string;
  name: string;
  os: string;
  port: number;
  /** IPv4 addresses of the peer reachable from here (one per network path). */
  addrs: string[];
  /** Same hostname as this computer. */
  self?: boolean;
}

/** Receiver side: answer "who's there?" broadcasts. */
export function startResponder(info: { id: string; name: string; port: number }) {
  const s = dgram.createSocket({ type: "udp4", reuseAddr: true });
  s.on("message", (msg, rinfo) => {
    try {
      const m = JSON.parse(msg.toString());
      if (m.beam !== 1 || m.t !== "discover") return;
      const reply = JSON.stringify({
        beam: 1, t: "here", ...info, os: process.platform,
        addrs: ipv4Ifaces().map((i) => i.address),
      });
      s.send(reply, rinfo.port, rinfo.address);
    } catch {}
  });
  s.on("error", (e) => console.error(`discovery: ${e.message} (auto-discovery off; senders can still use --to <ip>)`));
  s.bind(UDP_PORT);
  return s;
}

/** Sender side: broadcast on every interface and collect receivers. */
export async function discover(timeoutMs = 1500): Promise<Peer[]> {
  const s = dgram.createSocket("udp4");
  await new Promise<void>((r) => s.bind(0, () => r()));
  s.setBroadcast(true);
  const peers = new Map<string, Peer>();

  s.on("message", (msg, rinfo) => {
    try {
      const m = JSON.parse(msg.toString());
      if (m.beam !== 1 || m.t !== "here") return;
      let p = peers.get(m.id);
      if (!p) peers.set(m.id, (p = { id: m.id, name: m.name, os: m.os, port: m.port, addrs: [] }));
      const add = (a: string) => { if (!p!.addrs.includes(a)) p!.addrs.push(a); };
      add(rinfo.address);
      // other addresses of the peer that sit on one of our subnets = alternative paths
      for (const a of m.addrs ?? []) if (ifaceFor(a)) add(a);
    } catch {}
  });

  const payload = JSON.stringify({ beam: 1, t: "discover" });
  const targets = new Set(["255.255.255.255", ...ipv4Ifaces().map((i) => i.broadcast)]);
  for (let k = 0; k < 3; k++) {
    for (const t of targets) { try { s.send(payload, UDP_PORT, t, () => {}); } catch {} }
    await sleep(300);
  }
  await sleep(Math.max(0, timeoutMs - 900));
  s.close();
  return [...peers.values()].map((p) => ({ ...p, self: p.name === os.hostname() }));
}
