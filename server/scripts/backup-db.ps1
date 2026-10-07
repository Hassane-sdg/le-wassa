param(
  [int]$IntervalHours = 24,
  [string]$DbPath = '',
  [string]$DestDir = ''
)

if (-not $DbPath) {
  if ($env:WASSA_DB_PATH) {
    $DbPath = $env:WASSA_DB_PATH
  } elseif ($env:WASSA_DATA_DIR) {
    $DbPath = Join-Path $env:WASSA_DATA_DIR 'db.sqlite'
  } elseif ($env:LOCALAPPDATA) {
    $DbPath = Join-Path $env:LOCALAPPDATA 'LeWASSA\db.sqlite'
  } else {
    $dataHome = if ($env:XDG_DATA_HOME) { $env:XDG_DATA_HOME } else { Join-Path $HOME '.local\share' }
    $DbPath = Join-Path $dataHome 'le-wassa\db.sqlite'
  }
}

if (-not $DestDir) {
  $DestDir = Join-Path (Split-Path -Parent $DbPath) 'backups'
}

# Create destination directory
if (-not (Test-Path $DestDir)) { New-Item -ItemType Directory -Path $DestDir | Out-Null }

Write-Output "Starting DB backup loop. IntervalHours=$IntervalHours, DbPath=$DbPath, DestDir=$DestDir"

while ($true) {
  try {
    if (Test-Path $DbPath) {
      $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
      $dest = Join-Path $DestDir "db-$timestamp.sqlite"
      Copy-Item -Path $DbPath -Destination $dest -Force
      Write-Output "Backed up $DbPath -> $dest"
    } else {
      Write-Output "DB file not found: $DbPath"
    }
  } catch {
    Write-Output "Backup error: $_"
  }
  Start-Sleep -Seconds ($IntervalHours * 3600)
}
