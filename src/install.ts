import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { HTTP_PORT, ipv4Ifaces, prettyIface } from "./util";

const WIN = process.platform === "win32";
const HOME = WIN ? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "beam") : path.join(os.homedir(), ".beam");
const BIN_DIR = path.join(HOME, "bin");
const DIST_DIR = path.join(HOME, "dist");
const BINARIES = ["beam-windows-x64.exe", "beam-mac-arm64", "beam-mac-x64"];

function selfExe(): string {
  const exe = process.execPath;
  if (/^bun(\.exe)?$/i.test(path.basename(exe)))
    throw new Error("run this from a built binary: `bun run build`, then `./dist/beam-mac-arm64 install`");
  return exe;
}

/** Copy this binary into ~/.beam/bin (or %LOCALAPPDATA%\beam\bin) and put it on PATH. */
export async function install() {
  const exe = selfExe();
  await fs.mkdir(BIN_DIR, { recursive: true });
  await fs.mkdir(DIST_DIR, { recursive: true });
  const target = path.join(BIN_DIR, WIN ? "beam.exe" : "beam");

  if (path.resolve(exe) !== path.resolve(target)) {
    await fs.rm(target, { force: true });
    await fs.copyFile(exe, target);
  }
  if (!WIN) await fs.chmod(target, 0o755);

  // Keep every platform's binary around so `beam share-install` can bootstrap the other computer.
  const srcDir = path.dirname(exe);
  if (path.resolve(srcDir) !== path.resolve(DIST_DIR)) {
    for (const f of BINARIES) {
      const p = path.join(srcDir, f);
      if (existsSync(p)) await fs.copyFile(p, path.join(DIST_DIR, f));
    }
  }

  if (WIN) {
    const ps = `$b='${BIN_DIR}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; ` +
      `if(-not (($p -split ';') -contains $b)){ [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';' + $b).TrimStart(';'), 'User') }`;
    spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
    spawnSync("netsh", ["advfirewall", "firewall", "delete", "rule", "name=beam"], { stdio: "ignore" });
    const fw = spawnSync("netsh", ["advfirewall", "firewall", "add", "rule", "name=beam", "dir=in", "action=allow",
      `program=${target}`, "enable=yes", "profile=private,domain"], { stdio: "ignore" });
    if (fw.status !== 0)
      console.log("note: firewall rule not added (needs admin). On first `beam receive`, click 'Allow' for Private networks.");
  } else {
    if (process.platform === "darwin" && spawnSync("codesign", ["-v", target]).status !== 0)
      spawnSync("codesign", ["--force", "--sign", "-", target], { stdio: "ignore" });
    const line = `export PATH="$HOME/.beam/bin:$PATH"`;
    for (const rc of [".zshrc", ".bashrc", ".bash_profile"].map((f) => path.join(os.homedir(), f))) {
      if (!rc.endsWith(".zshrc") && !existsSync(rc)) continue;
      const cur = existsSync(rc) ? readFileSync(rc, "utf8") : "";
      if (!cur.includes(".beam/bin")) await fs.appendFile(rc, `\n# beam\n${line}\n`);
    }
  }

  console.log(`✔ installed ${target}`);
  console.log(`  open a NEW terminal, then:  beam receive   or   beam send <folder>`);
}

function findDist(): string {
  const cands = [DIST_DIR, path.dirname(process.execPath), path.join(process.cwd(), "dist")];
  const d = cands.find((c) => BINARIES.some((b) => existsSync(path.join(c, b))));
  if (!d) throw new Error(`no beam binaries found (looked in ${cands.join(", ")}). Run \`bun run build\` first.`);
  return d;
}

const shScript = (base: string) => `#!/bin/sh
set -e
B="${base}"
case "$(uname -m)" in arm64|aarch64) F=beam-mac-arm64 ;; *) F=beam-mac-x64 ;; esac
D="$HOME/.beam/dist"; mkdir -p "$D"
echo "Downloading beam from $B …"
for f in beam-mac-arm64 beam-mac-x64 beam-windows-x64.exe; do curl -fsSL "$B/$f" -o "$D/$f" || true; done
chmod +x "$D"/beam-mac-* 2>/dev/null || true
xattr -d com.apple.quarantine "$D/$F" 2>/dev/null || true
codesign -v "$D/$F" 2>/dev/null || codesign --force --sign - "$D/$F"
"$D/$F" install
`;

const ps1Script = (base: string) => `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$B = '${base}'
$D = Join-Path $env:LOCALAPPDATA 'beam\\dist'
New-Item -ItemType Directory -Force $D | Out-Null
Write-Host "Downloading beam from $B ..."
foreach ($f in @('beam-windows-x64.exe','beam-mac-arm64','beam-mac-x64')) {
  try { Invoke-WebRequest "$B/$f" -OutFile (Join-Path $D $f) -UseBasicParsing } catch { }
}
& (Join-Path $D 'beam-windows-x64.exe') install
$env:Path += ';' + (Join-Path $env:LOCALAPPDATA 'beam\\bin')
Write-Host 'beam is ready in this window too. Try: beam receive'
`;

/** Serve the binaries + one-line installer over HTTP so the other computer can install in one command. */
export async function shareInstall() {
  const dist = findDist();
  const have = BINARIES.filter((b) => existsSync(path.join(dist, b)));
  Bun.serve({
    port: HTTP_PORT,
    hostname: "0.0.0.0",
    fetch(req, server) {
      const url = new URL(req.url);
      const base = `http://${req.headers.get("host") ?? url.host}`;
      const who = server.requestIP(req)?.address ?? "?";
      const name = url.pathname.slice(1);
      if (name === "install.sh") { console.log(`  ${who} → install.sh`); return new Response(shScript(base)); }
      if (name === "install.ps1") { console.log(`  ${who} → install.ps1`); return new Response(ps1Script(base)); }
      if (have.includes(name)) { console.log(`  ${who} → ${name}`); return new Response(Bun.file(path.join(dist, name))); }
      return new Response("not found", { status: 404 });
    },
  });
  console.log(`Serving beam installer (${have.join(", ")})\n`);
  for (const i of ipv4Ifaces()) {
    const b = `http://${i.address}:${HTTP_PORT}`;
    console.log(`  via ${prettyIface(i.name)}:`);
    console.log(`    Windows (PowerShell):  irm ${b}/install.ps1 | iex`);
    console.log(`    Mac (Terminal):        curl -fsSL ${b}/install.sh | sh\n`);
  }
  console.log("Run one of those on the other computer. Ctrl+C here when it's done.");
  await new Promise(() => {});
}
