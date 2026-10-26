#requires -Version 5.1
. (Join-Path $PSScriptRoot 'common.ps1')
Start-LocalPostgres
Write-Host "PostgreSQL $script:PgVersion is running on 127.0.0.1:$script:PgPort."
