[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$graphifyCommand = Get-Command graphify -ErrorAction SilentlyContinue
$graphifyCommandSource = if ($graphifyCommand) { $graphifyCommand.Source } else { $null }
$candidates = @(
  $graphifyCommandSource,
  (Join-Path $HOME ".local\bin\graphify.exe"),
  (Join-Path $env:APPDATA "uv\tools\graphifyy\Scripts\graphify.exe")
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) }

$graphify = $candidates | Select-Object -First 1
if (-not $graphify) {
  throw "Graphify executable not found. Install it with 'uv tool install graphifyy' and rerun this script."
}

Push-Location $repoRoot
try {
  & $graphify update .
  if ($LASTEXITCODE -ne 0) {
    throw "Graphify update failed with exit code $LASTEXITCODE."
  }

  & $graphify export obsidian --dir docs/Graphify
  if ($LASTEXITCODE -ne 0) {
    throw "Graphify Obsidian export failed with exit code $LASTEXITCODE."
  }

  & (Join-Path $PSScriptRoot "fix-graphify-obsidian-paths.ps1")
  Write-Host "Graphify graph and Obsidian export are up to date."
} finally {
  Pop-Location
}
