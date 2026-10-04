# OS3 Voice add-on for Windows  -  EXPERIMENTAL, NOT TESTED ON A REAL WINDOWS PC YET.
# Builds "OS3 Voice" from YOUR installed rabbit OS3 (nothing of rabbit's is downloaded or redistributed).
#   powershell -ExecutionPolicy Bypass -File windows\install.ps1
#   powershell -ExecutionPolicy Bypass -File windows\install.ps1 -Uninstall
param([switch]$Uninstall, [string]$Source = "")
$ErrorActionPreference = "Stop"
$dst = Join-Path $env:LOCALAPPDATA "OS3 Voice"
$lnk = Join-Path ([Environment]::GetFolderPath("Programs")) "OS3 Voice.lnk"

if ($Uninstall) {
  Get-Process -Name "rabbit OS3" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dst*" } | Stop-Process -Force
  Remove-Item $dst, $lnk -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Removed OS3 Voice. Your key and settings stay in $HOME\.os3-voice.json (delete that file to remove them)."
  exit 0
}

# find the installed rabbit OS3 (per-user install is the usual place)
$candidates = @($Source,
  (Join-Path $env:LOCALAPPDATA "Programs\rabbit OS3"), (Join-Path $env:LOCALAPPDATA "rabbit OS3"),
  (Join-Path $env:ProgramFiles "rabbit OS3"), (Join-Path ${env:ProgramFiles(x86)} "rabbit OS3")) | Where-Object { $_ }
$src = $candidates | Where-Object { Test-Path (Join-Path $_ "resources\app.asar") } | Select-Object -First 1
if (-not $src) { throw "Can't find rabbit OS3. Install it first, or pass -Source 'C:\path\to\rabbit OS3'." }

$addon = Join-Path (Split-Path $PSScriptRoot -Parent) "addon"
if (-not (Test-Path (Join-Path $addon "boot.js"))) { throw "Run this from a checkout of the repo (the addon folder is missing)." }

Get-Process -Name "rabbit OS3" -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "$dst*" } | Stop-Process -Force
Remove-Item $dst -Recurse -Force -ErrorAction SilentlyContinue
Write-Host "Building OS3 Voice from $src ..."
Copy-Item $src $dst -Recurse
$res = Join-Path $dst "resources"
# rabbit's code stays exactly as shipped, just renamed; our wrapper app\ folder starts first and then runs it
Rename-Item (Join-Path $res "app.asar") "original.asar"
if (Test-Path (Join-Path $res "app.asar.unpacked")) { Rename-Item (Join-Path $res "app.asar.unpacked") "original.asar.unpacked" }
New-Item -ItemType Directory (Join-Path $res "app") | Out-Null
foreach ($f in "boot.js", "voice-main.js", "voice-preload.js") { Copy-Item (Join-Path $addon $f) (Join-Path $res "app\$f") }
'{"name":"os3-voice","productName":"OS3 Voice","version":"1.0.0","main":"boot.js"}' | Set-Content (Join-Path $res "app\package.json") -Encoding ascii

$exe = Get-ChildItem $dst -Filter "*.exe" | Where-Object { $_.Name -notmatch "^(Uninstall|elevate|update)" } | Select-Object -First 1
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sh.TargetPath = $exe.FullName; $sh.WorkingDirectory = $dst; $sh.Save()
Write-Host "Done. Open 'OS3 Voice' from the Start menu, log in to OS3, then Settings > Voice and paste an OpenRouter key."
Write-Host "Privacy: what you say is sent as audio to OpenRouter and its speech providers; see the README."
Write-Host "After a rabbit OS3 update, run this script again."
