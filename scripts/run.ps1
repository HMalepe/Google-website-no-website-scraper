#Requires -Version 5.1
<#
.SYNOPSIS
  Full pipeline: scrape Google Maps, export ranked leads with location + contact info.

.PARAMETER Audit
  Also audit listed websites and keep outdated / broken ones as leads (slower).
#>
param(
    [int]$Depth = 10,
    [int]$Concurrency = 4,
    [switch]$Audit
)

$ErrorActionPreference = "Stop"

& "$PSScriptRoot\scrape.ps1" -Depth $Depth -Concurrency $Concurrency -Email:$Audit
if ($Audit) {
    & node "$PSScriptRoot\filter-no-website.mjs" --audit
} else {
    & node "$PSScriptRoot\filter-no-website.mjs"
}

& node "$PSScriptRoot\market-insights.mjs" "output\results.csv" "output"

Write-Host "Done. Main file: output\leads.csv (best leads first)"
Write-Host "Market gaps: output\market.csv"
Write-Host "No-website only: output\no-website-leads.csv"
