# Live evaluation artifact policy

The live benchmark intentionally processes copyrighted public articles. Extracted bodies, downloaded assets, generated PDFs, screenshots, raw process logs, timing sidecars, and resumability state are local evaluation artifacts and must stay under `evals/.artifacts/`. That directory must be gitignored and must never be committed.

Publishable reports may contain only:

- Article IDs, titles, source URLs, categories, and assigned reviewer slots from the benchmark manifest.
- Status and failure categories, byte counts, image/chunk counts, and capture/model/render/total timings.
- Numeric rubric scores, pass/fail checks, and concise reviewer notes that do not quote or paraphrase article content.

Do not place article bodies, excerpts, extracted images, screenshots, raw stdout/stderr, or model responses in `evals/reports/`, issues, commits, or pull requests. A failure note should identify the behavior, such as “navigation duplicated before body” or “figure clipped on page 4,” without reproducing source material.
