[CmdletBinding()]
param(
    [string]$SiteName,
    [string]$ResourceGroup = 'classnest-student',
    [string]$Location = 'centralindia'
)
$ErrorActionPreference = 'Stop'
# Keep this guard before archive changes, credentials, CLI calls, and resource creation.
# The bundled SQLite database needs filesystem locking that App Service's mounted
# Linux content share does not support. Do not offer a bypass or a paid fallback.
throw @'
Azure deployment is blocked: this version uses SQLite, which is unsupported on the Linux App Service mounted network share. Publishing it there can lose or corrupt class data.
Continue using START-WEBSITE.cmd locally. Before Azure deployment, integrate a supported managed database, migrate the class data, and verify authentication, uploads, backups, and student-subscription costs against that configuration.
Microsoft guidance: https://github.com/Azure/app-service-linux-docs/blob/master/Things_You_Should_Know/things_you_should_know.md#sqlite-and-other-file-based-databases-are-not-supported
No Azure resources were created by this script, and no paid fallback was attempted.
'@
