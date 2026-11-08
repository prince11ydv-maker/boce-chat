param([string]$JavaHome = $env:JAVA_HOME)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$compiler = if ($JavaHome) { Join-Path $JavaHome 'bin/javac.exe' } else { (Get-Command javac -ErrorAction Stop).Source }
$runtime = if ($JavaHome) { Join-Path $JavaHome 'bin/java.exe' } else { (Get-Command java -ErrorAction Stop).Source }
$classesDirectory = Join-Path $projectDirectory 'build/policy-checks'
New-Item -ItemType Directory -Path $classesDirectory -Force | Out-Null
& $compiler -encoding UTF-8 -d $classesDirectory (Join-Path $projectDirectory 'app/src/main/java/app/classnest/pusoe/UrlPolicy.java') (Join-Path $projectDirectory 'policy-test/UrlPolicyTest.java')
if ($LASTEXITCODE -ne 0) { throw 'URL policy compilation failed.' }
& $runtime -cp $classesDirectory app.classnest.pusoe.UrlPolicyTest
if ($LASTEXITCODE -ne 0) { throw 'URL policy checks failed.' }
