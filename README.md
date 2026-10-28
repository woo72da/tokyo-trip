# 도쿄 여행 PWA

아이폰 홈 화면에 추가해서 쓰는 오프라인 여행일정 앱입니다. 서버나 빌드 과정이 필요 없는 정적 파일입니다.

## 구성

| 파일 | 역할 |
|---|---|
| `data/trip.json` | 일정·항공·숙소·체크리스트·가이드 데이터 (**일정 수정은 여기서만**) |
| `index.html`, `styles.css`, `app.js` | 화면 (오늘 / 일정 / 정보 / 체크) |
| `sw.js` | 오프라인 캐시 |
| `manifest.webmanifest`, `icons/` | 홈 화면 앱 설정 |

## 로컬에서 보기

```bash
python3 -m http.server 8765 --directory travel-app
```

`http://localhost:8765/?now=2026-11-05T15:30` 처럼 `now`를 붙이면 여행 중 특정 시각의 화면을 미리 볼 수 있습니다.

## 배포 (HTTPS 필요: 서비스 워커는 HTTPS에서만 동작)

- **GitHub Pages**: 저장소를 만들고 `travel-app` 폴더 안의 파일을 업로드한 뒤, Settings → Pages에서 브랜치를 지정합니다.
- **Netlify Drop**: app.netlify.com/drop 에 `travel-app` 폴더를 끌어다 놓습니다.

배포한 URL은 공개 주소입니다. 그래서 예약번호는 `trip.json`에 넣지 않고, 앱의 정보 탭에서 각 기기에만 저장합니다.

## 아이폰 설치

1. Safari로 URL을 엽니다.
2. 공유 버튼 → **홈 화면에 추가**를 누릅니다.
3. 홈 화면 아이콘으로 한 번 연 뒤 **비행기 모드에서 다시 열어** 오프라인 동작을 확인합니다.

## 일정을 고친 뒤

1. `data/trip.json`을 수정하고 다시 배포합니다.
2. 앱 화면 파일(html/css/js)을 고쳤다면 `sw.js`의 `VERSION`도 올립니다 (예: `trip-v2`).
3. 폰에서 인터넷에 연결된 상태로 앱을 한 번 열면 새 일정이 반영됩니다.
