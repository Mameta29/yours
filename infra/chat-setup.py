"""Create the isolated chat worker identity and encryption key, without export.

Only the API and private consent authority can decrypt LINE identities/proofs.
The queue worker has DB access and API invocation, but no KMS/Vertex roles.
The original LINE channel credentials stay in the existing EC deployment.
"""
import base64
import os
import subprocess

PROJECT = 'yours-511602'
SECRET = 'yours-chat-encryption-key'
ACCOUNT = 'yours-chat@' + PROJECT + '.iam.gserviceaccount.com'


def run(*args, **kwargs):
    return subprocess.run(['gcloud', *args, '--project=' + PROJECT, '--quiet'], check=True, **kwargs)


def exists(*args):
    return subprocess.run(['gcloud', *args, '--project=' + PROJECT], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0


if not exists('secrets', 'describe', SECRET):
    run('secrets', 'create', SECRET, '--replication-policy=automatic', stdout=subprocess.DEVNULL)
    run('secrets', 'versions', 'add', SECRET, '--data-file=-', input=base64.b64encode(os.urandom(32)), stdout=subprocess.DEVNULL)
for service in ('api', 'mandates'):
    run('secrets', 'add-iam-policy-binding', SECRET,
        '--member=serviceAccount:yours-' + service + '@' + PROJECT + '.iam.gserviceaccount.com',
        '--role=roles/secretmanager.secretAccessor', stdout=subprocess.DEVNULL)
if not exists('iam', 'service-accounts', 'describe', ACCOUNT):
    run('iam', 'service-accounts', 'create', 'yours-chat', '--display-name=yours chat queue', stdout=subprocess.DEVNULL)
run('projects', 'add-iam-policy-binding', PROJECT, '--member=serviceAccount:' + ACCOUNT,
    '--role=roles/cloudsql.client', '--condition=None', stdout=subprocess.DEVNULL)
run('secrets', 'add-iam-policy-binding', 'yours-db-runtime', '--member=serviceAccount:' + ACCOUNT,
    '--role=roles/secretmanager.secretAccessor', stdout=subprocess.DEVNULL)
print('Chat identity and resource-specific secret bindings configured; no secret values printed.')
