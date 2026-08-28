# REE live extraction evaluation

This benchmark runs TXT, Markdown, and image-enabled PDF extraction against the ten sources in `live-articles.json`, producing 30 runs. It is deliberately separate from deterministic tests and does not run as part of `npm test`.

## Setup

Build REE first, then make sure `evals/.artifacts/` is gitignored. The harness invokes the built CLI sequentially and writes every potentially copyrighted or bulky file beneath that directory.

```sh
npm run build
npm run evaluate:live -- --dry-run
npm run evaluate:live
```

Runs are resumable: successful article/format pairs are skipped when their output still exists. Use filters for a small batch, or `--force` to repeat selected successful runs.

```sh
npm run evaluate:live -- --article jvns-hugo-upgrade --format txt
npm run evaluate:live -- --format pdf --limit 2
npm run evaluate:live -- --report-only
```

The runner always creates local metadata reports under `evals/.artifacts/reports/`. After reviewers fill a copy of `scores.template.json`, use `--scores <path>`. Add `--publish-report` only when the resulting metadata-only JSON and Markdown report are ready to commit under `evals/reports/`.

```sh
npm run evaluate:live -- --report-only --scores evals/scores.json --publish-report
```

The optional `REE_EVAL_METRICS_PATH` integration lets the CLI write a per-run JSON object containing `captureMs`, `modelMs`, `renderMs`, `chunkCount`, `sourceBytes`, `outputBytes`, and `imageCount`. The harness measures total wall time itself and leaves unavailable phase metrics as `null` rather than inventing them.

Five reviewers should each grade the two articles sharing their `reviewerSlot`, comparing all three outputs with the live source and applying `rubric.json`. Follow `ARTIFACT_POLICY.md` for every report and note.
