"""Read-only Cloud Run checks; tokens are kept in memory and never logged."""
import json
import subprocess
import urllib.request
import urllib.error
from pathlib import Path

project='yours-511602'
token=subprocess.check_output(['gcloud','auth','print-identity-token','--project='+project],text=True).strip()
results=[]
for service in ('api','mandates','worker','agent','chat'):
    origin=f'https://yours-{service}-110852561536.asia-northeast1.run.app'
    try:
        urllib.request.urlopen(origin+'/health',timeout=60)
        private=False
    except urllib.error.HTTPError as error:
        private=error.code in (401,403)
    request=urllib.request.Request(origin+'/health',headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(request,timeout=90) as response:
        health=json.load(response)
    assert health['ok'] and (private if service!='api' else not private)
    result={'service':service,'url':origin,'private':private,'health':health}
    if service=='api':
        for path in ('/ready','/.well-known/ucp'):
            with urllib.request.urlopen(urllib.request.Request(origin+path,headers={'Authorization':'Bearer '+token}),timeout=90) as response:
                data=json.load(response)
            if path=='/ready':
                assert data['ok']
                result['databaseReady']=True
            else:
                assert data['ucp']['version']=='2026-08-25'
                expected=json.loads(Path('deployments/amoy.json').read_text())['merchantPublicJwk']
                assert data['keys']==[expected]
                result['discoveryKeyMatchesDeployedHsm']=True
    results.append(result)
Path('docs/evidence/cloud-services.json').write_text(json.dumps({'project':project,'scope':'Public API/console; private AP2, settlement worker, LINE chat worker and Gemini health; live Cloud SQL access and discovery HSM key binding. Amoy purchase is separate evidence.','services':results},indent=2)+'\n')
print(json.dumps({'passed':len(results),'evidence':'docs/evidence/cloud-services.json'}))
