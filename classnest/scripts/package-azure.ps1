$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$projectDir = Split-Path $PSScriptRoot -Parent
$outputDir = Split-Path $projectDir -Parent
$archivePath = Join-Path $outputDir 'classnest-azure-code.zip'
$tempPath = Join-Path $outputDir ('classnest-code-' + [Guid]::NewGuid().ToString('N') + '.zip')
$archive = [IO.Compression.ZipFile]::Open($tempPath, [IO.Compression.ZipArchiveMode]::Create)
# Deliberately exclude data/, portable exports, uploaded attachments, .env, and node_modules.
$sourceFiles = @('package.json','package-lock.json','server.js','db-adapter.js','schema/sqlite.sql','schema/azure-sql.sql','public/index.html','public/app.js','public/theme.js','public/style.css','public/icon.svg','public/icons.svg','public/study-art.svg','scripts/bootstrap-sql.mjs','scripts/migrate-data.mjs','scripts/check-database.mjs','storage-adapter.js','rate-limiter.js','password-reset.js','email-preferences.js','email-outbox.js','mailer.js','schema/email-sqlite.sql','schema/email-postgres.sql')
$sourceFiles += @('schema/semester-postgres.sql','schema/semester-azure-sql.sql')
$sourceFiles += @('routine-data.js','build-assets.mjs','public/note-preview.js','schema/routines-postgres.sql','schema/routines-azure-sql.sql')
$sourceFiles += @('public/routine-html-import.js')
$sourceFiles += @('teaching.js','public/teaching-ui.js','schema/teaching-sqlite.sql','schema/teaching-postgres.sql','schema/teacher-accounts-postgres.sql')
$sourceFiles += @('teacher-dashboard.js','schema/teacher-semesters-sqlite.sql','schema/teacher-semesters-postgres.sql')
$sourceFiles += @('notice-attachments.js','notice-file-validation.js','schema/notice-attachments-sqlite.sql','schema/notice-attachments-postgres.sql')
$sourceFiles += @('public/pwa.js','public/service-worker.js','public/manifest.webmanifest','public/offline.html','public/offline.css','public/app-icons/icon-192.png','public/app-icons/icon-512.png','public/app-icons/maskable-512.png','public/app-icons/apple-touch-icon.png')
try {
    foreach ($relative in $sourceFiles) {
        $file = Join-Path $projectDir $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing deployment source: $relative" }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file, $relative) | Out-Null
    }
} finally { $archive.Dispose() }
Move-Item -LiteralPath $tempPath -Destination $archivePath -Force
Write-Host "Azure-ready code archive prepared; not deployed: $archivePath"

