#Requires -Version 5.1
<#
.SYNOPSIS
  Full pipeline: scrape Google Maps, export no-website leads with location + contact info.
#>
param(
    [int]$Depth = 1,
    [int]$Concurrency = 4
)

$ErrorActionPreference = "Stop"

& "$PSScriptRoot\scrape.ps1" -Depth $Depth -Concurrency $Concurrency
& node "$PSScriptRoot\filter-no-website.mjs"

Write-Host "Done. Main file: output\no-website-leads.csv"
Write-Host "Columns: business, location, phone, email, whatsapp"
