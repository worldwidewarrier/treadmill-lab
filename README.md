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
2. **검증 세션**: 세션 탭에서 **자유(Free) 모드**에 러닝머신 속도를 입력하고 「채혈 알림」에 분을 적습니다(MLSS: `10,30`, LT1 35분: `35`) → 30초 전 예고 + 정각에 음성·진동 → 벨트를 멈추고 채혈 → **서 있는 동안** 「젖산 입력」(시작 4분 안 = 안정 시, 입력 뒤 다시 달렸으면 10분 값, 멈춘 뒤 입력하고 끝났으면 종료 값으로 자동 배치). 분석 화면의 **젖산 검증** 카드가 판정합니다 (종료 ≥ 3 mmol/L이면 MLSS 규칙 자동 적용). LT2 세션 모드는 MLSS가 정해진 뒤 인터벌 훈련(4×8 …)에 씁니다.
   - **주간 LT1 검증 — 두 랩 (v1.1.17, 권장):** 세션 탭 **「LT1 검증 (두 랩)」** 모드. 홈 화면 「주간 LT1 검증」이 이번 주 검사 속도를 알려 줍니다(첫 주는 현재 LT1 속도). 목요일 아침 공복, 같은 시각, 키트 2벌 준비 → 쉬운 5분 → **랩 1** 검사 속도 10분 → 「정지」 음성에 벨트를 멈추고 **서서** 기다리기 → 30초에 「채혈하세요」(젖산 입력 창이 열림: 땀 닦기 → 손가락 말리기 → 첫 방울 닦기 → 짜지 않기 → 같은 부위) → 60–90초 안에 벨트를 올리고 **「2랩 시작」**(상한 3분, 넘으면 상승 ≤ 0.3만 통과) → **랩 2** 30분 → 정지 → 같은 방법으로 종료 채혈(쿨다운 전) → 입력 → 종료. 판정: **통과** = 랩 1 ≤ 최저 + 0.5(최저 = 최근 계단 검사의 최저 젖산, 없으면 안정 시 기준값 0.8 → 기준선 1.3)이고 랩 1→종료 상승 ≤ 0.5 → 다음 주 +0.2 km/h(계단 검사 LT1 + 0.3까지) · **경계** = 상승 0.5–1.0 또는 랩 1이 기준선 0.2 이내 → 같은 속도 · **실패** = 랩 1 > 기준선, 상승 > 1.0, 종료 > 2.5 → −0.3 km/h. 수준은 통과했는데 30분을 못 버틴 경우(상승 > 0.5 또는 랩 2 드리프트 > 8 bpm)는 **지구력** 문제로 따로 표시(속도가 아니라 롱런 시간·보급 점검). 한 번의 결과로는 존을 바꾸지 않고, **두 주 연속 같은 결과**일 때 홈 화면 「범위 반영」이 LT1 범위를 옮깁니다(통과 2회 → 그 속도·랩 1 심박으로 올림, 실패 2회 → 속도 −0.3·심박 −4로 내림). 확인일에 안정 시 채혈은 필요 없습니다. MLSS 변형(랩 2 = 20분)은 「목적」 전환으로.
   - LT1 세션(단일 런, 15–35분 종료 값): 종료 젖산 ≤ 2.0 (안정 시 +1.0 이내) → LT1 아래 ✓ · 2.0–2.5 → 목표 −2 bpm · > 2.5 → 목표 −4 bpm 후 재검증. **LT1 세션 모드의 후반 천장(v1.1.17):** 20분이 지나면 심박 범위 위쪽 대신 LT1 + 5가 천장이 되어 정상적인 드리프트는 허용하고, 천장을 1분 넘게 넘으면 "속도를 0.3 낮추세요" 음성.
   - LT2 세션(MLSS): 30분 일정 속도, **10분과 30분** 두 번 채혈 → 상승 ≤ 0.5 → MLSS 이하 ✓(다음 +0.3 km/h) · **0.5–1.0 → 그 속도가 MLSS, 유지(상향 없음)** · > 1.0 → 0.4 km/h 낮추기 · 채혈 정지가 3분을 넘었으면 상향 없이 재검(v1.1.17)
   - **중간 채혈이 어려우면(종료 1회만)**: 30분을 완주하고 종료 젖산 + 대리 지표로 판정 — 심박 드리프트(8–13분 → 마지막 5분) ≤ 6 bpm이고 SmO2 안정이면 'MLSS 이하 가능성 높음'(다음 +0.3), 드리프트 > 8 bpm·SmO2 계속 하락 중 하나면 'MLSS 초과 가능성'(−0.3), 그 사이면 경계(재검). 25분 미만이면 판정 보류. 검증 카드의 「목적」을 MLSS로 두면 종료 값이 3 미만이어도 MLSS 규칙으로 판정합니다.
   - **젖산 값은 멈춘 직후, 쿨다운 전에 입력하세요 (v1.1.12).** 앱은 「젖산 입력」을 저장한 시각 바로 앞에서 심박이 달리기 수준을 떠난 지점을 찾아 그곳을 **달리기 종료**로 봅니다. 마지막 5분 심박·α1, 10→30분 드리프트, 달린 시간, SmO2 끝 기울기가 모두 거기서부터 계산되므로, 값을 입력한 뒤에는 쿨다운을 하든 「종료」를 늦게 누르든 결과가 같습니다. 10분 채혈로 잠깐 선 구간은 달린 시간과 심박 평균에서 빠집니다(앱을 일시정지할 필요 없음).
     - 검증 카드의 **「달리기 종료」 칸**에 앱이 찾은 시각과 근거가 나옵니다. 다르면 직접 고치세요 — `35:05`, 숫자만 `3505`, `35.05` 모두 됩니다. 칸을 비우면 자동 판단으로 돌아갑니다.
     - **「달리기 종료 시점 불확실」**이 뜨는 경우: ① 세션 중에 값을 입력하지 않고 나중에 카드에 적었고 기록이 달리기 뒤에도 이어진 경우(심박만으로 추정), ② 멈춘 뒤 6분 넘게 지나 입력한 값이 있는 경우, ③ 입력 전에 심박이 몇 분 간격으로 두 번 내려간 경우(쿨다운 조깅 뒤 채혈 등), ④ 멈추기 전부터 심박이 달리기 수준보다 낮았던 경우, ⑤ 멈춘 뒤 2분 넘게 지나 입력했는데(또는 일시정지를 눌렀는데) 그동안 심박이 25 bpm도 안 내려간 경우(멈춘 것인지 속도만 낮춘 것인지 불분명), ⑥ 입력한 값이 있어도 그 앞에서 심박이 90초 안에 10 bpm 이상 떨어지지 않았거나 멈춘 뒤 12분 넘게 지나 입력한 경우, 또는 기록이 마지막 입력 때보다 훨씬 낮은 심박으로 끝나는 경우(심박만으로 추정). 이때 카드는 추정 시각을 보여 주되 **심박으로는 존을 바꾸지 않고(속도만 반영) 대리 지표 판정도 하지 않습니다.** 시각이 맞으면 「확정」, 아니면 실제 시각을 입력하면 풀립니다.
     - 한계: 달리던 심박보다 8–10 bpm도 안 낮은 쿨다운(가벼운 조깅)은 달리기와 구별하지 못합니다 — 그럴 땐 「달리기 종료」를 직접 입력하세요. 멈춰서 값을 입력한 뒤 달리기 수준에 가까운 조깅을 몇 분 넘게 하면 그 값은 10분 값으로 잡히고 종료는 추정이 됩니다 — 카드에서 값을 옮기고 종료 시각을 입력하세요. 끝에 속도를 낮추고 2분 안에 값을 입력하면 속도를 낮춘 시점이 달리기 종료가 됩니다.
     - **안정 시 기준값 (v1.1.13):** 설정 → 프로필의 「안정 시 젖산」(아침 공복·채혈 규칙대로 잰 값)은 세션에 안정 시 값이 없을 때 LT1 판정의 '종료 ≤ 안정 시 + 1.0'에 쓰입니다. 세션에 직접 잰 값이 있으면 그 값이 우선합니다.
     - 젖산 칸은 0.3–25 mmol/L만 받고, 쉼표도 소수점으로 읽습니다(`4,7` = 4.7). v1.1.11 카드에서 고친 세션은 그때 직접 입력한 칸만 고정되고, 나머지는 새 규칙으로 다시 배치됩니다.
   - **존 반영**: 검증 카드의 「존에 반영」은 그 런의 속도와 **달리기 마지막 5분** 심박으로 역치를 갱신합니다 — 통과한 런은 **하한**(LT ≥ 그 속도/심박)을 올리고, 실패한 런은 **상한**(LT1: 속도 −0.5·심박 −5, MLSS: 속도 −0.3·심박 −3)을 내립니다. 현재 존과 모순되지 않으면 바꾸지 않습니다. Free·LT1 모드와 LT2 모드의 1회 반복(템포)은 같은 방식입니다.
   - **인터벌(LT2 모드, 2회 이상 반복)**: 회복 구간에서 젖산이 빠지므로 LT1·MLSS 판정을 하지 않습니다. 마지막 반복 뒤 젖산이 3–4.5면 목표 강도, 반복 사이 상승이 1.0을 넘거나 6 이상이면 속도를 낮추라는 안내만 하고, 존은 바꾸지 않으며 다일 곡선에도 넣지 않습니다.
3. **다일 젖산 곡선**: 다른 날 다른 속도(예 8·9·10·11·12 km/h)로 검증 세션을 쌓으면 분석 탭이 젖산–속도–심박 곡선을 만들어 LT1/LT2를 계산합니다(3점부터, 5점 이상 B등급). 러닝머신을 멈출 필요가 없고 안정 상태 생리에 더 가깝습니다. **v1.1.17 규칙:** 젖산은 두 랩 검증의 종료 값(랩 2, 20–35분)과 15–35분 정속 런의 종료 값만; 심박은 랩 1의 5–10분, 단일 런은 8–13분(드리프트 전); 35분 넘게 달린 뒤의 값은 지구력 판독으로 제외(20–35분 사이 중간 값이 있으면 그 값이 점). 빠진 세션은 이유와 함께 곡선 아래에 나옵니다.

4. **계획 탭 = 10/10에 정한 한 주(v1.1.18)**: 아침은 달리기(평일 05:30 · 주말 09:00), 저녁은 다른 운동. 월 쉬운 런 50 · **화 유일한 고강도**(MLSS 속도의 LT2 사다리 4×8 → 4×10 → 5×10 → 회복 → 3×15 → 2×20, 또는 달력이 정한 MLSS 검증 30분·쉬운 런) · 수 쉬운 런 50 · **목 두 랩 LT1 검증 45분** · 금 쉬운 런 30(선택) · 토 롱런 70분부터 매주 +10, 100까지(30일 최장 × 1.1 상한, 회복주 × 0.7; 계단 테스트 주는 계단 테스트) · 일 쉬운 런 50. 날마다 저녁 줄(월 홈 세션, 화 근력 A, 수 걷기, 목 근력 B, 금 폼롤링, 일 경사 걷기 선택). **설정 → 계획 → 주 달력**에 `날짜 종류 메모` 한 줄씩(recovery · mlss · easy · blood · step)을 적으면 그 주의 화·목·토가 바뀌고 사다리·롱런 주차가 그에 맞춰 셉니다(첫 실행이 10/12 시작 달력을 채워 둠). 「왜 이렇게 짰나」를 펼치면 볼륨·강도·요일의 근거가 나옵니다.
EN: Set sampling pause to 0 for a continuous α1-only step test (HRVT1/2). **Plan tab (v1.1.18) = the week decided on 10/10:** mornings run (05:30 weekdays, 09:00 weekends), evenings other exercise; Mon easy 50 · Tue the one hard day (LT2 ladder at MLSS speed, or the MLSS check / an easy run when the week calendar says so) · Wed easy 50 · Thu the two-lap LT1 check · Fri easy 30 optional · Sat long run 70 → 100 (+10 a week, ≤ 110 % of the 30-day longest, × 0.7 in a recovery week; a step test in step-test weeks) · Sun easy 50, each day with its evening line. Settings → Plan → week calendar: one `date kind note` line per week (recovery · mlss · easy · blood · step); the first run fills in the calendar from 10/12. The 「why」 card explains the volume, the intensity distribution and the days. **Weekly LT1 check (v1.1.17): the two-lap mode** — easy 5 min → lap 1 10 min at the speed Home proposes → stop the belt and stand still, sample at 30–45 s (the prompt opens) → belt up and "Start lap 2" within 60–90 s (cap 3 min) → lap 2 30 min → stop, end sample before any cool-down. Pass = lap 1 ≤ lowest + 0.5 and rise ≤ 0.5 → next week +0.2 km/h; borderline → same speed; fail (lap 1 over the line, rise > 1.0, end > 2.5) → −0.3; the band moves after two consecutive results (Home → apply). Single constant-speed runs with one end sample still get a verdict (end ≤ 2.0 confirms LT1); LT2 runs → sample at 10 and 30 min: a rise ≤ 0.5 confirms MLSS with a raise, 0.5–1.0 confirms it as *the* MLSS (hold). Several such runs at different speeds form the **multi-day lactate curve** in Analysis, which yields LT1/LT2 without ever stopping mid-run.
**Type the lactate value right after you stop, before any cool-down (v1.1.12):** the card measures everything "at the end of the run" from where the heart rate left its running level before that entry — shown in the "run ended at" field, which you can correct (`35:05`, `3505` or `35.05`). After that a cool-down or a late Finish changes nothing. If nothing was logged near the end, or the picture has two readings (a value typed more than 6 min after the stop, two steps down minutes apart, a stop from a level below the run, a value typed minutes after a drop that never went deep), the card says the end is uncertain: it shows its estimate, but puts no heart rate into the zones and makes no proxy call until you confirm or correct the time. A cool-down less than 8–10 bpm below the run cannot be told from the run. Interval sessions (LT2 mode, two or more reps) get an interval verdict only and never change zones.

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
- **일시정지**: 단계·인터벌·경과 시계가 멈추고, 재개하면 남은 시간이 그대로 이어집니다(기록은 계속되고 그 구간의 α1 행은 '일시정지'로 표시). 일시정지 중에 「단계 종료」나 「종료」를 누르면 그 단계는 일시정지를 누른 시점에 끝난 것으로 기록됩니다. 단계 표의 '마지막 60초'는 아직 벽시계 기준이라, 단계 끝 60초 안에 일시정지가 있으면 그 단계 값은 참고만 하세요.
- **스트랩 무신호**: 5초 넘게 심박 알림이 없으면(범위 이탈·재연결 중) 그 구간의 행은 시간축만 남기고 심박·α1을 비웁니다(마지막 값을 되풀이해 적지 않음). 존 체류 시간도 세지 않습니다.
- **달리기 종료 시점 (검증 카드, v1.1.12)**: 기록은 「종료」를 누를 때까지 이어지지만 판정은 달리기가 끝난 지점까지로 합니다(`analysis.js` `runTimeline`). 정지는 **기록된 것이 있는 곳에서만** 찾습니다 — 「젖산 입력」(건너뛴 입력 포함), 심박이 확인해 주는 「일시정지」, LT2 세션의 반복 시계, 카드에 직접 넣은 시각. 심박은 그 시각을 정하는 데만 씁니다: 입력 시각 앞 12분 안에서, 직전 2분의 중앙값(달리기 수준)에 머물다가 10 bpm 이상 떨어지고 이어지는 1분이 8 bpm 이상 낮은 마지막 지점. 걷다가 선 경우(계단식 하강)는 첫 단계를 종료로 보고, 두 단계 사이가 3분을 넘으면 불확실로 표시합니다. 기록된 것이 없고 기록이 달리기 수준에서 끝나지 않으면 심박만으로 추정하되, **불확실한 종료에서는 심박에 기대는 결론을 내지 않습니다**(심박으로 존 변경 없음, 대리 판정 보류, 세션 숫자는 이전 버전 방식 그대로; 심박만으로 추정한 종료에서는 젖산 값 배치도 이전처럼 기록 시계 기준). 가져온 파일처럼 심박이 몇 초에 한 번만 있는 기록은 1초 간격으로 채워 같은 규칙을 적용하고, 마지막 5분 구간에 심박이 1분어치도 없으면(종료 전에 스트랩을 벗은 경우) 숫자를 내지 않습니다. 심박으로 잡은 종료는 보통 실제보다 0–30초 늦고(드물게 ±45초 넘게 어긋남), α1은 끝 15초를 버리며, 중간 정지 뒤에는 심박이 달리기 수준으로 돌아온 뒤 2분(α1 창)까지의 α1도 쓰지 않습니다. 다일 곡선에서 종료가 불확실한 세션의 심박은 양옆 속도의 확실한 세션 사이에서만 읽고, 그 밖이면 역치 심박을 내지 않습니다(적용 버튼 비활성). 달리는 중에 「종료」를 누른 세션은 숫자가 이전 버전과 같습니다. 요약 복사와 CSV(`# run_end_s,…,found_by,…,certain,…`)에 종료 시각과 근거가 들어갑니다. 검증은 모의 심박(정지·걷기·조깅·서지·드리프트·끊김 조합 수천 건)으로 했고 실제 기록으로는 아직 못 했습니다 — 처음 몇 번은 카드의 「달리기 종료」 시각이 기억과 맞는지 확인하세요.
- **처방**: 3존·5존, LT1 세션 = LT1 −10~−3 bpm(α1 ≥0.75 유지), LT2 세션 = LT2 ±3, 주 1회 LT2(4×8 → 4×10 → 5×10 → 회복 → 3×15 → 2×20 → 템포 30 → 회복), 긴 LT1 매주 +10분, 자동 조정(α1 <0.70 → −3 bpm 등), 8주 또는 드리프트 시 재검사.

## 5. 개발 · Development

```
python3 -m http.server 8765        # then open http://127.0.0.1:8765/
node test/test_dfa.mjs             # DFA α1 vs FatMaxxer vector + numpy reference (needs python3 + numpy)
node test/test_lactate.mjs         # lactate methods vs numpy reference
node test/test_analysis.mjs        # HRVT / SmO2 / triangulation on a synthetic step test
node test/test_prescribe.mjs       # zones, weekly plan, insights
node test/test_session.mjs         # full synthetic step test through the engine (×120)
node test/test_engine.mjs          # engine on a hand-driven clock: pause (clocks, stage end), numeric settings, silent strap, nothing carried into the next session
node test/test_ble.mjs             # Bluetooth source against a mock strap: flaky reconnects, stuck GATT calls, failed / cancelled first connection, two sources on one strap (≈45 s)
node test/test_alerts.mjs          # screen wake lock: one lock, the last of several quick on/off requests wins
node test/test_verify.mjs          # lactate verification verdicts, zone updates, multi-day curve
node test/test_run_end.mjs         # where the running stopped: simulated runs with stops, walks, jogs, surges, pauses, gaps; uncertain ends; odd records (≈10 s)
node test/test_twolap.mjs          # the two-lap LT1 check (v1.1.17): engine phases/cues/tags, verdict (pass / borderline / fail, strict gap, durability), band finder, curve rules, MLSS hold, late ceiling, long-run cap, α1 gate, resting-lactate reminder
TZ=Asia/Seoul node test/test_importers.mjs   # Garmin FIT + RR text always; Train.Red / FatMaxxer parts when the private files are present
node test/test_version.mjs         # APP_VERSION (app.js) == sw.js VERSION
TZ=Asia/Seoul node test/test_align.mjs       # SmO2 clock-offset estimator (synthetic lags + real Train.Red file if present)
node test/ui_smoke.mjs             # headless Chromium at 384×604 (needs playwright + the dev server on :8765)
node test/ui_flows.mjs             # LT1 / LT2 demo sessions, backup, language
node test/ui_verify.mjs            # verification card, multi-day curve, continuous test
node test/ui_card.mjs              # verification card for recordings that run on after the stop: end-of-run field, uncertain → confirm, typed end, emptied fields, CSV line
node test/ui_strap.mjs             # the Bluetooth path through the UI with a mock strap (double tap, pause, cue on another tab, reconnect, settings)
node test/ui_data.mjs              # generated RR + Train.Red-style files: replay, SmO2 auto-attach + clock alignment, backup → delete all → restore (also during a session), stage edits
node test/ui_sw.mjs                # service worker: install, offline start, update served like GitHub Pages, host error / slow host → cached app (own server)
node test/ui_twolap.mjs            # the two-lap check through the UI with the demo strap: setup, prompts, card, CSV, band change on Home, Settings, one-time fixes
```

Tests that need the owner's private exports skip those parts when the files are absent (`test/data/README.md`). Screenshots go to `$TL_SHOTS` (default: a temp folder).

Files: `js/dfa.js` (α1 engine), `js/lactate.js`, `js/analysis.js`, `js/prescribe.js`, `js/session.js` (test/LT1/LT2 engine), `js/ble.js`, `js/sources.js` (demo/replay), `js/importers.js` + `js/fit.js`, `js/store.js` (IndexedDB), `js/app.js` (UI), `sw.js` (offline).

## 6. 안전 · Safety

훈련 보조 도구이며 의료기기가 아닙니다. 흉통·어지러움·비정상 심박이 있으면 즉시 중단하세요. 러닝머신 비상정지 클립을 착용하세요.
Training aid, not a medical device. Stop immediately if you feel chest pain, dizziness or an abnormal heartbeat. Wear the treadmill safety clip.

License: app code MIT; `vendor/uPlot` MIT; DFA method mirrors FatMaxxer (Apache-2.0, Ian Peake) and Marco Altini's reference code.
