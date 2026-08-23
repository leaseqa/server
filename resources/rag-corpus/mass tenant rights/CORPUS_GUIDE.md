# Legal Tactics Corpus Guide

## 1) Corpus Map (ASCII)

```text
Legal Tactics Corpus
│
└─ pdf/
   ├─ chapters/
   │  └─ ch01_...pdf ~ ch18_...pdf
   ├─ handouts/
   │  └─ handout_ch01a_...pdf ~ handout_ch18_...pdf
   ├─ forms/
   │  └─ form_01_...pdf ~ form_25_...pdf
   ├─ booklets/
   │  └─ booklet_1_...pdf ~ booklet_12_...pdf
   └─ appendix/
      ├─ appendix_00_using_legal_tactics.pdf
      ├─ appendix_01_acknowledgments.pdf
      ├─ appendix_02_glossary.pdf
      └─ appendix_03_directory.pdf
```

Meaning:

- `chapters`: full legal rules and explanations, `P0`
- `handouts`: short 2-page chapter summaries and checklists, `P1`
- `forms`: action templates and sample letters/forms, `P1`
- `booklets`: eviction-specific workflow documents, `P1`
- `appendix`: orientation, glossary, directory, `P2`

## 2) Retrieval Rules (Recommended)

- Default retrieval order: `chapters -> handouts -> forms -> booklets -> appendix`
- For rule/legal basis questions: upweight `chapters`.
- For "write letter/form/checklist" requests: upweight `forms`.
- For eviction procedure/timeline: upweight `booklets` and `chapters` chapter 12.
- For definitions: query `appendix` glossary first, then verify with `chapters`.

## 3) Metadata Fields (for ingestion)

Use these fields in vector metadata:

- `source_type`: `chapter | handout | form | booklet | appendix`
- `source_group`: `chapters | handouts | forms | booklets | appendix`
- `chapter_ref`: `1..18` when applicable, else empty
- `title_hint`: filename-decoded short title
- `priority`: `P0 | P1 | P2`
- `file_name`: original file name
- `file_path`: corpus-root-relative path, for example `pdf/chapters/ch01_moving_in.pdf`
- `source_url`: official Mass Legal Help page or PDF URL for citations

## 4) Current Corpus Location

The corpus is committed inside the `leaseqa-server` repository, at
`resources/rag-corpus/mass tenant rights/` relative to the repository root.
`resolveCorpusRoot()` in `LeaseQA/RAG/config.js` finds it there first and only
walks up to parent directories if the repository has no copy. Set
`RAG_CORPUS_ROOT` to override both for any other layout.

- Corpus root: `<leaseqa-server>/resources/rag-corpus/mass tenant rights`
- PDF root: `<corpus root>/pdf`
- Machine-readable index: `<corpus root>/corpus_manifest.csv`
- Previous manifest: `<corpus root>/corpus_manifest.csv.bak` (exactly one backup,
  rewritten by `npm run corpus:refresh` on every write)
- Last upstream check: `<corpus root>/upstream_state.json` (never referenced by
  the manifest, so it is not part of `corpusVersion`)

## 5) Refresh Procedure

Run every command from the `leaseqa-server` repository root.

1. `npm run corpus:check -- --write-state` — reports which upstream documents
   changed and records the observation in `upstream_state.json`. It never
   downloads and never attempts to defeat the upstream bot check.
2. For each changed file, open the page URL from the report **in a real
   browser**, download the new PDF, and overwrite the existing file in place,
   keeping its current name.
3. `npm run corpus:refresh` — re-hashes every PDF and rewrites only the rows
   whose bytes actually changed, so a no-op refresh leaves
   `corpus_manifest.csv` byte-identical and does not trigger a re-ingest. Use
   `--dry-run` first to preview. The previous manifest is kept at
   `corpus_manifest.csv.bak`.
4. Commit the changed PDFs, `corpus_manifest.csv`, `corpus_manifest.csv.bak`
   and `upstream_state.json` together, with the upstream revision strings in
   the message.
5. Ingest: run the `corpus-ingest` workflow, or `npm run ingest:rag` locally.
   The retrieval gate decides whether the knowledge alias is repointed; a
   failing gate leaves the run in `staging` and does not move the alias.

Plain git, no LFS: 36 MB total, largest file 1.5 MB.

## 6) Notes

- This guide is for retrieval strategy and corpus governance.
- `corpus_manifest.csv` is hashed in full into `corpusVersion`. Never edit it by
  hand; use `npm run corpus:refresh`.
- Old download logs, URL lists, and duplicate sample files were removed during cleanup.
- If new PDFs are added, regenerate `corpus_manifest.csv` and keep this guide updated.
