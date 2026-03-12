$env:Path = "C:\Program Files\nodejs;" + $env:Path
Set-Location "$PSScriptRoot\server"
Write-Host ""
Write-Host "  Starting PDQ Screenshot Server..." -ForegroundColor Cyan
Write-Host ""
node server.js
