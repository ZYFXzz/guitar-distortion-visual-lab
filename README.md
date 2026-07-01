# Guitar Distortion Visual Lab

Interactive HTML/JS demo for visualizing guitar distortion in both time and frequency domains.

## Live demo

After GitHub Pages is enabled, this project will be available at:

`https://zyfxzz.github.io/guitar-distortion-visual-lab/`

## Features

- Input source: sine wave / guitar chord sample / guitar single-note sample
- Upload local guitar audio files in-browser
- Gain stage and distortion bypass mode
- Distortion algorithms:
  - hard clip
  - soft clip (tanh)
  - distortion (atan)
  - overdrive
  - mosfet-like
  - fuzz
  - rectifier
- Asymmetry control for asymmetric clipping
- Time-domain overlay (input vs output) with threshold guide lines
- Frequency-domain overlay (FFT magnitude)
- Play input and output audio in-browser

## Files

- `index.html` – UI layout and style
- `distortion-lab.js` – DSP and visualization logic
