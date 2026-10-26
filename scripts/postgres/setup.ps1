#requires -Version 5.1
. (Join-Path $PSScriptRoot 'common.ps1')
Protect-PostgresDirectory

$archiveDirectory = Join-Path $script:PostgresRoot 'downloads'
New-Item -ItemType Directory -Force -Path $archiveDirectory | Out-Null
$archivePath = Join-Path $archiveDirectory ('postgresql-' + $script:PgPackaging + '-windows-x64-binaries.zip')
if (-not (Test-Path -LiteralPath $archivePath)) {
  $partialPath = $archivePath + '.partial'
  Write-Host "Downloading official EDB PostgreSQL $script:PgVersion Windows binaries..."
  Invoke-WebRequest -Uri $script:PgDownload -OutFile $partialPath -UseBasicParsing
  if ((Get-FileHash -LiteralPath $partialPath -Algorithm SHA256).Hash -ne $script:PgArchiveSha256) { throw 'Archive checksum differs from the pinned official download; nothing was installed.' }
  Move-Item -LiteralPath $partialPath -Destination $archivePath
}
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $script:PgArchiveSha256) { throw 'The cached PostgreSQL archive failed its checksum check.' }

$installedMarker = Join-Path $script:PostgresRoot 'installation.json'
if (-not (Test-Path -LiteralPath $installedMarker)) {
  if (Test-Path -LiteralPath (Join-Path $script:PostgresData 'PG_VERSION')) { throw 'An existing cluster has no installation marker. Refusing to replace its binaries.' }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
  try {
    foreach ($entry in $zip.Entries) {
      # No pgAdmin, StackBuilder, PATH changes, services, or unrelated components.
      if ($entry.FullName -notmatch '^pgsql/(bin/|lib/|share/|server_license\.txt$|commandlinetools_3rd_party_licenses\.txt$)') { continue }
      $destination = [IO.Path]::GetFullPath((Join-Path $script:PostgresRoot ($entry.FullName.Replace('/', '\'))))
      if (-not $destination.StartsWith($script:PostgresRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry escapes the project-local installation.' }
      if ($entry.FullName.EndsWith('/')) { New-Item -ItemType Directory -Force -Path $destination | Out-Null; continue }
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
      [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
    }
  } finally { $zip.Dispose() }
  $versionCheck = Invoke-PostgresProgram 'postgres' @('--version')
  if ($versionCheck.ExitCode -ne 0 -or $versionCheck.Output -notmatch '18\.6') { throw 'The extracted PostgreSQL executable did not pass the version check.' }
  Write-Utf8File $installedMarker (([ordered]@{ version = $script:PgVersion; packaging = $script:PgPackaging; source = $script:PgDownload; sourcePage = 'https://www.enterprisedb.com/download-postgresql-binaries'; sha256 = $script:PgArchiveSha256; installedAt = [DateTime]::UtcNow.ToString('o') }) | ConvertTo-Json)
}

if (-not (Test-Path -LiteralPath $script:CredentialsPath)) {
  if (Test-Path -LiteralPath (Join-Path $script:PostgresData 'PG_VERSION')) { throw 'A cluster already exists without credentials. Nothing was reset.' }
  function New-Secret {
    $bytes = New-Object byte[] 32
    $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $generator.GetBytes($bytes) } finally { $generator.Dispose() }
    return [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  }
  $roles = [ordered]@{}
  foreach ($item in @(
    @('admin', 'agentic_local_admin', 'postgres'),
    @('migration', 'agentic_migrator', 'agentic_v3'),
    @('app', 'agentic_app', 'agentic_v3'),
    @('testMigration', 'agentic_test_migrator', 'agentic_v3_test'),
    @('testApp', 'agentic_test_app', 'agentic_v3_test')
  )) { $roles[$item[0]] = [ordered]@{ user = $item[1]; password = (New-Secret); database = $item[2] } }
  function Connection-Url($Role) { return 'postgresql://' + $Role.user + ':' + $Role.password + '@127.0.0.1:55432/' + $Role.database }
  $settings = [ordered]@{
    schemaVersion = 1; version = $script:PgVersion; host = $script:PgHost; port = $script:PgPort
    databaseUrl = (Connection-Url $roles.app)
    migrationDatabaseUrl = (Connection-Url $roles.migration)
    testDatabaseUrl = (Connection-Url $roles.testApp)
    testMigrationDatabaseUrl = (Connection-Url $roles.testMigration)
    roles = $roles
  }
  Write-Utf8File $script:CredentialsPath ($settings | ConvertTo-Json -Depth 5)
}
$settings = Get-PostgresCredentials
if ((Test-Path -LiteralPath (Join-Path $script:PostgresData 'PG_VERSION')) -and -not (Test-Path -LiteralPath (Join-Path $script:PostgresData 'global\pg_control'))) {
  throw 'An incomplete cluster exists. Preserve or inspect it before retrying; it was not overwritten.'
}
if (-not (Test-Path -LiteralPath (Join-Path $script:PostgresData 'PG_VERSION'))) {
  if ((Test-Path -LiteralPath $script:PostgresData) -and @(Get-ChildItem -LiteralPath $script:PostgresData -Force).Count -gt 0) { throw 'A nonempty uninitialized data directory already exists. Nothing was deleted.' }
  $passwordPath = Join-Path $script:PostgresRoot 'initdb-password.tmp'
  Write-Utf8File $passwordPath $settings.roles.admin.password
  try {
    $result = Invoke-PostgresProgram 'initdb' @('-D', $script:PostgresData, '--username=agentic_local_admin', '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', ('--pwfile=' + $passwordPath), '--encoding=UTF8', '--locale-provider=builtin', '--locale=C', '--builtin-locale=C.UTF-8') 180
    if ($result.ExitCode -ne 0) { Write-Utf8File (Join-Path $script:PostgresLogs 'initdb-error.log') $result.Error; throw 'initdb failed; inspect the local initdb error log.' }
  } finally { Remove-Item -LiteralPath $passwordPath -Force -ErrorAction SilentlyContinue }
  # Cluster-local defaults; no externally reachable listener and no trust fallback.
  Write-Utf8File (Join-Path $script:PostgresData 'agentic-local.conf') @"
listen_addresses = '127.0.0.1'
port = 55432
password_encryption = 'scram-sha-256'
max_connections = 60
shared_buffers = '64MB'
timezone = 'UTC'
log_timezone = 'UTC'
log_statement = 'none'
log_min_error_statement = 'panic'
"@
  Add-Content -LiteralPath (Join-Path $script:PostgresData 'postgresql.conf') -Value "`ninclude = 'agentic-local.conf'" -Encoding ASCII
  Write-Utf8File (Join-Path $script:PostgresData 'pg_hba.conf') @"
# This cluster is only for the local Agentic V3 demo.
host all all 127.0.0.1/32 scram-sha-256
host all all 0.0.0.0/0 reject
host all all ::0/0 reject
"@
}
Start-LocalPostgres

# All objects belong to the migration login. The runtime login only has DML privileges.
foreach ($key in @('migration', 'app', 'testMigration', 'testApp')) {
  $role = $settings.roles.$key
  if ($role.user -notmatch '^agentic_[a-z_]+$' -or $role.password -notmatch '^[a-f0-9]{64}$') { throw 'Unexpected local role configuration; refusing to interpolate it into setup SQL.' }
  $sql = "SELECT format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', '$($role.user)', '$($role.password)') WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$($role.user)');`n\gexec"
  [void](Invoke-PostgresSql $settings.roles.admin $sql)
}
foreach ($pair in @(@('migration', 'app'), @('testMigration', 'testApp'))) {
  $migration = $settings.roles.($pair[0]); $app = $settings.roles.($pair[1])
  $database = $migration.database
  $create = "SELECT format('CREATE DATABASE %I OWNER %I', '$database', '$($migration.user)') WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '$database');`n\gexec"
  [void](Invoke-PostgresSql $settings.roles.admin $create)
  $adminConnection = [pscustomobject]@{ user = $settings.roles.admin.user; password = $settings.roles.admin.password; database = $database }
  $grants = @"
REVOKE ALL ON DATABASE $database FROM PUBLIC;
GRANT CONNECT ON DATABASE $database TO $($migration.user), $($app.user);
ALTER SCHEMA public OWNER TO $($migration.user);
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO $($app.user);
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO $($app.user);
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO $($app.user);
SELECT format('REVOKE INSERT, UPDATE, DELETE ON TABLE public.%I FROM %I', table_name, '$($app.user)')
FROM (VALUES ('characters'), ('schema_migrations')) AS readonly_tables(table_name)
WHERE to_regclass(format('public.%I', table_name)) IS NOT NULL;
\gexec
ALTER DEFAULT PRIVILEGES FOR ROLE $($migration.user) IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO $($app.user);
ALTER DEFAULT PRIVILEGES FOR ROLE $($migration.user) IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO $($app.user);
ALTER ROLE $($app.user) SET search_path = public;
ALTER ROLE $($migration.user) SET search_path = public;
"@
  [void](Invoke-PostgresSql $adminConnection $grants)
  [void](Invoke-PostgresSql $app 'SELECT 1;')
}
[void](Invoke-PostgresSql $settings.roles.admin 'REVOKE CONNECT ON DATABASE postgres FROM PUBLIC; REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;')
Write-Host "PostgreSQL $script:PgVersion ready at 127.0.0.1:$script:PgPort. Databases: agentic_v3, agentic_v3_test."
Write-Host 'Credentials stay in .local/postgres/credentials.json. Runtime and migration roles are separate; no passwords were printed.'
