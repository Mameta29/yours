#!/usr/bin/env bash
set -euo pipefail
PROJECT_ID="${PROJECT_ID:-yours-511602}"
REGION="${REGION:-asia-northeast1}"
project_role() {
  gcloud projects add-iam-policy-binding "$PROJECT_ID" --member="serviceAccount:yours-$1@${PROJECT_ID}.iam.gserviceaccount.com" --role="$2" --condition=None --quiet >/dev/null
}
key_role() {
  gcloud kms keys add-iam-policy-binding "$1" --keyring=yours --location="$REGION" --project="$PROJECT_ID" --member="serviceAccount:yours-$2@${PROJECT_ID}.iam.gserviceaccount.com" --role=roles/cloudkms.signerVerifier --quiet >/dev/null
}
for service in api worker mandates migrate; do
  project_role "$service" roles/cloudsql.client
done
project_role agent roles/aiplatform.user
project_role build roles/logging.logWriter
gcloud artifacts repositories add-iam-policy-binding yours --location="$REGION" --project="$PROJECT_ID" --member="serviceAccount:yours-build@${PROJECT_ID}.iam.gserviceaccount.com" --role=roles/artifactregistry.writer --quiet >/dev/null
key_role ucp-merchant api
for key in relayer merchant risk price agent; do key_role "$key" worker; done
for key in ap2-issuer ap2-agent human; do key_role "$key" mandates; done
# Gemini has no KMS role. It calls only the API tools authorized for its user.
for service in api worker mandates; do
  gcloud secrets add-iam-policy-binding yours-db-runtime --project="$PROJECT_ID" --member="serviceAccount:yours-${service}@${PROJECT_ID}.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
done
gcloud secrets add-iam-policy-binding yours-db-migrate --project="$PROJECT_ID" --member="serviceAccount:yours-migrate@${PROJECT_ID}.iam.gserviceaccount.com" --role=roles/secretmanager.secretAccessor --quiet >/dev/null
printf 'Service roles configured for %s. Cloud Run invoker bindings are applied after deployment.\n' "$PROJECT_ID"
