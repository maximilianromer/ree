---
name: ree
description: Use the REE CLI to extract a webpage, HTML file, PDF, image, or image gallery into plain text, Markdown, or a reading-edition PDF. Trigger when the user asks to run REE or convert a supported source with REE.
---

# REE

Prefer the CLI. REE also has a Chromium extension for content already open in a signed-in browser, but agents should use the CLI unless that browser context is required.

Resolve the source and destination paths, then run:

```sh
ree "<source>" --format <txt|md|pdf> -o "<output>"
```

`<source>` may be an HTTP(S) URL or a local HTML, PDF, JPEG, PNG, WebP, or GIF file. Use `-` only for HTML piped over stdin. Quote paths. Use `-o` for a predictable file; without it, TXT and Markdown go to stdout and PDF chooses a filename.

Example:

```sh
ree "$HOME/Downloads/report.pdf" --format txt -o "$HOME/Downloads/report.txt"
```

For photographed pages, pass a directory to process its images in natural filename order, or pass multiple image paths in the exact desired order:

```sh
ree "$HOME/Downloads/book-photos" --format txt -o "$HOME/Downloads/book.txt"
```

Pass `--custom-instructions "..."` when the user gives extraction-specific guidance. Use `--fast` only when requested because it costs more credits, and `--model` only when requested because REE remembers that choice.

If REE is unavailable or reports a setup problem, run `ree doctor` and report the result. After extraction, verify that the output exists and is nonempty, then return its absolute path.
