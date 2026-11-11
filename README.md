# beam

Fast transfer of big folders (Unity projects) between Mac and Windows over your local network.

## Install

**Windows** (PowerShell):

```powershell
irm https://raw.githubusercontent.com/DaniilPak/beam/main/install.ps1 | iex
```

**macOS** (Terminal):

```bash
curl -fsSL https://raw.githubusercontent.com/DaniilPak/beam/main/install.sh | sh
```

Without internet, run `beam share-install` on a machine that already has beam, then run the one-line command it prints on the other machine.

**Build from source**: `bun install && bun run build` writes the binaries to `dist/`. To publish them: `gh release create vX.Y.Z dist/*`.

## Use

```bash
beam                            # on the receiving machine: receives into ~/Downloads, no prompts
beam D:\Projects                # ...or into a specific folder
beam send ~/Desktop/LastStand   # on the sending machine, which finds the receiver by itself
```

- **Picks the fastest path**: when the two machines can reach each other over more than one network (Wi-Fi, Ethernet, a direct cable, Bluetooth PAN), beam tests the speed of each and uses the fastest. `beam peers` shows the speed of each path.
- **Skips Unity caches**: `Library`, `Temp`, `Logs`, `obj` and `Build` at the project root are left out, because Unity rebuilds them. Use `--all` to send them anyway.
- **Only sends changes**: when you send the same project again, only changed files go over (it compares size and modification time). An interrupted transfer resumes the same way.
- **Uses 4 TCP streams in parallel**, with big files split into chunks. Change the count with `--streams 8`.
- The receiver accepts everything automatically. Start it with `beam receive --ask` to confirm each transfer. Paths that try to escape the target folder are rejected.

## Notes

- **Windows**: set the network to *Private*. When `beam receive` starts the first time, click Allow in the firewall prompt (or run `beam install` as admin, which adds the firewall rule for you).
- **Fastest setup**: an Ethernet cable between the two machines, or both on wired LAN. That gives 100+ MB/s, against roughly 20–60 MB/s on Wi-Fi.
- **No discovery?** If the receiver isn't found automatically, run `beam send <folder> --to <ip>` with the IP the receiver prints.
- **Ports**: UDP 47100 for discovery, TCP 47101 for the transfer, HTTP 47102 for share-install.
