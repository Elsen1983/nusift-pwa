param(
  [string]$CanvasPath = "docs/Graphify/graph.canvas",
  [string]$VaultPrefix = "Graphify"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $CanvasPath)) {
  throw "Graphify canvas not found: $CanvasPath"
}

$canvas = Get-Content -LiteralPath $CanvasPath -Raw | ConvertFrom-Json
$changed = 0

foreach ($node in $canvas.nodes) {
  if ($node.type -ne "file" -or [string]::IsNullOrWhiteSpace($node.file)) {
    continue
  }

  $normalized = $node.file.Replace("\", "/")
  if ($normalized.StartsWith("$VaultPrefix/")) {
    continue
  }

  $node.file = "$VaultPrefix/$normalized"
  $changed++
}

$json = $canvas | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText(
  (Resolve-Path -LiteralPath $CanvasPath),
  $json + [Environment]::NewLine,
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "Graphify canvas paths updated: $changed file node(s)."
