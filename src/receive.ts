import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { startResponder } from "./discovery";
import {
  TCP_PORT, Reader, readFrame, sendFrame, frame, fmtBytes, fmtTime, ipv4Ifaces, prettyIface, ask, Progress,
} from "./util";

const PART = ".beam-partial";
const END = 0xffffffff;

type FileEntry = [rel: string, size: number, mtime: number];

/** Turn a sender-supplied relative path into an absolute path inside root, or throw. */
function safeJoin(root: string, rel: string): string {
  const parts = rel.split("/");
  const bad = (x: string) =>
    x === "" || x === "." || x === ".." ||
    (process.platform === "win32" && /[\\:*?"<>|]/.test(x));
  if (!rel || rel.startsWith("/") || parts.some(bad)) throw new Error(`unsafe path rejected: ${rel}`);
  const full = path.join(root, ...parts);
  if (!full.startsWith(root + path.sep)) throw new Error(`unsafe path rejected: ${rel}`);
  return full;
}

class Session {
  readonly id = randomUUID();
  private handles = new Map<number, Promise<FileHandle>>();
  private got = new Map<number, number>();
  readonly completed = new Set<number>();
  private dirs = new Set<string>();
  private finished = 0;
  private failed: Error | null = null;
  private waiters: (() => void)[] = [];
  lastActivity = Date.now();
  readonly socks = new Set<net.Socket>();
  progress!: Progress;

  constructor(readonly files: FileEntry[], readonly full: string[], readonly skip: Set<number>) {}

  private async ensureDir(d: string) {
    if (this.dirs.has(d)) return;
    await fs.mkdir(d, { recursive: true });
    this.dirs.add(d);
  }

  private handle(i: number) {
    let p = this.handles.get(i);
    if (!p) {
      p = (async () => {
        await this.ensureDir(path.dirname(this.full[i]!));
        return fs.open(this.full[i]! + PART, "w");
      })();
      this.handles.set(i, p);
    }
    return p;
  }

  private async finish(i: number, fh: FileHandle) {
    this.handles.delete(i);
    await fh.close();
    const dst = this.full[i]!;
    await fs.rename(dst + PART, dst);
    const t = new Date(this.files[i]![2]);
    await fs.utimes(dst, t, t);
    this.completed.add(i);
    this.progress.fileDone();
  }

  async createEmpty(i: number) {
    await this.ensureDir(path.dirname(this.full[i]!));
    await fs.writeFile(this.full[i]!, "");
    const t = new Date(this.files[i]![2]);
    await fs.utimes(this.full[i]!, t, t);
    this.completed.add(i);
  }

  async write(i: number, buf: Buffer, pos: number) {
    const fh = await this.handle(i);
    await fh.write(buf, 0, buf.length, pos);
    this.progress.add(buf.length);
    this.lastActivity = Date.now();
    const g = (this.got.get(i) ?? 0) + buf.length;
    this.got.set(i, g);
    if (g === this.files[i]![1]) await this.finish(i, fh);
  }

  async dataConn(sock: net.Socket, r: Reader) {
    this.socks.add(sock);
    try {
      for (;;) {
        const h = await r.read(16);
        const idx = h.readUInt32BE(0);
        if (idx === END) break;
        const len = h.readUInt32BE(4);
        let pos = Number(h.readBigUInt64BE(8));
        if (idx >= this.files.length || this.skip.has(idx) || pos + len > this.files[idx]![1])
          throw new Error("bad chunk from sender");
        let rem = len;
        while (rem > 0) {
          const b = await r.readSome(rem);
          if (!b) throw new Error("stream ended mid-chunk");
          await this.write(idx, b, pos);
          pos += b.length;
          rem -= b.length;
        }
      }
      sock.end();
    } catch (e) {
      this.failed ??= e as Error;
      sock.destroy();
    } finally {
      this.finished++;
      this.waiters.splice(0).forEach((w) => w());
    }
  }

  async waitStreams(n: number) {
    while (this.finished < n && !this.failed) await new Promise<void>((r) => this.waiters.push(r));
    if (this.failed) throw this.failed;
  }

  async abort() {
    for (const [i, p] of this.handles) {
      try { await (await p).close(); await fs.unlink(this.full[i]! + PART); } catch {}
    }
    this.handles.clear();
  }
}

export async function receive(dirArg: string | undefined, opts: { ask: boolean }) {
  const dir = path.resolve(dirArg ?? path.join(os.homedir(), "Downloads"));
  await fs.mkdir(dir, { recursive: true });
  const name = os.hostname();
  startResponder({ id: randomUUID(), name, port: TCP_PORT });

  const sessions = new Map<string, Session>();
  let busy = false;

  const server = net.createServer((sock) => {
    handle(sock).catch(() => sock.destroy());
  });

  async function handle(sock: net.Socket) {
    const r = new Reader(sock);
    const first = await readFrame(r);
    if (first.t === "probe") return probe(sock, r, first.ms ?? 1200);
    if (first.t === "data") {
      const s = sessions.get(first.sid);
      if (!s) return sock.destroy();
      return s.dataConn(sock, r);
    }
    if (first.t === "offer") {
      if (busy) { sendFrame(sock, { t: "reject", reason: "receiver is busy with another transfer" }); return sock.end(); }
      busy = true;
      try { await offer(sock, r, first); } finally { busy = false; }
    }
  }

  async function probe(sock: net.Socket, r: Reader, ms: number) {
    let bytes = 0, t0 = 0, replied = false;
    for (;;) {
      const b = await r.readSome(1 << 20).catch(() => null);
      if (!b) break;
      if (!t0) t0 = Date.now();
      bytes += b.length;
      const el = Date.now() - t0;
      if (!replied && el >= ms) { replied = true; sendFrame(sock, { t: "probe-result", bytes, ms: el }); sock.end(); }
    }
  }

  async function offer(sock: net.Socket, r: Reader, o: any) {
    const files: FileEntry[] = o.files;
    let full: string[];
    try { full = files.map((f) => safeJoin(dir, f[0])); }
    catch (e) { sendFrame(sock, { t: "reject", reason: (e as Error).message }); return sock.end(); }

    // Resume / sync: skip files that already exist with same size + mtime.
    const skip = new Set<number>();
    for (let i = 0; i < files.length; i += 256) {
      await Promise.all(files.slice(i, i + 256).map(async (f, k) => {
        try {
          const st = await fs.stat(full[i + k]!);
          if (st.isFile() && st.size === f[1] && Math.abs(st.mtimeMs - f[2]) < 2) skip.add(i + k);
        } catch {}
      }));
    }
    let sendBytes = 0, sendFiles = 0;
    files.forEach((f, i) => { if (!skip.has(i)) { sendBytes += f[1]; sendFiles++; } });

    console.log(`\n▶ Incoming from ${o.from} (${o.os}): ${o.roots.join(", ")}`);
    console.log(`  ${files.length} files, ${fmtBytes(o.total)}` +
      (skip.size ? `  —  ${skip.size} already up to date, ${sendFiles} to transfer (${fmtBytes(sendBytes)})` : ""));
    if (o.excluded?.length) console.log(`  sender skipped: ${o.excluded.join(", ")}`);
    console.log(`  → ${dir}`);

    const ok = !opts.ask || /^(y|yes|)$/i.test(await ask("  Accept? [Y/n] "));
    if (!ok) { sendFrame(sock, { t: "reject", reason: "declined by receiver" }); sock.end(); console.log("  declined"); return; }

    const s = new Session(files, full, skip);
    s.progress = new Progress(sendBytes, sendFiles, "  receiving");
    for (let i = 0; i < files.length; i++) if (!skip.has(i) && files[i]![1] === 0) { await s.createEmpty(i); s.progress.fileDone(); }
    sessions.set(s.id, s);
    sendFrame(sock, { t: "accept", sid: s.id, skip: [...skip] });

    // Watchdog: a sender that goes silent for 60s is dropped so the receiver frees up.
    const dog = setInterval(() => {
      if (Date.now() - s.lastActivity > 60_000) {
        s.socks.forEach((d) => d.destroy());
        sock.destroy(new Error("sender went silent for 60s"));
      }
    }, 2000);
    try {
      const done = await readFrame(r);
      if (done.t !== "done") throw new Error("protocol error");
      await s.waitStreams(done.streams);
      const missing = files.filter((f, i) => !skip.has(i) && !s.completed.has(i)).length;
      s.progress.stop();
      sock.write(frame({ t: "complete", ok: missing === 0, missing }));
      sock.end();
      if (missing) console.log(`  ✖ ${missing} files incomplete — run the send again to resume`);
      else console.log(`  ✔ done in ${fmtTime(s.progress.elapsed())}  →  ${dir}`);
    } catch (e) {
      s.progress.stop();
      await s.abort();
      console.log(`  ✖ transfer aborted: ${(e as Error).message} — send again to resume`);
    } finally {
      clearInterval(dog);
      sessions.delete(s.id);
      console.log("\nWaiting for files… (Ctrl+C to stop)");
    }
  }

  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(TCP_PORT, "0.0.0.0", () => res());
  }).catch((e) => {
    if (e.code === "EADDRINUSE") throw new Error(`port ${TCP_PORT} is in use — is another 'beam receive' already running?`);
    throw e;
  });

  console.log(`beam receiver "${name}" ready`);
  console.log(`  saving to: ${dir}`);
  for (const i of ipv4Ifaces()) console.log(`  ${i.address.padEnd(15)}  ${prettyIface(i.name)}`);
  console.log(`\nOn the other computer run:  beam send <folder>\nWaiting for files… (Ctrl+C to stop)`);
  await new Promise(() => {});
}
