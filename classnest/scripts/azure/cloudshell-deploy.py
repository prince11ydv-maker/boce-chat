#!/usr/bin/env python3
"""Read-only preflight by default. --apply creates only a NEW F1/free-SQL stack.

Run in the user's authenticated ephemeral Azure Cloud Shell. Generated database
passwords stay in process memory and are supplied through secure ARM parameters
and child stdin; neither passwords nor access tokens are written or printed.
"""
import argparse
import copy
import hashlib
import ipaddress
import json
import logging
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent.parent
ARM = 'https://management.azure.com'
APP_API = '2024-04-01'
SQL_API = '2025-01-01'
MAX_UPLOAD = 20 * 1024 * 1024
MAX_TOTAL_UPLOAD = 700 * 1024 * 1024


class SafeFailure(Exception):
    pass


def safe_identifier(value, fallback=None):
    return value if isinstance(value, str) and re.fullmatch(r'[A-Za-z0-9_./:\-]{1,512}', value) else fallback


def sdk_error_summary(error):
    """Only allowlisted SDK metadata. Never exception messages, bodies, or values."""
    output = {'errorType': type(error).__name__}
    status = getattr(error, 'status_code', None)
    if isinstance(status, int):
        output['httpStatus'] = status
    seen = []
    def visit(item, depth=0):
        if item is None or depth > 4 or len(seen) >= 12:
            return
        field = lambda name: item.get(name) if isinstance(item, dict) else getattr(item, name, None)
        code, target = safe_identifier(field('code')), safe_identifier(field('target'))
        if code or target:
            seen.append({**({'code': code} if code else {}), **({'target': target} if target else {})})
        details = field('details')
        if isinstance(details, (list, tuple)):
            for detail in details:
                visit(detail, depth + 1)
        visit(field('innererror'), depth + 1)
    visit(getattr(error, 'error', None))
    if seen:
        output['azureErrors'] = seen
    return output


def ensure_allowed_location(policy, location):
    parameters = policy.get('properties', {}).get('parameters', {})
    parameter = next((value for name, value in parameters.items() if name.lower() in ('allowedlocations', 'listofallowedlocations')), None)
    allowed = parameter.get('value') if isinstance(parameter, dict) else None
    if not isinstance(allowed, list) or not allowed or any(not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9 ]{2,50}', value) for value in allowed):
        raise SafeFailure('The sys.regionrestriction allowed locations could not be verified. Stop for policy review.')
    normalize = lambda value: re.sub(r'[^a-z0-9]', '', value.lower())
    if normalize(location) not in {normalize(value) for value in allowed}:
        raise SafeFailure('The selected resource region is blocked by sys.regionrestriction. Allowed locations: ' + ', '.join(allowed))
    return allowed


def verify_owned_group_reference(manager, rg, reference, plan, server_name):
    expected = {'subscriptionId': plan['subscriptionId'], 'resourceGroup': rg, 'siteName': plan['siteName'], 'sqlServerName': server_name, 'databaseName': plan['databaseName']}
    if not isinstance(reference, dict) or reference.get('ready') is not False or any(not isinstance(reference.get(key), str) or reference[key].lower() != value.lower() for key, value in expected.items()):
        raise SafeFailure('The failed-deployment reference does not match this exact unfinished stack.')
    prefix = '/subscriptions/' + plan['subscriptionId'] + '/resourceGroups/' + rg
    for key, value in {'siteId': prefix + '/providers/Microsoft.Web/sites/' + plan['siteName'], 'databaseId': prefix + '/providers/Microsoft.Sql/servers/' + server_name + '/databases/' + plan['databaseName']}.items():
        if key in reference and (not isinstance(reference[key], str) or reference[key].lower() != value.lower()):
            raise SafeFailure('A saved resource identifier does not match the reviewed unfinished stack.')
    group = manager.resource_groups.get(rg)
    tags = group.tags or {}
    if tags.get('app') != 'classnest' or tags.get('dataMode') != 'azure-sql-v1':
        raise SafeFailure('The resource group is not tagged as this Classnest Azure SQL deployment.')
    old_location = reference.get('resourceGroupLocation', reference.get('location'))
    normalize = lambda value: re.sub(r'[^a-z0-9]', '', value.lower()) if isinstance(value, str) else ''
    if not old_location or normalize(group.location) != normalize(old_location):
        raise SafeFailure('The resource group metadata location does not match its failed-deployment reference.')
    return group


def verify_empty_group_resume(manager, rg, reference, plan, server_name):
    group = verify_owned_group_reference(manager, rg, reference, plan, server_name)
    if next(iter(manager.resources.list_by_resource_group(rg)), None) is not None:
        raise SafeFailure('The target group is not empty. Stop for resource ownership/state reconciliation.')
    if next(iter(manager.deployments.list_by_resource_group(rg)), None) is not None:
        raise SafeFailure('The target group contains a deployment record. Stop for state reconciliation.')
    return group.location


def verify_provisioning_resume(manager, arm, rg, reference, plan, server_name, entra_admin_object_id):
    """Accept only the reviewed failure before app/database creation or bootstrap."""
    group = verify_owned_group_reference(manager, rg, reference, plan, server_name)
    prefix = '/subscriptions/' + plan['subscriptionId'] + '/resourceGroups/' + rg
    plan_id = prefix + '/providers/Microsoft.Web/serverfarms/' + plan['siteName'] + '-free'
    server_id = prefix + '/providers/Microsoft.Sql/servers/' + server_name
    master_id = server_id + '/databases/master'
    allowed = {value.lower() for value in (plan_id, server_id, master_id)}
    found = {resource.id.lower() for resource in manager.resources.list_by_resource_group(rg)}
    if not {plan_id.lower(), server_id.lower()}.issubset(found) or not found.issubset(allowed):
        raise SafeFailure('Provisioning resume allows only the exact F1 plan, SQL server, and system master database; stop for reconciliation.')
    deployments = list(manager.deployments.list_by_resource_group(rg))
    if len(deployments) != 1 or deployments[0].name != 'classnest-free-live' or getattr(deployments[0].properties, 'provisioning_state', None) != 'Failed':
        raise SafeFailure('Provisioning resume requires only the exact failed classnest-free-live deployment record.')
    existing_plan = arm('GET', plan_id, version=APP_API)
    existing_server = arm('GET', server_id, version=SQL_API)
    normalize = lambda value: re.sub(r'[^a-z0-9]', '', value.lower()) if isinstance(value, str) else ''
    for resource in (existing_plan, existing_server):
        if resource.get('tags', {}).get('app') != 'classnest' or resource.get('tags', {}).get('dataMode') != 'azure-sql-v1' or normalize(resource.get('location')) != normalize(plan['location']):
            raise SafeFailure('Existing plan/server ownership tags or resource regions do not match the reviewed partial stack.')
    if existing_plan.get('sku', {}).get('name') != 'F1' or existing_plan.get('sku', {}).get('tier') != 'Free' or existing_plan.get('properties', {}).get('reserved') is not True:
        raise SafeFailure('The existing hosting plan is not the reviewed Free Linux F1 plan.')
    if existing_plan.get('properties', {}).get('numberOfSites', 0) != 0:
        raise SafeFailure('The existing plan already hosts an app; this bounded resume does not apply.')
    props = existing_server.get('properties', {})
    if props.get('administratorLogin') != 'classnest_bootstrap' or props.get('minimalTlsVersion') != '1.2' or props.get('publicNetworkAccess') != 'Enabled':
        raise SafeFailure('The existing SQL server authentication/TLS/network settings do not match the reviewed partial stack.')
    administrator = arm('GET', server_id + '/administrators/ActiveDirectory', version=SQL_API).get('properties', {})
    if str(administrator.get('sid', '')).lower() != entra_admin_object_id.lower() or str(administrator.get('tenantId', '')).lower() != plan['tenantId'].lower():
        raise SafeFailure('The existing SQL server Entra administrator does not match the reviewed user and tenant.')
    databases = arm('GET', server_id + '/databases', version=SQL_API).get('value', [])
    if len(databases) != 1 or databases[0].get('id', '').lower() != master_id.lower():
        raise SafeFailure('The SQL server contains a database other than system master; do not overwrite or re-import it.')
    if arm('GET', server_id + '/firewallRules', version=SQL_API).get('value', []):
        raise SafeFailure('The SQL server already has firewall rules; bootstrap/provisioning state needs reconciliation.')
    if arm('GET', server_id + '/privateEndpointConnections', version=SQL_API).get('value', []):
        raise SafeFailure('The SQL server has an unexpected private endpoint connection.')
    return group.location


def template_without_existing_infrastructure(template):
    """Reference the verified existing infrastructure; do not PUT it or reset auth."""
    result = copy.deepcopy(template)
    retained = {'microsoft.web/serverfarms', 'microsoft.sql/servers'}
    result['resources'] = [resource for resource in result['resources'] if resource['type'].lower() not in retained]
    for resource in result['resources']:
        dependencies = resource.get('dependsOn', [])
        if any(not isinstance(value, str) for value in dependencies):
            raise SafeFailure('Unexpected dependency shape in the compiled deployment template.')
        resource['dependsOn'] = [value for value in dependencies if not any("resourceid('" + kind + "'" in value.lower() for kind in retained)]
    for name in ('sqlAdminPassword', 'sqlAdminLogin', 'entraAdminObjectId', 'entraAdminLogin', 'tenantId'):
        result['parameters'].pop(name, None)
    return result


def wait_for_database(probe, authorize_ip, *, timeout=240, poll_seconds=5):
    deadline = time.monotonic() + timeout
    transient = {'40615', '40613', '40197', '40501', '49918', '49919', '49920', '18456', 'ETIMEOUT', 'ESOCKET', 'ECONNRESET', 'ECONNREFUSED', 'PROBE_TIMEOUT'}
    last_code = 'PROBE_NOT_READY'
    authorized = set()
    while time.monotonic() < deadline:
        result = probe(max(1, min(120, int(deadline - time.monotonic()))))
        if isinstance(result, dict) and result.get('ok') is True:
            return
        last_code = str(result.get('code', 'PROBE_FAILED')) if isinstance(result, dict) else 'PROBE_FAILED'
        last_code = safe_identifier(last_code, 'PROBE_FAILED')
        if last_code == '40615' and result.get('clientIp'):
            try:
                address = str(ipaddress.IPv4Address(result['clientIp']))
            except ValueError:
                raise SafeFailure('The SQL firewall probe returned an invalid client address.') from None
            if address == '0.0.0.0':
                raise SafeFailure('A broad Azure-services firewall exception is prohibited.')
            if address not in authorized:
                authorize_ip(address)
                authorized.add(address)
                say('Temporary exact-client firewall exception set; waiting for SQL/Entra propagation.')
        elif last_code not in transient:
            raise SafeFailure('The Entra SQL bootstrap probe stopped (' + last_code + '). The site remains restricted.')
        time.sleep(min(poll_seconds, max(0, deadline - time.monotonic())))
    raise SafeFailure('SQL/Entra bootstrap readiness did not complete within the bounded wait (' + last_code + '). The site remains restricted.')


def say(message):
    print(message, flush=True)


def command(args, *, env=None, stdin=None, timeout=180):
    executable = shutil.which(args[0], path=(env or os.environ).get('PATH'))
    if not executable:
        raise SafeFailure(f'Required deployment tool is unavailable: {Path(args[0]).name}')
    args = [executable, *args[1:]]
    result = subprocess.run(args, cwd=PROJECT, env=env, input=stdin,
                            capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        # CLI/driver diagnostics can contain request bodies. Never print them.
        raise SafeFailure(f'{Path(args[0]).name} {args[1]} failed; inspect the resource status in Azure Portal. No paid fallback was attempted.')
    return result.stdout


def load_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def validate_template(template):
    resources = template.get('resources', [])
    plans = [r for r in resources if r['type'].lower() == 'microsoft.web/serverfarms']
    databases = [r for r in resources if r['type'].lower() == 'microsoft.sql/servers/databases']
    sites = [r for r in resources if r['type'].lower() == 'microsoft.web/sites']
    allowed = {'microsoft.web/serverfarms', 'microsoft.sql/servers', 'microsoft.sql/servers/databases', 'microsoft.web/sites', 'microsoft.web/sites/basicpublishingcredentialspolicies'}
    if len(plans) != 1 or len(databases) != 1 or len(sites) != 1 or any(r['type'].lower() not in allowed for r in resources):
        raise SafeFailure('Unexpected resources in the deployment template.')
    if plans[0]['sku'].get('name') != 'F1' or plans[0]['sku'].get('tier') != 'Free':
        raise SafeFailure('Only the F1 Free web plan is allowed.')
    props = databases[0]['properties']
    if props.get('useFreeLimit') is not True or props.get('freeLimitExhaustionBehavior') != 'AutoPause' or props.get('maxSizeBytes', 2**40) > 34359738368:
        raise SafeFailure('The database must pause at its free allowance and stay within 32 GiB.')
    if props.get('requestedBackupStorageRedundancy') != 'Local' or props.get('zoneRedundant') is not False:
        raise SafeFailure('Unexpected database redundancy configuration.')
    if 'autoPauseDelay' in props or 'minCapacity' in props:
        raise SafeFailure('The free AutoPause database must use platform defaults for idle delay and minimum capacity.')
    config = sites[0]['properties']['siteConfig']
    if config.get('ipSecurityRestrictionsDefaultAction') != 'Deny' or config.get('scmIpSecurityRestrictionsUseMain') is not False:
        raise SafeFailure('The site must stay closed to visitors during migration.')
    for key in ('sqlAdminPassword', 'appSqlPassword'):
        param = template['parameters'].get(key, {})
        if param.get('type', '').lower() != 'securestring' or 'defaultValue' in param:
            raise SafeFailure('Database passwords must be secure parameters without defaults.')


def validate_inputs(plan, args):
    required = ['subscriptionId', 'tenantId', 'resourceGroup', 'siteName', 'location', 'databaseName']
    if any(not isinstance(plan.get(k), str) or not plan[k] for k in required):
        raise SafeFailure('The nonsecret deployment plan is incomplete.')
    if plan.get('webTier') != 'F1' or plan.get('databaseUseFreeLimit') is not True or plan.get('databaseFreeLimitExhaustionBehavior') != 'AutoPause':
        raise SafeFailure('The plan must explicitly request F1 and free SQL with AutoPause.')
    for key in ('subscriptionId', 'tenantId'):
        if not re.fullmatch(r'[0-9a-fA-F-]{36}', plan[key]):
            raise SafeFailure(f'Invalid {key}.')
    if not re.fullmatch(r'[a-z][a-z0-9-]{2,48}[a-z0-9]', plan['siteName']):
        raise SafeFailure('Use a simple lowercase site name, 4–50 characters.')
    if not re.fullmatch(r'[a-zA-Z0-9_.-]{2,80}', plan['resourceGroup']):
        raise SafeFailure('Use a simple resource group name.')
    if not re.fullmatch(r'[a-z0-9]{2,30}', plan['location']):
        raise SafeFailure('Use an Azure location code, such as southeastasia.')
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,60}', plan['databaseName']):
        raise SafeFailure('Use a simple database name.')
    if not re.fullmatch(r'[0-9a-fA-F-]{36}', args.entra_admin_object_id or ''):
        raise SafeFailure('The reviewed current-user Entra object ID is required.')
    server = args.sql_server or plan['siteName'] + '-sql'
    if not re.fullmatch(r'[a-z][a-z0-9-]{2,58}[a-z0-9]', server):
        raise SafeFailure('Use a simple SQL server name, 4–60 characters.')
    return server


def validate_code_zip(file):
    with zipfile.ZipFile(file) as bundle:
        names = bundle.namelist()
        for name in names:
            path = Path(name)
            if name.startswith(('/', '\\')) or '..' in path.parts or '\\' in name or any(p in ('data', 'work', 'node_modules', '.env') for p in path.parts) or name.endswith(('.sqlite', '.sqlite-wal', '.sqlite-shm')):
                raise SafeFailure('The code ZIP must not include private data, credentials, dependencies, or unsafe paths.')
        if not {'server.js', 'db-adapter.js', 'schema/azure-sql.sql', 'package.json', 'package-lock.json', 'public/index.html'}.issubset(set(names)):
            raise SafeFailure('The ZIP must contain the Azure-ready code at its root, including its adapter and schema.')


def upload_files(directory):
    items = []
    for file in Path(directory).resolve().iterdir():
        if file.is_symlink() or not file.is_file() or not re.fullmatch(r'[-a-f0-9]{36}\.(pdf|txt|md|docx|pptx|xlsx|png|jpg|jpeg|webp)', file.name):
            raise SafeFailure('The private upload folder must contain only generated attachment filenames.')
        if file.stat().st_size > MAX_UPLOAD:
            raise SafeFailure('A migrated attachment exceeds 20 MiB.')
        items.append(file)
    if sum(f.stat().st_size for f in items) > MAX_TOTAL_UPLOAD:
        raise SafeFailure('Migrated attachments exceed the 700 MiB cap.')
    return sorted(items)


def validate_migration(path, attachments):
    manifest = load_json(path)
    if manifest.get('format') != 'classnest-portable-v1' or not isinstance(manifest.get('tables'), dict) or not manifest['tables'].get('users'):
        raise SafeFailure('Use the reviewed portable migration export with the existing owner account.')
    if any(key in manifest['tables'] for key in ('sessions', 'auth_failures')):
        raise SafeFailure('Browser sessions and login-failure state must not be migrated.')
    records = manifest.get('files', [])
    expected = {record.get('name'): record for record in records}
    if len(expected) != len(records) or set(expected) != {file.name for file in attachments}:
        raise SafeFailure('The private attachment folder and migration manifest do not match.')
    for file in attachments:
        record = expected[file.name]
        if record.get('size') != file.stat().st_size or record.get('sha256') != hashlib.sha256(file.read_bytes()).hexdigest():
            raise SafeFailure('An attachment failed its pre-migration size/hash check.')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', required=True, help='Reviewed nonsecret plan JSON')
    parser.add_argument('--entra-admin-object-id', required=True)
    parser.add_argument('--sql-server')
    parser.add_argument('--code-zip')
    parser.add_argument('--migration-file')
    parser.add_argument('--uploads-dir')
    parser.add_argument('--apply', action='store_true', help='Use only after the concrete plan/access changes have been approved')
    parser.add_argument('--resume-empty-group', action='store_true', help='Resume only the exact saved, tagged group with no resources or deployment records')
    parser.add_argument('--resume-provisioning', action='store_true', help='Resume only the reviewed failed deployment with its exact F1 plan/SQL server/master and no app/data')
    parser.add_argument('--validate-template-only', action='store_true')
    args = parser.parse_args()
    if args.resume_empty_group and args.resume_provisioning:
        raise SafeFailure('Choose only one exact resume mode.')
    plan = load_json(args.plan)
    server_name = validate_inputs(plan, args)
    template = load_json(HERE / 'free-app.json')
    validate_template(template)
    if args.validate_template_only:
        say('Local template policy checks passed: F1, free SQL AutoPause, 32 GiB, secure parameters, migration access restriction.')
        return
    # Imports are deliberately delayed so local template checks need no Azure SDK.
    from azure.identity import AzureCliCredential
    from azure.mgmt.resource import ResourceManagementClient
    logging.getLogger('azure').setLevel(logging.CRITICAL)
    account = json.loads(command(['az', 'account', 'show', '--output', 'json']))
    if account.get('id', '').lower() != plan['subscriptionId'].lower() or account.get('tenantId', '').lower() != plan['tenantId'].lower() or account.get('state') != 'Enabled':
        raise SafeFailure('The active Azure CLI account does not match the reviewed active subscription and tenant.')
    if account.get('user', {}).get('type') != 'user':
        raise SafeFailure('Use the reviewed signed-in user, not an unreviewed service principal.')
    credential = AzureCliCredential(tenant_id=plan['tenantId'])
    manager = ResourceManagementClient(credential, plan['subscriptionId'])
    sub = '/subscriptions/' + plan['subscriptionId']
    rg = plan['resourceGroup']
    location = plan['location']
    site = plan['siteName']
    rg_path = sub + '/resourceGroups/' + rg
    site_path = rg_path + '/providers/Microsoft.Web/sites/' + site
    server_path = rg_path + '/providers/Microsoft.Sql/servers/' + server_name
    db_path = server_path + '/databases/' + plan['databaseName']
    reference_path = Path(args.plan).resolve().parent / 'classnest-deployment-reference.json'

    def arm(method, resource, body=None, *, version=None):
        url = ARM + resource
        if version:
            url += ('&' if '?' in url else '?') + 'api-version=' + version
        token = credential.get_token('https://management.azure.com/.default').token
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(url, data=data, method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(request, timeout=180) as response:
                content = response.read()
                return json.loads(content) if content else {}
        except urllib.error.HTTPError as error:
            try:
                code = safe_identifier(json.loads(error.read()).get('error', {}).get('code'), 'AzureRequestFailed')
            except Exception:
                code = 'AzureRequestFailed'
            raise SafeFailure(f'Azure request failed ({error.code}, {code}). Check the portal; no paid fallback was attempted.') from None

    policy = arm('GET', sub + '/providers/Microsoft.Authorization/policyAssignments/sys.regionrestriction', version='2024-04-01')
    allowed_locations = ensure_allowed_location(policy, location)
    group_exists = manager.resource_groups.check_existence(rg)
    group_metadata_location = location
    if group_exists:
        if not (args.resume_empty_group or args.resume_provisioning) or not reference_path.is_file():
            raise SafeFailure('The target group already exists. Explicit --resume-empty-group plus its matching failed-deployment reference is required for an empty tagged group.')
        if args.resume_provisioning:
            group_metadata_location = verify_provisioning_resume(manager, arm, rg, load_json(reference_path), plan, server_name, args.entra_admin_object_id)
            template = template_without_existing_infrastructure(template)
        else:
            group_metadata_location = verify_empty_group_resume(manager, rg, load_json(reference_path), plan, server_name)
    elif args.resume_empty_group or args.resume_provisioning:
        raise SafeFailure('The requested resume mode requires its exact previously created group; no new group was created.')
    locations = json.loads(command(['az', 'appservice', 'list-locations', '--sku', 'F1', '--linux-workers-enabled', '--output', 'json']))
    normalize = lambda s: re.sub(r'[^a-z0-9]', '', s.lower())
    if not any(normalize(item.get('name', '')) == normalize(location) for item in locations):
        raise SafeFailure('Linux F1 is not listed in this region. Choose another reviewed region; no paid fallback is allowed.')
    available = arm('POST', sub + '/providers/Microsoft.Web/checknameavailability', {'name': site, 'type': 'Microsoft.Web/sites'}, version=APP_API)
    if not available.get('nameAvailable'):
        raise SafeFailure('The reviewed website name is unavailable; do not silently choose another name.')
    if not args.resume_provisioning:
        available = arm('POST', sub + '/providers/Microsoft.Sql/checkNameAvailability', {'name': server_name, 'type': 'Microsoft.Sql/servers'}, version=SQL_API)
        if not available.get('available'):
            raise SafeFailure('The reviewed SQL server name is unavailable; do not silently choose another name.')
    # Inspect existing free databases without changing unrelated resources.
    servers = arm('GET', sub + '/providers/Microsoft.Sql/servers', version=SQL_API)
    free_databases = []
    for existing in servers.get('value', []):
        dbs = arm('GET', existing['id'] + '/databases', version=SQL_API)
        free_databases += [d for d in dbs.get('value', []) if d.get('properties', {}).get('useFreeLimit') is True]
    if len(free_databases) >= 10 or any(normalize(d['location']) != normalize(location) for d in free_databases):
        raise SafeFailure('Existing free database limits/region conflict with this plan. Stop for review.')
    capabilities = arm('GET', sub + '/providers/Microsoft.Sql/locations/' + location + '/capabilities', version='2023-08-01')
    supported = []
    for version in capabilities.get('supportedServerVersions', []):
        for edition in version.get('supportedEditions', []):
            for level in edition.get('supportedServiceLevelObjectives', []):
                sku = level.get('sku', {})
                if sku.get('name') == 'GP_S_Gen5' and sku.get('capacity') == 2 and level.get('status') in ('Available', 'Default'):
                    supported.append(level)
    if not supported:
        raise SafeFailure('The selected SQL serverless size is not available to this subscription in the reviewed region.')
    say(json.dumps({'mode': 'reviewed-preflight', 'subscriptionId': plan['subscriptionId'], 'resourceGroup': rg, 'location': location, 'resourceGroupMetadataLocation': group_metadata_location, 'resumingVerifiedEmptyGroup': bool(args.resume_empty_group), 'resumingVerifiedProvisioning': bool(args.resume_provisioning), 'policyAllowedLocations': allowed_locations, 'website': site, 'sqlServer': server_name, 'database': plan['databaseName'], 'webTier': 'F1 Free', 'databaseFreeLimit': True, 'freeLimitExhaustionBehavior': 'AutoPause', 'maxDatabaseGiB': 32, 'publicAccessUntilMigration': 'Deny', 'existingResourcesModified': False}, indent=2))
    if not args.apply:
        say('Read-only preflight completed. No resource group, website, database, credential, or firewall rule was created.')
        return
    if not all((args.code_zip, args.migration_file, args.uploads_dir)):
        raise SafeFailure('--apply requires code ZIP, private migration JSON, and private upload folder.')
    validate_code_zip(args.code_zip)
    if not Path(args.migration_file).is_file():
        raise SafeFailure('The private migration export was not found.')
    attachments = upload_files(args.uploads_dir)
    migration = validate_migration(args.migration_file, attachments)
    for module in ('bootstrap-sql.mjs', 'migrate-data.mjs', 'check-database.mjs'):
        if not (PROJECT / 'scripts' / module).is_file():
            raise SafeFailure('The database bootstrap/migration helper is missing.')

    admin_password = None if args.resume_provisioning else 'Aa9!' + secrets.token_urlsafe(42)
    runtime_password = 'Az7!' + secrets.token_urlsafe(42)
    runtime_user = 'classnest_runtime'
    parameters = {key: {'value': value} for key, value in {
        'siteName': site, 'sqlServerName': server_name, 'databaseName': plan['databaseName'], 'location': location,
        'entraAdminObjectId': args.entra_admin_object_id, 'entraAdminLogin': account['user']['name'], 'tenantId': plan['tenantId'],
        'sqlAdminLogin': 'classnest_bootstrap', 'appSqlUser': runtime_user, 'sqlAdminPassword': admin_password, 'appSqlPassword': runtime_password,
    }.items() if key in template['parameters']}
    reference = {'subscriptionId': plan['subscriptionId'], 'resourceGroup': rg, 'location': location, 'resourceGroupLocation': group_metadata_location, 'siteName': site, 'sqlServerName': server_name, 'databaseName': plan['databaseName'], 'ready': False}
    temp_firewall = None
    opened_to_visitors = False
    try:
        say('Creating the new resource group and exact free-tier resources. The website stays closed to visitors.')
        for namespace in ('Microsoft.Web', 'Microsoft.Sql'):
            if manager.providers.get(namespace).registration_state != 'Registered':
                manager.providers.register(namespace)
                for _ in range(60):
                    if manager.providers.get(namespace).registration_state == 'Registered':
                        break
                    time.sleep(5)
                else:
                    raise SafeFailure('The required resource provider did not finish registering; no paid fallback was attempted.')
        # Recheck immediately before mutation, and never rewrite a resumed group's
        # metadata location when its app/database resource region has changed.
        if group_exists:
            if args.resume_provisioning:
                verify_provisioning_resume(manager, arm, rg, load_json(reference_path), plan, server_name, args.entra_admin_object_id)
            else:
                verify_empty_group_resume(manager, rg, load_json(reference_path), plan, server_name)
        else:
            if manager.resource_groups.check_existence(rg):
                raise SafeFailure('The target group appeared after preflight. Stop for ownership review.')
            manager.resource_groups.create_or_update(rg, {'location': location, 'tags': {'app': 'classnest', 'dataMode': 'azure-sql-v1'}})
        reference_path.write_text(json.dumps(reference, indent=2), encoding='utf-8')
        deployment = {'properties': {'mode': 'Incremental', 'template': template, 'parameters': parameters}}
        manager.deployments.begin_validate(rg, 'classnest-free-validation', deployment).result()
        manager.deployments.begin_create_or_update(rg, 'classnest-free-live', deployment).result()
        # The strong values are never written to the nonsecret reference file.
        parameters.clear()
        admin_password = None
        database = arm('GET', db_path, version=SQL_API)
        props = database['properties']
        if props.get('useFreeLimit') is not True or props.get('freeLimitExhaustionBehavior') != 'AutoPause' or props.get('maxSizeBytes', 2**40) > 34359738368:
            raise SafeFailure('Azure did not return the required free/AutoPause database state. The site remains restricted.')
        plan_state = arm('GET', rg_path + '/providers/Microsoft.Web/serverfarms/' + site + '-free', version=APP_API)
        if plan_state.get('sku', {}).get('name') != 'F1':
            raise SafeFailure('Unexpected web plan tier. The site remains restricted; inspect the portal.')
        app = arm('GET', site_path, version=APP_API)
        outbound = [str(ipaddress.IPv4Address(ip.strip())) for ip in app.get('properties', {}).get('outboundIpAddresses', '').split(',') if ip.strip()]
        if not outbound or any(ip == '0.0.0.0' for ip in outbound):
            raise SafeFailure('Could not establish exact web app outbound IP addresses.')
        for number, address in enumerate(sorted(set(outbound)), start=1):
            arm('PUT', server_path + '/firewallRules/classnest-app-' + str(number), {'properties': {'startIpAddress': address, 'endIpAddress': address}}, version=SQL_API)
        child_env = os.environ.copy()
        for key in ('SQL_USER', 'SQL_PASSWORD', 'AZURE_CLIENT_SECRET', 'AZURE_CLIENT_ID'):
            child_env.pop(key, None)
        child_env.update({'DB_PROVIDER': 'azure-sql', 'SQL_SERVER': server_name + '.database.windows.net', 'SQL_DATABASE': plan['databaseName'], 'CLASSNEST_WORK_DIR': str(Path(args.migration_file).resolve().parent)})
        # The reviewed Entra administrator handles schema creation/import; the app receives DML only.
        node_executable = shutil.which('node', path=child_env.get('PATH'))
        if not node_executable:
            raise SafeFailure('Node.js is unavailable for the reviewed database bootstrap.')
        def probe_database(timeout):
            try:
                result = subprocess.run([node_executable, 'scripts/bootstrap-sql.mjs', '--probe'], cwd=PROJECT, env=child_env, capture_output=True, text=True, timeout=timeout)
            except subprocess.TimeoutExpired:
                return {'ok': False, 'code': 'PROBE_TIMEOUT'}
            try:
                return json.loads(result.stdout.strip().splitlines()[-1])
            except Exception:
                raise SafeFailure('SQL bootstrap probe did not return its sanitized status. The site remains restricted.') from None
        def authorize_bootstrap_ip(address):
            nonlocal temp_firewall
            temp_firewall = server_path + '/firewallRules/classnest-bootstrap-temporary'
            arm('PUT', temp_firewall, {'properties': {'startIpAddress': address, 'endIpAddress': address}}, version=SQL_API)
        wait_for_database(probe_database, authorize_bootstrap_ip)
        say('Initializing the schema, least-privilege database user, and existing class data.')
        command(['node', 'scripts/bootstrap-sql.mjs'], env=child_env, stdin=json.dumps({'appUser': runtime_user, 'appPassword': runtime_password}), timeout=240)
        command(['node', 'scripts/migrate-data.mjs', 'import', str(Path(args.migration_file).resolve())], env=child_env, timeout=300)
        runtime_env = child_env.copy()
        runtime_env.update({'SQL_USER': runtime_user, 'SQL_PASSWORD': runtime_password})
        try:
            checked = json.loads(command(['node', 'scripts/check-database.mjs'], env=runtime_env, timeout=300).strip().splitlines()[-1])
            if checked.get('ok') is not True or checked.get('runtimeWritesVerified') is not True or checked.get('rollbackVerified') is not True:
                raise SafeFailure('Runtime database CRUD/rollback verification did not pass. The site remains restricted.')
        finally:
            runtime_env.pop('SQL_PASSWORD', None)
            runtime_password = None
        say('Deploying Azure-ready code and existing attachments through authenticated deployment APIs. Visitors remain blocked.')
        command(['az', 'webapp', 'deploy', '--resource-group', rg, '--name', site, '--type', 'zip', '--src-path', str(Path(args.code_zip).resolve()), '--restart', 'true', '--output', 'none'], timeout=900)
        # The deployed server creates its persistent upload directory on startup.
        for file in attachments:
            command(['az', 'webapp', 'deploy', '--resource-group', rg, '--name', site, '--type', 'static', '--src-path', str(file), '--target-path', '/home/classnest-data/uploads/' + file.name, '--restart', 'false', '--output', 'none'], timeout=300)
        # Close the bootstrap exception before opening the student website.
        if temp_firewall:
            arm('DELETE', temp_firewall, version=SQL_API)
            temp_firewall = None
        config = arm('GET', site_path + '/config/web', version=APP_API)['properties']
        config['ipSecurityRestrictionsDefaultAction'] = 'Allow'
        config['ipSecurityRestrictions'] = []
        arm('PUT', site_path + '/config/web', {'properties': config}, version=APP_API)
        opened_to_visitors = True
        hostname = arm('GET', site_path, version=APP_API)['properties']['defaultHostName']
        url = 'https://' + hostname
        healthy = False
        for _ in range(30):
            try:
                with urllib.request.urlopen(url + '/api/health', timeout=15) as response:
                    healthy = json.load(response).get('ok') is True
                if healthy:
                    break
            except Exception:
                pass
            time.sleep(5)
        if not healthy:
            raise SafeFailure('Deployment submitted, but the website health check has not passed. Inspect the portal before announcing a live URL.')
        with urllib.request.urlopen(url + '/api/ready', timeout=90) as response:
            if json.load(response).get('ok') is not True:
                raise SafeFailure('The bounded database readiness check did not pass.')
        with urllib.request.urlopen(url + '/api/state', timeout=90) as response:
            state = json.load(response)
        if state.get('needsSetup') is not False:
            raise SafeFailure('The existing owner account was not verified on the hosted website.')
        expected_files = {item['name']: item for item in migration['files']}
        for note in migration['tables'].get('notes', []):
            filename = note.get('filename')
            if not filename:
                continue
            if filename not in expected_files or not re.fullmatch(r'[-a-f0-9]{36}', note.get('id', '')):
                raise SafeFailure('A migrated note does not match the reviewed attachment manifest.')
            digest = hashlib.sha256()
            length = 0
            with urllib.request.urlopen(url + '/api/notes/' + note['id'] + '/download', timeout=90) as response:
                if 'attachment' not in response.headers.get('Content-Disposition', '').lower():
                    raise SafeFailure('A hosted attachment was not served as a download.')
                while True:
                    chunk = response.read(65536)
                    if not chunk:
                        break
                    length += len(chunk)
                    if length > MAX_UPLOAD:
                        raise SafeFailure('A hosted attachment exceeded the expected maximum size.')
                    digest.update(chunk)
            expected = expected_files[filename]
            if length != expected['size'] or digest.hexdigest() != expected['sha256']:
                raise SafeFailure('A hosted attachment failed its post-migration size/hash check.')
        reference.update({'ready': True, 'url': url, 'webTier': 'F1', 'databaseUseFreeLimit': True, 'freeLimitExhaustionBehavior': 'AutoPause', 'attachmentsMigrated': len(attachments)})
        reference_path.write_text(json.dumps(reference, indent=2), encoding='utf-8')
        say(json.dumps({'ready': True, 'url': url, 'ownerAccountMigrated': True, 'attachmentsMigrated': len(attachments), 'freeLimitExhaustionBehavior': 'AutoPause'}))
    finally:
        parameters.clear()
        admin_password = None
        runtime_password = None
        if temp_firewall:
            try:
                arm('DELETE', temp_firewall, version=SQL_API)
                say('Temporary bootstrap firewall exception removed.')
            except Exception:
                say('ACTION REQUIRED: remove classnest-bootstrap-temporary from this new SQL server firewall in Azure Portal.')
        if opened_to_visitors and not reference.get('ready'):
            try:
                config = arm('GET', site_path + '/config/web', version=APP_API)['properties']
                config['ipSecurityRestrictionsDefaultAction'] = 'Deny'
                config['ipSecurityRestrictions'] = []
                arm('PUT', site_path + '/config/web', {'properties': config}, version=APP_API)
                say('The incomplete website was closed to visitors pending review.')
            except Exception:
                say('ACTION REQUIRED: restrict visitor access to the incomplete website in Azure Portal.')


if __name__ == '__main__':
    try:
        main()
    except SafeFailure as error:
        say(str(error))
        sys.exit(1)
    except Exception as error:
        # SDK exception bodies may contain secure request parameters: print neither
        # exception repr nor tracebacks. Portal deployments show safe resource status.
        say('Stopped safely: ' + json.dumps(sdk_error_summary(error)) + '. Review the new resource group/deployment in Azure Portal before retrying. No automatic paid fallback or resource deletion was attempted.')
        sys.exit(1)
