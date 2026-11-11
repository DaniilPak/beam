# beam installer for Windows:  irm https://raw.githubusercontent.com/DaniilPak/beam/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$url = 'https://github.com/DaniilPak/beam/releases/latest/download/beam-windows-x64.exe'
$dir = Join-Path $env:LOCALAPPDATA 'beam\dist'
New-Item -ItemType Directory -Force $dir | Out-Null
$exe = Join-Path $dir 'beam-windows-x64.exe'
Write-Host "Downloading beam..."
Invoke-WebRequest $url -OutFile $exe -UseBasicParsing
& $exe install
$env:Path += ';' + (Join-Path $env:LOCALAPPDATA 'beam\bin')
Write-Host 'Done. Try: beam receive'
