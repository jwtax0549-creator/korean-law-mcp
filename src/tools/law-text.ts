/**
 * get_law_text Tool - 법령 조문 조회
 */

import { z } from "zod"
import type { LawApiClient } from "../lib/api-client.js"
import { buildJO } from "../lib/law-parser.js"
import { lawCache } from "../lib/cache.js"
import { formatArticleUnit } from "../lib/article-parser.js"
import { getStrategyWarning } from "../lib/article-warnings.js"
import { flattenAddendum } from "./applicable-law.js"
import { formatToolError } from "../lib/errors.js"

import { MAX_RESPONSE_SIZE, truncateResponse } from "../lib/schemas.js"

export const GetLawTextSchema = z.object({
  mst: z.string().optional().describe("법령일련번호 (search_law에서 획득)"),
  lawId: z.string().optional().describe("법령ID (search_law에서 획득)"),
  jo: z.string().optional().describe("조문 번호 (예: '제38조' 또는 '003800')"),
  efYd: z.string().optional().describe("시행일자 (YYYYMMDD 형식)"),
  addenda: z.string().optional().describe("부칙 조회. 'list'=부칙 목록(공포일자·번호) | 'YYYYMMDD'=해당 공포일자 부칙 본문. 경과조치·적용례 확인용. 지정하면 jo는 무시된다(법제처는 부칙을 전문 조회에만 실어 준다)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달")
}).refine(data => data.mst || data.lawId, {
  message: "mst 또는 lawId 중 하나는 필수입니다"
})

export type GetLawTextInput = z.infer<typeof GetLawTextSchema>

/** 부칙 조문의 **자기 머리**(`제2조(적용례)`) — 본문의 조문 참조와 같은 모양이라 먼저 떼어낸다 */
const ADDENDUM_OWN_HEADER = /^\s*(제\d+조(?:의\d+)?\s*(?:\([^)]*\))?)\s*/;
/** 다른 법령의 조문(`「법인세법 시행령」 제39조제1항`) — 이 법령의 조문이 아니다 */
const FOREIGN_ARTICLE = /「[^」]*」\s*제\d+조(?:의\d+)?/g;
const ARTICLE_REF = /제(\d+)조(?:의(\d+))?/g;
/** ★적용례·경과조치를 가르는 두 신호. **줄의 문언만 보면 옛 부칙을 통째로 놓친다**
 *  (2026-08-11 실측: 「개정규정」만 보면 조문을 든 줄의 20~27%가 샜고, 그 안에
 *   `제4조(…에 관한 적용례) 제16조제1항제11호의 규정은 …` 같은 진짜가 들어 있었다 — 옛 판은 「개정」을 안 쓴다). */
const ADDENDUM_KIND = /적용례|경과조치|특례|의제|적용시기/;
const ADDENDUM_ANCHOR = /개정규정|종전의 규정/;
/** 자구정비뿐이라 이 조문의 적용시기를 바꾸지 않는다 */
const OTHER_LAW_AMEND = /다른 법[령률]의 개정/;

/**
 * 부칙에서 **이 법령의 어느 조문을 건드리는가**를 뽑아 역인덱스를 만든다.
 * 키는 `제16조`·`제2조의2` 꼴이고, 값은 사람이 읽을 수 있는 출처 한 줄이다.
 *
 * ★조문 하나만 읽고 부칙을 안 보면 적용례를 통째로 놓친다 — 그것 하나로 결론이 뒤집힌 사례가 있다.
 * ★모집단을 「개정규정·종전의 규정이 있는 줄」로 좁힌다(2026-08-11 실측): 그 문언이 없는 조문 나열은
 *   「다른 법령의 개정」식 일괄 자구정비라 이 조문의 적용시기를 바꾸지 않는다.
 */
export function buildAddendaIndex(
  buList: any[],
  flatten: (x: any) => string[],
  known?: Set<string>
): Record<string, string[]> {
  const idx: Record<string, string[]> = {};
  for (const b of buList) {
    const label = `${b?.부칙공포일자 || "?"} 제${b?.부칙공포번호 || "?"}호`;
    let ownHeader = "";
    for (const rawLine of flatten(b?.부칙내용)) {
      const line = String(rawLine).trim();
      if (!line) continue;
      const own = line.match(ADDENDUM_OWN_HEADER);
      if (own) ownHeader = own[1].trim();
      if (OTHER_LAW_AMEND.test(ownHeader)) continue;
      if (!ADDENDUM_KIND.test(ownHeader) && !ADDENDUM_ANCHOR.test(line)) continue;
      const rest = (own ? line.slice(own[0].length) : line).replace(FOREIGN_ARTICLE, "");
      const seen = new Set<string>();
      let m: RegExpExecArray | null;
      ARTICLE_REF.lastIndex = 0;
      while ((m = ARTICLE_REF.exec(rest)) !== null) {
        const key = m[2] ? `제${m[1]}조의${m[2]}` : `제${m[1]}조`;
        // ★부칙은 모법(母法)·타법 조문도 같은 모양으로 인용한다 — 이 법령에 없는 번호는 버린다
        if (known && !known.has(key)) continue;
        if (seen.has(key)) continue;
        seen.add(key);
        const entry = ownHeader ? `${label} ${ownHeader}` : label;
        (idx[key] ||= []).push(entry);
      }
    }
  }
  return idx;
}


export async function getLawText(
  apiClient: LawApiClient,
  input: GetLawTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  try {
    // 조문 번호가 한글이면 JO 코드로 변환
    // 부칙은 전문 조회 응답에만 실려 온다(JO 지정 시 최상위 키에 부칙이 없다)
    let joCode = input.addenda ? undefined : input.jo
    if (joCode && /제\d+조/.test(joCode)) {
      try {
        joCode = buildJO(joCode)
      } catch (e) {
        return {
          content: [{
            type: "text",
            text: `조문 번호 변환 실패: ${e instanceof Error ? e.message : String(e)}`
          }],
          isError: true
        }
      }
    }

    // ★부칙 역인덱스는 **목차 조회 때** 적재된다. 그 전에 부른 조문 응답은 「부칙은 이 응답에 실리지
    //   않습니다」 안내를 담고 캐시되는데, 캐시 키가 적재 여부를 모르면 **목차를 부른 뒤에도 그 안내가
    //   그대로 돌아온다.** 2026-08-11 라이브 첫 사용에서 실제로 밟았다(안내대로 목차를 불렀는데 안 바뀌었다).
    const addendaIdxKey = `addenda-idx:${input.mst || input.lawId}:${input.efYd || "current"}`
    const addendaIdxState = lawCache.get<string>(addendaIdxKey) ? "idx" : "noidx"

    // Check cache first (efYd 정규화: 미지정 → 'current'로 통일)
    const cacheKey = `lawtext:${input.mst || input.lawId}:${joCode || 'full'}:${input.efYd || 'current'}:${input.addenda || ''}:${addendaIdxState}`
    const cached = lawCache.get<string>(cacheKey)
    if (cached) {
      return {
        content: [{
          type: "text",
          text: cached
        }]
      }
    }

    const jsonText = await apiClient.getLawText({
      mst: input.mst,
      lawId: input.lawId,
      jo: joCode,
      efYd: input.efYd,
      apiKey: input.apiKey
    })

    const json = JSON.parse(jsonText)

    // JSON 구조 파싱 (LexDiff 방식 적용)
    const lawData = json?.법령
    if (!lawData) {
      return {
        content: [{
          type: "text",
          text: "[NOT_FOUND] 법령 데이터를 찾을 수 없습니다.\n\n⚠️ 법제처 API가 해당 mst/lawId에 대해 데이터를 반환하지 않았습니다. LLM이 조문을 추측/생성하지 마세요. search_law로 유효한 mst를 먼저 확인하세요."
        }],
        isError: true
      }
    }

    // 조문 범위 파싱 함수
    const extractArticleRange = (data: any): { min: number, max: number, count: number } | null => {
      const rawUnits = data.조문?.조문단위
      if (!rawUnits) return null

      const units = Array.isArray(rawUnits) ? rawUnits : [rawUnits]
      const articleNumbers: number[] = []

      for (const unit of units) {
        if (unit.조문여부 === "조문" && unit.조문번호) {
          const num = parseInt(unit.조문번호, 10)
          if (!isNaN(num)) articleNumbers.push(num)
        }
      }

      if (articleNumbers.length === 0) return null

      return {
        min: Math.min(...articleNumbers),
        max: Math.max(...articleNumbers),
        count: articleNumbers.length
      }
    }

    const basicInfo = lawData.기본정보 || lawData
    const lawName = basicInfo?.법령명_한글 || basicInfo?.법령명한글 || basicInfo?.법령명 || "알 수 없음"
    const promDate = basicInfo?.공포일자 || ""
    const effDate = basicInfo?.시행일자 || basicInfo?.최종시행일자 || ""
    const prevLawName = basicInfo?.이전법령명 || ""

    let resultText = `법령명: ${lawName}\n`
    if (prevLawName) resultText += `(구 법령명: ${prevLawName} — 개정/분법으로 명칭 변경됨)\n`
    if (promDate) resultText += `공포일: ${promDate}\n`
    if (effDate) resultText += `시행일: ${effDate}\n`

    // 현행성 라벨: LLM이 옛 버전 조문을 현행으로 오인하지 않도록
    // 조회 시점 날짜와 시행일자를 비교해 명시
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "")
    if (input.efYd) {
      resultText += `⚠️ 특정 시행일자(efYd=${input.efYd}) 버전 조회 — 현행 법령이 아닐 수 있음. 현행 기준 답변에는 efYd 없이 재조회할 것.\n`
    } else if (effDate && String(effDate) > today) {
      resultText += `⚠️ 시행 예정 버전 (조회기준일 ${today} 현재 미시행). 현재 효력 있는 조문과 다를 수 있음.\n`
    } else if (effDate) {
      resultText += `ℹ️ 조회기준일 ${today} — 위 시행일 버전 본문. 연혁 MST로 조회한 경우 과거 버전일 수 있으니, 개정 여부가 의심되면 search_law로 [현행] MST를 재확인할 것.\n`
    }
    resultText += `\n`

    // 조문 내용 추출 (정확한 경로: 법령.조문.조문단위)
    // 주의: 조문단위는 배열 또는 객체일 수 있음
    const rawUnits = lawData.조문?.조문단위
    let articleUnits: any[] = []

    if (Array.isArray(rawUnits)) {
      articleUnits = rawUnits
    } else if (rawUnits && typeof rawUnits === 'object') {
      articleUnits = [rawUnits]  // 단일 객체를 배열로 변환
    }

    if (articleUnits.length === 0) {
      // 조문 범위 확인
      const range = extractArticleRange(lawData)
      let errorMsg = resultText + "[NOT_FOUND] 조문 내용을 찾을 수 없습니다.\n⚠️ LLM은 조문을 추측/생성하지 말고 아래 안내대로 재조회하세요."

      if (input.jo) {
        // 특정 조문 요청했는데 없는 경우
        if (range) {
          errorMsg += `\n\n이 법령은 제${range.min}조~제${range.max}조까지 총 ${range.count}개 조문만 존재합니다.`
          errorMsg += `\n\n해결 방법:`
          errorMsg += `\n   1. 전체 조회:`
          if (input.mst) {
            errorMsg += `\n      get_law_text(mst="${input.mst}")`
          } else if (input.lawId) {
            errorMsg += `\n      get_law_text(lawId="${input.lawId}")`
          }
          errorMsg += `\n\n   2. 유사 조문 조회 예시:`
          const suggestJo = Math.max(1, range.max - 3)
          if (input.mst) {
            errorMsg += `\n      get_law_text(mst="${input.mst}", jo="제${range.max}조")`
            errorMsg += `\n      get_law_text(mst="${input.mst}", jo="제${suggestJo}조")`
          } else if (input.lawId) {
            errorMsg += `\n      get_law_text(lawId="${input.lawId}", jo="제${range.max}조")`
            errorMsg += `\n      get_law_text(lawId="${input.lawId}", jo="제${suggestJo}조")`
          }
          errorMsg += `\n\n   3. 키워드 검색:`
          errorMsg += `\n      search_all(query="${lawName.replace(/\s+(시행령|시행규칙)/, '')}")`
        } else {
          errorMsg += `\n\n[NOT_FOUND] 조문을 찾을 수 없습니다. 다음을 시도해보세요:`
          errorMsg += `\n   - 전체 법령 조회 (jo 파라미터 생략)`
          errorMsg += `\n   - 키워드 검색 (search_all 도구 사용)`
        }
      }

      return {
        content: [{
          type: "text",
          text: errorMsg
        }],
        isError: true
      }
    }

    /** 조문단위 → `제16조`·`제2조의2` 키 */
    const articleKeyOf = (u: any): string => {
      const n = parseInt(u?.조문번호, 10)
      if (isNaN(n)) return ""
      const br = parseInt(u?.조문가지번호, 10)
      return br ? `제${n}조의${br}` : `제${n}조`
    }
    // ★부칙은 **전문 조회 응답에만** 실려 온다(jo 지정 시 최상위에 없다). 그래서 전문/목차를 부르는
    //   이 자리에서 역인덱스를 만들어 캐시해 두고, 조문 조회 때 꺼내 쓴다 — 추가 요청 0.
    if (!input.jo) {
      const buRawIdx = lawData.부칙?.부칙단위
      const buListIdx: any[] = buRawIdx ? (Array.isArray(buRawIdx) ? buRawIdx : [buRawIdx]) : []
      if (buListIdx.length > 0) {
        const known = new Set(
          articleUnits.filter(u => u.조문여부 === "조문").map(articleKeyOf).filter(Boolean)
        )
        lawCache.set(addendaIdxKey, JSON.stringify(buildAddendaIndex(buListIdx, flattenAddendum, known)))
      }
    }

    // 부칙 조회 — lawData.부칙 은 지금까지 아무도 읽지 않았다(경과조치 확인 경로가 막혀 있었다)
    if (input.addenda) {
      const buRaw = lawData.부칙?.부칙단위
      const buList: any[] = buRaw ? (Array.isArray(buRaw) ? buRaw : [buRaw]) : []
      const label = (b: any) => `${b.부칙공포일자 || "?"} 제${b.부칙공포번호 || "?"}호`
      const idArg = input.mst ? `mst="${input.mst}"` : `lawId="${input.lawId}"`

      if (buList.length === 0) {
        return { content: [{ type: "text", text: resultText + "부칙: 응답에 부칙이 없습니다." }] }
      }

      if (input.addenda === "list") {
        let t = resultText + `부칙 ${buList.length}건 (최신순)\n\n`
        t += buList.slice().reverse().map(label).join("\n")
        t += `\n\n특정 부칙 본문: get_law_text(${idArg}, addenda="YYYYMMDD")`
        const out = truncateResponse(t)
        lawCache.set(cacheKey, out)
        return { content: [{ type: "text", text: out }] }
      }

      // 같은 공포일자에 여러 호가 있다(예: 20251223 제21223호·제21221호).
      // 8자리면 공포일자, 그 외 숫자면 공포번호로 특정한다.
      const want = String(input.addenda).replace(/[^0-9]/g, "")
      const byDate = want.length === 8
      const strip = (v: any) => String(v || "").replace(/^0+/, "")
      const hits = buList.filter((b: any) =>
        byDate ? String(b.부칙공포일자 || "") === want : strip(b.부칙공포번호) === strip(want))
      if (hits.length === 0) {
        const recent = buList.slice(-5).reverse().map(label).join(" · ")
        const kind = byDate ? "공포일자" : "공포번호"
        return { content: [{ type: "text", text: resultText + `${kind} ${want} 부칙 없음.\n최근 5건: ${recent}\n전체 목록: get_law_text(${idArg}, addenda="list")` }] }
      }

      const kindLabel = byDate ? "공포일자" : "공포번호"
      let t = resultText + `부칙 ${hits.length}건 (${kindLabel} ${want})` + `\n\n`
      for (const b of hits) {
        const body = flattenAddendum(b.부칙내용).join("\n")
        t += `[부칙] ${label(b)}\n${body}\n\n`
      }
      const out = truncateResponse(t)
      lawCache.set(cacheKey, out)
      return { content: [{ type: "text", text: out }] }
    }

    // 조문 미지정 시 전체 법령 대신 목차(조문 제목 목록)만 반환
    // 대형 법령(국가공무원법 등)의 "too large content" 에러 방지
    if (!input.jo && articleUnits.length > 20) {
      const tocItems: string[] = []
      for (const unit of articleUnits) {
        if (unit.조문여부 !== "조문") continue
        const joNum = unit.조문번호 || ""
        const joBranch = unit.조문가지번호 || ""
        const joTitle = unit.조문제목 || ""
        if (joNum) {
          const displayNum = joBranch && joBranch !== "0" ? `제${joNum}조의${joBranch}` : `제${joNum}조`
          tocItems.push(`${displayNum}${joTitle ? ` ${joTitle}` : ""}`)
        }
      }

      let tocText = resultText
      tocText += `목차 (총 ${tocItems.length}개 조문)\n\n`
      tocText += tocItems.join("\n")
      tocText += `\n\n특정 조문 조회: get_law_text(`
      if (input.mst) {
        tocText += `mst="${input.mst}", jo="제XX조")`
      } else if (input.lawId) {
        tocText += `lawId="${input.lawId}", jo="제XX조")`
      }
      tocText += `\n여러 조문 일괄 조회: get_batch_articles 도구 사용`
      const buRawToc = lawData.부칙?.부칙단위
      const buCount = buRawToc ? (Array.isArray(buRawToc) ? buRawToc.length : 1) : 0
      if (buCount > 0) {
        const idArgToc = input.mst ? `mst="${input.mst}"` : `lawId="${input.lawId}"`
        tocText += `\n부칙 ${buCount}건 — 목록: get_law_text(${idArgToc}, addenda="list") · 경과조치·적용례 확인 시 필수`
      }

      // 절단본을 캐시 — 캐시 히트 경로는 절단 없이 반환하므로 미절단 캐시 시 50KB 제한 우회됨
      const truncatedToc = truncateResponse(tocText)
      lawCache.set(cacheKey, truncatedToc)
      return {
        content: [{
          type: "text",
          text: truncatedToc
        }]
      }
    }

    for (const unit of articleUnits) {
      const formatted = formatArticleUnit(unit)
      if (!formatted) continue

      if (formatted.header) resultText += `${formatted.header}\n`
      if (formatted.body) resultText += `${formatted.body}\n\n`

      // 민법 의사표시 하자 조문(107~110)에 전략 경고 주입
      const warning = getStrategyWarning(lawName, unit.조문번호 || "", unit.조문가지번호 || "")
      if (warning) resultText += `${warning}\n\n`
    }

    // ★조문만 읽고 부칙을 안 보면 적용례를 통째로 놓친다 — 그것 하나로 결론이 뒤집힐 수 있다.
    if (input.jo) {
      const idArgJo = input.mst ? `mst="${input.mst}"` : `lawId="${input.lawId}"`
      const cachedIdx = lawCache.get<string>(addendaIdxKey)
      if (cachedIdx) {
        const idx: Record<string, string[]> = JSON.parse(cachedIdx)
        const keys = articleUnits.filter(u => u.조문여부 === "조문").map(articleKeyOf).filter(Boolean)
        const hits = [...new Set(keys.flatMap(k => idx[k] || []))]
        if (hits.length > 0) {
          resultText += `※ 이 조문에 걸린 부칙 ${hits.length}건(적용례·경과조치) — 하나만 보고 인용하면 반대 방향을 놓칩니다.\n`
          resultText += hits.map(h => `   · ${h}`).join("\n") + `\n`
          resultText += `   본문: get_law_text(${idArgJo}, addenda="YYYYMMDD")  ※ 위 목록 앞의 8자리가 그 날짜입니다.\n\n`
        }
      } else {
        resultText += `※ 이 조문에 걸린 부칙(적용례·경과조치)은 이 응답에 실리지 않습니다 — get_law_text(${idArgJo})로 목차를 먼저 부르면 조문 조회에 함께 표시됩니다.\n\n`
      }
    }

    // 응답 크기 제한 - 조문 경계에서 자르기 (mid-article 절단 방지)
    if (resultText.length > MAX_RESPONSE_SIZE) {
      const totalArticles = articleUnits.filter(u => u.조문여부 === "조문").length

      // 조문 헤더 위치를 역순으로 찾아서 MAX_RESPONSE_SIZE 이내의 마지막 완전한 조문 경계에서 자르기
      const articleHeaderPattern = /^제\d+조(?:의\d+)?/gm
      let lastSafePos = 0
      let includedCount = 0
      let match
      while ((match = articleHeaderPattern.exec(resultText)) !== null) {
        if (match.index > MAX_RESPONSE_SIZE - 200) break // 200자 여유 (안내 메시지용)
        lastSafePos = match.index
        includedCount++
      }

      // 마지막 조문 이후의 내용도 포함 (조문 본문)
      if (lastSafePos > 0 && includedCount > 0) {
        // 다음 조문 헤더 전까지 또는 끝까지
        const nextArticlePattern = /^제\d+조(?:의\d+)?/gm
        nextArticlePattern.lastIndex = lastSafePos + 1
        const nextMatch = nextArticlePattern.exec(resultText)
        const cutPos = nextMatch && nextMatch.index <= MAX_RESPONSE_SIZE - 200
          ? nextMatch.index
          : Math.min(resultText.length, MAX_RESPONSE_SIZE - 200)
        resultText = resultText.slice(0, cutPos)
      } else {
        resultText = resultText.slice(0, MAX_RESPONSE_SIZE - 200)
      }

      // 포함된 조문 번호 추출
      const includedArticles: string[] = []
      const finalHeaderPattern = /^(제\d+조(?:의\d+)?)/gm
      let m
      while ((m = finalHeaderPattern.exec(resultText)) !== null) {
        includedArticles.push(m[1])
      }

      const first = includedArticles[0] || "?"
      const last = includedArticles[includedArticles.length - 1] || "?"

      resultText += `\n\n[응답 크기 제한] ${totalArticles}개 조문 중 ${includedArticles.length}개만 포함 (${first}~${last})`
      resultText += `\n나머지 조문 조회: get_law_text(`
      if (input.mst) {
        resultText += `mst="${input.mst}", jo="제XX조")`
      } else if (input.lawId) {
        resultText += `lawId="${input.lawId}", jo="제XX조")`
      }
      resultText += `\n여러 조문 일괄 조회: get_batch_articles 도구 사용`
    }

    // Cache the result
    lawCache.set(cacheKey, resultText)

    return {
      content: [{
        type: "text",
        text: resultText
      }]
    }
  } catch (error) {
    return formatToolError(error, "get_law_text")
  }
}
