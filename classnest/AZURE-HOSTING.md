# Azure hosting preparation

This is the supported replacement for the retired SQLite/App Service deployment. Preparation and local checks do not prove that resources were provisioned or that the website is live. Keep the local app and its `data/` directory until the cloud migration, sign-in, and attachment checks pass.

## Reviewed resource plan

- One **Linux App Service F1 (Free)** plan and one Node.js 24 website, using Azure's provided HTTPS hostname. F1 has shared compute, a daily CPU allowance, 1 GB total content storage, cold starts, and no availability SLA.
- One new **Azure SQL Database General Purpose serverless free-tier** database, 32 GiB maximum, `useFreeLimit=true`, `freeLimitExhaustionBehavior=AutoPause`, local backup redundancy, and 15-minute idle pause. If its monthly allowance runs out, the database pauses instead of enabling paid overages.
- Existing notes' uploaded files remain ordinary files under `/home/classnest-data/uploads`, within the app's 700 MiB cap and the plan's total storage allowance. SQLite is never used on this shared filesystem.
- No paid web tier, extra storage account, Key Vault, paid monitoring workspace, or paid fallback is provisioned by the template.

The target account must show an active eligible **regular Azure for Students** subscription. Azure for Students Starter is not eligible for the SQL free tier. Before any creation, verify the selected region, existing free database region/count, current allowances, and provider quotas. The template alone cannot guarantee account eligibility or uptime.

## Authentication and access changes

The reviewed current user becomes the Entra administrator of the **new SQL logical server only**, to initialize its schema and import the existing class data. The app receives a separate contained SQL user with data reader/writer roles; it receives no database-owner or schema-creation rights. The free F1 plan uses SQL authentication because managed-identity support cannot be assumed on this tier.

The deployment process generates separate random SQL server/admin and runtime passwords only in process memory. It submits them over HTTPS as secure ARM parameters; the runtime password is stored in encrypted App Service settings. It never writes passwords/tokens to files, prints them, or supplies them as command-line arguments. Do not enable CLI debug logging or shell tracing. Your Classnest administrator password does not change; its existing hash is migrated.

SQL firewall rules allow the app's exact reported outbound IP addresses. A temporary rule for the Cloud Shell session's exact IP is added only if SQL reports that address in its firewall error, then removed. The broad `0.0.0.0` Azure-services exception is prohibited. Public website access stays denied until the schema, class data, and attachment deployment steps succeed. A final access change opens the student website publicly, as requested; posting permissions remain enforced by Classnest.

These resource, credential, firewall, Entra-administrator, and public-access changes must be part of the concrete reviewed deployment approval before `--apply` is run.

## Prepare private migration and deployment artifacts locally

1. Use the current Azure-ready source and run its tests. Keep a private SQLite snapshot plus its matching upload folder. Avoid editing the class during the final snapshot/migration.
2. Export a portable migration file into the workspace's private `work/` directory:

```powershell
node scripts/migrate-data.mjs export C:/ABSOLUTE/WORK/classnest-migration.json --source-data-dir C:/ABSOLUTE/CLASSNEST/data
```

This file contains account email addresses and password hashes. It is **private**: never include it in public code archives or shareable outputs. It excludes active sessions and login-failure state. It includes an attachment size/SHA-256 manifest.

3. Run `scripts/package-azure.ps1` to create `classnest-azure-code.zip`. Its explicit source allowlist includes the new database adapter/schema and excludes accounts, private migration exports, uploads, credentials, and installed dependencies. `scripts/package.ps1` creates the separate full source download.

## Run read-only preflight in Azure Cloud Shell

Use **ephemeral Cloud Shell / No storage account required** so deployment tooling does not create a billed persistent fileshare. Use Node.js 24 (minimum 22.13), npm, and Python 3. Upload the source, code ZIP, reviewed nonsecret plan JSON, and—only when ready to migrate—the private migration JSON and its matching attachment folder into a task-specific ephemeral working directory.

From the extracted Classnest project, install the locked Node dependencies (`npm ci --no-audit --no-fund`). Then run:

```bash
bash scripts/azure/cloudshell-deploy.sh \
  --plan /ABSOLUTE/PRIVATE/WORK/azure-deployment-plan.json \
  --entra-admin-object-id REVIEWED-CURRENT-USER-OBJECT-ID
```

This default command reads account/resource metadata and prints the selected plan. It creates no resource group, database, app, password, or firewall rule. It refuses an existing target resource group or globally unavailable reviewed name rather than overwriting unrelated resources or generating different names. SDK dependencies come from the official Azure packages on PyPI.

## Apply only the approved plan

After concrete approval, use the same plan and names with the private migration inputs:

```bash
bash scripts/azure/cloudshell-deploy.sh \
  --plan /ABSOLUTE/PRIVATE/WORK/azure-deployment-plan.json \
  --entra-admin-object-id REVIEWED-CURRENT-USER-OBJECT-ID \
  --code-zip /ABSOLUTE/PRIVATE/WORK/classnest-azure-code.zip \
  --migration-file /ABSOLUTE/PRIVATE/WORK/classnest-migration.json \
  --uploads-dir /ABSOLUTE/PRIVATE/WORK/uploads \
  --apply
```

The new resource group must not exist. The script validates the compiled template's fixed free-tier controls, validates attachment hashes, creates the new resources, initializes schema and least-privilege access, imports records into an empty database transactionally, deploys attachments/code using authenticated APIs, and removes the temporary firewall exception. It never prints database passwords. It then opens the website and verifies its health, migrated owner, and attachment hashes before reporting `ready:true` with the actual URL.

If any step fails, it stops without a paid fallback or automatic resource deletion. The nonsecret `classnest-deployment-reference.json` records the selected resources and readiness. Inspect that resource group in Azure Portal before retrying; the script intentionally refuses to overwrite a partial deployment. If failure occurs after opening visitors, it attempts to close access again. An explicit `ACTION REQUIRED` message identifies any firewall/access cleanup that could not be completed.

The old `scripts/deploy-azure.ps1` remains blocked; do not use it. Do not change `AutoPause` to billable overages or raise the web plan tier to make a failed deployment proceed.

## Verification and backups

The final handoff must confirm a successful deployment URL, owner sign-in/permissions, subjects/notes, attachment downloads, and persistence after an app restart. A template output or a `ready:false` reference is not proof of a live site. Keep local data until these checks pass.

For Azure SQL, use its managed backup/restore controls and the application's portable export; the local `.sqlite` backup/restore procedure applies only to the local SQLite mode. Back up upload files separately. The SQL free tier limits backup retention/features, and a paused database is unavailable until its allowance renews. Avoid database-polling health checks and ensure idle connections close so auto-pause can work.

Primary references: [SQL free tier](https://learn.microsoft.com/azure/azure-sql/database/free-tier), [SQL ARM resource fields](https://learn.microsoft.com/azure/templates/microsoft.sql/2025-01-01/servers/databases), [App Service persistent files](https://learn.microsoft.com/azure/app-service/configure-custom-container#use-persistent-shared-storage), [Entra SQL administration](https://learn.microsoft.com/azure/azure-sql/database/authentication-aad-configure), [ephemeral Cloud Shell](https://learn.microsoft.com/azure/cloud-shell/get-started/ephemeral), [authenticated file deployment](https://learn.microsoft.com/azure/app-service/deploy-zip).
