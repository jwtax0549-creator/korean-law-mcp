import { z } from "zod";
import type { LawApiClient } from "../lib/api-client.js";
import { truncateResponse } from "../lib/schemas.js";
import { parseSearchXML, extractTag } from "../lib/xml-parser.js";
import { formatToolError, noResultHint } from "../lib/errors.js";
import { fetchTaxlawAction, extractTaxlawEditorBody, normalizeTaxlawBodyCandidate } from "./precedents.js";

// 관세청(kcsCgmExpc)·국세청(ntsCgmExpc) 응답 구조가 동일하므로 target만 분기해 재사용
type CgmExpcTarget = "kcsCgmExpc" | "ntsCgmExpc";
const TARGET_LABEL: Record<CgmExpcTarget, string> = {
  kcsCgmExpc: "관세청",
  ntsCgmExpc: "국세청",
};

/** 국세청 검색은 제목(section=itmNm)만 대상이라 관련 예규가 뒤로 밀린다 — 표시 하한을 올려 누락 방지 */
const NTS_MIN_DISPLAY = 50;

/** 국세청 문서ID(ntstDcmId) — 법제처 일련번호와 다른 체계. 본문 조회는 이 값으로만 가능 */
const NTST_DCM_ID_PATTERN = /^\d{15,20}$/;

/** 법령해석상세링크(taxlaw.nts.go.kr/...?ntstDcmId=...)에서 본문 조회용 문서ID를 뽑는다 */
function extractNtstDcmId(link: string | undefined): string {
  if (!link) return "";
  try {
    return new URL(link).searchParams.get("ntstDcmId") || "";
  } catch {
    return "";
  }
}

/**
 * 회신에 통째로 붙은 「다른 문서」의 머리줄. 실물에서 확인된 모양(2026-08-11 · 303건 스윕):
 *   `○ 부가46015-1221, 1999.04.24`      `[서면3팀-586, 2005.05.02]`
 *   `○ 법인세과-433 (2012.06.29)`        ← 날짜가 괄호 안
 *   `○ 서면-2018-법령해석부가-1462, 2018.6.28.`  ← 문서번호에 하이픈이 여럿
 *   ` ○ 재정경제부 부가가치세제과-265, 2006.11.29` ← 기관명이 앞에 붙어 공백 포함
 *   `▪ 서면-2015-법령해석부가-0770 , 2015.06.30`  `■ 부가1235-3410, …`  `* 법인46012-3131, …`
 *   `※ 부가가치세법기본통칙 2-0-1 【납세의무】`  ← 예규가 아니라 통칙을 실은 것
 * ★글머리 기호는 열거하지 않는다 — 실물에서 ○ ● ※ ▪ ■ * 가 나왔고 더 있을 것이다.
 * ★줄 전체가 인용표시여야 한다 — 문장 안 괄호(`…(부가46015-4306,1999.10.25)과 …`)는 잡으면 안 된다.
 */
const QUOTED_DOC_HEADER = /^[^가-힣A-Za-z0-9[]*\[?\s*([가-힣A-Za-z][가-힣A-Za-z0-9 ]*(?:-[가-힣A-Za-z0-9 ]+)*-\d+)\s*[,，]?\s*(?:\(?\s*\d{4}\s*[.-]\s*\d{1,2}\s*[.-]\s*\d{1,2}\.?\s*\)?)?\s*(?:【[^】]*】)?\s*[.\]]?$/;

/** 머리줄 뒤에 「본문」이라 부를 만한 분량이 따라와야 실린 것으로 본다 */
const QUOTED_BODY_MIN_CHARS = 50;

/**
 * 국세청 회신 본문에 **다른 문서의 본문이 함께 실렸는지** 판정해 그 문서번호를 돌려준다.
 *
 * ★판별 축은 「참조하시기 바람」 같은 낱말이 아니다 — 그 낱말은 자기 판단을 말한 회신에도 흔히 붙는다.
 *   실제로 틀린 자리는 **남의 문장을 이 예규의 판단으로 인용한 것**이라, 재야 할 것은
 *   「다른 문서의 본문이 여기 실려 있는가」다(2026-08-11 · 실물 표본 3건으로 축을 정했다).
 */
export function findQuotedDocuments(reply: string): string[] {
  const lines = reply.split("\n");
  const found: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(QUOTED_DOC_HEADER);
    if (!m) continue;
    // 다음 머리줄 전까지가 그 문서의 본문 — 머리줄만 늘어선 인용 목록은 여기서 걸러진다
    let body = "";
    for (let j = i + 1; j < lines.length; j++) {
      if (QUOTED_DOC_HEADER.test(lines[j].trim())) break;
      body += lines[j];
    }
    if (body.replace(/\s/g, "").length < QUOTED_BODY_MIN_CHARS) continue;
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

// Customs legal interpretation search tool - Search for customs law interpretations
export const searchCustomsInterpretationsSchema = z.object({
  query: z.string().optional().describe("Search keyword (e.g., '거래명세서', '세금')"),
  display: z.number().min(1).max(100).default(20).describe("Results per page (default: 20, max: 100)"),
  page: z.number().min(1).default(1).describe("Page number (default: 1)"),
  inq: z.number().optional().describe("Inquiry organization code (질의기관코드)"),
  rpl: z.number().optional().describe("Interpretation organization code (해석기관코드)"),
  gana: z.string().optional().describe("Dictionary search (ga, na, da, etc.)"),
  explYd: z.string().optional().describe("Interpretation date range (YYYYMMDD~YYYYMMDD, e.g., '20200101~20201231')"),
  sort: z.enum(["lasc", "ldes", "dasc", "ddes"]).optional()
    .describe("Sort option: lasc/ldes (interpretation name), dasc/ddes (interpretation date)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
});

export type SearchCustomsInterpretationsInput = z.infer<typeof searchCustomsInterpretationsSchema>;

export async function searchCustomsInterpretations(
  apiClient: LawApiClient,
  args: SearchCustomsInterpretationsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return searchCgmExpcByTarget(apiClient, args, "kcsCgmExpc");
}

/** 국세청 법령해석 검색 (#35) — 응답 구조 관세청과 동일, target만 분기. unified-decisions만 사용 */
export async function searchNtsInterpretations(
  apiClient: LawApiClient,
  args: SearchCustomsInterpretationsInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return searchCgmExpcByTarget(apiClient, args, "ntsCgmExpc");
}

async function searchCgmExpcByTarget(
  apiClient: LawApiClient,
  args: SearchCustomsInterpretationsInput,
  target: CgmExpcTarget
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  const orgLabel = TARGET_LABEL[target];
  try {
    // 국세청은 제목검색뿐이라 상위 20건에 핵심 예규가 안 잡히는 사례가 많다 → 하한 상향
    const requested = args.display || 20;
    const display = target === "ntsCgmExpc" ? Math.max(requested, NTS_MIN_DISPLAY) : requested;
    const extraParams: Record<string, string> = {
      display: display.toString(),
      page: (args.page || 1).toString(),
    };
    if (args.query) extraParams.query = args.query;
    if (args.inq !== undefined) extraParams.inq = args.inq.toString();
    if (args.rpl !== undefined) extraParams.rpl = args.rpl.toString();
    if (args.gana) extraParams.gana = args.gana;
    if (args.explYd) extraParams.explYd = args.explYd;
    if (args.sort) extraParams.sort = args.sort;

    const xmlText = await apiClient.fetchApi({
      endpoint: "lawSearch.do",
      target,
      extraParams,
      apiKey: args.apiKey,
    });

    // parseSearchXML 사용 (rootTag: CgmExpc, itemTag: cgmExpc)
    const { totalCnt, page: currentPage, items: expcs } = parseSearchXML(
      xmlText, "CgmExpc", "cgmExpc",
      (content) => ({
        법령해석일련번호: extractTag(content, "법령해석일련번호"),
        안건명: extractTag(content, "안건명"),
        안건번호: extractTag(content, "안건번호"),
        질의기관코드: extractTag(content, "질의기관코드"),
        질의기관명: extractTag(content, "질의기관명"),
        해석기관코드: extractTag(content, "해석기관코드"),
        해석기관명: extractTag(content, "해석기관명"),
        해석일자: extractTag(content, "해석일자"),
        법령해석상세링크: extractTag(content, "법령해석상세링크"),
      })
    );

    const totalCount = totalCnt;

    if (totalCount === 0) {
      return noResultHint(args.query || "", `${orgLabel} 법령해석`)
    }

    let output = `${orgLabel} 법령해석 검색 결과 (총 ${totalCount}건, ${currentPage}페이지):\n\n`;

    for (const expc of expcs) {
      output += `[${expc.법령해석일련번호}] ${expc.안건명}\n`;
      if (expc.안건번호) {
        output += `  문서번호: ${expc.안건번호}\n`;
      }
      output += `  질의기관: ${expc.질의기관명 || "N/A"}\n`;
      output += `  해석기관: ${expc.해석기관명 || "N/A"}\n`;
      output += `  해석일자: ${expc.해석일자 || "N/A"}\n`;
      if (expc.법령해석상세링크) {
        output += `  링크: ${expc.법령해석상세링크}\n`;
        const ntstDcmId = target === "ntsCgmExpc" ? extractNtstDcmId(expc.법령해석상세링크) : "";
        if (ntstDcmId) {
          output += `  ntstDcmId: ${ntstDcmId}  ← 본문: get_decision_text(domain="nts", id="${ntstDcmId}")\n`;
        }
      }
      output += `\n`;
    }

    if (target === "ntsCgmExpc" && totalCount > expcs.length) {
      output += `⚠️ 총 ${totalCount}건 중 ${expcs.length}건만 표시. 국세청 검색은 **제목만** 대상이고 관련도순이 아니라, 핵심 예규가 뒤에 묻힐 수 있습니다.\n`;
      output += `   빠짐 없이 보려면 display를 올리거나(최대 100) page를 넘기세요. 제목에 없는 말로는 검색되지 않으니 문서번호·다른 표현으로도 검색하세요.\n`;
    }

    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  } catch (error) {
    return formatToolError(error, target === "ntsCgmExpc" ? "search_nts_interpretations" : "search_customs_interpretations");
  }
}

// Customs legal interpretation text retrieval tool - Get full text of a specific interpretation
export const getCustomsInterpretationTextSchema = z.object({
  id: z.string().describe("Customs interpretation serial number (법령해석일련번호) from search results"),
  interpretationName: z.string().optional().describe("Interpretation name (optional, for verification)"),
  apiKey: z.string().optional().describe("법제처 Open API 인증키(OC). 사용자가 제공한 경우 전달"),
});

export type GetCustomsInterpretationTextInput = z.infer<typeof getCustomsInterpretationTextSchema>;

export async function getCustomsInterpretationText(
  apiClient: LawApiClient,
  args: GetCustomsInterpretationTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  return getCgmExpcTextByTarget(apiClient, args, "kcsCgmExpc");
}

/**
 * 국세청 법령해석 본문 조회 (#35)
 *
 * 법제처 OPEN API는 국세청 법령해석에 **목록 조회만 제공**한다(`lawService.do?target=ntsCgmExpc` 없음).
 * 대신 검색 응답의 `법령해석상세링크`에 담긴 국세청 문서ID(`ntstDcmId`)로
 * 국세청 조회 endpoint에 직접 질의해 본문을 가져온다(판례 HTML 폴백과 동일 경로 재사용).
 *
 * ⚠️ 국세청 문서는 두 본문이 성격이 정반대다 — 섞으면 안 된다:
 *   - `dcmDVO.ntstDcmCntn`      = **국세청 회신**(답변).           ← 핵심
 *   - `dcmHwpEditorDVOList`     = **납세자 질의서**(`qstn/...`).   ← 참고
 * 판례용 `extractTaxlawBody()`는 에디터를 우선하므로 여기서 쓰면 회신이 통째로 유실된다.
 */
export async function getNtsInterpretationText(
  _apiClient: LawApiClient,
  args: GetCustomsInterpretationTextInput
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  // 법제처 일련번호(짧은 숫자)로는 국세청 본문을 찾을 수 없다 — 변환식도 없다
  if (!NTST_DCM_ID_PATTERN.test(args.id)) {
    const text =
      `[NEED_NTST_DCM_ID] 국세청 법령해석 본문은 국세청 문서ID(ntstDcmId)로 조회합니다.\n\n` +
      `받은 id: ${args.id} — 법제처 일련번호로 보이며, 본문 조회에는 쓸 수 없습니다(두 번호 사이에 변환식이 없습니다).\n` +
      `search_decisions(domain="nts") 결과의 'ntstDcmId' 값을 id로 넣어 다시 호출하세요.\n` +
      `예: get_decision_text(domain="nts", id="010000000000050559")`;
    return { content: [{ type: "text", text }] };
  }

  try {
    const referer = `https://taxlaw.nts.go.kr/qt/USEQTA002P.do?ntstDcmId=${args.id}`;
    const actionData = (await fetchTaxlawAction(args.id, referer))?.data?.ASIQTB002PR01;
    const dcm = actionData?.dcmDVO;

    // 국세청은 존재하지 않는 id에도 status=SUCCESS + dcmDVO=null 을 준다.
    // 이걸 "본문 없음"으로 흘리면 LLM이 '예규 부존재'로 오독한다 — 반드시 구분한다.
    if (!dcm) {
      const text =
        `[LOOKUP_FAILED] ntstDcmId ${args.id} 로 문서를 찾지 못했습니다(국세청 응답이 비어 있음).\n\n` +
        `id가 틀렸거나 국세청 조회 방식이 바뀐 경우입니다.\n` +
        `⚠️ 이것은 해당 예규의 **부존재를 의미하지 않습니다**. 본문을 추측하지 말고 search_decisions(domain="nts")로 다시 확인하세요.\n` +
        `원문 링크: ${referer}`;
      return { content: [{ type: "text", text }], isError: true };
    }

    const reply = normalizeTaxlawBodyCandidate(dcm.ntstDcmCntn);   // 국세청 회신
    const question = extractTaxlawEditorBody(actionData);          // 납세자 질의서

    let output = `=== ${dcm.ntstDcmTtl || "국세청 법령해석"} ===\n\n`;
    output += `기본 정보:\n`;
    output += `  문서번호: ${dcm.ntstDcmDscmCntn || "N/A"}\n`;
    output += `  귀속연도: ${dcm.attrYr || "N/A"}\n`;
    output += `  ntstDcmId: ${args.id}\n\n`;

    if (dcm.ntstDcmGistCntn) {
      output += `요지:\n${dcm.ntstDcmGistCntn}\n\n`;
    }

    if (reply) {
      // ★2026-08-11 — 회신이 「기존 해석사례를 참조하시기 바람」뿐이고 그 참조 문서의 본문이 뒤에 통째로
      //   붙어 오는 예규가 있다. 그 문장을 **이 예규의 판단으로** 인용한 사례가 실제로 발생했다.
      const quoted = findQuotedDocuments(reply);
      if (quoted.length > 0) {
        const refs = quoted.join(", ");
        output += `★참조 회신 — 아래 「회신」에는 다른 문서(${refs})의 본문이 함께 실려 있습니다.\n`;
        output += `   그 부분의 실질 판단은 그 문서의 것입니다. 근거로 인용할 때는 이 문서번호가 아니라\n`;
        output += `   해당 문서(${refs})를 따로 조회해 그 문서로 인용하십시오.\n\n`;
      }
      output += `회신:\n${reply}\n\n`;
    }

    if (question) {
      // ★2026-08-10 — 앞 절반(인용 금지)만 있던 판이 **「읽지 마세요」로 읽혔다.** 이 구획을 열지 않은 채
      //   「원문에 사실관계가 없다」고 결론 낸 오독이 **실제로 발생했다**(사실관계는 여기 있었다).
      //   이 구획은 **그 예규가 어느 사실관계에 대한 것인가를 아는 유일한 겹**이라 「인용 금지 + 열람 필수」가 같이 가야 한다.
      // ★★그리고 「3. 관련법령」 축을 따로 적는다 — 그 구획에 실린 **구 법령 문언**을 근거로 인용한 사례가
      //   **실제로 발생했다.** 머리의 이유가 「회신이 아니다」뿐이면 **조문은 공적 문언이니 써도 된다**로 갈라 읽힌다.
      //   진짜 이유는 다르다 — 그 조문은 **그 예규 시점의 문언**이고 현행 여부를 예규가 보증하지 않는다.
      output += `※ 아래는 납세자가 제출한 질의내용 요약·관련법령이며, **국세청 회신이 아닙니다**. 근거로 인용하지 마십시오.\n`;
      output += `   ★다만 **반드시 읽으십시오** — 이 예규가 어느 사실관계(시점·거래구조)에 대한 것인지는 여기서만 확인됩니다.\n`;
      output += `   결론이 엇갈리는 예규 둘을 만났을 때, 사실관계를 모르면 「서로 어긋나는 것」인지 「사안이 달라 둘 다 맞는 것」인지 가릴 수 없습니다.\n`;
      output += `   ★「3. 관련법령」에 실린 조문은 **그 예규 시점의 문언**입니다. 현행인지를 예규가 보증하지 않으므로,\n`;
      output += `   인용은 법령 조회로 꺼낸 원문으로 하십시오.\n`;
      // ★★안내는 여기서 끝나고 **아래 한 줄부터가 「본문」 절**이다. 순서를 바꾸지 마라 —
      //   후처리 compactLongSections가 **마지막 섹션 헤더 뒤 전부**를 축약 대상으로 잡는다.
      //   안내를 헤더 안으로 넣으면 안내 길이가 본문의 축약 예산을 먹고 **읽으라고 한 조문이 잘린다**
      //   (2026-08-10 실측: 안내 4줄을 절 안에 두었더니 「3. 관련법령」 조문 884자가 「⋯ 중략 ⋯」이 됐다).
      output += `본문:\n`;
      output += `${question}\n\n`;
    }

    if (!reply && !question) {
      output += `⚠️ 회신 본문이 비어 있습니다(회신생략 문서일 수 있음). 해당 예규가 존재하지 않는다는 뜻은 아닙니다 — 요지·링크로 판단하세요.\n\n`;
    }

    output += `원문 링크: ${referer}\n`;

    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  } catch (error) {
    return formatToolError(error, "get_nts_interpretation_text");
  }
}

async function getCgmExpcTextByTarget(
  apiClient: LawApiClient,
  args: GetCustomsInterpretationTextInput,
  target: CgmExpcTarget
): Promise<{ content: Array<{ type: string, text: string }>, isError?: boolean }> {
  try {
    const extraParams: Record<string, string> = { ID: args.id };
    if (args.interpretationName) extraParams.LM = args.interpretationName;

    const responseText = await apiClient.fetchApi({
      endpoint: "lawService.do",
      target,
      type: "JSON",
      extraParams,
      apiKey: args.apiKey,
    });

    let data: any;
    try {
      data = JSON.parse(responseText);
    } catch (err) {
      throw new Error("Failed to parse JSON response from API");
    }

    if (!data.CgmExpcService) {
      throw new Error("Customs interpretation not found or invalid response format");
    }

    const expc = data.CgmExpcService;
    const basic = {
      안건명: expc.안건명,
      법령해석일련번호: expc.법령해석일련번호,
      업무분야: expc.업무분야,
      해석일자: expc.해석일자,
      해석기관명: expc.해석기관명,
      질의기관명: expc.질의기관명,
      등록일시: expc.등록일시
    };
    const content = {
      질의요지: expc.질의요지,
      회답: expc.회답,
      이유: expc.이유,
      관련법령: expc.관련법령,
      관세법령정보포털원문링크: expc.관세법령정보포털원문링크
    };

    let output = `=== ${basic.안건명 || "Customs Interpretation"} ===\n\n`;

    output += `기본 정보:\n`;
    output += `  해석일련번호: ${basic.법령해석일련번호 || "N/A"}\n`;
    output += `  업무분야: ${basic.업무분야 || "N/A"}\n`;
    output += `  해석일자: ${basic.해석일자 || "N/A"}\n`;
    output += `  질의기관: ${basic.질의기관명 || "N/A"}\n`;
    output += `  해석기관: ${basic.해석기관명 || "N/A"}\n`;
    output += `  등록일시: ${basic.등록일시 || "N/A"}\n\n`;

    if (content.질의요지) {
      output += `질의요지:\n${content.질의요지}\n\n`;
    }

    if (content.회답) {
      output += `회답:\n${content.회답}\n\n`;
    }

    if (content.이유) {
      output += `이유:\n${content.이유}\n\n`;
    }

    if (content.관련법령) {
      output += `관련법령:\n${content.관련법령}\n\n`;
    }

    if (content.관세법령정보포털원문링크) {
      output += `원문 링크: ${content.관세법령정보포털원문링크}\n`;
    }

    return {
      content: [{
        type: "text",
        text: truncateResponse(output)
      }]
    };
  } catch (error) {
    return formatToolError(error, target === "ntsCgmExpc" ? "get_nts_interpretation_text" : "get_customs_interpretation_text");
  }
}

