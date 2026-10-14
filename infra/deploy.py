"""Deploy yours services with fixed identities and Secret Manager references.

No secret values are read, embedded in YAML, or printed by this script.
Usage: python3 infra/deploy.py --tag payments-20261014
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--tag', required=True)
parser.add_argument('--migrate-only', action='store_true')
parser.add_argument('--public', action='store_true', help='Expose only the API/console; all private services retain IAM')
args = parser.parse_args()
project, region = 'yours-511602', 'asia-northeast1'
number = '110852561536'
base = f'{region}-docker.pkg.dev/{project}/yours/'
manifest = json.loads(Path('deployments/amoy.json').read_text())
key = f'projects/{project}/locations/{region}/keyRings/yours/cryptoKeys/'
origin = f'https://yours-api-{number}.{region}.run.app'
mandates_url = f'https://yours-mandates-{number}.{region}.run.app'

def gcloud(*arguments, capture=False):
    command = ['gcloud', *arguments, '--project=' + project, '--region=' + region]
    if capture:
        return subprocess.check_output(command, text=True).strip()
    subprocess.run(command, check=True)


def env_file(values):
    # gcloud accepts JSON as YAML. The file holds public configuration only.
    file = tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False)
    json.dump({name: str(value) for name, value in values.items()}, file)
    file.close()
    return Path(file.name)


gcloud('run', 'jobs', 'update', 'yours-migrate', '--image=' + base + 'api:' + args.tag)
gcloud('run', 'jobs', 'execute', 'yours-migrate', '--wait')
if args.migrate_only:
    raise SystemExit(0)
common = {'CHAIN_ID': 80002, 'GATE_ADDRESS': manifest['gate'], 'PUBLIC_ORIGIN': origin}
ec_merchants = json.dumps(json.loads(Path('deployments/ec-merchants-amoy.json').read_text()))
services = {
    'mandates': {
        'ENVIRONMENT': 'production', **common,
        'AP2_ISSUER_KEY': key + 'ap2-issuer/cryptoKeyVersions/1',
        'AP2_AGENT_KEY': key + 'ap2-agent/cryptoKeyVersions/1',
        'HUMAN_KEY': key + 'human/cryptoKeyVersions/1',
        'MERCHANT_PUBLIC_JWK': json.dumps(manifest['merchantPublicJwk']),
    },
    'agent': {
        'ENVIRONMENT': 'production', 'GOOGLE_GENAI_USE_VERTEXAI': 'true',
        'GOOGLE_CLOUD_PROJECT': project, 'GOOGLE_CLOUD_LOCATION': 'global',
        'GEMINI_MODEL': 'gemini-3.8-flash', 'YOURS_API_ORIGIN': origin,
    },
    'api': {
        'NODE_ENV': 'production', **common,
        'EC_MERCHANTS_JSON': ec_merchants,
        'RPC_URL': 'https://polygon-amoy-bor-rpc.publicnode.com',
        'JPYC_ADDRESS': manifest['jpyc'], 'AGENT_ADDRESS': manifest['addresses']['agent'],
        'MERCHANT_ID': 'yours-lab', 'MERCHANT_NAME': 'yours Market',
        'MERCHANT_PAY_TO': manifest['addresses']['merchant'],
        'AGENT_URL': f'https://yours-agent-{number}.{region}.run.app',
        'WORKER_URL': f'https://yours-worker-{number}.{region}.run.app',
        'WORKER_IDENTITY': f'yours-worker@{project}.iam.gserviceaccount.com',
        'UCP_SIGNING_KEY': key + 'ucp-merchant/cryptoKeyVersions/1', 'MANDATES_URL': mandates_url,
    },
    'worker': {
        'NODE_ENV': 'production', **common,
        'EC_MERCHANTS_JSON': ec_merchants,
        'RPC_URL': 'https://polygon-amoy-bor-rpc.publicnode.com',
        'MERCHANT_ID': 'yours-lab', 'MERCHANT_PAY_TO': manifest['addresses']['merchant'],
        'MANDATES_URL': mandates_url,
        **{role.upper() + '_KEY': key + role + '/cryptoKeyVersions/1' for role in ('relayer', 'agent', 'merchant', 'risk')},
    },
}
for service, values in services.items():
    env = env_file(values)
    try:
        arguments = ['run', 'deploy', 'yours-' + service,
            '--image=' + base + (service if service in ('mandates','agent') else 'api') + ':' + args.tag,
            '--service-account=yours-' + service + '@' + project + '.iam.gserviceaccount.com',
            '--env-vars-file=' + str(env), '--allow-unauthenticated' if service=='api' and args.public else '--no-allow-unauthenticated',
            '--min-instances=0', '--max-instances=2' if service=='api' else '--max-instances=1', '--concurrency=40' if service=='api' else '--concurrency=4' if service=='agent' else '--concurrency=1',
            '--cpu=1', '--memory=1Gi' if service=='agent' else '--memory=512Mi', '--timeout=180', '--quiet']
        if service != 'agent':
            arguments += ['--add-cloudsql-instances=' + project + ':' + region + ':yours-db', '--set-secrets=DATABASE_URL=yours-db-runtime:latest']
        if service == 'worker':
            arguments += ['--command=node', '--args=services/worker/dist/server.js']
        gcloud(*arguments)
    finally:
        env.unlink()
    print(json.dumps({'service': service, 'url': gcloud('run', 'services', 'describe', 'yours-' + service, '--format=value(status.url)', capture=True)}))

for source, target in [('api','mandates'), ('api','agent'), ('api','worker'), ('worker','mandates'), ('scheduler','worker')]:
    gcloud('run', 'services', 'add-iam-policy-binding', 'yours-' + target,
        '--member=serviceAccount:yours-' + source + '@' + project + '.iam.gserviceaccount.com', '--role=roles/run.invoker', '--quiet')
