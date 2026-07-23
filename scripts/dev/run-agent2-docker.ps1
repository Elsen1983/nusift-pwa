<#
.SYNOPSIS
    Run the Agent 2 dev target runner inside a Docker container that mirrors
    the production Vercel Linux runtime (playwright-core + @sparticuz/chromium).

.DESCRIPTION
    Builds the Dockerfile.agent2-dev image if needed, then runs the existing
    Agent 2 dev runner script inside the container.

    All CLI arguments are forwarded to the runner (e.g. --sourceId, --categoryId,
    --targetUrl, --mode, --persist).

    DATABASE_URL (and PRISMA_DATABASE_URL / POSTGRES_URL if set) are
    automatically converted from localhost/127.0.0.1 to host.docker.internal
    so the container can reach the host's Docker Postgres.

.PARAMETER checkRuntime
    Run the browser runtime sanity check instead of a target run.

.PARAMETER batch
    Run the bounded Agent 2 batch processor instead of a single target debug run.

.PARAMETER headless
    Run the Agent 2 headless/browser fallback queue processor.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/dev/run-agent2-docker.ps1 --targetUrl=https://www.bignewsnetwork.com/category/arizona-news --mode=browser --persist=false

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/dev/run-agent2-docker.ps1 --sourceId=dfadf552-91ee-48e3-aadb-0775184ca832 --categoryId=4c7ca326-6762-40d3-8bc5-4d212f863379 --mode=both --persist=false

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/dev/run-agent2-docker.ps1 -checkRuntime
#>

param(
    [Alias("check-runtime")]
    [switch]$checkRuntime,
    [switch]$batch,
    [switch]$headless,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

$ErrorActionPreference = "Stop"

# ── Resolve project root (one level up from scripts/dev/) ──────────────────
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)

# ── Docker image name ──────────────────────────────────────────────────────
$ImageName = "nusift-agent2-dev"
$Dockerfile = "Dockerfile.agent2-dev"

# ── Load .env file if present ─────────────────────────────────────────────
$envFile = Join-Path $ProjectRoot ".env"
$envVars = @{}

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line -match "^([^=]+)=(.*)$") {
            $envVars[$Matches[1].Trim()] = $Matches[2].Trim()
        }
    }
}

# ── Helper: convert localhost DB URL to host.docker.internal ──────────────
function ConvertTo-DockerDbUrl {
    param([string]$url)
    if (-not $url) { return $url }
    # Replace localhost or 127.0.0.1 with host.docker.internal
    $converted = $url -replace "@localhost:", "@host.docker.internal:"
    $converted = $converted -replace "@127\.0\.0\.1:", "@host.docker.internal:"
    return $converted
}

# ── Resolve DATABASE_URL ──────────────────────────────────────────────────
$databaseUrl = $env:DATABASE_URL
if (-not $databaseUrl -and $envVars.ContainsKey("DATABASE_URL")) {
    $databaseUrl = $envVars["DATABASE_URL"]
}

if (-not $databaseUrl) {
    Write-Error @"
ERROR: DATABASE_URL is not set.

Set it in your .env file or as an environment variable before running this script.
Example (Docker Postgres):
  DATABASE_URL=postgresql://postgres:postgres@localhost:5432/nusift
"@
    exit 1
}

$dbUrlDocker = ConvertTo-DockerDbUrl $databaseUrl

# ── Build image if needed ─────────────────────────────────────────────────
Write-Host "Building Docker image '$ImageName' (if not cached)..." -ForegroundColor Cyan
Push-Location $ProjectRoot
try {
    & docker build -f $Dockerfile -t $ImageName .
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Docker build failed."
        exit 1
    }
} finally {
    Pop-Location
}

# ── Determine entrypoint command ──────────────────────────────────────────
if ($checkRuntime) {
    $cmd = @("scripts/dev/check-agent2-browser-runtime.ts")
} elseif ($batch) {
    $cmd = @("scripts/dev/run-agent2-batch.ts") + $RemainingArgs
} elseif ($headless) {
    $cmd = @("scripts/dev/run-agent2-headless-queue.ts") + $RemainingArgs
} else {
    $cmd = @("scripts/dev/run-agent2-target.ts") + $RemainingArgs
}

# ── Build docker run arguments ────────────────────────────────────────────
$dockerArgs = @(
    "run", "--rm",
    "--add-host=host.docker.internal:host-gateway",
    "-e", "DATABASE_URL=$dbUrlDocker",
    "-e", "NUXT_ENABLE_AGENT2_BROWSER_FALLBACK=true",
    "-e", "VERCEL=1"
)

# Forward PRISMA_DATABASE_URL if set
$prismaUrl = $env:PRISMA_DATABASE_URL
if (-not $prismaUrl -and $envVars.ContainsKey("PRISMA_DATABASE_URL")) {
    $prismaUrl = $envVars["PRISMA_DATABASE_URL"]
}
if ($prismaUrl) {
    $dockerArgs += "-e"
    $dockerArgs += "PRISMA_DATABASE_URL=$(ConvertTo-DockerDbUrl $prismaUrl)"
}

# Forward POSTGRES_URL if set
$pgUrl = $env:POSTGRES_URL
if (-not $pgUrl -and $envVars.ContainsKey("POSTGRES_URL")) {
    $pgUrl = $envVars["POSTGRES_URL"]
}
if ($pgUrl) {
    $dockerArgs += "-e"
    $dockerArgs += "POSTGRES_URL=$(ConvertTo-DockerDbUrl $pgUrl)"
}

# Forward any other NUXT_* env vars from the host
foreach ($key in @("NUXT_ENABLE_AGENT2_BROWSER_FALLBACK")) {
    $val = [Environment]::GetEnvironmentVariable($key)
    if ($val) {
        $dockerArgs += "-e"
        $dockerArgs += "$key=$val"
    }
}

$dockerArgs += $ImageName
$dockerArgs += $cmd

# ── Run ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Running Agent 2 in Docker..." -ForegroundColor Green
Write-Host "  Image: $ImageName" -ForegroundColor DarkGray
Write-Host "  Command: $($cmd -join ' ')" -ForegroundColor DarkGray
Write-Host "  DB URL: $($dbUrlDocker -replace '//([^:]+):[^@]+@', '//$1:***@')" -ForegroundColor DarkGray
Write-Host ""

& docker @dockerArgs
exit $LASTEXITCODE
