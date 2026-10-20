# Re-recording the README demo

`docs/demo.gif` is generated with [vhs](https://github.com/charmbracelet/vhs) from
`demos/demo.tape` against the toy fixture in `demos/wordcount-app/`. The fixture
starts with one passing and one failing test; the task asks chantier to fix it.
The recording surface is deliberately sanitized: a throwaway fixture with no
credentials on screen — the same QC gate that applies to every episode of the
video series.

## What you need

- A local OpenAI-compatible model. The tape was recorded against Ollama serving
  `glm-5.3-flash:cloud`; point `~/.chantier/config.json` at whatever model you
  have (any OpenAI-compatible endpoint works, see examples/config.json).
- `vhs` (charmbracelet/vhs) + `ttyd` + `ffmpeg` on PATH.
- Node >= 22 with the workspace built (`npm run build`): the tape drives the CLI
  through a local PATH shim, replace the shim's path with your global
  `chantier` install if you just want to run it by hand.

## Record

```sh
cd demos
HOME=/tmp/chantier-demo-home vhs demo.tape   # demo HOME keeps your real sessions out of the recording
```

The tape is timing-based, not anchor-based: approval latencies depend on the
model, so the sleeps are conservative. If your model is slower, bump the
`Sleep` beats or swap in your own anchor waits — any content change should
update `docs/demo.gif` in the same commit so the README stays honest.

## Why approvals resolve inside the GIF

The fixture ships a `.chantier/settings.json` that allows read-only tools and
bash but NOT `edit`/`write` — so the one approval card in the demo is the
file edit, which is exactly the moment we want visible. The tape answers it
with `a` (allow for the session).