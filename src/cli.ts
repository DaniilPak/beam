#!/usr/bin/env bun
import { receive } from "./receive";
import { send, findPeers, probe } from "./send";
import { install, shareInstall } from "./install";
import { VERSION, fmtBytes, ifaceFor, prettyIface } from "./util";

const HELP = `beam ${VERSION} — fast folder transfer between your Mac and PC

  beam receive [dir] [-y]        wait for files (default dir: ~/Downloads)
  beam send <path>... [options]  send files/folders to a receiver
      --to <name|ip>             pick receiver (skips discovery when an IP)
      --streams <n>              parallel TCP streams (default 4)
      --all                      include Unity Library/Temp/Logs/Build/obj
      --exclude <name>           skip files/folders with this name (repeatable)
  beam peers                     list receivers and speed of each network path
  beam install                   install this binary and add it to PATH
  beam share-install             serve a one-line installer for the other computer

Re-sending the same folder only transfers files that changed (size/mtime).`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const o = { to: undefined as string | undefined, streams: 4, all: false, yes: false, exclude: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === "--to") o.to = val();
    else if (a === "--streams" || a === "-j") o.streams = Math.max(1, Math.min(16, Number(val()) || 4));
    else if (a === "--all") o.all = true;
    else if (a === "-y" || a === "--yes") o.yes = true;
    else if (a === "--exclude") o.exclude.push(val());
    else if (a.startsWith("-") && a !== "-") throw new Error(`unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, o };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, o } = parse(rest);
  switch (cmd) {
    case "receive": case "recv": case "r":
      return receive(pos[0], o);
    case "send": case "s":
      return send(pos, o);
    case "peers": {
      const peers = await findPeers();
      if (!peers.length) return console.log("No receivers found. Run `beam receive` on the other computer.");
      for (const p of peers) {
        console.log(`${p.name} (${p.os})`);
        for (const a of p.addrs) {
          const sp = await probe(a, p.port);
          console.log(`  ${prettyIface(ifaceFor(a)?.name ?? "?").padEnd(28)} ${a.padEnd(15)}  ${sp ? fmtBytes(sp) + "/s" : "unreachable"}`);
        }
      }
      return;
    }
    case "install": return install();
    case "share-install": return shareInstall();
    case "version": case "--version": case "-v": return console.log(VERSION);
    default: console.log(HELP);
  }
}

main().then(
  () => process.exit(0),
  (e) => { console.error(`\n✖ ${e instanceof Error ? e.message : e}`); process.exit(1); },
);
