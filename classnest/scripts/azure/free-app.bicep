@description('New globally unique app name. The deployment script rejects existing resource groups/names.')
param siteName string
param sqlServerName string
param databaseName string = 'classnest'
param location string
param entraAdminObjectId string
param entraAdminLogin string
param tenantId string
param sqlAdminLogin string = 'classnest_bootstrap'
param appSqlUser string = 'classnest_runtime'
@secure()
param sqlAdminPassword string
@secure()
param appSqlPassword string

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${siteName}-free'
  location: location
  kind: 'linux'
  sku: {
    name: 'F1'
    tier: 'Free'
    capacity: 1
  }
  properties: {
    reserved: true
    zoneRedundant: false
  }
  tags: { app: 'classnest', dataMode: 'azure-sql-v1' }
}
resource server 'Microsoft.Sql/servers@2025-01-01' = {
  name: sqlServerName
  location: location
  properties: {
    version: '12.0'
    administratorLogin: sqlAdminLogin
    administratorLoginPassword: sqlAdminPassword
    minimalTlsVersion: '1.2'
    publicNetworkAccess: 'Enabled'
    administrators: {
      administratorType: 'ActiveDirectory'
      azureADOnlyAuthentication: false
      login: entraAdminLogin
      sid: entraAdminObjectId
      tenantId: tenantId
      principalType: 'User'
    }
  }
  tags: { app: 'classnest', dataMode: 'azure-sql-v1' }
}
resource database 'Microsoft.Sql/servers/databases@2025-01-01' = {
  parent: server
  name: databaseName
  location: location
  sku: {
    name: 'GP_S_Gen5'
    tier: 'GeneralPurpose'
    family: 'Gen5'
    capacity: 2
  }
  properties: {
    createMode: 'Default'
    useFreeLimit: true
    freeLimitExhaustionBehavior: 'AutoPause'
    maxSizeBytes: 34359738368
    // The free AutoPause offer requires the platform defaults for idle delay and
    // minimum capacity. Supplying explicit values can disable provisioning.
    requestedBackupStorageRedundancy: 'Local'
    zoneRedundant: false
    readScale: 'Disabled'
  }
  tags: { app: 'classnest', dataMode: 'azure-sql-v1' }
}
resource site 'Microsoft.Web/sites@2024-04-01' = {
  name: siteName
  location: location
  kind: 'app,linux'
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    clientAffinityEnabled: false
    publicNetworkAccess: 'Enabled'
    siteConfig: {
      linuxFxVersion: 'NODE|24-lts'
      appCommandLine: 'node server.js'
      alwaysOn: false
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      scmMinTlsVersion: '1.2'
      remoteDebuggingEnabled: false
      // The script opens visitors only after schema/data/file migration succeeds.
      ipSecurityRestrictionsDefaultAction: 'Deny'
      scmIpSecurityRestrictionsUseMain: false
      scmIpSecurityRestrictionsDefaultAction: 'Allow'
      appSettings: [
        { name: 'NODE_ENV', value: 'production' }
        { name: 'HOST', value: '0.0.0.0' }
        { name: 'DATA_DIR', value: '/home/classnest-data' }
        { name: 'DB_PROVIDER', value: 'azure-sql' }
        { name: 'SQL_SERVER', value: server.properties.fullyQualifiedDomainName }
        { name: 'SQL_DATABASE', value: database.name }
        { name: 'SQL_USER', value: appSqlUser }
        { name: 'SQL_PASSWORD', value: appSqlPassword }
        { name: 'WEBSITES_ENABLE_APP_SERVICE_STORAGE', value: 'true' }
        { name: 'SCM_DO_BUILD_DURING_DEPLOYMENT', value: 'true' }
      ]
    }
  }
  tags: { app: 'classnest', dataMode: 'azure-sql-v1' }
}
resource noScmBasic 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: site
  name: 'scm'
  properties: { allow: false }
}
resource noFtpBasic 'Microsoft.Web/sites/basicPublishingCredentialsPolicies@2024-04-01' = {
  parent: site
  name: 'ftp'
  properties: { allow: false }
}
output siteId string = site.id
output databaseId string = database.id
output sqlServerId string = server.id
output expectedHostName string = site.properties.defaultHostName
