# Deploying the spike

This assumes the two secrets from Phase 1 already exist in your project
(`service-api-key`, `perplexity-api-key`). If this is a fresh project instead,
create them first:

```bash
echo -n "some-long-random-string" | gcloud secrets create service-api-key --data-file=-
echo -n "YOUR_MM_PERPLEXITY_KEY" | gcloud secrets create perplexity-api-key --data-file=-
```

## Deploy

From inside this folder:

```bash
gcloud run deploy nexus-copy-spike \
  --source . \
  --region australia-southeast1 \
  --allow-unauthenticated \
  --set-secrets=SERVICE_API_KEY=service-api-key:latest,PERPLEXITY_API_KEY=perplexity-api-key:latest
```

Notes:
- `--allow-unauthenticated` here means Cloud Run's own IAM layer doesn't
  gate requests — your app-level `X-API-Key` check still does. That's the
  same posture as the Phase 1 skeleton. Tighten with `--no-allow-unauthenticated`
  plus IAM later if you want defense in depth.
- No region preference recorded from you yet — `australia-southeast1` is a
  guess given MM/Narta are AU-based. Swap if you want it elsewhere.
- This deliberately does NOT hardcode a project ID anywhere in the code or
  Dockerfile, per the "keep it portable, might migrate GCP org" note.

## Test

```bash
# Unauthenticated health check
curl https://YOUR-SERVICE-URL/health

# Authenticated ping (sanity check on the secret wiring)
curl https://YOUR-SERVICE-URL/v1/ping -H "X-API-Key: YOUR_SERVICE_API_KEY"

# The actual spike — calls Perplexity with the hardcoded fridge product
curl -X POST https://YOUR-SERVICE-URL/v1/generate-test \
  -H "X-API-Key: YOUR_SERVICE_API_KEY"
```

## What to look at in the response

The `/v1/generate-test` response includes:
- `rawPerplexityResponse` — the full untouched Perplexity API response
- `extractedMessageContent` — just the model's message text, pulled out
- `parsedCopyObject` — what you get if you `JSON.parse()` that text directly
- `parseError` — non-null if the model's text was NOT clean JSON as-is
  (e.g. wrapped in ```json fences, or had stray commentary)

That last field is the actual answer to the spike's core question. If
`parseError` is consistently non-null across a few runs, Phase 3's output
schema validation needs a cleanup step (strip code fences, etc.) before
`JSON.parse`. If it's consistently null, Perplexity is giving clean JSON
back on its own with this prompt style.

## Known limitations of this spike (by design)

- Rate limiting is per-container-instance, not global — same caveat as
  Phase 1.
- No disclaimer/document retrieval — out of scope per the current
  hand-off-method ambiguity with Simple.
- No output length/field validation against MM's confirmed limits yet —
  that's Phase 3 (output schema validation), not this spike.
- Single hardcoded product, no real input contract — this only proves the
  Perplexity round-trip, not the Simple → Camel payload shape.
