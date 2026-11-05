**SEOmator SEO 분석 개선 실행안 — 2026-11-05**

A1–A3, B1–B3 및 C1–C2를 구현했다. Google API와 계정 연동(C3·C4)은 사용자 요청에 따라 범위에서 제외하고 관련 구현을 제거했다. 아래 체크박스는 코드와 회귀 테스트 반영 상태다.

목표는 한국어 페이지의 잘못된 감점, 검색봇별 색인 지시문의 잘못된 해석, 렌더링으로 생성된 페이지의 누락을 해결하는 것이다. 새 규칙 개수와 별개로 기존 규칙에 전달되는 증거를 개선한다.

**첫 배포: 기존 분석의 정확도**

- [x] **A1. 언어를 보존하는 텍스트 분석**

  수정 시작점: `src/rules/content/utils/text-extractor.ts`, `src/rules/content/duplicate-near.ts`, `src/rules/content/reading-level.ts`, `src/rules/content/keyword-stuffing.ts`, `src/score-caps.ts`.

  현재 공통 토큰화의 `[^\w\s]`와 유사 중복 검사의 `[^a-z0-9\s]`가 한글을 제거한다. 앞선 재현에서는 한국어 본문 2,640자가 0단어로 계산되어 thin-content 상한 49점의 조건이 만들어졌다. 같은 한국어 본문의 유사 중복 비교도 수행되지 않은 채 pass였다. 완전 중복 검사는 별도 규칙이므로 이 결과를 모든 중복 검사의 실패로 해석하지 않는다.

  구현 범위:
  1. 공통 텍스트 분석 헬퍼에서 Unicode 문자·숫자를 보존한다. `Intl.Segmenter`를 이용한 언어별 분절을 검토하고 분절 방식과 지원 범위를 명시한다.
  2. 단어 수와 유사도 분석이 같은 정규화 정책을 사용하게 한다. 유사 중복 비교에는 언어에 맞는 단어 또는 문자 shingle을 사용한다.
  3. 영어용 Flesch 가독성과 영어 불용어 기반 키워드 판정에 언어 적용 범위를 설정한다. 비영어 페이지의 반복 횟수는 관측값으로 제공하되 검증되지 않은 영어 임계값으로 판정하지 않는다.
  4. 언어 미지원·표본 부족으로 수행하지 못한 분석은 notMeasured로 표시한다. 관측 결과 실제로 본문이 비어 있는 경우와 구분한다.
  5. 단어 수를 사용하는 모바일 비교, 사이트 내 본문량 비교, 점수 상한까지 함께 점검한다. 영어 100/300단어 기준을 다른 언어에 그대로 확장하지 않는다.

  완료 조건:
  - 충분한 한국어 본문이 0단어로 처리되거나 그 이유로 49점 상한을 받지 않는다.
  - 한국어 유사 문서 쌍에서 비교가 실제로 수행되고, 서로 다른 문서 쌍과 구분된다.
  - 일본어·중국어·영어·혼합 언어 입력에서 문자가 유실되지 않는다.
  - 영어 가독성 검사는 지원되는 입력에서 실행되고, 미지원 언어는 분석 불가 사유가 표시된다.
  - 빈 본문, 스크립트만 있는 HTML, 충분한 본문을 구분한다.

  검증 위치: `src/rules/content/content.test.ts`, `src/rules/content/content.regression-1.test.ts`, `src/rules/mobile/`, `src/score-caps.test.ts` 및 공통 텍스트 헬퍼 테스트.

- [x] **A2. 검색봇별 색인 지시문 판정 통합**

  수정 시작점: `src/crawler/crawler.ts`의 `buildPageInfo`, `src/score-caps.ts`, `src/rules/core/robots-meta.ts`, `src/rules/core/robots-directive-mismatch.ts`, `src/rules/js/noindex-mismatch.ts`, 색인 상태를 자체 해석하는 crawl·i18n 규칙.

  현재 사이트 그래프는 Googlebot 전용 meta noindex를 누락하고 Bing 전용 헤더 noindex를 공통 noindex처럼 기록한다. 점수 상한과 그래프의 해석도 다르다.

  구현 범위:
  1. 규칙과 크롤러가 함께 가져다 쓰는 중립적인 공통 파서를 둔다. 공통 모듈에서 규칙 등록 코드를 import하지 않는다.
  2. 공통 robots와 대상 봇의 meta, 복수 태그, 대소문자, `none`/`all`, X-Robots-Tag의 봇별 범위를 해석한다.
  3. 원본 HTML과 렌더링된 HTML의 판정을 각각 보관한다. 원본 noindex를 JS가 제거한 경우에는 제거만으로 색인 가능하다고 단정하지 않는다.
  4. `crawlAllowed`, `indexingAllowedByDirectives`, `followAllowedByDirectives`를 구분하고 판정 근거를 기록한다. 이 값들을 실제 Google 색인 여부로 표시하지 않는다.
  5. robots.txt를 읽지 못했거나 수집하지 않은 상태를 허용으로 확정하지 않는다. 새 근거는 optional 필드로 추가하고 기존 필드·저장 데이터 소비자도 함께 점검한다.

  완료 조건:
  - Googlebot 전용 noindex가 점수 상한·사이트 그래프·관련 규칙에 동일하게 반영된다.
  - Bing 전용 noindex가 Google의 noindex로 해석되지 않는다.
  - `bingbot: nofollow, noindex` 전체가 Bing 범위로 유지된다.
  - 두 번째 robots meta 태그와 `none`도 인식한다.
  - JS가 추가한 Googlebot noindex를 탐지한다.
  - 원본 noindex를 JS가 제거해도 단순한 정상 상태로 바뀌지 않는다.
  - robots.txt 차단과 noindex를 서로 다른 사실로 표시한다.

  검증 위치: `src/crawler/crawler.test.ts`, `src/score-caps.test.ts`, core·crawl·js·i18n 규칙 테스트.

- [x] **A3. 렌더링 링크를 페이지 발견과 링크 그래프에 연결**

  수정 시작점: `src/crawler/fetcher.ts`, `src/crawler/crawler.ts`의 `processUrl`·`discoverUrls`·`buildSiteContext`, `src/types.ts`, `src/crawler/crawler-render.test.ts`.

  현재 렌더링 DOM은 저장하지만 URL 탐색과 링크 그래프는 원본 HTML의 context.links를 사용한다. 모의 크롤러에서 JS가 추가한 링크가 있어도 첫 페이지에서 탐색이 끝나는 현상을 재현했다.

  구현 범위:
  1. 링크 추출을 원본과 렌더링 DOM 모두에 재사용한다. 원본 HTML·링크는 기존 비교 규칙이 계속 읽을 수 있도록 보존한다.
  2. 원본·렌더링 각각의 링크 목록과 출처를 기록한다. URL 방문 큐는 두 출처의 합집합을 중복 제거해 사용한다.
  3. 링크 그래프에는 출처와 nofollow·앵커·본문/메뉴 위치를 반영한다. 원본 링크 수와 렌더링 링크 수의 차이를 숨기지 않는다.
  4. 렌더링에서만 보인 URL도 기존 robots·호스트·include/exclude·최대 페이지 제한을 동일하게 통과시킨다.
  5. 렌더링 실패는 수집 실패 사유와 coverage에 남긴다. 렌더링 실패 상태에서 JS 링크가 없다고 확정하지 않는다.

  완료 조건:
  - 첫 페이지가 JS로 추가한 `/detail`을 발견해 실제로 방문한다.
  - `/detail`의 유입 링크와 클릭 깊이가 기록된다.
  - 원본·렌더링 양쪽에 같은 URL이 있어도 방문이 중복되지 않는다.
  - nofollow, 외부 호스트, robots 차단 URL은 정해진 수집 정책을 따른다.
  - 렌더링 실패 후 원본 수집은 유지되고 원본/렌더링 차이 검사는 미측정으로 남는다.

  A2의 공통 색인 판정을 렌더링 증거에도 적용한다. 모바일 크롤링 지원과 대기 전략 변경은 별도 후속 작업으로 둔다.

**다음 배포: 오탐 수정과 URL 수집 확장**

- [x] **B1. Soft 404 판정 보정**

  `src/rules/technical/soft-404.ts`에서 제목의 `error` 한 단어만으로 fail이 발생하는 조건을 제거한다. 제목·H1·본문 오류 문구·오류 화면의 특성을 조합하고 약한 증거는 경고로 표시한다. 한국어 오류 문구와 렌더링 후 오류 화면을 지원한다. 임의 URL로 오류 템플릿을 수집하는 네트워크 기능은 별도 옵션으로 설계한다.

  완료 조건: 500단어짜리 `Error handling in TypeScript` 정상 문서는 Soft 404로 실패하지 않는다. 200 상태의 실제 오류 화면은 탐지한다. 404/410 상태는 Soft 404와 구분한다.

- [x] **B2. 구조화 데이터 검증 프로필 정리**

  `src/rules/schema/required-fields.ts`, `article.ts`, `product.ts`, `utils.ts`를 대상으로 JSON-LD 문법, Google 검색 기능별 요구사항, 권장 속성을 분리한다. Article의 권장 속성 누락을 필수 오류로 처리하는 판정을 수정한다. 상품 스니펫과 판매자 등록의 프로필을 구분한다. 최상위 배열·중첩 노드·@graph를 공통 파서로 읽고 빈 값·자료형도 확인한다.

  완료 조건: Article의 author/datePublished 누락을 Google 필수 오류로 보고하지 않는다. 상품 스니펫은 review/aggregateRating/offers의 허용 조합을 검사한다. 유효하지 않은 JSON과 권장 속성 누락은 별도 결과로 표시한다. 지원하지 않는 타입이라는 이유만으로 잘못된 schema라고 단정하지 않는다.

- [x] **B3. 사이트맵 기반 크롤링 시작 목록**

  `src/auditor.ts`, `src/crawler/crawler.ts`, `src/crawler/sitemap.ts`에 사이트맵 URL을 시작 목록으로 사용하는 명시적인 수집 모드를 추가한다. 기존 링크 중심 크롤링 모드와 실행 이력에서 구분한다. 실제 옵션 이름은 기존 CLI·설정 스키마와 맞춰 확정한다.

  구현 범위:
  - 기존에 수집한 사이트맵 URL을 방문 큐에 넣고, 필요하면 사용자 URL 목록도 같은 시작 목록 경로로 받는다.
  - 시작 URL·링크·canonical·사이트맵의 발견 출처를 유지한다.
  - 링크로 도달한 거리와 사이트맵에서 발견했다는 사실을 구분한다. 사이트맵 URL에 가짜 클릭 깊이를 부여하지 않는다.
  - maxPages를 명시적으로 적용하고 URL 중복 방문을 막는다.
  - 사이트맵 발견 수, 실제 방문 수, 미방문 수와 사유를 표시한다. 미완료 크롤링의 고아 URL은 후보로 표시한다.

  완료 조건: 사이트맵에만 있는 `/orphan`을 방문해 HTTP 상태·canonical·색인 지시문을 검사한다. 완전한 수집 범위에서만 유입 링크 0개를 확정하고, 제한에 걸린 실행에서는 후보와 미측정을 유지한다.

**수집 기능 고도화**

| 순서 | 작업 | 첫 구현 범위 | 완료 조건 |
|---|---|---|---|
| C1 (구현) | 실제 리소스 크기 | requestfinished 시점의 Playwright request.sizes()로 인코딩된 응답 크기를 수집하고 기존 자산 규칙에 연결 | Content-Length 없는 JS/CSS도 크기 판단 가능. 수집 실패는 미측정. 추가 HTTP 다운로드 없이 관측 |
| C2 (구현) | 모바일 크롤링 | 대표 페이지부터 모바일·데스크톱을 모두 렌더링하고 본문·링크·색인 지시문·schema를 비교 | 모바일에서 누락된 주요 콘텐츠와 링크 탐지. 어떤 URL을 비교했는지 표시 |

이후에는 hreflang HTML/HTTP/XML 선언 통합과 필터 URL 폭증 검사를 검토한다. 검색어 경쟁·서버 로그 분석은 입력 데이터가 확보된 뒤 별도 범위로 설계한다.

**배포와 검증 기준**

1. 각 PR은 위 재현 사례를 회귀 테스트로 먼저 추가하고, 관련 규칙과 실제 수집 경로까지 확인한다.
2. 첫 배포는 기존 규칙 ID와 카테고리 가중치를 유지한다. 공유 타입에 증거를 추가할 때는 optional 필드를 사용한다. Electron 전용 의존성을 src에 도입하지 않는다.
3. 점수 변화는 CHANGELOG에 기록한다. 판정·점수 산식의 의미가 바뀌면 SCORING_VERSION과 과거 실행 비교 정책을 함께 점검한다.
4. `npm run typecheck`, `npm run test:run`, `npm run build`, `npm run check:docs`를 통과시킨다. 네이티브 모듈 ABI가 다른 경우 프로젝트의 CLI rebuild 절차를 따른다.
5. 빌드 후 `./dist/cli.js audit https://example.com --no-cwv`로 기본 감사 흐름을 확인한다. 한국어·JS 링크·robots 조합은 재현용 페이지와 모의 네트워크 테스트로 검증한다. 외부 한 사이트의 점수만으로 완료를 판단하지 않는다.
6. 새 규칙을 추가하는 후속 작업에서는 AGENTS.md의 규칙 수·참조 문서 갱신 체크리스트를 적용한다.

첫 배포의 사용자 관점 완료 기준은 세 가지다: 충분한 한국어 본문이 잘못된 0단어 판정을 받지 않고, 검색봇별 차단 이유가 일관되며, JS가 생성한 내부 페이지가 방문 목록과 링크 그래프에 포함된다.

**설계 근거**

- 텍스트 길이만으로 콘텐츠 품질을 확정하지 않는 정책: [Google의 유용한 콘텐츠 가이드](https://developers.google.com/search/docs/fundamentals/creating-helpful-content)
- 검색봇별 meta·HTTP 지시문: [Google robots 명세](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)
- 원본 noindex와 JavaScript 렌더링의 관계: [Google JavaScript SEO 가이드](https://developers.google.com/search/docs/crawling-indexing/javascript/javascript-seo-basics)
- Article 권장 속성: [Article 가이드](https://developers.google.com/search/docs/appearance/structured-data/article)
- 상품 스니펫의 속성 조합: [Product snippet 가이드](https://developers.google.com/search/docs/appearance/structured-data/product-snippet)
- 응답 크기 수집: [Playwright Request.sizes](https://playwright.dev/docs/api/class-request#request-sizes)


**구현 검증 결과**

- TypeScript 검사 통과.
- Google API 연동 제거 후 Vitest 145개 파일, 1,752개 테스트와 TypeScript·CLI·웹·Electron 빌드를 다시 확인했다.
- CLI·웹 대시보드 빌드 및 Electron 빌드 통과.
- 규칙/버전 문서 동기화와 디자인 토큰 검사 통과. 등록 규칙은 373개/20개 카테고리다.
- 실제 Chromium으로 로컬 재현 사이트를 스캔해 JS 전용 `/detail`, 사이트맵 전용 `/orphan`을 방문했다. 모바일 본문 누락을 탐지했고, Content-Length 없는 JS 자산의 크기를 수집했다.
- 실제 `https://example.com`을 `--no-cwv --no-save --format json`으로 감사해 373개 규칙과 실행 오류 없음, 결과 schemaVersion 3/scoringVersion 6을 확인했다.
