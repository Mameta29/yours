"""Restrict the dedicated runtime user through the existing migration job.

No credentials are fetched locally. Cloud Run uses its migration-only secret.
The statements are also part of infra/migrate.mjs for subsequent migrations.
"""
import subprocess
import json
import urllib.request

code = """
import {createDb,transaction} from './packages/storage/dist/index.js';
const db=createDb(process.env.DATABASE_URL);
try {
 await transaction(db,async tx=>{
  await tx.query('GRANT yours_app TO yours_runtime');
  await tx.query('REVOKE cloudsqlsuperuser FROM yours_runtime');
  await tx.query('ALTER ROLE yours_runtime NOCREATEDB NOCREATEROLE');
  const {rows:[role]}=await tx.query("SELECT rolcreatedb,rolcreaterole,rolsuper,pg_has_role('yours_runtime','cloudsqlsuperuser','member') AS admin_member FROM pg_roles WHERE rolname='yours_runtime'");
  if(!role||role.rolcreatedb||role.rolcreaterole||role.rolsuper||role.admin_member)throw new Error('runtime_role_not_restricted');
  console.log(JSON.stringify({event:'runtime_role_restricted',...role}));
 });
} finally {await db.end();}
"""
token = subprocess.check_output(['gcloud','auth','print-access-token','--project=yours-511602'], text=True).strip()
request = urllib.request.Request(
    'https://run.googleapis.com/v2/projects/yours-511602/locations/asia-northeast1/jobs/yours-migrate:run',
    method='POST', data=json.dumps({'overrides': {'containerOverrides': [{'args': ['--input-type=module', '-e', code]}]}}).encode(),
    headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'},
)
with urllib.request.urlopen(request, timeout=30) as response:
    result = json.load(response)
    print(json.dumps({'operation': result['name']}))
