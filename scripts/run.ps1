#Requires -Version 5.1
<#
.SYNOPSIS
  Full pipeline: scrape Google Maps, then split no-website vs with-website leads.
#>
param(
    [switch]$Email,
    [int]$Depth = 1,
    [int]$Concurrency = 4
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $PSScriptRoot

& "$PSScriptRoot\scrape.ps1" -Email:$Email -Depth $Depth -Concurrency $Concurrency
& node "$PSScriptRoot\filter-no-website.mjs"

Write-Host "Done. Open output\no-website-leads.csv for web-design prospects (phone outreach)."
Write-Host "Businesses with websites are in output\with-website-leads.csv"
