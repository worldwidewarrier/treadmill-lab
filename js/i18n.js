// Bilingual strings. UI shows Korean first with English beneath (mode 'both'), or one language.
export const S = {
  app: { ko: '러닝머신 랩', en: 'Treadmill Lab' },
  nav_home: { ko: '홈', en: 'Home' }, nav_live: { ko: '세션', en: 'Session' }, nav_analysis: { ko: '분석', en: 'Analysis' }, nav_plan: { ko: '계획', en: 'Plan' }, nav_settings: { ko: '설정', en: 'Settings' },
  // home
  zones_title: { ko: '현재 역치', en: 'Current thresholds' }, no_zones: { ko: '아직 역치가 없습니다. 단계 테스트를 하거나 FatMaxxer 기록을 가져오세요.', en: 'No thresholds yet. Run a step test or import a FatMaxxer recording.' },
  lt1: { ko: 'LT1 (유산소 역치)', en: 'LT1 (aerobic threshold)' }, lt2: { ko: 'LT2 (무산소 역치)', en: 'LT2 (anaerobic threshold)' },
  today: { ko: '오늘의 세션', en: "Today's session" }, start_session: { ko: '세션 시작', en: 'Start session' }, start_test: { ko: '단계 테스트', en: 'Step test' }, import_file: { ko: '파일 가져오기', en: 'Import file' },
  last_session: { ko: '최근 세션', en: 'Recent session' }, retest_due: { ko: '재검사 권장: 마지막 테스트 후 {weeks}주 경과', en: 'Retest recommended: {weeks} weeks since last test' },
  grade: { ko: '신뢰도', en: 'Confidence' }, source: { ko: '근거', en: 'Source' }, speed: { ko: '속도', en: 'Speed' }, hr: { ko: '심박', en: 'HR' }, incline: { ko: '경사', en: 'Incline' },
  // live
  mode: { ko: '모드', en: 'Mode' }, mode_test: { ko: '단계 테스트', en: 'Step test' }, mode_lt1: { ko: 'LT1 세션', en: 'LT1 session' }, mode_lt2: { ko: 'LT2 세션', en: 'LT2 session' }, mode_free: { ko: '자유', en: 'Free' },
  source_ble: { ko: 'Polar H10 (블루투스)', en: 'Polar H10 (Bluetooth)' }, source_demo: { ko: '데모 (가상 스트랩)', en: 'Demo (virtual strap)' }, source_replay: { ko: '재생 (RR 파일)', en: 'Replay (RR file)' },
  connect: { ko: 'H10 연결', en: 'Connect H10' }, disconnect: { ko: '연결 해제', en: 'Disconnect' }, connected: { ko: '연결됨', en: 'Connected' }, connecting: { ko: '연결 중…', en: 'Connecting…' }, reconnecting: { ko: '재연결 중…', en: 'Reconnecting…' }, disconnected: { ko: '연결 안 됨', en: 'Not connected' },
  start: { ko: '시작', en: 'Start' }, stop: { ko: '종료', en: 'Finish' }, next_stage: { ko: '다음 단계', en: 'Next stage' }, lap: { ko: '랩', en: 'Lap' }, pause: { ko: '일시정지', en: 'Pause' }, resume: { ko: '재개', en: 'Resume' },
  stage: { ko: '단계', en: 'Stage' }, remaining: { ko: '남은 시간', en: 'Remaining' }, elapsed: { ko: '경과', en: 'Elapsed' }, sampling: { ko: '채혈 정지', en: 'Sampling pause' }, warmup: { ko: '워밍업', en: 'Warm-up' },
  alpha1: { ko: '알파1', en: 'α1' }, artifacts: { ko: '아티팩트', en: 'Artifacts' }, samples: { ko: '샘플', en: 'Samples' }, rmssd: { ko: 'RMSSD', en: 'RMSSD' }, battery: { ko: '배터리', en: 'Battery' },
  target: { ko: '목표', en: 'Target' }, in_zone: { ko: '존 안', en: 'In zone' }, above_zone: { ko: '높음 — 속도를 줄이세요', en: 'High — slow down' }, below_zone: { ko: '낮음 — 속도를 올리세요', en: 'Low — speed up' }, waiting: { ko: '계산 대기 (2분 필요)', en: 'Waiting (needs 2 min)' },
  lactate_entry: { ko: '젖산 입력 (mmol/L)', en: 'Lactate (mmol/L)' }, rpe_entry: { ko: 'RPE (6–20)', en: 'RPE (6–20)' }, save: { ko: '저장', en: 'Save' }, skip: { ko: '건너뛰기', en: 'Skip' }, cancel: { ko: '취소', en: 'Cancel' },
  stop_criteria: { ko: '종료 기준: 젖산 ≥ {la} mmol/L 또는 RPE ≥ {rpe} 또는 자발적 중단', en: 'Stop when lactate ≥ {la} mmol/L, RPE ≥ {rpe}, or voluntary' },
  stop_reached: { ko: '종료 기준 도달 — 이번 단계 후 종료하세요', en: 'Stop criteria reached — finish after this stage' },
  demo_speed: { ko: '배속', en: 'Speed-up' }, replay_pick: { ko: 'RR 파일 선택', en: 'Choose RR file' },
  keep_awake: { ko: '화면 켜짐 유지', en: 'Keep screen on' }, keep_awake_fail: { ko: '화면 켜짐 유지를 켤 수 없습니다. 화면 꺼짐 시간을 길게 설정하세요.', en: 'Wake lock unavailable — lengthen your screen timeout.' },
  session_saved: { ko: '세션 저장됨', en: 'Session saved' }, confirm_stop: { ko: '세션을 종료할까요?', en: 'Finish this session?' }, yes: { ko: '예', en: 'Yes' }, no: { ko: '아니오', en: 'No' },
  // analysis
  sessions: { ko: '세션 기록', en: 'Sessions' }, tests: { ko: '테스트', en: 'Tests' }, imports: { ko: '가져온 파일', en: 'Imports' }, no_sessions: { ko: '저장된 세션이 없습니다.', en: 'No sessions saved yet.' },
  stage_table: { ko: '단계표', en: 'Stage table' }, thresholds: { ko: '역치 계산', en: 'Threshold methods' }, triangulation: { ko: '삼각측량', en: 'Triangulation' }, apply_zones: { ko: '이 역치를 존에 적용', en: 'Apply these thresholds' }, applied: { ko: '적용됨', en: 'Applied' },
  attach_smo2: { ko: 'SmO2 파일 붙이기 (Train.Red CSV/FIT)', en: 'Attach SmO2 file (Train.Red CSV/FIT)' }, offset: { ko: '시간 보정', en: 'Time offset' }, delete: { ko: '삭제', en: 'Delete' }, export_csv: { ko: 'CSV 내보내기', en: 'Export CSV' }, copy_summary: { ko: 'Claude용 요약 복사', en: 'Copy summary for Claude' },
  method: { ko: '방법', en: 'Method' }, lactate: { ko: '젖산', en: 'Lactate' }, smo2: { ko: 'SmO2', en: 'SmO2' }, agree: { ko: '일치', en: 'agree' }, caution: { ko: '주의', en: 'caution' }, disagree: { ko: '불일치', en: 'disagree' },
  time_in_zone: { ko: '존 체류', en: 'Time in zone' }, drift: { ko: '심박 드리프트', en: 'HR drift' }, mean_alpha: { ko: '평균 α1', en: 'Mean α1' }, duration: { ko: '시간', en: 'Duration' },
  // plan
  weekly_plan: { ko: '주간 계획', en: 'Weekly plan' }, week: { ko: '주차', en: 'Week' }, zones_table: { ko: '훈련 존', en: 'Training zones' }, insights: { ko: '자동 조정', en: 'Auto-adjustments' }, rest: { ko: '휴식', en: 'Rest' }, long_run: { ko: '긴 LT1', en: 'Long LT1' },
  goal_base: { ko: '유산소 기반·지방대사', en: 'Aerobic base / fat metabolism' }, goal_perf: { ko: '기록 향상', en: 'Performance' }, goal_health: { ko: '건강 유지', en: 'Health' },
  // settings
  profile: { ko: '프로필', en: 'Profile' }, birth: { ko: '생년월일', en: 'Date of birth' }, rest_hr: { ko: '안정 시 심박', en: 'Resting HR' }, max_hr: { ko: '최대 심박', en: 'Max HR' }, max_hr_tanaka: { ko: '추정(Tanaka 208−0.7×나이)', en: 'Estimated (Tanaka 208−0.7×age)' },
  treadmill: { ko: '러닝머신', en: 'Treadmill' }, protocol: { ko: '테스트 프로토콜', en: 'Test protocol' }, alpha_settings: { ko: 'α1 계산', en: 'α1 computation' }, alert_settings: { ko: '알림', en: 'Alerts' }, plan_settings: { ko: '훈련 가능 시간', en: 'Availability' }, data: { ko: '데이터', en: 'Data' },
  backup: { ko: 'JSON 백업 내보내기', en: 'Export JSON backup' }, restore: { ko: '백업 복원', en: 'Restore backup' }, clear_all: { ko: '모든 데이터 삭제', en: 'Delete all data' }, lang: { ko: '표시 언어', en: 'Display language' },
  voice: { ko: '음성 안내 (한국어)', en: 'Voice prompts (Korean)' }, vibrate: { ko: '진동', en: 'Vibration' }, beep: { ko: '비프음', en: 'Beep' }, test_alert: { ko: '알림 테스트', en: 'Test alerts' },
  saved: { ko: '저장됨', en: 'Saved' }, disclaimer: { ko: '이 앱은 훈련 보조 도구이며 의료기기가 아닙니다. 흉통·어지러움·비정상 심박이 느껴지면 즉시 중단하세요.', en: 'This app is a training aid, not a medical device. Stop immediately if you feel chest pain, dizziness or an abnormal heartbeat.' },
};

export function fmtTemplate(str, vars = {}) { return str.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '')); }

let langMode = 'both';
export function setLang(m) { langMode = m; }
export function getLang() { return langMode; }
/** Returns HTML for a bilingual label. */
export function t(key, vars) {
  const s = S[key]; if (!s) return key;
  const ko = fmtTemplate(s.ko, vars), en = fmtTemplate(s.en, vars);
  if (langMode === 'ko') return `<span class="ko">${ko}</span>`;
  if (langMode === 'en') return `<span class="ko">${en}</span>`;
  return `<span class="ko">${ko}</span><span class="en">${en}</span>`;
}
/** Plain text (first language). */
export function tx(key, vars) { const s = S[key]; if (!s) return key; return fmtTemplate(langMode === 'en' ? s.en : s.ko, vars); }

// Korean voice prompts (spoken) — kept short for a treadmill.
export const VOICE = {
  stage_start: (n, speed, incline) => `${n}단계. 시속 ${speed} 킬로미터${incline ? `, 경사 ${incline}퍼센트` : ''}.`,
  stage_warn: (sec) => `${sec}초 후 채혈 정지.`,
  stage_end: () => '정지. 채혈하세요.',
  free_cue: (min) => `${min}분 경과. 벨트를 멈추고 채혈하세요.`,
  pause_warn: (sec) => `${sec}초 후 다음 단계.`,
  resume: (n, speed) => `${n}단계 시작. 시속 ${speed} 킬로미터.`,
  zone_high: () => '심박 높음. 속도를 줄이세요.',
  zone_low: () => '심박 낮음. 속도를 올리세요.',
  alpha_low: () => '알파1 낮음. 강도를 낮추세요.',
  alpha_ok: () => '알파1 정상.',
  interval_work: (n, total) => `${n}번째 인터벌 시작. 총 ${total}회.`,
  interval_rest: () => '회복. 천천히.',
  stop_criteria: () => '종료 기준 도달. 이번 단계 후 종료하세요.',
  finished: () => '세션 종료. 저장했습니다.',
  connected: () => '센서 연결됨.',
  disconnected: () => '센서 연결 끊김.',
  artifacts_high: () => '아티팩트 많음. 전극을 확인하세요.',
  warmup_end: () => '워밍업 끝. 1단계 시작.',
  halfway: () => '절반 지났습니다.',
  minute_left: () => '1분 남았습니다.',
};
