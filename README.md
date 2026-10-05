# Treadmill Lab · 러닝머신 랩

Polar H10 + StatStrip lactate + Train.Red FYER → **단계 테스트 → LT1/LT2 역치(삼각측량) → 실시간 세션 가이드 → 주간 처방**을 한 앱에서.
Polar H10 + StatStrip lactate + Train.Red FYER → **step test → LT1/LT2 thresholds (triangulated) → live session guidance → weekly prescription**, in one app.

- 100% 브라우저 앱 (Android Chrome). 서버·계정·API 없음. 데이터는 폰 안에만 저장.
- 100% browser app (Android Chrome). No server, account or API. Data stays on the phone.

## 1. 배포 — GitHub Pages (5분) · Deploy to GitHub Pages (5 min)

1. github.com 로그인 → 우측 상단 **+ → New repository** → 이름 `treadmill-lab` → **Public** → Create.
2. 새 저장소 화면에서 **uploading an existing file** 클릭 → 이 폴더의 파일을 **폴더 구조 그대로** 끌어다 놓기 (`index.html`, `manifest.webmanifest`, `sw.js`, `css/`, `js/`, `vendor/`, `icons/`) → **Commit changes**.
   - 폴더째 드래그가 안 되면 `treadmill-lab-site.zip`을 풀어 폴더별로 올리세요.
3. 저장소 **Settings → Pages → Build and deployment → Source: Deploy from a branch → Branch: main / (root) → Save**.
4. 1–2분 뒤 `https://<아이디>.github.io/treadmill-lab/` 접속 → Chrome 메뉴 **홈 화면에 추가** → 전체화면 앱처럼 실행.
5. 업데이트: 바뀐 파일을 같은 방법으로 다시 올리면 됩니다 (앱이 "새 버전" 알림을 띄웁니다).

EN: Sign in to GitHub → New repository `treadmill-lab` (Public) → "uploading an existing file" → drop the files keeping the folder structure → Commit → Settings → Pages → Deploy from a branch, `main` / root → open `https://<user>.github.io/treadmill-lab/` → Chrome menu → **Add to Home screen**.

> claude.ai 아티팩트 안에서는 블루투스가 차단되므로(사전 점검에서 확인) 반드시 위처럼 자체 주소에서 여세요. 로컬 파일(file://)로 열면 모듈 스크립트가 막혀 동작하지 않습니다.
> Bluetooth is blocked inside claude.ai artifacts (confirmed by the pre-flight), so open the app from its own HTTPS address. Opening `index.html` as a local file will not work (module scripts are blocked on file://).

## 2. 첫 실행 · First run

1. **설정**: 생년월일·안정 시 심박·러닝머신 한계·프로토콜 확인 (기본값은 확정한 내용으로 채워져 있음).
2. **세션 → 단계 테스트 → 센서: 데모 ×10 → 연결 → 시작**: 알림(음성·진동·비프)과 젖산 입력 흐름을 미리 연습.
3. **분석 → 파일 가져오기**: FatMaxxer `rr.csv`를 넣으면 세션으로 바뀌어 α1 그래프가 뜹니다. Train.Red CSV/FIT는 가져오기 목록에 들어가고, 시간이 겹치는 세션에 자동으로 붙습니다.
4. 실제 테스트 날: **설정 맨 아래 체크리스트** 참고.

EN: Check Settings → practise with Session → Step test → Demo ×10 → import your FatMaxxer `rr.csv` and Train.Red exports in Analysis → on test day follow the checklist at the bottom of Settings.


## 2b. 혼자 할 때 — 젖산을 시작/끝에만 찍을 수 있다면 · Solo use: lactate only at start/end

**권장 조합 (α1 기준 + 젖산 검증):**
1. **연속 단계 테스트(α1 전용)**: 설정 → 프로토콜 → 채혈 초 = `0`. 정지 없이 3분 단계가 이어지고 HRVT1/HRVT2(α1 0.75/0.5)가 나옵니다. 시작 전·종료 직후 젖산은 참고용으로 기록.
2. **검증 세션**: 세션 탭에서 **자유(Free) 모드**에 러닝머신 속도를 입력하고 「채혈 알림」에 분을 적습니다(MLSS: `10,30`, LT1 35분: `35`) → 30초 전 예고 + 정각에 음성·진동 → 벨트를 멈추고 채혈 → 「젖산 입력」(시각에 따라 안정 시/10분/종료로 자동 배치). 분석 화면의 **젖산 검증** 카드가 판정합니다 (종료 ≥ 3 mmol/L이면 MLSS 규칙 자동 적용). LT2 세션 모드는 MLSS가 정해진 뒤 인터벌 훈련(4×8 …)에 씁니다.
   - LT1 세션: 종료 젖산 ≤ 2.0 (안정 시 +1.0 이내) → LT1 아래 ✓ · 2.0–2.5 → 목표 −2 bpm · > 2.5 → 목표 −4 bpm 후 재검증
   - LT2 세션(MLSS): 30분 일정 속도, **10분과 30분** 두 번 채혈 → 상승 ≤ 1.0 mmol/L → MLSS 이하 ✓(다음 +0.3 km/h) · > 1.0 → 0.3–0.5 km/h 낮추기
   - **중간 채혈이 어려우면(종료 1회만)**: 30분을 완주하고 종료 젖산 + 대리 지표로 판정 — 심박 드리프트(8–13분 → 마지막 5분) ≤ 6 bpm이고 SmO2 안정이면 'MLSS 이하 가능성 높음'(다음 +0.3), 드리프트 > 8 bpm·SmO2 계속 하락·RPE ≥ 18 중 하나면 'MLSS 초과 가능성'(−0.3), 그 사이면 경계(재검). 25분 미만이면 판정 보류. 검증 카드의 「목적」을 MLSS로 두면 종료 값이 3 미만이어도 MLSS 규칙으로 판정합니다.
   - **존 반영**: 검증 카드의 「존에 반영」은 그 런의 속도와 마지막 5분 심박으로 역치를 갱신합니다 — 통과한 런은 **하한**(LT ≥ 그 속도/심박)을 올리고, 실패한 런은 **상한**(LT1: 속도 −0.5·심박 −5, MLSS: 속도 −0.3·심박 −3)을 내립니다. 현재 존과 모순되지 않으면 바꾸지 않습니다. Free·LT1·LT2 어느 모드의 세션이든 같습니다.
3. **다일 젖산 곡선**: 다른 날 다른 속도(예 8·9·10·11·12 km/h)로 검증 세션을 쌓으면 분석 탭이 종료 젖산–속도–심박 곡선을 만들어 LT1/LT2를 계산합니다(3점부터, 5점 이상 B등급). 러닝머신을 멈출 필요가 없고 안정 상태 생리에 더 가깝습니다.

EN: Set sampling pause to 0 for a continuous α1-only step test (HRVT1/2). Then run constant-speed **verification sessions** with the treadmill speed entered and one end-of-run lactate sample: LT1 runs → end ≤ 2.0 mmol/L confirms; LT2 runs → sample at 10 and 30 min, a rise ≤ 1.0 confirms MLSS. Several such runs at different speeds form the **multi-day lactate curve** in Analysis, which yields LT1/LT2 without ever stopping mid-run.

## 3. 장비 연결 방식 · How each device connects

| 장비 | 실시간 | 방법 |
|---|---|---|
| Polar H10 | ✅ | Web Bluetooth (앱이 직접 연결, RR 간격 → DFA α1 5초마다) |
| Train.Red FYER 2.0 | 세션 후 | Train.Red 앱에서 측정·랩 → CSV/FIT 내보내기 → 분석 탭에서 가져오기 (FYER 2.0 내장 저장도 가능) |
| StatStrip Xpress | 수동 | 단계 종료 음성 안내 → 키패드 입력 |
| Garmin Instinct 2 | 선택 | 활동 FIT 가져오기(심박·랩, Train.Red 필드 없이도 됨) |

H10은 블루투스 2개 + ANT+를 동시에 지원하므로 이 앱(RR) + Train.Red 앱(HR) + 가민(ANT+)이 함께 받을 수 있습니다.

## 4. 계산 방법 · Methods

- **DFA α1**: FatMaxxer `alpha1v2`와 동일 — 2분 창, 5초 갱신, smoothness-priors 디트렌딩(λ=500), FatMaxxer 스케일(3–15박), 전진+후진 박스, log2 기울기. 아티팩트: 직전 RR 대비 ±5%(HR>95)/±25%(HR<80) Auto. `test/test_dfa.mjs`가 FatMaxxer 자체 테스트 벡터(1.5503173…)와 독립 numpy 구현에 대해 1e-9 이내 일치를 확인합니다.
- **젖산**: LT1 = 기저치 +0.5 mmol/L (보조: log-log, OBLA 2.0); LT2 = Log-Poly-ModDmax (보조: Dmax, OBLA 4.0). 3차 다항 곡선, 심박은 단계 간 선형 보간.
- **HRVT**: 단계 마지막 60초 α1(윈도우가 단계 안에 완전히 들어오도록) vs 심박 회귀 → 0.75 / 0.5.
- **SmO2**: 단계 마지막 60초 평균 vs 속도의 2-분절 선형 회귀 → BP1/BP2, 2분 기울기 < −0.5 %/min = 비정상 상태.
- **SmO2 (일정 부하 세션)**: 5–10분 평균 vs 마지막 5분 평균(드리프트), 마지막 10분 기울기 > −0.3 %/min = 안정 상태, THb 평균 < 12 = 접촉 불량 의심. 젖산 검증 카드·요약·CSV에 표시.
- **삼각측량**: 젖산 = 기준. 차이 ≤5 bpm 일치 / 5–10 주의 / >10 불일치. 등급 A(젖산 + 6단계↑ + 일치 1↑, 불일치 0) / B / C.
- **SmO2 시간 정렬**: Train.Red/가민 파일에 심박이 있으면 세션의 H10 심박과 교차상관(±180 s, 1 s 간격)으로 시계 오차를 추정해 자동 보정하고(평균 오차 < 2.5 bpm일 때), 세션 상세·요약에 '심박 교차검증 ✓'로 표시합니다. 심박이 없는 파일은 시작 시각 기준 정렬 + 수동 보정.
- **심박 드리프트**: 마지막 1/3 vs 첫 1/3 (15분 이상 세션은 처음 5분 램프업 제외).
- **처방**: 3존·5존, LT1 세션 = LT1 −10~−3 bpm(α1 ≥0.75 유지), LT2 세션 = LT2 ±3, 주 1회 LT2(4×8 → 4×10 → 5×10 → 회복 → 3×15 → 2×20 → 템포 30 → 회복), 긴 LT1 매주 +10분, 자동 조정(α1 <0.70 → −3 bpm 등), 8주 또는 드리프트 시 재검사.

## 5. 개발 · Development

```
python3 -m http.server 8765        # then open http://127.0.0.1:8765/
node test/test_dfa.mjs             # DFA α1 vs FatMaxxer vector + numpy reference (needs python3 + numpy)
node test/test_lactate.mjs         # lactate methods vs numpy reference
node test/test_analysis.mjs        # HRVT / SmO2 / triangulation on a synthetic step test
node test/test_prescribe.mjs       # zones, weekly plan, insights
node test/test_session.mjs         # full synthetic step test through the engine (×120)
TZ=Asia/Seoul node test/test_importers.mjs   # Train.Red CSV/FIT, FatMaxxer, Garmin FIT (python3 test/make_fit.py first)
node test/test_version.mjs         # APP_VERSION (app.js) == sw.js VERSION
TZ=Asia/Seoul node test/test_align.mjs       # SmO2 clock-offset estimator (synthetic lags + real Train.Red file if present)
node test/ui_smoke.mjs             # headless Chromium at 384×604 (needs playwright)
```

Files: `js/dfa.js` (α1 engine), `js/lactate.js`, `js/analysis.js`, `js/prescribe.js`, `js/session.js` (test/LT1/LT2 engine), `js/ble.js`, `js/sources.js` (demo/replay), `js/importers.js` + `js/fit.js`, `js/store.js` (IndexedDB), `js/app.js` (UI), `sw.js` (offline).

## 6. 안전 · Safety

훈련 보조 도구이며 의료기기가 아닙니다. 흉통·어지러움·비정상 심박이 있으면 즉시 중단하세요. 러닝머신 비상정지 클립을 착용하세요.
Training aid, not a medical device. Stop immediately if you feel chest pain, dizziness or an abnormal heartbeat. Wear the treadmill safety clip.

License: app code MIT; `vendor/uPlot` MIT; DFA method mirrors FatMaxxer (Apache-2.0, Ian Peake) and Marco Altini's reference code.
