# CLAUDE.md

Operating context for Claude Code sessions in the vanioAntunes website repository.

## Project

Personal academic site of Vanio Antunes, live at https://vanioantunes.com (Vercel) and
https://vanioljantunes.github.io (GitHub Pages). Four paths from the home page: Who am I
(`about/`), Meta-analysis tools (`tools/`), R packages (`packages/`), Imaging projects (`imaging/`, three
in-progress cards). [PRODUCT.md](PRODUCT.md)
holds users, brand and design principles and wins over taste; [README.md](README.md) lists pages.

This folder is the working copy for the site as a whole. Tools and packages that the site shows
have their own repositories (table below); this repo only links to or proxies them.

## Stack

Static HTML + CSS + small vanilla JS. No framework, and no build step anywhere except
`imaging/viewer/`, which is bundled from TypeScript by esbuild into committed output
(`npm run build:viewer`); Vercel still builds nothing. `site.css` and
`site-bar.css` style the pages; the About page keeps inline styles. Motion 13.4 and anime.js 4.5
load from jsDelivr. Design system: Warm Editorial (Georgia serif, warm paper, terracotta accent).

Small tools that live in this repo as static pages: `tools/median`, `tools/combine`,
`tools/diagnostic`.

## Deploy

- Branch `main` on `vanioljantunes/vanioljantunes.github.io` serves GitHub Pages.
- Vercel project `vanioantunes` (team `team_TdnUETUdVyRAW0LglpHrm5DA`) serves vanioantunes.com.
  `.vercel/project.json` is present locally and gitignored. `vercel.json` sets clean URLs, the
  old-page redirects and the `/tools/ssHelper/` and `/tools/triageHelper/` proxies.
- After a push, probe `curl -sI https://vanioantunes.com/` to confirm the deploy.

## Sibling repositories

| Thing | Local path | Repository | Live |
|---|---|---|---|
| ssHelper | `claudeOS/projects/ssHelper` | vanioljantunes/ssHelper | sshelper-five.vercel.app, proxied at `/tools/ssHelper/` |
| triageHelper | `claudeOS/projects/triageHelper` (tracked inside claudeOS) | vanioljantunes/claudeOS | triagehelper.vercel.app, proxied at `/tools/triageHelper/` |
| nmaplots (R) | `claudeOS/projects/nmaplots` | vanioljantunes/nmaplots | GitHub only |
| easyTSA (R) | `claudeOS/projects/easyTSA` | vanioljantunes/easyTSA | GitHub only |
| meta3l (R) | `aiBrain/Projects/meta3l` | vanioljantunes/meta3l | GitHub only |
| easyDTA (R) | not checked out locally | vanioljantunes/easydta | GitHub only |

Change a tool or package in its own repository, never here. Here you change how the site
presents or proxies it (`vercel.json`, `tools/index.html`, `packages/index.html`).

## Working rules

- This is its own repository (`main`). It sits inside the claudeOS folder, which ignores it:
  run git commands inside this directory only and never commit to claudeOS.
- Conventional commit messages (`feat:`, `fix:`, `docs:`, `chore:`). Commit and push when a
  task is done; small content fixes go straight to `main`.
- Visual changes are verified with a screenshot from a dedicated Playwright browser, at desktop
  and phone widths, before they are called done. Code and grep are not proof of pixels.
- WCAG 2.2 AA: contrast, 24px targets, keyboard focus visible, reduced motion respected.
- Real numbers only (Google Scholar counts, actual repositories). No emojis in code or copy.
- Local-only files (`element-bridge.js`, `inspector.js`, `fix.js`, `gen_*.R`, `Python/`,
  `node_modules/`, `.tmp_*.mjs`, `.vercel/`) are gitignored dev helpers; do not track them.
