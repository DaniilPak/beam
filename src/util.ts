import os from "node:os";
import net from "node:net";
import readline from "node:readline";
import { spawnSync } from "node:child_process";

export const VERSION = "0.1.3";
export const UDP_PORT = 47100;
export const TCP_PORT = 47101;
export const HTTP_PORT = 47102;

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function fmtBytes(n: number): string {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? 2 : 1)} ${u[i]}`;
}

export function fmtTime(s: number): string {
  if (!isFinite(s) || s < 0) return "--:--";
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

// ---------- network interfaces ----------

export interface Iface { name: string; address: string; netmask: string; broadcast: string }

const ipToInt = (ip: string) => ip.split(".").reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0);
const intToIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");

export function ipv4Ifaces(): Iface[] {
  const out: Iface[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      // 169.254.x.x link-local is kept on purpose: direct cables / Bluetooth PAN often use it
      const bc = (ipToInt(a.address) | (~ipToInt(a.netmask) >>> 0)) >>> 0;
      out.push({ name, address: a.address, netmask: a.netmask, broadcast: intToIp(bc) });
    }
  }
  return out;
}

export function ifaceFor(ip: string): Iface | undefined {
  if (ip.startsWith("127.")) return { name: "loopback", address: "127.0.0.1", netmask: "255.0.0.0", broadcast: "" };
  const n = ipToInt(ip);
  return ipv4Ifaces().find((i) => {
    const m = ipToInt(i.netmask);
    return (n & m) === (ipToInt(i.address) & m);
  });
}

let macPortNames: Map<string, string> | null = null;
/** Human name for an interface: "Wi-Fi (en0)", "Ethernet", "Bluetooth Network Connection"... */
export function prettyIface(name: string): string {
  if (process.platform !== "darwin") return name;
  if (!macPortNames) {
    macPortNames = new Map();
    try {
      const out = spawnSync("networksetup", ["-listallhardwareports"], { encoding: "utf8" }).stdout ?? "";
      let port = "";
      for (const line of out.split("\n")) {
        if (line.startsWith("Hardware Port: ")) port = line.slice(15).trim();
        else if (line.startsWith("Device: ")) macPortNames.set(line.slice(8).trim(), port);
      }
    } catch {}
  }
  const p = macPortNames.get(name);
  return p ? `${p} (${name})` : name;
}

export const isIPv4 = (s: string) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

// ---------- socket helpers ----------

/** Buffered exact-length reader over a socket, with backpressure. */
export class Reader {
  private q: Buffer[] = [];
  private qlen = 0;
  private ended = false;
  private error: Error | null = null;
  private wake: (() => void) | null = null;
  private paused = false;

  constructor(private sock: net.Socket) {
    sock.on("data", (b: Buffer) => {
      this.q.push(b);
      this.qlen += b.length;
      if (this.qlen > 16 << 20 && !this.paused) { this.paused = true; sock.pause(); }
      this.notify();
    });
    sock.on("end", () => { this.ended = true; this.notify(); });
    sock.on("close", () => { this.ended = true; this.notify(); });
    sock.on("error", (e) => { this.error = e; this.notify(); });
  }

  private notify() { const w = this.wake; this.wake = null; w?.(); }
  private wait() { return new Promise<void>((r) => (this.wake = r)); }

  private take(n: number): Buffer {
    let out: Buffer;
    const head = this.q[0]!;
    if (head.length === n) { this.q.shift(); out = head; }
    else if (head.length > n) { out = head.subarray(0, n); this.q[0] = head.subarray(n); }
    else {
      out = Buffer.allocUnsafe(n);
      let o = 0;
      while (o < n) {
        const h = this.q[0]!;
        const k = Math.min(h.length, n - o);
        h.copy(out, o, 0, k);
        o += k;
        if (k === h.length) this.q.shift(); else this.q[0] = h.subarray(k);
      }
    }
    this.qlen -= n;
    if (this.paused && this.qlen < 4 << 20) { this.paused = false; this.sock.resume(); }
    return out;
  }

  async read(n: number): Promise<Buffer> {
    while (this.qlen < n) {
      if (this.error) throw this.error;
      if (this.ended) throw new Error("connection closed unexpectedly");
      await this.wait();
    }
    return this.take(n);
  }

  /** Returns 1..max bytes, or null at EOF. */
  async readSome(max: number): Promise<Buffer | null> {
    while (this.qlen === 0) {
      if (this.error) throw this.error;
      if (this.ended) return null;
      await this.wait();
    }
    return this.take(Math.min(max, this.qlen));
  }
}

export function frame(obj: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(obj));
  const h = Buffer.allocUnsafe(4);
  h.writeUInt32BE(json.length, 0);
  return Buffer.concat([h, json]);
}
export const sendFrame = (sock: net.Socket, obj: unknown) => sock.write(frame(obj));

export async function readFrame(r: Reader): Promise<any> {
  const len = (await r.read(4)).readUInt32BE(0);
  if (len > 1 << 30) throw new Error("bad frame");
  return JSON.parse((await r.read(len)).toString("utf8"));
}

export function writeAsync(sock: net.Socket, buf: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    if (sock.destroyed) return reject(new Error("connection closed"));
    // Resolve on whichever fires first: write callback, 'drain', or the buffer emptying.
    // Bun on Windows can miss 'drain', which used to hang transfers mid-way.
    let settled = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    function done(e?: Error | null) {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      sock.off("drain", onDrain); sock.off("error", onErr); sock.off("close", onClose);
      e ? reject(e) : resolve();
    }
    function onDrain() { done(); }
    function onErr(e: Error) { done(e); }
    function onClose() { done(new Error("connection closed")); }
    const ok = sock.write(buf, (e) => done(e));
    if (ok) return done();
    sock.on("drain", onDrain); sock.on("error", onErr); sock.on("close", onClose);
    poll = setInterval(() => { if (sock.writableLength < 1 << 20) done(); }, 50);
  });
}

export function connect(host: string, port: number, timeoutMs = 3000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); reject(new Error(`timeout connecting to ${host}`)); }, timeoutMs);
    s.once("connect", () => { clearTimeout(t); resolve(s); });
    s.once("error", (e) => { clearTimeout(t); reject(e); });
  });
}

export function withTimeout<T>(p: Promise<T>, ms: number, msg = "timeout"): Promise<T> {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(msg)), ms);
    p.then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); });
  });
}

export function ask(q: string): Promise<string> {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (a) => { rl.close(); res(a.trim()); });
  });
}

// ---------- progress ----------

export class Progress {
  done = 0;
  files = 0;
  private start = Date.now();
  private hist: [number, number][] = [];
  private timer: ReturnType<typeof setInterval>;
  private tty = !!process.stdout.isTTY;
  private lastPlain = 0;

  constructor(private total: number, private totalFiles: number, private label: string) {
    this.timer = setInterval(() => this.render(), this.tty ? 250 : 1000);
  }
  add(n: number) { this.done += n; }
  fileDone() { this.files++; }

  speed(): number {
    const now = Date.now();
    this.hist.push([now, this.done]);
    while (this.hist.length > 2 && now - this.hist[0]![0] > 3000) this.hist.shift();
    const [t0, b0] = this.hist[0]!;
    return now - t0 > 200 ? ((this.done - b0) * 1000) / (now - t0) : 0;
  }

  private render(final = false) {
    const sp = final ? (this.done * 1000) / Math.max(1, Date.now() - this.start) : this.speed();
    const pct = this.total ? this.done / this.total : 1;
    const w = 24, fill = Math.round(pct * w);
    const bar = "=".repeat(Math.max(0, fill - 1)) + (fill ? (pct >= 1 ? "=" : ">") : "") + " ".repeat(w - fill);
    const eta = sp > 0 ? (this.total - this.done) / sp : Infinity;
    const line = `${this.label} [${bar}] ${(pct * 100).toFixed(1).padStart(5)}%  ${fmtBytes(this.done)}/${fmtBytes(this.total)}  ${fmtBytes(sp)}/s  ${final ? "" : "ETA " + fmtTime(eta) + "  "}${this.files}/${this.totalFiles} files`;
    if (this.tty) process.stdout.write("\r" + line.slice(0, Math.max(20, (process.stdout.columns || 120) - 1)) + "\x1b[K");
    else if (final || Date.now() - this.lastPlain > 5000) { this.lastPlain = Date.now(); console.log(line); }
  }

  stop() {
    clearInterval(this.timer);
    this.render(true);
    if (this.tty) process.stdout.write("\n");
  }

  elapsed() { return (Date.now() - this.start) / 1000; }
}
