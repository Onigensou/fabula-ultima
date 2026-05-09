# setup.ps1 — Fabula Ultima co-dev environment check
# Run this once after cloning to verify your setup before opening Foundry.

$ErrorActionPreference = "Stop"
$dataPath = $PSScriptRoot

Write-Host ""
Write-Host "=== Fabula Ultima Dev Setup Check ===" -ForegroundColor Cyan
Write-Host ""

# --- 1. Confirm this script is inside the FoundryVTT Data folder ---
$worldPath = Join-Path $dataPath "worlds\fabula-ultima-2"
$modulePath = Join-Path $dataPath "modules\fabula-ultima-companion"
$systemPath = Join-Path $dataPath "systems\custom-system-builder"

$ok = $true

if (-not (Test-Path $worldPath)) {
    Write-Host "[MISSING] worlds\fabula-ultima-2 not found." -ForegroundColor Red
    Write-Host "         Make sure you cloned into your FoundryVTT Data folder." -ForegroundColor Yellow
    $ok = $false
} else {
    Write-Host "[OK] worlds\fabula-ultima-2 found" -ForegroundColor Green
}

if (-not (Test-Path $modulePath)) {
    Write-Host "[MISSING] modules\fabula-ultima-companion not found." -ForegroundColor Red
    $ok = $false
} else {
    Write-Host "[OK] modules\fabula-ultima-companion found" -ForegroundColor Green
}

if (-not (Test-Path $systemPath)) {
    Write-Host "[MISSING] systems\custom-system-builder not found." -ForegroundColor Red
    $ok = $false
} else {
    Write-Host "[OK] systems\custom-system-builder found" -ForegroundColor Green
}

# --- 2. Check required modules ---
Write-Host ""
Write-Host "--- Checking required modules ---" -ForegroundColor Cyan

$manifest = Get-Content (Join-Path $dataPath "required-modules.json") | ConvertFrom-Json
$missing = @()

foreach ($mod in $manifest.modules) {
    $modDir = Join-Path $dataPath "modules\$($mod.id)"
    if (-not (Test-Path $modDir)) {
        $missing += $mod
    }
}

if ($missing.Count -eq 0) {
    Write-Host "[OK] All $($manifest.modules.Count) required modules are installed" -ForegroundColor Green
} else {
    Write-Host "[MISSING] $($missing.Count) module(s) not installed:" -ForegroundColor Yellow
    foreach ($mod in $missing) {
        $noteText = if ($mod.note) { "  <- $($mod.note)" } else { "" }
        Write-Host "   - $($mod.id)$noteText" -ForegroundColor Yellow
    }
    Write-Host ""
    Write-Host "Install them via: Foundry Setup > Add-on Modules > Install Module" -ForegroundColor White
    $ok = $false
}

# --- 3. Check for stale LevelDB LOCK files (means Foundry was not shut down cleanly) ---
Write-Host ""
Write-Host "--- Checking for stale lock files ---" -ForegroundColor Cyan

$lockFiles = Get-ChildItem -Path $dataPath -Recurse -Filter "LOCK" -ErrorAction SilentlyContinue
if ($lockFiles.Count -gt 0) {
    Write-Host "[WARNING] Found $($lockFiles.Count) LevelDB LOCK file(s) — Foundry may still be running." -ForegroundColor Yellow
    Write-Host "          Close Foundry before committing or these will block peers from opening the DB." -ForegroundColor Yellow
    foreach ($lf in $lockFiles) {
        Write-Host "          $($lf.FullName)" -ForegroundColor DarkYellow
    }
} else {
    Write-Host "[OK] No stale LOCK files found" -ForegroundColor Green
}

# --- Summary ---
Write-Host ""
if ($ok) {
    Write-Host "Setup looks good. Open FoundryVTT and load the 'Fabula Ultima' world." -ForegroundColor Green
} else {
    Write-Host "Fix the issues above, then open FoundryVTT." -ForegroundColor Yellow
}
Write-Host ""
