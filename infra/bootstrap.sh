#!/usr/bin/env bash
set -euo pipefail

# Run against the explicitly selected project; never changes gcloud's defaults.
PROJECT_ID="${PROJECT_ID:-yours-511602}"
REGION="${REGION:-asia-northeast1}"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com cloudkms.googleapis.com secretmanager.googleapis.com aiplatform.googleapis.com cloudtasks.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com iamcredentials.googleapis.com modelarmor.googleapis.com --project="$PROJECT_ID"

if ! gcloud artifacts repositories describe yours --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud artifacts repositories create yours --repository-format=docker --location="$REGION" --project="$PROJECT_ID"
fi
for role in api worker mandates agent build scheduler migrate; do
  account="yours-${role}@${PROJECT_ID}.iam.gserviceaccount.com"
  if ! gcloud iam service-accounts describe "$account" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud iam service-accounts create "yours-${role}" --display-name="yours ${role}" --project="$PROJECT_ID"
  fi
done
if ! gcloud kms keyrings describe yours --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud kms keyrings create yours --location="$REGION" --project="$PROJECT_ID"
fi
for name in relayer merchant risk human price agent; do
  if ! gcloud kms keys describe "$name" --keyring=yours --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud kms keys create "$name" --keyring=yours --location="$REGION" --purpose=asymmetric-signing --default-algorithm=ec-sign-secp256k1-sha256 --protection-level=hsm --project="$PROJECT_ID"
  fi
done
for name in ap2-issuer ap2-agent ucp-merchant; do
  if ! gcloud kms keys describe "$name" --keyring=yours --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
    gcloud kms keys create "$name" --keyring=yours --location="$REGION" --purpose=asymmetric-signing --default-algorithm=ec-sign-p256-sha256 --protection-level=hsm --project="$PROJECT_ID"
  fi
done
if ! gcloud sql instances describe yours-db --project="$PROJECT_ID" >/dev/null 2>&1; then
  gcloud sql instances create yours-db --database-version=POSTGRES_16 --edition=ENTERPRISE --tier=db-f1-micro --region="$REGION" --storage-size=10GB --storage-type=SSD --backup-start-time=19:00 --enable-point-in-time-recovery --retained-backups-count=7 --deletion-protection --project="$PROJECT_ID" --async
fi
