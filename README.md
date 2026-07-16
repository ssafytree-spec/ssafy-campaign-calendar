# 16기 모집홍보 현황판 (파일 업로드 배포 버전)

npm, git 명령어, 터미널 전혀 안 씁니다. **파일을 만들고 → GitHub 웹사이트에 드래그해서 올리기만** 하면 배포됩니다.

구성 파일은 5개뿐입니다.
- `index.html` — 페이지 뼈대
- `styles.css` — 디자인
- `config.js` — Supabase 주소/키/접속코드 (여기만 수정하면 됨)
- `app.js` — 실제 기능 코드 (현황판/캘린더/인력배정/D-Day)
- `supabase/schema.sql` — DB 테이블 생성용 (Supabase에만 붙여넣음, 배포 파일 아님)

---

## 1단계. Supabase 세팅 (10분, 무료, 카드 등록 불필요)

1. https://supabase.com 접속 → **Start your project**
2. **GitHub 계정으로 로그인**
3. **New Project**
   - Project name: `promo-board`
   - Database Password: 아무 값 (메모만 해두기, 평소에 쓸 일 없음)
   - Region: **Northeast Asia (Seoul)**
   - Plan: **Free**
4. 생성 완료까지 1~2분 대기

### 테이블 생성
5. 왼쪽 메뉴 **SQL Editor → New query**
6. `supabase/schema.sql` 파일을 텍스트 에디터(메모장 등)로 열어서 **전체 복사 → 붙여넣기 → Run**
7. "Success" 확인 (왼쪽 **Table Editor**에서 tasks 등 6개 테이블 + 샘플 데이터 보이면 성공)

### 파일 업로드용 저장소(Storage) 만들기
8. 왼쪽 메뉴 **Storage → New bucket**
   - Name: `files` (반드시 이 이름)
   - **Public bucket 체크 ON**
9. 만든 `files` 버킷 클릭 → 상단 **Policies → New policy → For full customization**
   - Policy name: `anon upload`
   - Allowed operation: **INSERT, SELECT** 체크
   - Target roles: `anon`
   - USING / WITH CHECK: `true` 입력 → Save

### 키 확인
10. 왼쪽 메뉴 **Project Settings(톱니바퀴) → API**
    - `Project URL` 복사
    - `anon public` 키 복사
    - (`service_role` 키는 사용 금지 — 절대 외부 노출되면 안 되는 키)

---

## 2단계. config.js 수정 (1분)

`config.js` 파일을 메모장으로 열어서 값 3개만 바꿉니다:

```js
window.APP_CONFIG = {
  SUPABASE_URL: "https://내프로젝트주소.supabase.co",
  SUPABASE_ANON_KEY: "eyJ...로 시작하는 긴 키",
  ACCESS_CODE: "원하는접속코드",
};
```

저장하면 끝입니다. 코딩 지식 없이 이 3줄만 채우면 됩니다.

---

## 3단계. GitHub에 파일 업로드해서 배포 (5분, 명령어 없음)

1. https://github.com 접속 → 로그인 → 우측 상단 **+ → New repository**
   - Repository name: `promo-board` (아무거나)
   - **Public** 선택 (무료 계정은 Public이어야 Pages 무료 사용 가능)
   - Create repository

2. 저장소 생성 후 화면에서 **"uploading an existing file"** 링크 클릭
   (또는 상단 **Add file → Upload files**)

3. `index.html`, `styles.css`, `config.js`, `app.js` **4개 파일을 그대로 드래그 앤 드롭**
   - `supabase` 폴더는 올릴 필요 없음 (Supabase SQL Editor용이라 배포와 무관)
   - Commit changes 클릭

4. 저장소 상단 **Settings → Pages**
   - Source: `Deploy from a branch`
   - Branch: `main` / 폴더: `/(root)` 선택 → Save

5. 1~2분 후 안내되는 주소로 접속
   `https://내아이디.github.io/promo-board/`
   → 접속코드 입력 → 샘플 데이터 보이면 성공

이 주소 + 접속코드를 협력업체(10명 내외)에게 공유하면 됩니다.

---

## 4단계. 나중에 수정할 때

코드를 고치고 싶으면:
1. 로컬에서 해당 파일(`app.js` 등) 메모장으로 열어 수정
2. GitHub 저장소 페이지에서 그 파일 클릭 → 연필 아이콘(Edit) 또는
   **Add file → Upload files**로 같은 이름 파일 다시 올리기 (덮어쓰기)
3. Commit 하면 1~2분 내로 실사이트에 자동 반영 (별도 배포 명령 불필요)

---

## 실사용 팁

- **기존 엑셀 데이터 옮기기**: Supabase 대시보드 → Table Editor → tasks 테이블 → Insert → "Import data from CSV"
- **화면이 하얗게 나올 때**: `config.js`에 URL/키 오타 없는지 확인 (브라우저 F12 → Console 탭에서 에러 메시지 확인 가능)
- **수정했는데 반영 안 될 때**: 브라우저 강력 새로고침 (Ctrl+Shift+R / Cmd+Shift+R)
- **파일 업로드 실패**: Storage에 `files` 버킷 없거나 Public 체크 안 했거나 정책 미설정 (1단계 8~9번 재확인)
- **한참 뒤 접속했더니 안 됨**: 무료 플랜은 1주일 무접속 시 일시정지 → Supabase 대시보드에서 Restore 버튼

## 이 방식의 특징 (10명 이내 사내용으로는 문제 없음)

- 빌드 과정 없이 React/Babel/Supabase를 전부 CDN에서 즉석으로 불러와 실행
- 로딩이 빌드 방식보다 살짝 느릴 수 있으나 소규모 사용에는 체감 미미
- 코드가 압축되지 않고 그대로 보이지만, 사내 소규모 협업 도구 수준에서는 무리 없는 리스크
