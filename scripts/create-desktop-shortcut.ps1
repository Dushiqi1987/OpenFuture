# Recreate the OpenFuture desktop shortcut.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\create-desktop-shortcut.ps1
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$desktop = [Environment]::GetFolderPath('Desktop')
$shortcutPath = Join-Path $desktop 'OpenFuture.lnk'
$vbsPath = Join-Path $root 'scripts\OpenFuture-latest.vbs'
$iconPath = Join-Path $root 'build\icon.ico'

if (-not (Test-Path -LiteralPath $vbsPath)) {
  throw "Launcher not found: $vbsPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + $vbsPath + '"'
$shortcut.WorkingDirectory = $root
if (Test-Path -LiteralPath $iconPath) {
  $shortcut.IconLocation = $iconPath + ',0'
}
$shortcut.Description = 'Build and open the latest OpenFuture'
$shortcut.Save()

Write-Output "Created: $shortcutPath"
Write-Output "Target:  $($shortcut.TargetPath) $($shortcut.Arguments)"
