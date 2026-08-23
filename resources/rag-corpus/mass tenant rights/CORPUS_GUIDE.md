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

## 3) Manifest Columns

`corpus_manifest.csv` has 12 columns, in this order. The authoritative list is
`MANIFEST_COLUMNS` in `LeaseQA/RAG/corpusManifest.js`; keep the two in step.

Editorial — describe the document, maintained by hand:

- `file_name`: original file name
- `title_hint`: filename-decoded short title
- `source_type`: `chapter | handout | form | booklet | appendix`
- `source_group`: `chapters | handouts | forms | booklets | appendix`
- `chapter_ref`: `1..18` when applicable, else empty
- `priority`: `P0 | P1 | P2`
- `file_path`: corpus-root-relative path, for example `pdf/chapters/ch01_moving_in.pdf`
- `source_url`: official Mass Legal Help chapter page, used for citations

Provenance — **tool-maintained, do not edit by hand.** `npm run corpus:refresh`
owns all four and rewrites them only for rows whose PDF bytes actually changed:

- `pdf_url`: direct PDF link observed upstream, when one is known
- `content_sha256`: sha256 of the PDF on disk; the change-detection key
- `retrieved_at`: ISO date the current bytes were retrieved
- `upstream_revision`: the official revision string, e.g. `01 Moving 2025 Updated 8-13-25`

The first eight feed vector metadata at ingest. All twelve are part of the
manifest text, and the manifest text is hashed in full into `corpusVersion`, so
editing any column — including a cosmetic change to an editorial one — forces a
complete re-embed of all 81 files.

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

Run every command from the `leaseqa-server` repository root. A pre-migration
copy of this corpus may still exist outside the repository at
`<workspace>/resources/rag-corpus` on the original development machine; it is
redundant and is not what these commands operate on. Every script prints the
`corpusRoot` it resolved — if it is not inside this checkout, stop.

1. `npm run corpus:check -- --write-state` — reports which upstream documents
   changed and records the observation in `upstream_state.json`. It never
   downloads and never attempts to defeat the upstream bot check.
2. For each changed file, open the page URL from the report **in a real
   browser**, download the new PDF, and overwrite the existing file in place,
   keeping its current name.
3. `npm run corpus:refresh -- --dry-run` to preview, then
   `npm run corpus:refresh` to write. It re-hashes every PDF and rewrites only
   the rows whose bytes actually changed, so a no-op refresh leaves
   `corpus_manifest.csv` byte-identical and does not trigger a re-ingest. The
   previous manifest is kept at `corpus_manifest.csv.bak`.

   The `--` separator is required. `npm run corpus:refresh --dry-run` forwards
   nothing to the script and performs a **real write** — overwriting
   `corpus_manifest.csv.bak` and changing `corpusVersion` while appearing to
   have previewed nothing.
4. Commit the changed PDFs, `corpus_manifest.csv`, `corpus_manifest.csv.bak`
   and `upstream_state.json` together, with the upstream revision strings in
   the message.
5. Ingest: run the `corpus-ingest` workflow, or `npm run ingest:rag` locally.
   The retrieval gate decides whether the knowledge alias is repointed; a
   failing gate leaves the run in `staging` and does not move the alias.

   Set `RAG_MILVUS_KNOWLEDGE_COLLECTION` to the alias the readers are deployed
   with. The workflow refuses to start without an explicit alias, because the
   gate queries the staging collection and so cannot notice an ingest that
   repoints the wrong one.

Plain git, no LFS: 36 MB total, largest file 1.5 MB.

## 6) Notes

- This guide is for retrieval strategy and corpus governance.
- `corpus_manifest.csv` is hashed in full into `corpusVersion`. Never edit it by
  hand; use `npm run corpus:refresh`.
- Old download logs, URL lists, and duplicate sample files were removed during cleanup.
- If new PDFs are added, regenerate `corpus_manifest.csv` and keep this guide updated.
