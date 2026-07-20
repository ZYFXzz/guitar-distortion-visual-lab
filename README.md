# Guitar Distortion Visual Lab

Interactive HTML/JS demo for visualizing guitar distortion in both time and frequency domains.

## Live demo

After GitHub Pages is enabled, this project will be available at:

`https://zyfxzz.github.io/guitar-distortion-visual-lab/`

## Features (current develop focus)

- Input source: sine wave / guitar chord sample / guitar single-note sample
- Upload local guitar audio files in-browser
- Distortion bypass mode
- Circuit-focused pedal models:
  - Tube Screamer TS808 (feedback-path soft clipping)
  - Boss DS-1 (pre-boost + silicon hard clipping)
- 3-section architecture with independent toggles:
  - Section A: internal boost / pre-shaping
  - Section B: clipping core
  - Section C: tone shaping
- Tone control for post-clipping voicing
- Pedal-style Level control (post-circuit output volume)
- Time-domain overlay (input vs output) with threshold guide lines
- Frequency-domain overlay (FFT magnitude)
- Play input and output audio in-browser

## Files

- `index.html` – UI layout and style
- `distortion-lab.js` – DSP and visualization logic
