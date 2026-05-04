$env:Path = "C:\Program Files\nodejs;" + $env:Path
$cli = Join-Path $PSScriptRoot "server\serp-cli.js"
node $cli @args
