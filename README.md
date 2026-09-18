# vanioljantunes.github.io

Personal academic site for Vanio Antunes — MD candidate, meta-analyst, researcher.

Live at: https://vanioljantunes.github.io

## Pages

| Path | Description |
|---|---|
| `index.html` | Home: photo, one-line bio, links to the three sections |
| `about/index.html` | CV / about page (research, publications, teaching, contact) |
| `about/research.html`, `stats.html`, `teaching.html`, `contact.html` | Older sub-pages (root copies redirect here) |
| `tools/index.html` | Meta-analysis tools (ssHelper, upcoming tools) |
| `packages/index.html` | R packages, linking to their GitHub repositories |

## Stack

Static HTML + CSS. No build step. Hosted on GitHub Pages and on Vercel (`vercel.json`: clean URLs, `/tools/ssHelper/` proxied to the ssHelper deployment). `site.css` styles the new pages; the About page keeps its inline styles. Motion 13.4.0 and anime.js 4.5.0 load from jsDelivr on the home, about and packages pages.

Design system: Warm Editorial (nexu-io/open-design) — Georgia serif, warm paper background, terracotta accent.
