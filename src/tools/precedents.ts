import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { cleanHtml } from "../lib/article-parser.js"
import { truncateResponse } from "../lib/schemas.js"
import { formatToolError } from "../lib/errors.js"
import { fetchWithRetry } from "../lib/fetch-with-retry.js"
import {
  type ExternalHttpsProxyConfig,
  getExternalHttpsProxyConfig,
  requestExternalHttps,
} from "../lib/external-https-proxy.js"
import {
  compactBody,
  densifyLawRefs,
  densifyPrecedentRefs,
  stripRepeatedSummary,
} from "../lib/decision-compact.js"
import { searchPrecedentsStructured, type StructuredPrecedentSearchResult } from "./precedent-search-core.js"

export const searchPrecedentsSchema = z.object({
  query: z.string().optional().describe("검색 키워드 (예: '자동차', '담보권')"),
  search: z.number().int().min(1).max(2).optional()
    .describe("검색범위: 1=판례명 검색(기본), 2=본문검색"),
  court: z.string().optional().describe("법원명 필터 (예: '대법원', '서울고등법원')"),
  caseNumber: z.string().optional().describe("사건번호 (예: '2009느합133')"),
  display: z.number().min(1).max(100).default(20).describe("결과 수 (기본:20, 최대:100)"),
  page: z.number().min(1).default(1).describe("페이지 번호 (기본:1)"),
  sort: z.enum(["lasc", "ldes", "dasc", "ddes", "nasc", "ndes"]).optional()
    .describe("정렬: lasc/ldes(법령명), dasc/ddes(날짜), nasc/ndes(사건번호)"),
  fromDate: z.string().optional().describe("선고일 시작 (YYYYMMDD)"),
  toDate: z.string().optional().describe("선고일 종료 (YYYYMMDD)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
});

export type SearchPrecedentsInput = z.infer<typeof searchPrecedentsSchema>;

function renderNoPrecedentResult(result: StructuredPrecedentSearchResult): string {
  const kw = result.originalArgs.query || result.originalArgs.caseNumber || "관련 키워드"
  const keywords = kw.trim().split(/\s+/)
  const lines = [`[NOT_FOUND] '${kw}' 판례 검색 결과가 없습니다.`, "", "⚠️ LLM은 판례를 추측/생성하지 마세요. 사용자에게 '검색 실패'를 보고하세요."]
  if (keywords.length >= 2) {
    lines.push("")
    lines.push("힌트: 법제처 API는 공백 구분 키워드를 AND 조건으로 처리합니다. 키워드가 많을수록 결과가 줄어듭니다.")
    lines.push(`재시도 제안(낱말 수를 줄이세요 — 한 낱말씩 각각 돌려보세요): ${keywords.map((k) => `"${k}"`).join(" · ")}`)
  }
  if (result.attempts.length > 1) {
    lines.push("")
    lines.push(`검색 보정 시도: ${result.attempts.map(attempt => {
      const label = attempt.caseNumber || attempt.query || "(빈 검색어)"
      const scope = attempt.search === 2 ? ", 본문검색" : ""
      return `${label}${scope}`
    }).join(" → ")}`)
  }
  lines.push("")
  lines.push("대안:")
  lines.push(`  1. 해석례 검색: search_interpretations(query="${kw}")`)
  lines.push(`  2. 법령 검색: search_law(query="${kw}")`)
  return lines.join("\n")
}

export function renderPrecedentSearchResult(result: StructuredPrecedentSearchResult): string {
  const args = result.originalArgs
  if (result.hits.length === 0) return renderNoPrecedentResult(result)

  let output = `판례 검색 결과 (총 ${result.totalCount}건, ${result.page}페이지)`
  if (args.fromDate || args.toDate) {
    output += ` [기간: ${args.fromDate || "시작"} ~ ${args.toDate || "종료"}]`
  }
  output += `:\n\n`

  for (const hit of result.hits) {
    output += `[${hit.id}] ${hit.title}\n`
    output += `  사건번호: ${hit.caseNumber || "N/A"}\n`
    output += `  법원: ${hit.court || "N/A"}\n`
    output += `  선고일: ${hit.date || "N/A"}\n`
    output += `  판결유형: ${hit.decisionType || "N/A"}\n`
    if (hit.outOfRequestedDateRange) {
      output += `  범위: 요청 기간 밖 fallback 결과\n`
    }
    if (hit.link) {
      output += `  링크: ${hit.link}\n`
    }
    output += `\n`
  }

  if (result.fallbackUsed && result.successfulAttempt) {
    const attempt = result.successfulAttempt
    const label = attempt.caseNumber || attempt.query || "(빈 검색어)"
    const scope = attempt.search === 2 ? "본문검색" : "제목검색"
    const dateNote = attempt.outOfRequestedDateRange ? ", 요청 기간 밖 결과 포함" : ""
    output += `검색 보정: ${attempt.reason}="${label}" (${scope}${dateNote})\n\n`
  }

  if (result.hits[0]?.id) {
    output += `💡 다음: get_precedent_text(id="${result.hits[0].id}") 로 판결문 전문. full=true 로 축약 해제. 유사판례 원하면 find_similar_precedents 사용.\n`
  }

  return output
}

export async function searchPrecedents(
  apiClient: LawApiClient,
  args: SearchPrecedentsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  try {
    const { validatePrecedentSearchResult } = await import("./precedent-evidence.js")
    const result = await searchPrecedentsStructured(apiClient, args, {
      validateResult: validation => validatePrecedentSearchResult(apiClient, validation, { apiKey: args.apiKey }),
    })
    const output = renderPrecedentSearchResult(result)
    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }],
      isError: result.hits.length === 0 || undefined,
    };
  } catch (error) {
    return formatToolError(error, "search_precedents")
  }
}

export const getPrecedentTextSchema = z.object({
  id: z.string().describe("판례일련번호 (search_precedents 결과에서 획득)"),
  caseName: z.string().optional().describe("사건명 (선택, 검증용)"),
  full: z.boolean().optional().describe("true=전문 그대로. 미지정 시 '전문' 섹션을 계단식 축약 (판시/요지/참조는 항상 full)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
});

export type GetPrecedentTextInput = z.infer<typeof getPrecedentTextSchema>;

interface PrecedentBasic {
  판례명?: string
  사건번호?: string
  법원명?: string
  선고일자?: string
  사건종류명?: string
  판결유형?: string
}

interface PrecedentContent {
  판시사항?: string
  판결요지?: string
  참조조문?: string
  참조판례?: string
  전문?: string
}

// ★2026-08-04 — 이 서버가 준 편집 문자열이 판시(ratio)처럼 그대로 인용되는 사고가 있었다.
//   넷 다 「응답 안에 정답이 있는데 표시가 그것을 가리지 않은」 자리다. 새 조회는 하지 않는다.

// ⓐ 이유 본문이 심리불속행 정형문뿐인가 — 그러면 인용할 판시가 이 문서에 없다.
//
// ★2026-08-11 오탐 2건 수정. 이 경고는 **살아 있는 판시를 「인용 불가」로 내린다** — 조용한 손실이라
//   쓰는 쪽이 원문을 열어 보지 않으면 영영 안 드러난다. 실제로 두 건이 그렇게 걸렸다.
//   대법원 2017두31538 · 2015두50153 — 둘 다 **파기환송**이고 본안 판단부가 실재하는데 경고가 붙었다.
//
//   원인 둘, 둘 다 실물 재생으로 확인했다(표본 11건 · 서버 응답을 그대로 먹여 재생):
//   ⓧ `전문.split(/이\s*유/).pop()` 이 「이유 본문」이 아니라 **마지막 조각**을 집는다. 본안 판결일수록
//      「이유」가 여러 번 나와(조각 10~21개) 꼬리에 **맺음말 한 문단(54~151자)**만 남는다.
//      ⇒ 길이 조건이 자동으로 참이 된다. 진짜와 오탐이 **같은 구간(54~151자)**에 앉아 갈릴 수가 없었다.
//   ⓨ OR 의 「상고를 기각하기로 하여」는 **모든 일부상고기각 판결의 정형 맺음말**이라 신호가 아니다.
//
//   표본 계수(진짜 심리불속행 8건 / 오탐 2건 / 음성 대조 1건):
//     「상고심절차에 관한 특례법」 → 진짜 8/8(1~3회) · 오탐 0/2 · 음성 0   ← 완전 판별자
//     「상고를 기각하기로 하여」   → 진짜 2/8      · 오탐 2/2 · 음성 0   ← 오탐 전용 소음
//     ★그것만 가진 진짜 표본은 0건이다(둘 다 특례법도 함께 있다) ⇒ 빼도 검출이 안 준다.
//     전문 전체(공백 제거): 진짜 230~472 ↔ 오탐 4,075·4,864 — 한 자릿수 차이라 길이는 벨트로 남긴다.
//
//   ★판례명 판정도 고쳤다 — 표본에 **「(심리 불속행)」(띄어쓰기)**이 있었고 `includes`가 그걸 놓쳤다.
//    지금은 ⓨ가 우연히 받아 주고 있어 안 드러났을 뿐이다.
//   ★★2026-08-11 2차 — **전문 전체를 재던 것도 틀렸다.** 위 8표본이 전부 짧아 그 위험을 못 봤다.
//    `2017두48505`(precSeq 421636)는 **진짜 심리불속행인데 전문이 10,301자**다 — DB 레코드가 `---------`
//    뒤에 **원심 본문을 통째로 덧붙이기** 때문이다. 길이 벨트가 그 덧붙은 글을 세서 진짜를 놓쳤다.
//    ★옛 판정(`.pop()`)도 이 건을 놓쳤으므로 1차 수정이 만든 회귀가 아니라 **원래 있던 구멍**이다.
//    ⇒ **재는 대상을 「전문」이 아니라 「이유 구획」으로 바꾼다**(그게 애초에 이 판정의 뜻이었다).
//    표본 13건 같은 자 실측 — 이유 구획(공백 제거): 진짜 **129~353** ↔ 아님 **1,585~4,670**.
//      옛 판정 3건 오답(놓침 1 · 오탐 2) · 전문 전체 1건 오답(놓침 1) · **이유 구획 0건 오답**.
export function hasNoRatio(전문?: string, 판례명?: string): boolean {
  if (판례명 && /심리\s*불속행/.test(판례명)) return true
  if (!전문) return false
  const 이유 = reasonSection(전문)
  if (이유 === null) return false // 표제를 못 찾으면 판정하지 않는다(추측 금지 — 경고는 인용을 막는다)
  return /상고심절차에 관한 특례법/.test(이유) && 이유.replace(/\s+/g, "").length < 800
}

/** 전문에서 **이유 구획**만 잘라낸다(순수). 표제가 없으면 null.
 *  ★`split(…).pop()`을 쓰지 마라 — 「이유」는 본문 곳곳에 나오고(「상고이유」·「이유 없다」) 마지막 조각은
 *   맺음말 한 문단이다. **첫 표제 이후**를 취한다.
 *  ★`-----` 이후는 버린다 — 이 DB는 대법원 판결 뒤에 **원심 본문을 덧붙여** 싣는다(실측: 421636에서 145자
 *   짜리 이유 뒤에 10,000자가 더 붙어 있다). 그 글은 이 법원의 이유가 아니다. */
export function reasonSection(전문: string): string | null {
  const m = /【\s*이\s*유\s*】|이\s{2,}유|\n\s*이\s*유\s*\n/.exec(전문)
  if (!m) return null
  const tail = 전문.slice(m.index + m[0].length)
  const cut = /-{5,}/.exec(tail)
  return cut ? tail.slice(0, cut.index) : tail
}

/** 전문에서 **주문 구획**만 잘라낸다(순수). 표제가 없으면 null. */
export function dispositionSection(전문: string): string | null {
  const m = /【\s*주\s*문\s*】|주\s{2,}문/.exec(전문)
  if (!m) return null
  const tail = 전문.slice(m.index + m[0].length)
  const end = /【\s*이\s*유\s*】|이\s{2,}유|-{5,}/.exec(tail)
  return (end ? tail.slice(0, end.index) : tail).trim()
}

/** 주문이 원심을 파기했는가(순수) — **읽는 쪽이 「판결유형」만 보면 알 수 없다.**
 *  ★DB의 `판결유형`은 상고심 승패 표기라 **파기환송도 「처분청승소」로 찍힌다**(실측 요청 근거).
 *   그래서 「…라고 판시했다」로 단정한 인용이 실제로 나갔다 — 그 사건은 결론이 확정된 것이 아니다.
 *  ★판단하지 않고 **주문 문언 한 줄**을 얹는다. 파기 뒤 환송인지 자판인지는 주문이 스스로 말한다. */
export function reversalFlag(전문?: string): { reversed: boolean; remanded: boolean; text: string } {
  const d = 전문 ? dispositionSection(전문) : null
  if (!d) return { reversed: false, remanded: false, text: "" }
  const flat = d.replace(/<br\s*\/?>/gi, " ").replace(/\s+/g, " ").trim()
  return { reversed: /파기/.test(flat), remanded: /환송/.test(flat), text: flat }
}

// ⓑ 전문의 「판 결 선 고」 줄에서 선고일을 뽑는다(YYYYMMDD).
function 선고일FromBody(전문?: string): string | undefined {
  if (!전문) return undefined
  const m = /판\s*결\s*선\s*고\s*\n+\s*(\d{4})\s*[.\-]\s*(\d{1,2})\s*[.\-]\s*(\d{1,2})/.exec(전문)
  if (!m) return undefined
  return m[1] + m[2].padStart(2, "0") + m[3].padStart(2, "0")
}

// ⓒ 원심 사건번호(있으면 실체 법리가 그쪽에 있다).
function 원심FromBody(전문?: string): string | undefined {
  if (!전문) return undefined
  const m = /원\s*심\s*판\s*결\s*\n+\s*([^\n]+)/.exec(전문)
  return m ? m[1].trim() : undefined
}

function formatPrecedentText(
  basic: PrecedentBasic,
  content: PrecedentContent,
  full?: boolean
): string {
  let output = `=== 사건명(DB 편집 문자열 · 법원의 판시가 아니다): ${basic.판례명 || "판례"} ===\n\n`;

  output += `기본 정보:\n`;
  output += `  사건번호: ${basic.사건번호 || "N/A"}\n`;
  output += `  법원: ${basic.법원명 || "N/A"}\n`;
  const 선고일본문 = 선고일FromBody(content.전문);
  const 선고일불일치 = 선고일본문 && basic.선고일자 && 선고일본문 !== basic.선고일자;
  output += `  선고일: ${basic.선고일자 || "N/A"}${선고일불일치 ? ` ⚠ 전문의 「판결 선고」는 ${선고일본문} — 불일치. 전문을 믿어라` : ""}\n`;
  output += `  사건종류: ${basic.사건종류명 || "N/A"}\n`;
  output += `  판결유형: ${basic.판결유형 || "N/A"}\n\n`;

  if (content.판시사항) {
    output += `판시사항:\n${content.판시사항}\n\n`;
  }

  if (content.판결요지) {
    const 원심요지 = /^\s*\(원심\s*요지\)/.test(content.판결요지);
    output += `${원심요지 ? "원심 요지(이 법원의 판시가 아니다)" : "판결요지"}:\n${content.판결요지}\n\n`;
  }

  if (content.참조조문) {
    output += `참조조문:\n${densifyLawRefs(content.참조조문)}\n\n`;
  }

  if (content.참조판례) {
    output += `참조판례:\n${densifyPrecedentRefs(content.참조판례)}\n\n`;
  }

  if (hasNoRatio(content.전문, basic.판례명)) {
    const 원심 = 원심FromBody(content.전문);
    output += `⚠ 인용할 판시가 이 문서에 없습니다(심리불속행 — 이유는 정형문뿐).\n`;
    output += `   위 사건명은 DB가 붙인 편집 문자열이고 법원의 문장이 아닙니다. 「대법원이 …라고 판시했다」로 인용하지 마십시오.\n`;
    output += 원심 ? `   실체 법리는 원심에 있습니다: ${원심}\n\n` : `\n`;
  }

  // ★파기 표시 — 「판결유형」이 말하지 않는 것. 판단하지 않고 주문 문언을 그대로 얹는다.
  const rev = reversalFlag(content.전문);
  if (rev.reversed) {
    output += `⚠ 파기${rev.remanded ? "환송" : "자판"} — 이 판결로 결론이 확정된 것이 아닙니다${rev.remanded ? "(환송심 미대조)" : ""}.\n`;
    output += `   위 「판결유형」은 상고심 승패 표기이고 주문의 파기 여부를 말하지 않습니다.\n`;
    output += `   주문: ${rev.text.slice(0, 200)}\n\n`;
  }

  if (content.전문) {
    const deduped = stripRepeatedSummary(content.전문, [content.판시사항, content.판결요지]);
    const compacted = compactBody(deduped, { full });
    output += `전문:\n${compacted}\n`;
  }

  return output;
}

function normalizeHtmlText(html: string): string {
  const withBlockBreaks = html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|tr|table|tbody|thead|tfoot|ul|ol|li|h[1-6])\s*>/gi, "\n")
    .replace(/<\s*(p|div|tr|table|tbody|thead|tfoot|ul|ol|li|h[1-6])\b[^>]*>/gi, "\n")
    .replace(/<\/\s*td\s*>/gi, "\t")
    .replace(/<\s*td\b[^>]*>/gi, "")

  return cleanHtml(withBlockBreaks)
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function hasSubstantiveTaxlawBody(text: string): boolean {
  const compact = text.replace(/\s+/g, "")
  if (compact.length < 20) return false
  return !/(내용없음|본문없음|조회된내용이없습니다|자료가없습니다)/.test(compact)
}

export function normalizeTaxlawBodyCandidate(value: unknown): string {
  if (typeof value !== "string") return ""
  const body = normalizeHtmlText(value)
  return hasSubstantiveTaxlawBody(body) ? body : ""
}

export function extractTaxlawEditorBody(actionData: any): string {
  const editorList = Array.isArray(actionData.dcmHwpEditorDVOList)
    ? actionData.dcmHwpEditorDVOList
    : []

  for (const item of editorList) {
    const value = typeof item?.dcmFleByte === "string" ? item.dcmFleByte : ""
    if (!value.includes("<html") && !value.includes("<body") && value.length <= 100) continue
    const body = normalizeTaxlawBodyCandidate(value)
    if (body) return body
  }

  return ""
}

function extractTaxlawBody(actionData: any, dcm: any): string {
  return extractTaxlawEditorBody(actionData) || normalizeTaxlawBodyCandidate(dcm?.ntstDcmCntn)
}

function extractIframeSrc(html: string): string {
  return html.match(/<iframe\b[^>]*\bsrc\s*=\s*["']?\s*([^"'>\s]+)\s*["']?/i)?.[1] || ""
}

function extractHiddenPrecSeq(html: string): string {
  return html.match(/id\s*=\s*["']precSeq["'][^>]*value\s*=\s*["']?\s*(\d+)/i)?.[1] || ""
}

function normalizeUrl(url: string, base = "https://www.law.go.kr"): string {
  return new URL(url, base).toString()
}

function iframeMatchesPrecedentId(iframeUrl: string, id: string): boolean {
  try {
    return new URL(iframeUrl).searchParams.get("precSeq") === id
  } catch {
    return false
  }
}

function isMissingPrecedentJson(data: unknown): boolean {
  if (!data || typeof data !== "object") return true
  const obj = data as Record<string, unknown>
  return !obj.PrecService
}

async function fetchText(response: Response, context: string): Promise<string> {
  const text = await response.text()
  if (!response.ok) {
    throw new Error(`${context} failed with HTTP ${response.status}`)
  }
  return text
}

export async function fetchTaxlawAction(ntstDcmId: string, referer: string): Promise<any> {
  const body = new URLSearchParams({
    actionId: "ASIQTB002PR01",
    paramData: JSON.stringify({ dcmDVO: { ntstDcmId } }),
  })
  const headers = {
    "content-type": "application/x-www-form-urlencoded",
    "origin": "https://taxlaw.nts.go.kr",
    "referer": referer,
    "x-requested-with": "XMLHttpRequest",
  }

  const proxyConfig = getExternalHttpsProxyConfig()
  if (proxyConfig) {
    const response = await requestExternalHttps("https://taxlaw.nts.go.kr/action.do", {
      method: "POST",
      headers,
      body: body.toString(),
    }, proxyConfig)
    if (!response.ok) {
      throw new Error(`taxlaw action.do failed with HTTP ${response.status}`)
    }
    return JSON.parse(response.text)
  }

  const response = await fetchWithRetry("https://taxlaw.nts.go.kr/action.do", {
    method: "POST",
    headers,
    body: body.toString(),
  })

  const text = await fetchText(response, "taxlaw action.do")
  return JSON.parse(text)
}

function getResponseHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | null {
  const value = headers[name.toLowerCase()] ?? headers[name]
  if (Array.isArray(value)) return value[0] || null
  return value || null
}

async function fetchManualRedirect(
  url: string,
  proxyConfig: ExternalHttpsProxyConfig | null
): Promise<{ status: number; location: string | null }> {
  if (proxyConfig && new URL(url).protocol === "https:") {
    const response = await requestExternalHttps(url, {
      method: "GET",
      headers: {
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
    }, proxyConfig)
    return {
      status: response.status,
      location: getResponseHeader(response.headers, "location"),
    }
  }

  const response = await fetchWithRetry(url, { redirect: "manual" })
  return {
    status: response.status,
    location: response.headers.get("location"),
  }
}

async function resolveTaxlawDetailUrl(iframeUrl: string): Promise<string> {
  let currentUrl = iframeUrl
  const proxyConfig = getExternalHttpsProxyConfig()
  for (let redirectCount = 0; redirectCount < 3; redirectCount++) {
    const iframeResponse = await fetchManualRedirect(currentUrl, proxyConfig)
    const location = iframeResponse.location
    if (!location) {
      throw new Error(`precedent iframe did not include taxlaw redirect location (HTTP ${iframeResponse.status})`)
    }

    const nextUrl = normalizeUrl(location, currentUrl)
    const parsedNextUrl = new URL(nextUrl)
    if (parsedNextUrl.searchParams.get("ntstDcmId")) {
      return nextUrl
    }
    if (parsedNextUrl.hostname === "taxlaw.nts.go.kr") {
      throw new Error("HTML fallback response did not expose ntstDcmId")
    }
    currentUrl = nextUrl
  }

  throw new Error("HTML fallback response did not expose ntstDcmId")
}

async function fetchHtmlFallbackPrecedent(
  apiClient: LawApiClient,
  args: GetPrecedentTextInput,
  extraParams: Record<string, string>
): Promise<{ basic: PrecedentBasic; content: PrecedentContent }> {
  const html = await apiClient.fetchApi({
    endpoint: "lawService.do",
    target: "prec",
    type: "HTML",
    extraParams,
    apiKey: args.apiKey,
  })

  const hiddenPrecSeq = extractHiddenPrecSeq(html)
  const iframeSrc = extractIframeSrc(html)
  const iframeUrl = iframeSrc ? normalizeUrl(iframeSrc) : ""
  if (hiddenPrecSeq !== args.id && !iframeMatchesPrecedentId(iframeUrl, args.id)) {
    throw new Error("Precedent not found or invalid response format")
  }
  if (!iframeUrl) {
    throw new Error("HTML fallback response did not include a precedent iframe URL")
  }

  const taxlawDetailUrl = await resolveTaxlawDetailUrl(iframeUrl)
  const ntstDcmId = new URL(taxlawDetailUrl).searchParams.get("ntstDcmId")
  if (!ntstDcmId) {
    throw new Error("HTML fallback response did not expose ntstDcmId")
  }

  const actionJson = await fetchTaxlawAction(ntstDcmId, taxlawDetailUrl)
  const actionData = actionJson?.data?.ASIQTB002PR01
  const dcm = actionData?.dcmDVO
  if (!dcm) {
    throw new Error("HTML fallback taxlaw response did not include dcmDVO")
  }

  const body = extractTaxlawBody(actionData, dcm)
  if (!body) {
    throw new Error("HTML fallback taxlaw response did not include precedent body")
  }

  return {
    basic: {
      판례명: dcm.ntstDcmTtl,
      사건번호: dcm.ntstDcmDscmCntn || dcm.ntstPrdgHpnnNoCntn,
      법원명: dcm.ogzNm,
      선고일자: dcm.ntstDcmRgtDt,
      사건종류명: "국세법령정보시스템 판례",
      판결유형: dcm.ntstDcmClNm,
    },
    content: {
      판결요지: dcm.ntstDcmGistCntn,
      전문: body,
    },
  }
}

export async function getPrecedentText(
  apiClient: LawApiClient,
  args: GetPrecedentTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  try {
    const extraParams: Record<string, string> = { ID: args.id };
    if (args.caseName) extraParams.LM = args.caseName;

    let responseText: string;
    try {
      responseText = await apiClient.fetchApi({
        endpoint: "lawService.do",
        target: "prec",
        type: "JSON",
        extraParams,
        apiKey: args.apiKey,
      });
    } catch (err) {
      const fallback = await fetchHtmlFallbackPrecedent(apiClient, args, extraParams)
      const output = formatPrecedentText(fallback.basic, fallback.content, args.full)
      return {
        content: [{
          type: "text",
          text: truncateResponse(output)
        }]
      };
    }

  let data: any;
  try {
    data = JSON.parse(responseText);
  } catch (err) {
    const fallback = await fetchHtmlFallbackPrecedent(apiClient, args, extraParams)
    const output = formatPrecedentText(fallback.basic, fallback.content, args.full)
    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  }

  if (isMissingPrecedentJson(data)) {
    const fallback = await fetchHtmlFallbackPrecedent(apiClient, args, extraParams)
    const output = formatPrecedentText(fallback.basic, fallback.content, args.full)
    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  }

  if (!data.PrecService) {
    throw new Error("Precedent not found or invalid response format");
  }

  const prec = data.PrecService;
  // API returns fields directly in PrecService, not nested
  const basic = {
    판례명: prec.사건명,
    사건번호: prec.사건번호,
    법원명: prec.법원명,
    선고일자: prec.선고일자,
    사건종류명: prec.사건종류명,
    판결유형: prec.판결유형
  };
  const content = {
    판시사항: prec.판시사항,
    판결요지: prec.판결요지,
    참조조문: prec.참조조문,
    참조판례: prec.참조판례,
    전문: prec.판례내용
  };

  const output = formatPrecedentText(basic, content, args.full)

  return {
    content: [{
      type: "text",
      text: truncateResponse(output)
    }]
  };
  } catch (error) {
    return formatToolError(error, "get_precedent_text")
  }
}

