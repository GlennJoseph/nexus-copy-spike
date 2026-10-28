# Phase 4: document retrieval (disclaimers)

Default is OFF. With no changes to env vars the service behaves exactly as before (prompt v0.3, disclaimers empty). Turn it on only when the staging URL test passes.

## 1. Install (local)

1. Copy these files over yours (they replace the old versions): `generate.js`, `checks.js`, `run-tests.js`, `.gcloudignore`, `checks.test.js`.
2. Add these new files: `documents.js`, `check-doc.js`, `documents.test.js`, `generate-docs.test.js`, `tests/fixtures/brochure.pdf`, `tests/fixtures/scanned.pdf`.
3. Install the PDF reader (exact version, it matters for Node 20):
   `npm install pdfjs-dist@4.10.38 --save-exact`
4. In `package.json` change the test script to:
   `"test": "node --test checks.test.js documents.test.js generate-docs.test.js"`
5. Run `npm test`. Expect 48 passing.

## 2. Test the real staging URL (do this first)

`node check-doc.js "https://nartastaging.retailpath.com.au/NARTAStaging/ra/NPRFile/DoO26D4q5rbUOFSHpubk20/nprFile.pdf"`

- `OK` plus footnote-looking lines: the file is public and readable. Go on.
- `FAILED: http_401` or `http_403`: the URL needs a login. Stop and ask Simple how Camel authenticates.
- `FAILED: no_text`: the PDF is a scan (images only). Tell MM; those products fall back to empty disclaimers.
- `FAILED: network`: check the URL spelling and your connection.
- This tests from your machine. Cloud Run may differ if Narta restricts by IP. The same check runs on Cloud Run after step 5.

## 3. Prompt v0.4

1. Copy `prompts/v0.3` to `prompts/v0.4` (keep your own v0.3 edits).
2. In `prompts/v0.4/system.md` replace the whole `### disclaimers` section (down to the `***` line) with:

```
### disclaimers
A disclaimer is a footnote that backs up a claim: a test result, a comparison, or a performance or efficiency figure ("independently tested to...", "based on...", "compared to...").

Look for a section called DISCLAIMER SOURCES in the user message.
- If there is no such section, return "" and add no <sup> tags anywhere.
- If there is, find footnotes in those documents that back up claims you actually make in the copy. Use only those. If none fit, return "" and add no <sup> tags.
- Copy each footnote's wording exactly as it is written in the document. Fix only broken line breaks and spacing. Never reword, shorten, combine or invent a footnote.
- Put the tag right after the claim in npr_long_copy, with a space before it: "fade-free power <sup>1</sup>". Number the tags from 1 in order of first use. If one footnote backs up two claims, reuse its number.
- Write disclaimers as one line per footnote, in this exact form, with a single \n between lines:
<sup>1</sup> Footnote text.
<sup>2</sup> Footnote text.
- Use at most 5 footnotes.
- Never use <sup> tags in npr_short_copy.
```

3. In the SELF-CHECK list replace the line `- No <sup> tags, and disclaimers is ""` with:
   `- <sup> tags only where a document footnote backs up the claim, each footnote copied exactly, numbered in order, and disclaimers is "" when there is no DISCLAIMER SOURCES section`

## 4. Live test on the real API

1. In `tests/payloads/9313139336898.json` set the `uri` of the user manual to
   `https://nartastaging.retailpath.com.au/NARTAStaging/ra/NPRFile/DoO26D4q5rbUOFSHpubk20/nprFile.pdf`
   (Simple's staging example uses the same hash as this product's manual).
2. Run: `DOCS_ENABLED=on PROMPT_VERSION=v0.4 node run-tests.js 9313139336898`
   On Windows PowerShell: `$env:DOCS_ENABLED="on"; $env:PROMPT_VERSION="v0.4"; node run-tests.js 9313139336898`
3. The output now shows a `documents:` line and, if any, the `disclaimers:`. Read each disclaimer against the PDF yourself.
4. Also run the LG product (no attachments). Expect empty disclaimers and no `<sup>`.

## 5. Turn it on in Cloud Run (when step 4 looks right)

```
gcloud run services update nexus-copy-service --region australia-southeast1 \
  --memory=1Gi --update-env-vars DOCS_ENABLED=on,PROMPT_VERSION=v0.4
```
Roll back with `--update-env-vars DOCS_ENABLED=off,PROMPT_VERSION=v0.3`. Also set `--memory=1Gi` in `deploy.sh` so a redeploy keeps it. Then run `check-doc.js` equivalent on Cloud Run by calling `/v1/generate` with the Sunbeam payload and looking at the logs (`documents retrieved`).

## Rules built in

- URLs must be https and on `retailpath.com.au` (or a subdomain). Anything else is skipped. Change with env `DOC_HOSTS` (comma separated).
- PDFs only. The type comes from the extension at the end of the URL. No extension: the first bytes are checked.
- Limits: 4 documents, 10 MB each, 8 seconds each, 12 seconds in total, 60 pages each (first 30 and last 30 if longer), 20,000 characters each and 50,000 in total (start and end kept).
- A document that fails is skipped. It never stops the copy. The reason is logged in `meta.documents` (`http_403`, `no_text`, `too_large`, `timeout`...).
- Every disclaimer must be worded like a footnote in the documents (85% of three-word runs must match). Otherwise the model retries once. If it still fails, the copy goes back with `disclaimers: ""` and the `<sup>` tags removed (warning `disclaimers_dropped` in the logs).
- With no documents, disclaimers are always `""`.

## Assumptions to confirm

- Disclaimer line format is `<sup>1</sup> Footnote text.`, one per line. This matches MM's sample copy documents, but Shikha's instructions show `(1) Footnote text`. Confirm which one Nexus expects.
- Which attachment holds the disclaimer text is unknown, so all four attachment lists are read (up to 4 files).
