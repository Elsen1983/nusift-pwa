<#
.SYNOPSIS
Run all current Agent 1/2/3 work in Docker using the local PostgreSQL database.

.DESCRIPTION
Uses the production stage contract and the Linux browser runtime. Notifications
are intentionally disabled: this is a local processing parity runner, not a
delivery test. Refuses non-local database hosts before container startup.
#>
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$ProjectRoot = Split-Path -Parent (Split-Path -Parent $ScriptDir)
$ImageName = "nusift-agent2-dev"
$Dockerfile = "Dockerfile.agent2-dev"
$envFile = Join-Path $ProjectRoot ".env"
$envVars = @{}

function Remove-EnvWrappingQuotes {
    param([string]$Value)

    $trimmed = $Value.Trim()
    if ($trimmed.Length -ge 2) {
        $first = $trimmed[0]
        $last = $trimmed[$trimmed.Length - 1]
        if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
            return $trimmed.Substring(1, $trimmed.Length - 2)
        }
    }

    return $trimmed
}

function Get-PostgresConnectionHost {
    param([string]$ConnectionString)

    # Parse authority ourselves: .NET Uri rejects valid PostgreSQL passwords
    # containing characters that do not need to be inspected by this runner.
    $schemeMatch = [regex]::Match($ConnectionString, "^(?:postgres|postgresql)://(?<authority>[^/?#]+)", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $schemeMatch.Success) { throw "DATABASE_URL must use a postgres:// or postgresql:// URL." }

    $authority = $schemeMatch.Groups["authority"].Value
    $separator = $authority.LastIndexOf("@")
    $hostPort = if ($separator -ge 0) { $authority.Substring($separator + 1) } else { $authority }
    if (-not $hostPort) { throw "DATABASE_URL is missing a database host." }

    if ($hostPort.StartsWith("[")) {
        $endBracket = $hostPort.IndexOf("]")
        if ($endBracket -le 1) { throw "DATABASE_URL has an invalid IPv6 host." }
        return $hostPort.Substring(1, $endBracket - 1).ToLowerInvariant()
    }

    return ($hostPort -split ":", 2)[0].ToLowerInvariant()
}

function Convert-LocalDatabaseUrlForDocker {
    param([string]$ConnectionString)

    $schemeMatch = [regex]::Match($ConnectionString, "^(?<scheme>(?:postgres|postgresql)://)(?<authority>[^/?#]+)(?<suffix>[/?#].*)?$", [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $schemeMatch.Success) { throw "DATABASE_URL could not be mapped to the Docker host." }

    $authority = $schemeMatch.Groups["authority"].Value
    $separator = $authority.LastIndexOf("@")
    $credentials = if ($separator -ge 0) { $authority.Substring(0, $separator + 1) } else { "" }
    $hostPort = if ($separator -ge 0) { $authority.Substring($separator + 1) } else { $authority }
    $databaseHost = Get-PostgresConnectionHost $ConnectionString
    if ($databaseHost -notin @("localhost", "127.0.0.1", "::1")) { throw "DATABASE_URL is not local and cannot be mapped for Docker." }

    $portSuffix = ""
    if ($hostPort.StartsWith("[")) {
        $endBracket = $hostPort.IndexOf("]")
        $portSuffix = $hostPort.Substring($endBracket + 1)
    } else {
        $portSeparator = $hostPort.IndexOf(":")
        if ($portSeparator -ge 0) { $portSuffix = $hostPort.Substring($portSeparator) }
    }

    return "$($schemeMatch.Groups['scheme'].Value)$credentials`host.docker.internal$portSuffix$($schemeMatch.Groups['suffix'].Value)"
}

if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and -not $line.StartsWith("#") -and $line -match "^([^=]+)=(.*)$") {
            $envVars[$Matches[1].Trim()] = Remove-EnvWrappingQuotes $Matches[2]
        }
    }
}

$databaseUrl = $env:DATABASE_URL
if (-not $databaseUrl -and $envVars.ContainsKey("DATABASE_URL")) { $databaseUrl = $envVars["DATABASE_URL"] }
if (-not $databaseUrl) { throw "DATABASE_URL is not set." }
$databaseUrl = Remove-EnvWrappingQuotes $databaseUrl

try { $databaseHost = Get-PostgresConnectionHost $databaseUrl } catch { throw "DATABASE_URL is invalid: $($_.Exception.Message)" }
$localHosts = @("localhost", "127.0.0.1", "::1")
if ($databaseHost -notin $localHosts) { throw "Refusing non-local DATABASE_URL host: $databaseHost" }

$dbUrlDocker = Convert-LocalDatabaseUrlForDocker $databaseUrl
if ($ValidateOnly) {
    Write-Host "DATABASE_URL is a valid local PostgreSQL URL."
    Write-Host "Docker database host: host.docker.internal"
    exit 0
}

Push-Location $ProjectRoot
try {
    Write-Host "Building Docker image '$ImageName'..." -ForegroundColor Cyan
    & docker build -f $Dockerfile -t $ImageName .
    if ($LASTEXITCODE -ne 0) { throw "Docker build failed." }
} finally {
    Pop-Location
}

$dockerArgs = @(
    "run", "--rm",
    "--add-host=host.docker.internal:host-gateway",
    "-e", "DATABASE_URL=$dbUrlDocker",
    "-e", "NUXT_ENABLE_AGENT2_BROWSER_FALLBACK=true",
    "-e", "NUSIFT_LOCAL_DOCKER_PIPELINE=true",
    "-e", "VERCEL=1"
)
foreach ($key in @("NUXT_AGENT3_WORKFLOW_BROWSER_FALLBACK", "NUXT_DOMAIN_GOVERNOR_MODE")) {
    $value = [Environment]::GetEnvironmentVariable($key)
    if (-not $value -and $envVars.ContainsKey($key)) { $value = $envVars[$key] }
    if ($value) {
        $dockerArgs += "-e"
        $dockerArgs += "$key=$value"
    }
}
$dockerArgs += $ImageName
$dockerArgs += "scripts/dev/run-local-pipeline-docker.ts"
$dockerArgs += $RemainingArgs

Write-Host "Running the complete local Agent 1/2/3 pipeline..." -ForegroundColor Green
Write-Host "  DB host: host.docker.internal" -ForegroundColor DarkGray
Write-Host "  Notifications: disabled (local sandbox)" -ForegroundColor DarkGray
& docker @dockerArgs
exit $LASTEXITCODE
