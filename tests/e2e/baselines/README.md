# Baselines

Per-version aggregated E2E results, **committed** so runs can flag regressions
between releases (PLAN §8).

Each file is `<version>.json` written by `run-e2e --save-baseline`:

```jsonc
{
  "version": "0.4.0",
  "cells": [
    { "scenario": "S2-feature", "vendor": "claude-code", "model": "claude-opus-4-8",
      "runs": 3, "passRate": 1.0, "tokens": { "mean": ..., "median": ..., "p95": ... },
      "costUsd": { ... }, "wallSec": { ... } }
  ]
}
```

A run compares its aggregate against the most recent *previous* baseline and
flags: pass-rate drops, or token/cost increases beyond 20% per cell.

Capture a baseline right before cutting a release, from a full-matrix sweep with
`--runs >= 3` (so the pass-rate + variance are meaningful).
