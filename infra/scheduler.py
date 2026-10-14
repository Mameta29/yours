"""Ensure a bounded recovery wake-up for the durable payment/webhook outbox.

Uses the existing scheduler identity and private worker invoker binding.
No signing keys, owner credentials, or public endpoint are added.
"""
import subprocess

project, region = 'yours-511602', 'asia-northeast1'
name = 'yours-outbox'
base = ['gcloud', 'scheduler', 'jobs']
scope = ['--project=' + project, '--location=' + region]
existing = subprocess.run(base + ['describe', name, *scope, '--format=value(name)'],
                          capture_output=True, text=True)
if existing.returncode and 'NOT_FOUND' not in existing.stderr:
    raise RuntimeError(existing.stderr)
operation = 'update' if existing.returncode == 0 else 'create'
origin = 'https://yours-worker-110852561536.asia-northeast1.run.app'
subprocess.run(base + [operation, 'http', name, *scope,
    '--schedule=* * * * *', '--time-zone=UTC', '--uri=' + origin + '/run',
    '--http-method=POST', '--headers=Content-Type=application/json', '--message-body={}',
    '--oidc-service-account-email=yours-scheduler@' + project + '.iam.gserviceaccount.com',
    '--oidc-token-audience=' + origin, '--attempt-deadline=180s',
    '--min-backoff=10s', '--max-backoff=300s', '--max-retry-attempts=5',
    '--quiet'], check=True)
