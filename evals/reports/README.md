# Publishable live reports

This directory is reserved for generated metadata-only evaluation reports that are ready to commit. Generate them with:

```sh
npm run evaluate:live -- --report-only --scores evals/scores.json --publish-report
```

Never copy local extraction artifacts or raw logs here. See `../ARTIFACT_POLICY.md`.
