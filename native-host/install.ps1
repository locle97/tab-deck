# Installs Tab Desk's Claude Code helper (a Chrome native messaging host) for the current user on
# Windows. It lets Tab Desk run `claude -p` with your existing Claude Code sign-in.
#
#   powershell -ExecutionPolicy Bypass -File native-host\install.ps1 -ExtensionId <extension-id>
#   powershell -ExecutionPolicy Bypass -File native-host\install.ps1 -Uninstall
#
# The extension ID is shown in Tab Desk under Settings > General > Cloud > Claude Code (local),
# and on chrome://extensions with Developer mode on. Needs Node.js 18+ and Claude Code.
param(
  [string[]]$ExtensionId = @(),
  [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'

$Name = 'com.tabdesk.claude_code'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:LOCALAPPDATA 'TabDesk\native-host'
# Chrome reads the manifest's location from these keys; the others are Chromium-based browsers.
$Keys = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\Chromium\NativeMessagingHosts',
  'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts',
  'HKCU:\Software\Vivaldi\NativeMessagingHosts'
)

if ($Uninstall) {
  foreach ($k in $Keys) { Remove-Item -Path "$k\$Name" -Force -ErrorAction SilentlyContinue }
  Remove-Item -Path $Dest -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "Removed Tab Desk's Claude Code helper."
  exit 0
}

# Allow "-ExtensionId a,b" as well as several -ExtensionId values.
$ExtensionId = @($ExtensionId | ForEach-Object { $_ -split '[,\s]+' } | Where-Object { $_ })
if ($ExtensionId.Count -eq 0) {
  Write-Error 'Pass your extension ID: -ExtensionId <id>. Find it in Tab Desk: Settings > General > Cloud > Claude Code (local).'
}
foreach ($id in $ExtensionId) {
  if ($id -notmatch '^[a-p]{32}$') { Write-Error "'$id' doesn't look like a Chrome extension ID (32 letters a-p)." }
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Error 'Node.js 18 or later is needed for the helper, and `node` is not on your PATH. Install it from https://nodejs.org and run this again.'
}
$nodePath = $node.Source
$major = [int](& $nodePath -p 'process.versions.node.split(".")[0]')
if ($major -lt 18) { Write-Error "The helper needs Node.js 18 or later; $nodePath is $(& $nodePath --version)." }

$claude = $null
foreach ($n in @('claude.exe', 'claude.cmd', 'claude')) {
  $c = Get-Command $n -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($c) { $claude = $c.Source; break }
}
if (-not $claude) {
  foreach ($p in @("$env:USERPROFILE\.local\bin\claude.exe", "$env:APPDATA\npm\claude.cmd", "$env:USERPROFILE\.claude\local\claude.exe")) {
    if (Test-Path $p) { $claude = $p; break }
  }
}
if (-not $claude) {
  Write-Warning 'Claude Code (`claude`) was not found. Install it and sign in, then run this again so the helper knows where it is.'
}

$utf8 = New-Object System.Text.UTF8Encoding $false   # Chrome wants JSON without a byte order mark
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
Copy-Item -Force (Join-Path $Here 'tab-desk-claude-host.mjs') (Join-Path $Dest 'tab-desk-claude-host.mjs')
[IO.File]::WriteAllText((Join-Path $Dest 'config.json'), (@{ claude = $claude } | ConvertTo-Json), $utf8)
# Chrome can only start an .exe or .bat on Windows, so a small .bat starts node with the full path.
$bat = Join-Path $Dest 'tab-desk-claude-host.bat'
[IO.File]::WriteAllText($bat, "@echo off`r`n`"$nodePath`" `"%~dp0tab-desk-claude-host.mjs`" %*`r`n", $utf8)

$manifest = [ordered]@{
  name            = $Name
  description     = 'Tab Desk: runs Claude Code (claude -p) for AI summaries'
  path            = $bat
  type            = 'stdio'
  allowed_origins = @($ExtensionId | ForEach-Object { "chrome-extension://$_/" })
}
$manifestPath = Join-Path $Dest "$Name.json"
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), $utf8)

foreach ($k in $Keys) {
  New-Item -Path "$k\$Name" -Force | Out-Null
  Set-ItemProperty -Path "$k\$Name" -Name '(Default)' -Value $manifestPath
}

Write-Host "Installed Tab Desk's Claude Code helper."
Write-Host "  Helper:   $Dest"
Write-Host "  Node:     $nodePath"
Write-Host "  Claude:   $(if ($claude) { $claude } else { 'not found' })"
Write-Host "  Manifest: $manifestPath"
Write-Host 'Now press "Test connection" in Tab Desk''s Settings.'
