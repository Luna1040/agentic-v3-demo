Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProjectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:PostgresRoot = Join-Path $script:ProjectRoot '.local\postgres'
$script:PostgresBin = Join-Path $script:PostgresRoot 'pgsql\bin'
$script:PostgresData = Join-Path $script:PostgresRoot 'data'
$script:PostgresLogs = Join-Path $script:PostgresRoot 'logs'
$script:CredentialsPath = Join-Path $script:PostgresRoot 'credentials.json'
$script:PgVersion = '18.6'
$script:PgPackaging = '18.6-5'
$script:PgPort = 55432
$script:PgHost = '127.0.0.1'
$script:PgDownload = 'https://get.enterprisedb.com/postgresql/postgresql-18.6-5-windows-x64-binaries.zip'
# Recorded from the archive fetched through PostgreSQL.org -> EDB on 2026-10-21.
# This is a reproducibility pin, not an independently published EDB signature.
$script:PgArchiveSha256 = 'E2246BA91D22345BC3D017586C09EDE52D9DF180B1EEB480F050445F1CAD84E2'

function Write-Utf8File([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, (New-Object Text.UTF8Encoding($false)))
}

function Protect-PostgresDirectory {
  New-Item -ItemType Directory -Force -Path $script:PostgresRoot | Out-Null
  $ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  # Load and persist only the DACL; Set-Acl can also attempt privileged audit fields.
  $acl = New-Object Security.AccessControl.DirectorySecurity($script:PostgresRoot, [Security.AccessControl.AccessControlSections]::Access)
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) { [void]$acl.RemoveAccessRuleAll($rule) }
  foreach ($sid in @($ownerSid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')), (New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  $directory = New-Object IO.DirectoryInfo($script:PostgresRoot)
  if ($PSVersionTable.PSVersion.Major -ge 7) { [IO.FileSystemAclExtensions]::SetAccessControl($directory, $acl) }
  else { $directory.SetAccessControl($acl) }
  New-Item -ItemType Directory -Force -Path $script:PostgresLogs | Out-Null
}

function Get-PostgresCredentials {
  if (-not (Test-Path -LiteralPath $script:CredentialsPath)) { throw 'Local PostgreSQL is not configured. Run scripts/postgres/setup.ps1 first.' }
  $settings = Get-Content -LiteralPath $script:CredentialsPath -Raw | ConvertFrom-Json
  if ($settings.schemaVersion -ne 1 -or $settings.host -ne $script:PgHost -or $settings.port -ne $script:PgPort -or $settings.version -ne $script:PgVersion) {
    throw 'The existing local PostgreSQL configuration differs from this pinned setup. It was not overwritten.'
  }
  return $settings
}

function Invoke-PostgresProgram([string]$Program, [string[]]$Arguments, [int]$TimeoutSeconds = 45) {
  $executable = Join-Path $script:PostgresBin ($Program + '.exe')
  if (-not (Test-Path -LiteralPath $executable)) { throw 'PostgreSQL binaries are missing. Run scripts/postgres/setup.ps1 first.' }
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = $executable
  $start.Arguments = ($Arguments | ForEach-Object { '"' + $_.Replace('"', '\"') + '"' }) -join ' '
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) { $process.Kill(); throw "PostgreSQL utility $Program timed out." }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; Output = $stdout.GetAwaiter().GetResult(); Error = $stderr.GetAwaiter().GetResult() }
  } finally { $process.Dispose() }
}

function Invoke-PostgresSql([object]$Connection, [string]$Sql) {
  $start = New-Object Diagnostics.ProcessStartInfo
  $start.FileName = Join-Path $script:PostgresBin 'psql.exe'
  $start.Arguments = '-X -w -q -t -A -v ON_ERROR_STOP=1'
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  # Connection secrets are child-only environment values, never command arguments.
  $start.EnvironmentVariables['PGHOST'] = $script:PgHost
  $start.EnvironmentVariables['PGPORT'] = [string]$script:PgPort
  $start.EnvironmentVariables['PGDATABASE'] = $Connection.database
  $start.EnvironmentVariables['PGUSER'] = $Connection.user
  $start.EnvironmentVariables['PGPASSWORD'] = $Connection.password
  $start.EnvironmentVariables['PGCONNECT_TIMEOUT'] = '5'
  $start.EnvironmentVariables['PGCLIENTENCODING'] = 'UTF8'
  $process = New-Object Diagnostics.Process
  $process.StartInfo = $start
  try {
    [void]$process.Start()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.WriteLine($Sql)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(45000)) { $process.Kill(); throw 'PostgreSQL setup SQL timed out.' }
    $output = $stdout.GetAwaiter().GetResult()
    $errors = $stderr.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) {
      # Even PostgreSQL error text may contain submitted SQL. Keep it private and redact credentials.
      $settings = Get-PostgresCredentials
      foreach ($name in @('admin', 'migration', 'app', 'testMigration', 'testApp')) { $errors = $errors.Replace($settings.roles.$name.password, '[REDACTED]') }
      Write-Utf8File (Join-Path $script:PostgresLogs 'setup-sql-error.log') $errors
      throw 'PostgreSQL setup SQL failed; details are in .local/postgres/logs/setup-sql-error.log (secrets redacted).'
    }
    return $output.Trim()
  } finally { $process.Dispose() }
}

function Test-PostgresRunning {
  if (-not (Test-Path -LiteralPath (Join-Path $script:PostgresData 'PG_VERSION'))) { return $false }
  return (Invoke-PostgresProgram 'pg_ctl' @('status', '-D', $script:PostgresData)).ExitCode -eq 0
}

function Start-LocalPostgres {
  [void](Get-PostgresCredentials)
  if (Test-PostgresRunning) { return }
  $log = Join-Path $script:PostgresLogs 'postgres.log'
  $arguments = 'start -D "' + $script:PostgresData + '" -l "' + $log + '" -w -t 30'
  # WaitForExit waits for pg_ctl only; Start-Process -Wait can wait for its server descendants.
  $process = Start-Process -FilePath (Join-Path $script:PostgresBin 'pg_ctl.exe') -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $script:PostgresLogs 'start.out.log') -RedirectStandardError (Join-Path $script:PostgresLogs 'start.err.log')
  try {
    if (-not $process.WaitForExit(45000)) { throw 'PostgreSQL startup timed out. Inspect the private postgres log.' }
    $process.Refresh()
    # Windows PowerShell can leave Start-Process.ExitCode null after WaitForExit;
    # pg_ctl status plus an authenticated query verify the actual server instead.
    if (-not (Test-PostgresRunning)) { throw 'PostgreSQL did not start. Inspect .local/postgres/logs without sharing secrets.' }
    [void](Invoke-PostgresSql (Get-PostgresCredentials).roles.admin 'SELECT 1;')
  } finally { $process.Dispose() }
}
