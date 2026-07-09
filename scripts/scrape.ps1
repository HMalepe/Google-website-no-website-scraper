#Requires -Version 5.1
<#
.SYNOPSIS
  Run gosom/google-maps-scraper via Docker (free, fast, no API keys).

.PARAMETER Email
  Visit each business website and try to extract emails (-email flag).

.PARAMETER Depth
  Search depth (1 = faster, higher = more results per query).

.PARAMETER Concurrency
  Parallel scrape jobs (-c). Start with 4; increase on a strong machine.
#>
param(
    [switch]$Email,
    [int]$Depth = 1,
    [int]$Concurrency = 4,
    [string]$QueriesFile = "",
    [string]$OutputFile = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot
$OutDir = Join-Path $Root "output"
$Queries = if ($QueriesFile) { $QueriesFile } else { Join-Path $Root "queries.txt" }
$Example = Join-Path $Root "queries.example.txt"
$Results = if ($OutputFile) { $OutputFile } else { Join-Path $OutDir "results.csv" }

if (-not (Test-Path $Queries)) {
    if (Test-Path $Example) {
        Copy-Item $Example $Queries
        Write-Host "Created queries.txt from queries.example.txt — edit your search terms there."
    } else {
        throw "Missing queries.txt. Add one search per line, e.g. 'plumbers in Johannesburg'."
    }
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw "Docker is required. Install Docker Desktop: https://www.docker.com/products/docker-desktop/"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$dockerArgs = @(
    "run", "--rm",
    "-v", "gmaps-playwright-cache:/opt",
    "-v", "${Queries}:/queries.txt:ro",
    "-v", "${OutDir}:/out",
    "gosom/google-maps-scraper",
    "-input", "/queries.txt",
    "-results", "/out/results.csv",
    "-depth", "$Depth",
    "-c", "$Concurrency",
    "-exit-on-inactivity", "3m"
)

if ($Email) {
    $dockerArgs += "-email"
}

Write-Host ""
Write-Host "Google Maps scrape starting..."
Write-Host "Queries : $Queries"
Write-Host "Output  : $Results"
Write-Host "Email   : $(if ($Email) { 'yes' } else { 'no (add -Email to enable)' })"
Write-Host ""

& docker @dockerArgs
if ($LASTEXITCODE -ne 0) {
    throw "Docker scraper exited with code $LASTEXITCODE"
}

Write-Host ""
Write-Host "Scrape finished -> $Results"
Write-Host "Next: node scripts/filter-no-website.mjs"
Write-Host ""
