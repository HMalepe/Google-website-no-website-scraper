#Requires -Version 5.1
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required. Install from https://nodejs.org/"
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Warning "Docker not found. Install Docker Desktop before scraping."
}

if (-not (Test-Path (Join-Path $Root "node_modules"))) {
    Write-Host "Installing dashboard dependencies (first run)..."
    npm install --omit=dev
}

$port = if ($env:PORT) { $env:PORT } else { 3847 }
$url = "http://localhost:$port"

Write-Host ""
Write-Host "Starting Lead Finder Dashboard..."
Write-Host "Open: $url"
Write-Host ""

Start-Process $url
node server.mjs
