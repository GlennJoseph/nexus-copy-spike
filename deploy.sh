#!/bin/bash
# deploy.sh
#
# Deploys the nexus-copy-service service to Cloud Run.
# Run this from inside the project folder: ./deploy.sh
#
# Before running: fill in PROJECT_ID and REGION below, and make sure
# the two secrets already exist in Secret Manager (service-api-key,
# perplexity-api-key). See DEPLOY.md for how to create them.

set -e  # stop immediately if any command fails

PROJECT_ID="${PROJECT_ID:-tcdeph-mm-nexus}"
REGION="australia-southeast1"
SERVICE_NAME="nexus-copy-service"

echo "Deploying $SERVICE_NAME to project $PROJECT_ID in $REGION..."

gcloud config set project "$PROJECT_ID"

gcloud run deploy "$SERVICE_NAME" \
  --source . \
  --region "$REGION" \
  --allow-unauthenticated \
  --max-instances=3 \
  --timeout=90 \
  --memory=1Gi \
  --set-secrets=SERVICE_API_KEY=service-api-key:latest,PERPLEXITY_API_KEY=perplexity-api-key:latest

echo "Deploy finished. Test with:"
echo "curl \$(gcloud run services describe $SERVICE_NAME --region $REGION --format 'value(status.url)')/health"