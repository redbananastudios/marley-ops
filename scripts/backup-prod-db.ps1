# Nightly Marley Ops prod backup — pg_dump via Docker (no local pg tools needed).
# Reads MARLEY_OPS_DB_URL from credentials.env, dumps to the backups folder
# (rides Google Drive off-machine), prunes dumps older than 30 days, and logs
# DB/storage usage so quota pressure is visible before it bites.
# Schedule silently via the VBS-launcher pattern (make-tasks-silent.ps1).

$ErrorActionPreference = "Stop"
$credFile = "F:\My Drive\workspace\credentials.env"
$backupDir = "O:\projects\red-banana\clients\marley\backups"
$logFile = Join-Path $backupDir "backup.log"

if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Force $backupDir | Out-Null }

$dbUrl = (Get-Content $credFile | Where-Object { $_ -match "^MARLEY_OPS_DB_URL=" }) -replace "^MARLEY_OPS_DB_URL=", ""
if (-not $dbUrl) {
    Add-Content $logFile "$(Get-Date -Format s) FAIL no MARLEY_OPS_DB_URL in credentials.env"
    exit 1
}

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$outFile = Join-Path $backupDir "marley-ops-$stamp.sql"

# postgres:17 pg_dump matches Supabase's server major closely enough for logical dumps.
docker run --rm postgres:17 pg_dump --no-owner --no-privileges --dbname="$dbUrl" | Out-File -FilePath $outFile -Encoding utf8
if ($LASTEXITCODE -ne 0 -or -not (Test-Path $outFile) -or (Get-Item $outFile).Length -lt 1024) {
    Add-Content $logFile "$(Get-Date -Format s) FAIL dump missing/too small"
    exit 1
}

# Compress + remove the raw dump.
Compress-Archive -Path $outFile -DestinationPath "$outFile.zip" -Force
Remove-Item $outFile -Confirm:$false

# Prune > 30 days.
Get-ChildItem $backupDir -Filter "marley-ops-*.zip" | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-30) } | Remove-Item -Confirm:$false

$size = [math]::Round((Get-Item "$outFile.zip").Length / 1MB, 2)
Add-Content $logFile "$(Get-Date -Format s) OK marley-ops-$stamp.sql.zip ($size MB)"
