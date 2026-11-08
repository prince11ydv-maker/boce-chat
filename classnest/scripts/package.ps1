$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$projectDir = Split-Path $PSScriptRoot -Parent
$outputDir = Split-Path $projectDir -Parent
$archivePath = Join-Path $outputDir 'classnest-website.zip'
$tempPath = Join-Path $outputDir ('classnest-package-' + [Guid]::NewGuid().ToString('N') + '.zip')
$archive = [IO.Compression.ZipFile]::Open($tempPath, [IO.Compression.ZipArchiveMode]::Create)
# Explicit source allowlist: no accounts, databases, uploads, credentials, or backups.
$sourceFiles = @('.gitignore','package.json','package-lock.json','server.js','db-adapter.js','schema/sqlite.sql','schema/azure-sql.sql','README.md','SECURITY-REVIEW.md','AZURE-HOSTING.md','START-WEBSITE.cmd','public/index.html','public/app.js','public/theme.js','public/style.css','public/icon.svg','public/icons.svg','public/study-art.svg','scripts/package.ps1','scripts/package-azure.ps1','scripts/deploy-azure.ps1','scripts/bootstrap-sql.mjs','scripts/migrate-data.mjs','scripts/check-database.mjs','scripts/azure/free-app.bicep','scripts/azure/free-app.json','scripts/azure/cloudshell-deploy.py','scripts/azure/cloudshell-deploy.sh','scripts/azure/requirements.txt','test/flows.test.js','test/security.test.js','test/database.test.js','storage-adapter.js','rate-limiter.js','vercel.json','.vercelignore','schema/postgres.sql','schema/postgres-runtime.sql','FREE-HOSTING.md','test/cloud.test.js','DEPLOYMENT.md','password-reset.js','email-preferences.js','email-outbox.js','mailer.js','schema/email-sqlite.sql','schema/email-postgres.sql','schema/email-worker-postgres.sql','EMAIL-SETUP.md','test/password-reset.test.js','test/mailer.test.js','test/email-preferences.test.js','test/email-outbox.test.js','test/email-flows.test.js','test/fixtures/email-server.mjs')
$sourceFiles += @('schema/semester-postgres.sql','schema/semester-azure-sql.sql','test/semester-access.test.js')
$sourceFiles += @('routine-data.js','build-assets.mjs','public/note-preview.js','schema/routines-postgres.sql','schema/routines-azure-sql.sql','test/routine-preview.test.js')
$sourceFiles += @('public/routine-html-import.js','test/html-import-browser.html','test/fixtures/html-import-checks.js','test/fixtures/html-import-server.mjs')
$sourceFiles += @('teaching.js','public/teaching-ui.js','schema/teacher-accounts-postgres.sql','schema/teaching-sqlite.sql','schema/teaching-postgres.sql','test/teaching.test.js','test/teaching-http.test.js','test/teaching-email.test.js')
$sourceFiles += @('schema/teaching-worker-postgres.sql')
$sourceFiles += @('teacher-dashboard.js','schema/teacher-semesters-sqlite.sql','schema/teacher-semesters-postgres.sql','test/teacher-dashboard.test.js')
$sourceFiles += @('notice-attachments.js','notice-file-validation.js','schema/notice-attachments-sqlite.sql','schema/notice-attachments-postgres.sql','test/notice-attachments.test.js','test/notice-notifications.test.js','test/notice-file-validation.test.js','test/notice-files.test.js')
$sourceFiles += @('HOSTING.md')
try {
    foreach ($relative in $sourceFiles) {
        $file = Join-Path $projectDir $relative
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw "Missing source file: $relative" }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file, "classnest/$relative") | Out-Null
    }
} finally { $archive.Dispose() }
Move-Item -LiteralPath $tempPath -Destination $archivePath -Force
Write-Host "Updated source download: $archivePath"

