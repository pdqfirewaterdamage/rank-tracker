$env:Path = "C:\Program Files\nodejs;" + $env:Path
Set-Location "$PSScriptRoot\server"

Write-Host ""
Write-Host "  Starting PDQ Rank Tracker (Node server) ..." -ForegroundColor Cyan
Write-Host "  - Serves index.html on http://localhost:3456" -ForegroundColor Gray
Write-Host "  - Persists projects to server\data\projects.json" -ForegroundColor Gray
Write-Host "  - Provides /scrape (Puppeteer) and /data endpoints" -ForegroundColor Gray
Write-Host ""

# Install deps the first time
if (-not (Test-Path ".\node_modules")) {
    Write-Host "  First run: installing Node dependencies ..." -ForegroundColor Yellow
    npm install
}

Start-Process "http://localhost:3456"
node server.js
