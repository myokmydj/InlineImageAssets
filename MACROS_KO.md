# InlineImageAssets 매크로 가이드 (한국어)

이 문서는 **Inline Image Assets** 확장에 포함된 커스텀 매크로 시스템을 한국어로 설명합니다.

- 목표: SillyTavern 내부의 HTML/JS/CSS(또는 JS-Slash-Runner 스크립트)에서 **확장프로그램 번들 에셋**과 **캐릭터/페르소나(유저) 이미지 에셋**을 간단한 매크로로 불러오기
- 문법: SillyTavern 컨벤션과 동일하게 `{{매크로:...}}` 또는 `{{매크로::...}}`
- 핵심: 이 매크로는 **비동기(Async)** 로 해석됩니다.
  - (업데이트) 이제 InlineImageAssets가 채팅 렌더 이후 `.mes_text`를 관찰해서 `{{ia:...}}`를 **자동으로 resolve**합니다.
  - 단, 채팅 밖(UI/패널/커스텀 DOM)에 넣는 문자열은 여전히 **직접 `resolve(...)`를 호출**해야 합니다.

---

## 0) 먼저 알아둘 점 (중요)

### 로컬 경로 `C:\Users\...` 는 안 됩니다
브라우저(SillyTavern UI)는 로컬 파일 시스템을 직접 읽을 수 없고, 보안상 위험합니다.

따라서 아래처럼 **Windows 절대 경로를 매크로에 넣는 방식은 불가**입니다.

- (잘못된 예) `{{ia:img:C:\Users\...\card.png}}`

또한 아래처럼 **임의의 로컬 파일 경로를 넣는 매크로**도 브라우저에서 로드되지 않습니다.

- (잘못된 예) `{{random:C:/Users/.../card_00_fool.png}}`

대신 다음 중 하나를 쓰세요.

- **캐릭터/페르소나 에셋명 기반**: `{{ia:char:card_00_fool}}`
- **확장 폴더 내부 상대 경로 기반**: `{{ia:img:images/logo.png}}`
- **프리픽스 랜덤**: `{{ia:rand:card_|scope=char}}`
- **전체 랜덤(접두사 없음)**: `{{ia:randAll:scope=both}}`

---

## 1) 초기 설정

### 1-1. 확장 설치 확인
- Inline Image Assets가 설치/활성화되어 있어야 합니다.
- 비활성화 상태라면 이 JS 파일이 로드되지 않으므로 매크로도 동작하지 않습니다.

### 1-2. (선택) JS-Slash-Runner 함께 사용
JS-Slash-Runner(Tavern-Helper) 매크로(`{{userAvatarPath}}`, `{{charAvatarPath}}` 등)와 같이 쓰려면, 아래 API를 사용합니다.

- `window.inlineImageAssetsMacros.resolveWithTavernHelper(text)`

### 1-3. (파일 목록 매크로 사용 시) `assets.index.json` 생성/갱신
브라우저는 로컬 디렉토리 listing을 할 수 없습니다.
그래서 `{{ia:list:...}}` 는 기본적으로 **사전에 생성된 인덱스 파일** `assets.index.json`을 읽습니다.

에셋 파일을 추가/삭제한 뒤에는 인덱스를 갱신하세요:

```bash
cd "<SillyTavern>/data/default-user/extensions/InlineImageAssets"
node tools/build-assets-index.mjs
```

---

## 2) 매크로 문법 요약

### 2-1. 권장(통합) 문법: `{{ia:...}}`

- 확장 폴더 파일 URL
  - `{{ia:img:images/logo.png}}`
  - `{{ia:css:style.css}}`
  - `{{ia:js:some.js}}`
  - `{{ia:html:templates/a.html}}`

- 캐릭터/페르소나(유저) 에셋명 → URL
  - `{{ia:smile}}` (기본: 캐릭터 우선 → 없으면 페르소나)
  - `{{ia:char:smile}}` (캐릭터만)
  - `{{ia:user:smile}}` 또는 `{{ia:persona:smile}}` (페르소나만)

- 프리픽스 랜덤
  - `{{ia:rand:card_|scope=char}}`

- 전체 랜덤(접두사 없음)
  - `{{ia:randAll:scope=both}}`

- 디자인/템플릿 편의 매크로(HTML/CSS 생성)
  - `{{ia:imgTag:smile|scope=char|class=inline-asset-image|alt=Smile}}` → `<img ...>`
  - `{{ia:bgUrl:smile|scope=char}}` → `url("...")`
  - `{{ia:bgStyle:smile|scope=char}}` → `background-image:url("...");`
  - `{{ia:cssLink:style.css}}` → `<link rel="stylesheet" ...>`
  - `{{ia:jsModule:some.js}}` → `<script type="module" ...></script>`

  - (업데이트) 접두사 구분자 자동 지원
    - 예: `{{ia:rand:alice}}` 는 `alice_...`, `alice-...`, `alice....` 같은 이름들을 모두 후보로 잡습니다.
    - 이미 구분자가 포함된 접두사(예: `card_`)는 기존처럼 그대로 동작합니다.

- 전체 랜덤(접두사 없음)
  - `{{ia:randAll:scope=both}}`

- 파일 목록
  - `{{ia:list:templates|recursive=1|ext=png,jpg|format=json}}`

### 2-2. 옵션 문법(파이프)
`|key=value` 형태로 옵션을 추가합니다.

공통 옵션:
- `mode=abs`(기본) / `mode=rel`
- `fallback=...`

에셋명 해석 옵션:
- `prefer=char|user` (둘 다 허용(scope=both)일 때 우선순위)

랜덤 옵션:
- `scope=char|user|persona|both` (기본 both)
- `seed=...` (같은 seed면 같은 결과)

---

## 3) 실제로 “해석(치환)”하는 방법 (가장 중요)

이 매크로는 단순 문자열 치환이 아니라, 파일 존재 확인/캐시 등을 포함해 **비동기**로 URL을 계산합니다.

### 업데이트: 채팅 안에서는 “대부분 자동 치환”됩니다

InlineImageAssets가 채팅 메시지 렌더 이후 `{{ia:...}}`를 자동으로 치환하므로,
TavernRegex로 HTML을 만들 때도 **일반적으로는 매크로만 심어두면** 이미지 URL이 자동으로 들어갑니다.

다만 아래의 경우는 여전히 수동 resolve가 필요합니다.

- 채팅 밖(커스텀 UI/팝업/패널)에 문자열을 넣는 경우
- 확장이 비활성화/로드 실패인 경우

### 수동 resolve가 필요한 경우에만 아래 방식 사용

따라서 다음 중 하나로 사용하면 됩니다.

### 방식 A) JS에서 HTML 넣기 전에 resolve (권장)

```js
const html = await window.inlineImageAssetsMacros.resolve(
  `<img src="{{ia:img:images/logo.png}}">`
);
container.innerHTML = html;
```

JS-Slash-Runner/Tavern-Helper 매크로까지 같이 섞으면:

```js
const html = await window.inlineImageAssetsMacros.resolveWithTavernHelper(
  `<img src="{{userAvatarPath}}">\n<img src="{{ia:char:smile}}">`
);
container.innerHTML = html;
```

### 방식 B) 이미 렌더된 DOM을 후처리 (정규식/치환과 조합)

정규식(Tavern Regex/JS-Slash-Runner의 치환)으로 메시지에 `{{ia:...}}` 같은 토큰을 심어두고,
**메시지가 화면에 렌더된 후** `.mes_text`의 HTML을 다시 `resolveWithTavernHelper()`로 처리하는 방식입니다.

> 주의: SillyTavern 기본 TavernRegex는 동기 치환 엔진이라서, 그 자체만으로는 비동기 URL 해석을 수행할 수 없습니다.
> “정규식으로 토큰 삽입 + 렌더 후 JS로 해석” 패턴을 권장합니다.

간단 후처리 예시(개념 / 보통은 필요 없음):

```js
// 매우 단순한 예: 채팅 영역을 주기적으로 검사하여 매크로 토큰이 있는 메시지만 처리
setInterval(async () => {
  const nodes = document.querySelectorAll('#chat .mes .mes_text');
  for (const el of nodes) {
    const html = el.innerHTML;
    if (!html.includes('{{ia:') && !html.match(/\{\{\s*(img|css|js|html|char|user|persona|rand)\s*:/)) {
      continue;
    }
    const resolved = await window.inlineImageAssetsMacros.resolveWithTavernHelper(html);
    if (resolved !== html) el.innerHTML = resolved;
  }
}, 1500);
```

---

## 4) 예제 모음

### 4-1. background-image에 캐릭터 에셋 넣기

```js
const html = await window.inlineImageAssetsMacros.resolveWithTavernHelper(
  `<div class="card-image" style="background-image:url('{{ia:char:card_00_fool}}');"></div>`
);
container.innerHTML = html;
```

### 4-2. card_ 로 시작하는 캐릭터 에셋을 랜덤으로

```js
const html = await window.inlineImageAssetsMacros.resolveWithTavernHelper(
  `<div class="card-image" style="background-image:url('{{ia:rand:card_|scope=char}}');"></div>`
);
container.innerHTML = html;
```

### 4-2b. 접두사 구분자 상관없이 랜덤(예: alice_, alice-, alice.)

```js
const html = await window.inlineImageAssetsMacros.resolveWithTavernHelper(
  `<div class="card-image" style="background-image:url('{{ia:rand:alice|scope=char}}');"></div>`
);
container.innerHTML = html;
```

### 4-2c. 모든 에셋에서 랜덤(접두사 없음)

```js
const html = await window.inlineImageAssetsMacros.resolveWithTavernHelper(
  `<div class="card-image" style="background-image:url('{{ia:randAll:scope=both}}');"></div>`
);
container.innerHTML = html;
```

### 4-3. 메시지마다 “고정 랜덤”(seed 사용)

```js
const html = await window.inlineImageAssetsMacros.resolveWithTavernHelper(
  `<div class="card-image" style="background-image:url('{{ia:rand:card_|scope=char|seed={{lastMessageId}}}}');"></div>`
);
container.innerHTML = html;
```

### 4-5. HTML을 더 짧게: imgTag / bgStyle / cssLink / jsModule

```html
{{ia:cssLink:style.css}}

<div class="art-layer">
  {{ia:imgTag:card_00_fool|scope=char|class=inline-asset-image|alt=Fool}}
</div>

<div class="card-image" style="{{ia:bgStyle:card_00_fool|scope=char}}"></div>

{{ia:jsModule:templates/some-module.js}}
```

### 4-4. 충돌 처리(캐릭터/유저에 같은 이름이 있을 때)

- 기본: 캐릭터 우선
  - `{{ia:smile}}`

- 유저(페르소나) 우선으로 바꾸기:
  - `{{ia:smile|prefer=user}}`

- 명시적으로 스코프 고정:
  - `{{ia:char:smile}}`
  - `{{ia:user:smile}}`

---

## 5) 트러블슈팅

- 매크로가 그대로 보임 (`{{ia:...}}`가 치환되지 않음)
  - (업데이트) 채팅 안에서는 보통 자동 치환됩니다.
  - 그래도 그대로라면: InlineImageAssets가 활성화/로드됐는지, 브라우저 콘솔에 에러가 있는지 확인하세요.
  - 채팅 밖(UI/패널)에 넣은 문자열이라면: `resolve(...)` / `resolveWithTavernHelper(...)`를 직접 호출해야 합니다.

- `[InlineImageAssets] Missing asset: ...` 출력
  - 에셋명이 캐릭터/페르소나 에셋 목록에 존재하는지 확인하세요.

- `{{ia:list:...}}`가 항상 빈 배열
  - `assets.index.json` 갱신이 필요할 수 있습니다.
  - `node tools/build-assets-index.mjs` 실행 후 새로고침
