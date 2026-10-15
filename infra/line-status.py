"""Read-only LINE diagnostics inside the existing Cloud SQL migration job.

No database credentials, LINE identifiers, messages, email or signatures are
returned. Does not enqueue, approve, sign, or execute a purchase.
"""
import json
from datetime import datetime, timedelta, timezone
import subprocess
import time
import urllib.request
import uuid

project = 'yours-511602'
region = 'asia-northeast1'
check_id = str(uuid.uuid4())
code = """
import {createDb} from './packages/storage/dist/index.js';
const db=createDb(process.env.DATABASE_URL), tx=await db.connect();
try {
 await tx.query('BEGIN READ ONLY');
 const links=(await tx.query(`SELECT count(*)::int AS total,
 count(*) FILTER(WHERE user_hash IS NOT NULL)::int AS claimed,
 count(*) FILTER(WHERE activated_at IS NOT NULL AND revoked_at IS NULL AND expires_at>now())::int AS active
 FROM line_links`)).rows;
 const events=(await tx.query(`SELECT e.state,e.last_error,e.created_at,e.updated_at,
 e.decision->>'merchant' AS merchant,e.decision->>'title' AS product,
 e.decision->>'quantity' AS quantity,e.decision->>'amount' AS amount,
 i.state AS payment_state,i.transaction_hash,i.reasons,r.settled->>'orderNumber' AS merchant_order,
 (SELECT count(*)::int FROM approvals a WHERE a.intent_id=i.id AND a.line_action_id IS NOT NULL) AS line_approvals
 FROM line_events e LEFT JOIN intents i ON i.id=e.intent_id
 LEFT JOIN ec_reservations r ON r.checkout_id::text=i.checkout_id
 ORDER BY e.created_at DESC LIMIT 10`)).rows;
 const queue=(await tx.query(`SELECT topic,count(*)::int AS pending,
 max(attempts)::int AS max_attempts,max(last_error) AS last_error
 FROM outbox WHERE completed_at IS NULL GROUP BY topic ORDER BY topic`)).rows;
 const messages=(await tx.query(`SELECT count(*)::int AS total,
 count(*) FILTER(WHERE delivered_at IS NOT NULL)::int AS delivered FROM line_messages`)).rows;
 const permissions=(await tx.query(`SELECT c.status,p.document->>'perOrder' AS per_order,
 p.document->>'perPeriod' AS per_period,p.document->'merchants' AS merchants
 FROM connections c JOIN permissions p ON p.connection_id=c.id
 WHERE EXISTS(SELECT 1 FROM line_links l WHERE l.connection_id=c.id AND l.activated_at IS NOT NULL AND l.revoked_at IS NULL)`)).rows;
 await tx.query('ROLLBACK');
 console.log(JSON.stringify({event:'line_status',checkId:CHECK_ID,links,events,queue,messages,permissions}));
} finally {tx.release();await db.end();}
""".replace('CHECK_ID', json.dumps(check_id))
token = subprocess.check_output(['gcloud', 'auth', 'print-access-token', '--project=' + project], text=True).strip()


def call(url, body=None):
    request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
        headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.load(response)


operation = call(f'https://run.googleapis.com/v2/projects/{project}/locations/{region}/jobs/yours-migrate:run',
    {'overrides': {'containerOverrides': [{'args': ['--input-type=module', '-e', code]}]}})
print(json.dumps({'operation': operation['name'], 'checkId': check_id}), flush=True)
for attempt in range(90):
    status = call('https://run.googleapis.com/v2/' + operation['name'])
    if status.get('done'):
        if status.get('error'):
            raise RuntimeError('Read-only diagnostic execution failed')
        break
    time.sleep(2)
else:
    raise RuntimeError('Diagnostic job remains in progress; check the returned operation')
for attempt in range(90):
    since = (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat()
    logs = call('https://logging.googleapis.com/v2/entries:list', {'resourceNames': ['projects/' + project],
        'filter': 'resource.type="cloud_run_job" AND timestamp>="' + since + '" AND jsonPayload.checkId="' + check_id + '"',
        'orderBy': 'timestamp desc', 'pageSize': 1})
    if logs.get('entries'):
        print(json.dumps(logs['entries'][0]['jsonPayload'], ensure_ascii=False))
        break
    time.sleep(2)
else:
    raise RuntimeError('Diagnostic log is not available yet; use checkId to retrieve it')
