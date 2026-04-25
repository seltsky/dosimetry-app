# Dosimetry App — AI Maintainer Guide

Y-90 TARE (Transarterial Radioembolization) dosimetry 평가 PWA. Partition Model + MIRD 계산기.

- Live: https://seltsky.github.io/dosimetry-app/

## 사용자 프로파일

- 의사·연구자 (Interventional Radiology)
- 텔레그램으로 소통 (chat_id 6656604831)
- 한국어 답변, 존댓말, 마크다운 금지(불릿 OK)
- Y-90 dosimetry 임상 적용 중

## 핵심 컨셉

- HCC·간내 종양에 Y-90 방사성동위원소 투여 시 선량 계산
- Partition Model (3 compartment: tumor / normal liver / lung)
- 입력: tumor mass, liver mass, T/N ratio, lung shunt fraction
- 출력: 권장 활성도 (GBq), 각 compartment별 흡수선량 (Gy)
- 안전 한계: lung dose <30 Gy, normal liver <70 Gy

## 기술 스택

- HTML + vanilla JS + CSS
- 클라이언트 단 계산만 (서버·DB 없음)
- 입력은 사용자가 직접 (의무기록·CT 측정값)
- 결과는 화면 표시만, 저장 안 함

## 파일 구조

```
dosimetry-app/
├── index.html
├── dosimetry.js          partition model 계산 로직
├── style.css
├── manifest.json
└── references.json       참고 논문 메타데이터
```

추가 참조 파일: ~/Library/CloudStorage/Dropbox/앱/remotely-save/remotely-save/연구/공통/dosimetry-references.xlsx (참고문헌 DB)

## 절대 하지 말 것

1. **계산식 임의 변경 금지** — 임상 결정에 영향. 변경 시 사용자에게 식 명시 + 출처 논문 인용
2. **안전 한계값 임의 변경 금지** — Salem et al, EANM guideline 등 표준 따름
3. **환자 데이터 저장 기능 추가 금지** — 의료 데이터는 EMR에. 이 앱은 즉석 계산기 역할
4. **참고문헌 임의 추가 금지** — references.json은 dosimetry 스킬과 연동되어 있어 형식·내용 일치 필요

## 자주 받을 요청

### "MIRD 모델 추가"
- dosimetry.js에 별도 함수로 분리
- 입력 폼도 분리 (Partition vs MIRD 선택)

### "참고 논문 추가"
- references.json + Dropbox 엑셀 동기화
- dosimetry 스킬 (~/.claude/skills/dosimetry/) 의 references 경로 확인

### "PDF 출력 기능"
- 계산 결과 PDF 저장 — html2pdf.js 같은 라이브러리 필요
- 신중히 결정 (의존성 추가)

### "복수 환자 비교"
- 이 앱은 1인용·1회용 설계. 복수 케이스 비교는 별도 도구로
- 또는 input/output을 JSON export만 추가

## 임상 정확도 책임

이 앱은 의사가 보조 도구로 사용하는 것이 전제입니다. AI가 변경 시:
- 모든 계산식·상수 변경은 출처 명시
- 안전 한계 변경은 가이드라인 출처 인용
- 변경 후 기존 케이스로 회귀 테스트 (입력 같으면 출력 같은지)

## dosimetry 스킬과의 관계

~/.claude/skills/dosimetry/skill.md 가 임상 dosimetry 평가 스킬. 이 웹앱은 그 스킬의 "계산기 부분"을 시각화한 것. 두 시스템 모두 같은 수식·한계값 사용 — 한쪽 변경 시 다른 쪽도 검토.

## 텔레그램 응답 톤

- 의학 답변은 정확성 우선
- 임상 의사결정에 영향 주는 답변은 출처 명시
- 단순 UI 변경은 평소 톤대로

마지막 업데이트: 2026-04-26
