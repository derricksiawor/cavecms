# CaveCMS official logo

The canonical CaveCMS brand mark (copper brush-wand glyph + sparkles on a
black rounded square). Source: cavecms-web/app/icon.svg (the marketing site's
app icon).

- cavecms-mark.svg      — vector source (scales infinitely)
- cavecms-logo-512.png  — Google OAuth consent screen (square, <1 MB)
- cavecms-logo-120.png  — Google's exact 120×120 spec
- cavecms-logo-215.png  — Azure app-registration logo (215×215)

Regenerate the PNGs from the SVG with the project's sharp:
  node -e 'const s=require("sharp");const fs=require("fs");
    [512,120,215].forEach(n=>s(fs.readFileSync("cavecms-mark.svg"),{density:600})
    .resize(n,n,{fit:"contain",background:{r:5,g:5,b:5,alpha:1}}).png()
    .toFile(`cavecms-logo-${n}.png`));'
