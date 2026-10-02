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
- **삼각측량**: 젖산 = 기준. 차이 ≤5 bpm 일치 / 5–10 주의 / >10 불일치. 등급 A(젖산 + 6단계↑ + 일치 1↑, 불일치 0) / B / C.
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
node test/ui_smoke.mjs             # headless Chromium at 384×604 (needs playwright)
```

Files: `js/dfa.js` (α1 engine), `js/lactate.js`, `js/analysis.js`, `js/prescribe.js`, `js/session.js` (test/LT1/LT2 engine), `js/ble.js`, `js/sources.js` (demo/replay), `js/importers.js` + `js/fit.js`, `js/store.js` (IndexedDB), `js/app.js` (UI), `sw.js` (offline).

## 6. 안전 · Safety

훈련 보조 도구이며 의료기기가 아닙니다. 흉통·어지러움·비정상 심박이 있으면 즉시 중단하세요. 러닝머신 비상정지 클립을 착용하세요.
Training aid, not a medical device. Stop immediately if you feel chest pain, dizziness or an abnormal heartbeat. Wear the treadmill safety clip.

License: app code MIT; `vendor/uPlot` MIT; DFA method mirrors FatMaxxer (Apache-2.0, Ian Peake) and Marco Altini's reference code.
