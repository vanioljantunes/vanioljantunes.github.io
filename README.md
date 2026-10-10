# vanioljantunes.github.io

Personal academic site for Vanio Antunes — MD candidate, meta-analyst, researcher.

Live at: https://vanioljantunes.github.io

## Pages

| Path | Description |
|---|---|
| `index.html` | Home: photo, one-line bio, links to the four sections |
| `about/index.html` | CV / about page (research, publications, teaching, contact) |
| `about/research.html`, `stats.html`, `teaching.html`, `contact.html` | Older sub-pages (root copies redirect here) |
| `tools/index.html` | Meta-analysis tools (kmHelper, ssHelper, upcoming tools) |
| `packages/index.html` | R packages, linking to their GitHub repositories |
| `imaging/study-track/index.html` | Study track: the deep-learning-drizzle lecture catalogue, searchable, with the playlists playing in the page |
| `imaging/index.html` | Imaging projects (aleArrhythmia, cinematic rendering for 3D CT, CT reconstruction with machine learning), all in progress |

## Stack

Static HTML + CSS. No build step. Hosted on GitHub Pages and on Vercel (`vercel.json`: clean URLs, `/tools/kmHelper/` and `/tools/ssHelper/` proxied to their own deployments). `site.css` styles the new pages; the About page keeps its inline styles. Motion 13.4.0 and anime.js 4.5.0 load from jsDelivr on the home, about and packages pages.

Design system: Warm Editorial (nexu-io/open-design) — Georgia serif, warm paper background, terracotta accent.
