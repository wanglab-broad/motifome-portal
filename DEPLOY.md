# Putting the portal online

The site is **static files**. There is no server, no database and no runtime — so "deploying" is just
copying `portal/` somewhere that serves files over HTTP. That is what makes it cheap to host and what makes
the URL in your paper likely to still resolve in five years.

## What you are shipping (measured, not estimated)

| | |
|---|---|
| Files | **19,023** (18,093 gene shards · 900 cluster shards · 6 modules · 24 app/data files) |
| Raw size | **399 MB** |
| **Over the wire (gzipped)** | **~113 MB** — hosts compress text automatically |
| Largest single file | 1.2 MB (`search_alias.json`) |
| Largest gene shard | 81 KB raw ≈ 27 KB gzipped (`NM_003128`) |
| Typical page load | ~500 KB first visit, then ~6 KB per gene |

The file **count** is the number that constrains your choice of host, not the size.

---

## Recommended: GitHub Pages + a Zenodo DOI

Two URLs doing two different jobs. The Pages URL is what people click; the DOI is what the paper cites and
what survives if the Pages URL ever dies.

### Step 1 — put it in a repository under a *lab* account

Not your personal account. A personal GitHub account disappears if it is renamed or deleted, and you will
eventually leave this lab; the paper will not. Ask your PI to create the repo under a lab organization, or
use your institution's GitHub Enterprise if it has one.

```bash
cd /Users/wangyanz/Desktop/Project/sequence_design/manuscript/online_contents
git init -b main
git add -A
git commit -m "MIRTO bilingual motifome portal: bake pipeline and static site"
git remote add origin https://github.com/<LAB-ORG>/mirto-motifome-portal.git
git push -u origin main
```

`.gitignore` already excludes `code/build/_cache/` — those intermediates are regenerable and would add
another few hundred MB for nothing. `portal/data/` **is** committed: it is the site.

> **Do not use Git LFS for `portal/data/`.** GitHub Pages does not serve files stored in LFS — the site
> would return errors for every shard. Commit them as ordinary files. At 399 MB you are comfortably inside
> GitHub's 1 GB soft limit per repository.

### Step 2 — turn on Pages

The site lives in `portal/`, but Pages only publishes from a repo root or `/docs`. Use the included Action
instead of restructuring:

```bash
mkdir -p .github/workflows
mv .github_workflows_pages.yml .github/workflows/pages.yml
git add .github && git commit -m "Deploy portal/ to GitHub Pages" && git push
```

Then in the repo: **Settings → Pages → Source: GitHub Actions**. The first build takes a few minutes
(19,023 files). Your URL will be `https://<lab-org>.github.io/mirto-motifome-portal/`.

`portal/.nojekyll` is already in place — without it Jekyll would try to process 19,000 data files and the
build would fail.

### Step 3 — mint a DOI with Zenodo

This is the part that makes it citable and permanent.

1. Sign in at [zenodo.org](https://zenodo.org) with GitHub, go to **Account → GitHub**, and flip the switch
   on your repository.
2. Back on GitHub: **Releases → Create a new release**, tag `v1.0.0`, publish.
3. Zenodo archives that exact snapshot and mints a DOI. Use the **Concept DOI** (the one that always points
   at the newest version) in the paper.

Add authors and a license in the Zenodo record. CC-BY-4.0 for the data and MIT for the code is the usual
pairing for this kind of resource; check whether any upstream database licence (POSTAR3, TargetScan,
InterPro, ELM) constrains redistribution of the annotation columns before you settle on it.

### Step 4 — write it into the manuscript

In **Data availability** (adjust to the journal's wording):

> An interactive portal for the protein–RNA bilingual motifome — searchable by gene, motif cluster and
> module — is available at https://\<lab-org\>.github.io/mirto-motifome-portal/ and archived at
> https://doi.org/10.5281/zenodo.XXXXXXX.

In **Code availability**, point at the same repository and name the bake pipeline (`code/build/`), since it
regenerates every byte the portal serves from the primary data.

---

## The alternatives, honestly

| Host | Cost | File limit | Worth it when |
|---|---|---|---|
| **GitHub Pages** | free | none (1 GB repo soft limit) | **Default.** Free, no account to keep alive beyond GitHub itself, and the Zenodo integration is one click. |
| Netlify | free tier | none, but 19k-file deploys are slow | You want deploy previews or a custom domain with less fuss. |
| Cloudflare Pages | free tier | **20,000 files per deployment** | Only with caution — you are at 19,023, about 1,000 from the ceiling. Adding transcripts would break the deploy. |
| Institutional web server | free | none | Your department already hosts lab pages and IT will give you a stable path. Ask about the URL's lifetime. |
| AWS S3 + CloudFront | ~$1–3/mo | none | You need a custom domain and full control, and someone will keep paying the bill. |
| Hugging Face Spaces (static) | free | none | Your audience already lives there. Ties the URL to an HF account. |

**A custom domain is the one upgrade worth considering** (e.g. `motifome.<lab>.org`). It costs ~$12/year and
decouples the citation from the host — if you migrate off GitHub Pages later, the URL in the paper keeps
working. Point a CNAME at the host and add the domain in Settings → Pages.

---

## If a host rejects the file count

Bundle the gene shards into buckets instead of one file per transcript. In `06_gene_shards.py`, group by
the first two characters of a hash of the RefSeq id into 256 buckets, and have `data.js` fetch
`gene/bucket_<hh>.json` and pick the transcript out of it. That takes 18,093 files down to 256, at the cost
of ~70 KB per fetch instead of ~6 KB. Only do this if you actually hit a limit — the per-gene file is the
faster experience.

---

## Before you publish the link

- [ ] Open the site and click through a gene, a cluster and the network. Nothing in the automated checks
      can see a rendered page.
- [ ] Confirm the two blocking science questions are resolved: the `utr3_0027` / `utr3_0227` conflict in the
      MLXIPL example, and the M2 APEX claim (lamina q = 0.725, OMM q = 0.551). The portal renders whatever
      the data says — if the manuscript and the data disagree, a reader will find it.
- [ ] Check the "About the data" page states the coverage gaps and the co-occurrence caveat, since that page
      is what a sceptical reviewer will read first.
- [ ] Decide the licence, and check the upstream annotation databases permit redistribution.
- [ ] Tag `v1.0.0` and archive **after** the science is settled, so the DOI points at the version the paper
      describes.

## Rebuilding after the data changes

```bash
/opt/anaconda3/envs/bio/bin/python code/build/00_validate.py   # 11 assertions; must pass before anything else
# then the numbered scripts in order
git add -A && git commit -m "Rebuild portal data" && git push   # Pages redeploys automatically
```

`00_validate.py` fails the build rather than the reader — if an upstream file changes shape, you find out at
bake time instead of from someone reading your paper.
