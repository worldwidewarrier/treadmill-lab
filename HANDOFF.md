# Treadmill Lab — Handoff / 인수인계 (updated 2026-10-05)

Paste or point a new Claude chat at this file ("GitHub 저장소 worldwidewarrier/treadmill-lab 의 HANDOFF.md 를 읽고 이어서 도와줘") to continue without the original conversation.
The app itself never depends on any chat: code lives in this repo (GitHub Pages), data lives in the phone's browser (IndexedDB, Settings → Backup).

## 1. Athlete / 선수
- Born 1997-07-21 (29), resting HR low 50s, **HRpeak 185** (step test 2026-10-03), Tanaka 188 kept in settings. 5K 25:00, 10K 50:00. Self-reported easy jog 7 km/h. Weekday mornings 1 h, weekends 2–4 h. No conditions/meds.
- Gear: Polar H10 (BLE → app, RR for DFA α1), Nova **StatStrip Xpress Lactate** (capillary; range 0.3–20 mmol/L; strip auto-off 2 min after insertion; meter 15–40 °C), **Train.Red FYER 2.0** on right vastus lateralis (Train.Red app → CSV export with "Heart Rate (BPM)" column; FIT also supported), Garmin Instinct 2 Solar (Train.Red CIQ field restricted → not used), Lexco **LTSXL** treadmill (0.8–18 km/h, 0–15 %), Galaxy A35 + Chrome (Samsung Internet has no Web Bluetooth).
- Reply style the user asked for: start with an English translation/correction of the question, then Korean and English side by side.

## 2. App / 앱
- Live: https://worldwidewarrier.github.io/treadmill-lab/ · Repo: github.com/worldwidewarrier/treadmill-lab (Pages: main / root). Claude GitHub App is installed on the repo → a Claude session can clone, edit, commit, push.
- **Version discipline:** `APP_VERSION` in `js/app.js` must equal `VERSION = 'tl-v…'` in `sw.js` (test/test_version.mjs). Bump both on every deploy; the phone shows the version at the bottom of Settings with a "강제 업데이트 / force update" button (clears cache only, keeps data).
- Current version **1.1.10**. Modules: `dfa.js` (α1 identical to FatMaxxer alpha1v2, verified 1e-9), `lactate.js` (baseline+0.5, log-log, OBLA, Dmax, Log-Poly-ModDmax), `analysis.js` (stage summaries, HRVT, SmO2 breakpoints, `smo2Steady`, `estimateOffsetMs` HR cross-correlation, triangulation), `prescribe.js` (zones, plan, `sessionMetrics`, `lactateChecks/lactateVerdict/endOnlyProxy/verdictZoneChange`, `multiDayCurve`, `claudeSummary`), `session.js` (test/LT1/LT2/free engine), `app.js` (UI; Free-mode lactate cue minutes; verification card with purpose selector), `importers.js`+`fit.js`, `ble.js`, `sources.js` (demo/replay), `alerts.js`, `store.js`, `i18n.js`, `charts.js`, `sw.js`.
- Dev: `python3 -m http.server 8765` from the repo root; tests in `test/` (see README §5). Personal data fixtures (FatMaxxer rr/features CSVs, Train.Red CSV/FIT) are **not** in the repo — see `test/data/README.md`; unit tests that don't need them: dfa, lactate, analysis, prescribe, session, verify, align, version.
- Exports: session CSV (meta, lactate/RPE events, verdict, SmO2 steady line, features, RR) and "요약 복사" (Claude summary) both carry everything needed for interpretation.

## 3. Findings so far / 지금까지의 결론
- **2026-10-03 step test** (6→16 km/h, 3-min stages, incline 1 %, α1-only, Train.Red contact failed THb≈6): HR 116→185. α1 crossed 0.75 at ≈7 km/h/125 bpm and 0.5 at ≈8 km/h/135 bpm, then floored 0.3–0.5 up to 15 km/h. **For this athlete DFA-α1 reads about one zone too hard (confirmed again 10/4 and 10/5). Do NOT use α1-based zones; the applied 113/152 bpm result was wrong. Lactate (+HR drift, SmO2) is the anchor.**
- **2026-10-04 Free 9.0 km/h × 35 min:** HR 146 steady (drift +0.6 %), SmO2 70.9 → 67.6 % (−3.2, end slope +0.14 → steady), α1 0.3–0.4, end lactate **2.8** (seated rest 1.3 the day before) → **above LT1** (heavy domain).
- **2026-10-05 Free 8.0 km/h × 35 min:** HR 136, drift −0.1 %, SmO2 70.8 → 70.4 %, end lactate **0.5 (two fingers)** → **below LT1**. 0.5 (and a 0.3 seated reading on 10/4 morning) may be biased low (dilution: alcohol/wet finger, squeezing, first drop) — open question; a 10-min value of 3–4.5 at 10.5 km/h would clear the technique.
- **Current estimate:** LT1 ≈ **8.4 km/h / 140 bpm** (bracketed 8.0–9.0); LT2/MLSS ≈ **10.5–11.0 km/h / 157–161 bpm** (unverified). Manual thresholds in Settings: **LT1 140 @ 8.4 · LT2 157 @ 10.5**. Easy runs 7.5–8.0 km/h (HR 130–137).
- Train.Red: contact OK when THb ≳ 20 (patch + strap); clock alignment verified by HR cross-correlation (lag 1 s) — the app now aligns automatically and shows "심박 교차검증 ✓".
- HRmax: 185 is a floor from the step test; keep 188 until a higher value is observed (race finish / hill reps).

## 4. Solo protocol rules / 혼자 할 때 규칙
- Lactate technique: hands warm, washed with warm water and **fully dry (no alcohol residue, no sweat)**, wipe the first drop, no milking, fill the strip in one touch; end sample within 45 s of stopping; duplicate (two fingers) when a value looks odd (agree within 0.3). Keep caffeine/breakfast consistent on verification days. Strips: insert only when ready (2-min auto-off); meter ≥ 15 °C.
- **LT1 verification:** Free mode, speed entered, 35 min constant, cue "35". End ≤ 2.0 (and ≤ rest +1.0) → below; 2.1–2.5 → borderline; > 2.5 (or rise > 1.5) → above.
- **MLSS verification:** Free mode, **purpose = MLSS**, 30 min constant, warm-up outside the session, cue "30" (or "10,30" if a mid-run stop is possible: pause the app during the draw). With a 10-min sample: rise ≤ 1.0 → at/below (next +0.3), > 1.0 → above (−0.4). End-only proxy: < 25 min → withheld; end < 3 → below; ≥ 6 → above; 3–6 with HR drift (min 8–13 → last 5) ≤ 6 bpm and SmO2 steady → likely at/below (+0.3); drift > 8 bpm, SmO2 still falling or RPE ≥ 18 → likely above (−0.3); 6–8 → repeat.
- **Zone updates:** verification card "존에 반영" (confirmed run raises a floor, failed run lowers a cap, from the run's own speed and last-5-min HR); multi-day lactate curve (≥ 3 speeds, Analysis tab "적용"); manual thresholds override. Any Free/LT1/LT2 session with speed + end lactate feeds the curve.
- LT2 **training** (not testing): LT2 session mode, 4×8 min (3-min easy) → 4×10 → 5×10 → recovery week → 3×15 → 2×20 → 30-min tempo, at MLSS speed, HR LT2 ±3; optional lactate after the last rep 3–4.5 = on target.

## 5. Plan / 계획 (as of 10/5)
- Tue 10/6: rest or 7.0–7.5 km/h × 30 (optional fasted resting duplicate at home to test the low-bias question).
- Wed 10/7: **MLSS #1 — 10.5 km/h × 30 min, end-only (+ RPE)**. Expect HR 155–162, lactate 3–4.5. Verdict → next week 11.0 or 10.0.
- Thu easy 7.5 × 40 · Fri rest · Sat long 7.5–8.0 × 60–75 (optional end sample).
- Next Mon/Tue: **LT1 check 8.5 km/h × 35, two end samples** (≤ 2.0 → LT1 = 8.5; else 8.0–8.5). Repeat 9.0 in 3–4 weeks as a progress benchmark (2.8 → ≤ 2.0 means LT1 moved up).
- After ≥ 3 curve points (8.0 / 9.0 / 10.5): compare the multi-day curve with the manual thresholds and apply. Then weekly: 1 LT2 session, easy days 7.5–8.0, one long run; retest every 8 weeks or on drift.
